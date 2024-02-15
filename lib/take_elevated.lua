local tokens_per_ms        = tonumber(ARGV[1])
local bucket_size          = tonumber(ARGV[2])
local tokens_to_take       = tonumber(ARGV[3])
local ttl                  = tonumber(ARGV[4])
local drip_interval        = tonumber(ARGV[5])
local erl_tokens_per_ms    = tonumber(ARGV[6])
local erl_bucket_size      = tonumber(ARGV[7])

-- check if we should use erl
local erlKey = KEYS[2]
local is_erl_activated = redis.call('EXISTS', erlKey)

local current_time = redis.call('TIME')
local current_timestamp_ms = current_time[1] * 1000 + current_time[2] / 1000

local current = redis.pcall('HMGET', KEYS[1], 'd', 'r')

if current.err ~= nil then
    current = {}
end

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

local new_content = calculateNewBucketContent(current, tokens_per_ms, bucket_size, current_timestamp_ms)
local enough_tokens = new_content >= tokens_to_take

if enough_tokens then
    new_content = math.min(new_content - tokens_to_take, bucket_size)
else
    -- use erl
    new_content = calculateNewBucketContent(current, erl_tokens_per_ms, erl_bucket_size, current_timestamp_ms)

    -- if activating erl for first time, refill the bucket with the old bucket size
    if is_erl_activated == 0 then
        redis.log(redis.LOG_NOTICE, 'activating erl for first time')
        new_content = new_content + erl_bucket_size
        redis.call('SET', erlKey, '1')
    end

    enough_tokens = new_content >= tokens_to_take
    if enough_tokens then
        new_content = math.min(new_content - tokens_to_take, erl_bucket_size)
    end
end

-- https://redis.io/commands/EVAL#replicating-commands-instead-of-scripts
redis.replicate_commands()

redis.call('HMSET', KEYS[1],
            'd', current_timestamp_ms,
            'r', new_content)
redis.call('EXPIRE', KEYS[1], ttl)

local reset_ms = 0
if drip_interval > 0 then
    reset_ms = math.ceil(current_timestamp_ms + (bucket_size - new_content) * drip_interval)
end

return { new_content, enough_tokens, current_timestamp_ms, reset_ms, is_erl_activated }
