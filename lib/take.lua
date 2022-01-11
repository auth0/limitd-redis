local tokens_per_ms        = tonumber(ARGV[1])
local bucket_size          = tonumber(ARGV[2])
local new_remaining        = tonumber(ARGV[2])
local tokens_to_take       = tonumber(ARGV[3])
local ttl                  = tonumber(ARGV[4])

local current_time = redis.call('TIME')
local current_timestamp_ms = current_time[1] * 1000 + current_time[2] / 1000

local current = redis.pcall('HMGET', KEYS[1], 'd', 'r')

if current.err ~= nil then
    current = {}
end

if current[1] and tokens_per_ms then
    -- drip bucket
    local last_drip = current[1]
    local current_remaining = current[2]
    local delta_ms = math.max(current_timestamp_ms - last_drip, 0)
    local drip_amount = delta_ms * tokens_per_ms
    new_remaining = math.min(current_remaining + drip_amount, bucket_size)
elseif current[1] and tokens_per_ms == 0 then
    -- fixed bucket
    new_remaining = current[2]
end

local enough_tokens = new_remaining >= tokens_to_take

if enough_tokens then
    new_remaining = math.min(new_remaining - tokens_to_take, bucket_size)
end

-- https://redis.io/commands/EVAL#replicating-commands-instead-of-scripts
redis.replicate_commands()

redis.call('HMSET', KEYS[1],
            'd', current_timestamp_ms,
            'r', new_remaining)
redis.call('EXPIRE', KEYS[1], ttl)

return { new_remaining, enough_tokens, current_timestamp_ms }
