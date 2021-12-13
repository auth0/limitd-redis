local tokens_to_add        = tonumber(ARGV[1])
local bucket_size          = tonumber(ARGV[2])
local ttl                  = tonumber(ARGV[3])

local current_time = redis.call('TIME')
local current_timestamp_ms = current_time[1] * 1000 + current_time[2] / 1000

local current_remaining = redis.call('HMGET', KEYS[1], 'r')[1]
local new_remaining = tokens_to_add + (current_remaining and current_remaining or bucket_size)

redis.replicate_commands()
--[[
If the new bucket size `new_remaining` is at least as large as the maximum
bucket size `bucket_size`, then delete the bucket, to indicate that the
bucket is at its default state, which is the maximum bucket size
--]]
if new_remaining >= bucket_size then
  redis.call('DEL', KEYS[1])
  new_remaining = bucket_size
else
  redis.call('HMSET', KEYS[1],
            'd', current_timestamp_ms,
            'r', new_remaining)
  redis.call('EXPIRE', KEYS[1], ttl)
end

return { new_remaining, current_timestamp_ms }
