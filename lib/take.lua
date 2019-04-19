local tokens_per_ms        = tonumber(ARGV[1])
local bucket_size          = tonumber(ARGV[2])
local new_content          = tonumber(ARGV[2])
local tokens_to_take       = tonumber(ARGV[3])
local ttl                  = tonumber(ARGV[4])

local current_time = redis.call('TIME')
local current_timestamp_ms = current_time[1] * 1000 + current_time[2] / 1000

local current = redis.pcall('HMGET', KEYS[1], 'd', 'r', 'nca')

if current.err ~= nil then
    current = {}
end

if current[1] and tokens_per_ms then
    -- drip bucket
    local last_drip = current[1]
    local content = current[2]
    local delta_ms = math.max(current_timestamp_ms - last_drip, 0)
    local drip_amount = delta_ms * tokens_per_ms
    new_content = math.min(content + drip_amount, bucket_size)
elseif current[1] and tokens_per_ms == 0 then
    -- fixed bucket
    new_content = current[2]
end

local enough_tokens = new_content >= tokens_to_take
local current_conformant_attempts = current[3] or 0;
local non_conformant_attempts = 0;

if enough_tokens then
    new_content = math.min(new_content - tokens_to_take, bucket_size)
else
    -- HINCRBY is the natural redis command to think about for this case
    -- however this approach allows to use a single "HMSET" command instead
    -- HINCRBY and "HMSET" which makes the code a bit cleaner and since LUA scripts
    -- runs atomically it has the same guarantees as HINCRBY
    non_conformant_attempts = current_conformant_attempts + 1
end

-- https://redis.io/commands/EVAL#replicating-commands-instead-of-scripts
redis.replicate_commands()

redis.call('HMSET', KEYS[1],
            'd', current_timestamp_ms,
            'r', new_content,
            'nca', non_conformant_attempts)
redis.call('EXPIRE', KEYS[1], ttl)

return { new_content, enough_tokens, current_timestamp_ms, current_conformant_attempts }
