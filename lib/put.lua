local tokens_to_add        = tonumber(ARGV[1])
local bucket_size          = tonumber(ARGV[2])
local ttl                  = tonumber(ARGV[3])

local current_time = redis.call('TIME')
local current_timestamp_ms = current_time[1] * 1000 + current_time[2] / 1000

local current_remaining = redis.call('HMGET', KEYS[1], 'r')[1]
if current_remaining == false then
  current_remaining = bucket_size
end

local new_content = math.min(current_remaining + tokens_to_add, bucket_size)

redis.replicate_commands()
if new_content < bucket_size then
  redis.call('HMSET', KEYS[1],
            'd', current_timestamp_ms,
            'r', new_content)
  redis.call('EXPIRE', KEYS[1], ttl)
else
  redis.call('DEL', KEYS[1])
end

return { new_content, current_timestamp_ms }
