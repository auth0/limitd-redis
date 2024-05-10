local tokens_per_ms = tonumber(ARGV[1])
local bucket_size = tonumber(ARGV[2])
local tokens_to_take = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
local drip_interval = tonumber(ARGV[5])
local erl_tokens_per_ms = tonumber(ARGV[6])
local erl_bucket_size = tonumber(ARGV[7])
local erl_activation_period_seconds = tonumber(ARGV[8])
local erl_quota = tonumber(ARGV[9])
local erl_quota_expiration_epoch = tonumber(ARGV[10])
local erl_configured_for_bucket = tonumber(ARGV[11]) == 1

-- the key to use for pulling last bucket state from redis
local lastBucketStateKey = KEYS[1]

-- the key for checking in redis if elevated rate limits (erl) were activated earlier
local erlKey = KEYS[2]
local is_erl_activated = erl_configured_for_bucket and redis.call('EXISTS', erlKey) or 0

-- the key for erl quota counting
local erl_quota_key = KEYS[3]

-- get current bucket state
local current = redis.pcall('HMGET', lastBucketStateKey, 'd', 'r')
if current.err ~= nil then
    current = {}
end

-- get current time from redis, to be used in new bucket size calculations later
local current_time = redis.call('TIME')
local current_timestamp_ms = current_time[1] * 1000 + current_time[2] / 1000

local function calculateNewBucketContent(current, tokens_per_ms, bucket_size, current_timestamp_ms)
    if current[1] and tokens_per_ms then
        -- drip bucket
        local last_drip = current[1]
        local content = current[2]
        local delta_ms = math.max(current_timestamp_ms - last_drip, 0)
        local drip_amount = delta_ms * tokens_per_ms
        return math.min(content + drip_amount, bucket_size)
    elseif current[1] and tokens_per_ms == 0 then
        -- fixed bucket
        return current[2]
    else
        -- first take of the bucket
        return bucket_size
    end
end

local function takeERLQuota(erl_quota_key, erl_quota, erl_quota_expiration_epoch)
    if erl_quota <= 0 then
        -- no quota available to take
        return 0
    end

    local previously_used_quota = redis.call('GET', erl_quota_key)
    if type(previously_used_quota) ~= 'string' then
        -- first activation. Set quota to 1 and return.
        redis.call('SET', erl_quota_key, 1, 'PXAT', string.format('%.0f', erl_quota_expiration_epoch))
        return 0
    end

    previously_used_quota = tonumber(previously_used_quota)
    if previously_used_quota >= erl_quota then
        -- quota is already exceeded. Return the current total used quota.
        return previously_used_quota
    end

    -- quota is not exceeded. Increment and return.
    redis.call('SET', erl_quota_key, previously_used_quota+1, 'PXAT', string.format('%.0f', erl_quota_expiration_epoch))
    return previously_used_quota
end

-- Enable verbatim replication to ensure redis sends script's source code to all masters
-- managing the sharded database in a clustered deployment.
-- https://redis.io/docs/interact/programmability/eval-intro/#:~:text=scripts%20debugger.-,Script%20replication,-In%20standalone%20deployments
redis.replicate_commands()

-- calculate new bucket content
local bucket_content_after_refill
if erl_configured_for_bucket and is_erl_activated == 1 then
    bucket_content_after_refill = calculateNewBucketContent(current, erl_tokens_per_ms, erl_bucket_size, current_timestamp_ms)
else
    bucket_content_after_refill = calculateNewBucketContent(current, tokens_per_ms, bucket_size, current_timestamp_ms)
end

local enough_tokens = bucket_content_after_refill >= tokens_to_take
local bucket_content_after_take = bucket_content_after_refill
local erl_quota_left = -1
local erl_triggered = false

if enough_tokens then
    if is_erl_activated == 1 then
        bucket_content_after_take = math.min(bucket_content_after_refill - tokens_to_take, erl_bucket_size)
    else
        bucket_content_after_take = math.min(bucket_content_after_refill - tokens_to_take, bucket_size)
    end
else
    -- if tokens are not enough, see if activating erl will help.
    if erl_configured_for_bucket and is_erl_activated == 0 and erl_quota > 0 then
        local used_tokens = bucket_size - bucket_content_after_refill
        local bucket_content_after_erl_activation = erl_bucket_size - used_tokens
        local enough_tokens_after_erl_activation = bucket_content_after_erl_activation >= tokens_to_take
        if enough_tokens_after_erl_activation then
            local previously_used_quota = takeERLQuota(erl_quota_key, erl_quota, erl_quota_expiration_epoch)
            if previously_used_quota < erl_quota then
                enough_tokens = enough_tokens_after_erl_activation -- we are returning this value, thus setting it
                bucket_content_after_take = math.min(bucket_content_after_erl_activation - tokens_to_take, erl_bucket_size)
                -- save erl state
                redis.call('SET', erlKey, '1')
                redis.call('EXPIRE', erlKey, erl_activation_period_seconds)
                is_erl_activated = 1
                erl_triggered = true
                erl_quota_left = erl_quota - previously_used_quota - 1
            end
        end
    end
end

-- save bucket state
redis.call('HMSET', lastBucketStateKey,
        'd', current_timestamp_ms,
        'r', bucket_content_after_take)
redis.call('EXPIRE', lastBucketStateKey, ttl)

local reset_ms = 0
if drip_interval > 0 then
    if is_erl_activated == 1 then
        reset_ms = math.ceil(current_timestamp_ms + (erl_bucket_size - bucket_content_after_take) * drip_interval)
    else
        reset_ms = math.ceil(current_timestamp_ms + (bucket_size - bucket_content_after_take) * drip_interval)
    end
end

-- Return the current quota
return { bucket_content_after_take, enough_tokens, current_timestamp_ms, reset_ms, erl_triggered, is_erl_activated, erl_quota_left }
