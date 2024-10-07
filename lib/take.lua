local tokens_per_ms        = tonumber(ARGV[1])
local bucket_size          = tonumber(ARGV[2])
local new_content          = tonumber(ARGV[2])
local tokens_to_take       = tonumber(ARGV[3])
local ttl                  = tonumber(ARGV[4])
local drip_interval        = tonumber(ARGV[5])

local current_time = redis.call('TIME')
local current_timestamp_ms = current_time[1] * 1000 + current_time[2] / 1000

local current = redis.pcall('HMGET', KEYS[1], 'd', 'r', 't')
local triggered = false

if current.err ~= nil then
    current = {}
end

if current[1] and tokens_per_ms then
    -- drip bucket
    local last_drip = current[1]
    local content = current[2]
    triggered = current[3]
    local delta_ms = math.max(current_timestamp_ms - last_drip, 0)
    local drip_amount = delta_ms * tokens_per_ms
    new_content = math.min(content + drip_amount, bucket_size)
elseif current[1] and tokens_per_ms == 0 then
    -- fixed bucket
    new_content = current[2]
    triggered = current[3]
end

local enough_tokens = new_content >= tokens_to_take

if enough_tokens then
    new_content = math.min(new_content - tokens_to_take, bucket_size)
end

-- https://redis.io/commands/EVAL#replicating-commands-instead-of-scripts
redis.replicate_commands()

if triggered == false and enough_tokens == false then
    triggered = true
end

redis.call('HMSET', KEYS[1],
            'd', current_timestamp_ms,
            'r', new_content,
            't', triggered)
redis.call('EXPIRE', KEYS[1], ttl)

local reset_ms = 0
if drip_interval > 0 then
    reset_ms = math.ceil(current_timestamp_ms + (bucket_size - new_content) * drip_interval)
end

return { new_content, enough_tokens, current_timestamp_ms, reset_ms, triggered }
