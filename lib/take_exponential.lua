local tokens_per_ms        = tonumber(ARGV[1])
local bucket_size          = tonumber(ARGV[2])
local new_content          = tonumber(ARGV[2])
local tokens_to_take       = tonumber(ARGV[3])
local ttl                  = tonumber(ARGV[4])
local drip_interval        = tonumber(ARGV[5])
local backoff_factor       = tonumber(ARGV[6])
local mult_unit            = tonumber(ARGV[7])
local fixed_window         = tonumber(ARGV[8])

local current_time         = redis.call('TIME')
local current_timestamp_ms = current_time[1] * 1000 + current_time[2] / 1000

local current              = redis.pcall('HMGET', KEYS[1], 'd', 'r')

if current.err ~= nil then
    current = {}
end

-- calculate the time of next available token
local last_token_ms = current[1] or 0
local remaining_tokens = 0
if current[2] then
    remaining_tokens = tonumber(current[2])
else
    remaining_tokens = bucket_size
end

local backoff_step = bucket_size - remaining_tokens
local backoff_time = math.ceil(backoff_factor ^ backoff_step) * mult_unit
local next_token_ms = last_token_ms + backoff_time
local is_passed_wait_time = current_timestamp_ms >= next_token_ms

if current[1] and tokens_per_ms then
    -- drip bucket

    if fixed_window > 0 then
        -- fixed window for granting new tokens
        local interval_correction = (current_timestamp_ms - last_token_ms) % fixed_window
        current_timestamp_ms = current_timestamp_ms - interval_correction
    end

    is_passed_wait_time = current_timestamp_ms >= next_token_ms

    if not is_passed_wait_time then
        new_content = tonumber(current[2])
        last_token_ms = current[1]
    else
        local last_drip = current[1]
        local content = current[2]
        local delta_ms = math.max(current_timestamp_ms - last_drip, 0)
        local drip_amount = delta_ms * tokens_per_ms
        new_content = math.min(content + drip_amount, bucket_size)
    end
elseif current[1] and tokens_per_ms == 0 and is_passed_wait_time then
    -- fixed bucket
    new_content = current[2]
end

local enough_tokens = (new_content >= tokens_to_take) and is_passed_wait_time

if enough_tokens then
    new_content = new_content - 1
    last_token_ms = current_timestamp_ms
end

-- https://redis.io/commands/EVAL#replicating-commands-instead-of-scripts
redis.replicate_commands()

redis.call('HMSET', KEYS[1],
    'd', last_token_ms,
    'r', new_content)
redis.call('EXPIRE', KEYS[1], ttl)

local reset_ms = 0
if fixed_window > 0 then
    reset_ms = current_timestamp_ms + fixed_window
elseif drip_interval > 0 then
    reset_ms = math.ceil(current_timestamp_ms + (bucket_size - new_content) * drip_interval)
end

return { new_content, enough_tokens, current_timestamp_ms, reset_ms, backoff_factor, backoff_time, next_token_ms }
