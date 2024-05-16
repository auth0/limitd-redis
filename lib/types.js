// --- Public Types ---

/**
 * @typedef {Object} LimitDBParams
 * uri nodes buckets prefix
 * @property {string} [params.uri] Address of Redis.
 * @property {Object.<string, object>} [params.nodes] Redis Cluster Configuration https://github.com/luin/ioredis#cluster".
 * @property {Object.<string, type>} [params.types] The buckets configuration.
 * @property {string} [params.prefix] Prefix keys in Redis.
 * @property {type} [params.configOverride] Bucket configuration override
 */

/**
* @typedef {Object} type
* @property {number} [per_interval] The number of tokens to add per interval.
* @property {number} [interval] The length of the interval in milliseconds.
* @property {number} [size] The maximum number of tokens in the bucket.
* @property {number} [per_second] The number of tokens to add per second. Equivalent to "interval: 1000, per_interval: x".
* @property {number} [per_minute] The number of tokens to add per minute. Equivalent to "interval: 60000, per_interval: x".
* @property {number} [per_hour] The number of tokens to add per hour. Equivalent to "interval: 3600000, per_interval: x".
* @property {number} [per_day] The number of tokens to add per day. Equivalent to "interval: 86400000, per_interval: x".
* @property {number} [unlimited] the maximum number of tokens in the bucket. equivalent to "size: x".
* @property {number} [skip_n_calls] the number of calls to skip. equivalent to "size: x".
* @property {ElevatedLimitParams} [elevated_limits] The elevated limit configuration.
*/

/**
 * @typedef TakeParams
 * @property {string} type The name of the bucket type.
 * @property {string} key The key of the bucket instance.
 * @property {number} [count=1] The number of tokens to take from the bucket.
 * @property {type} configOverride Externally provided bucket configuration
*/

/**
 * @typedef TakeResult
 * @property {boolean} conformant Returns true if there is enough capacity in the bucket and the tokens has been removed.
 * @property {number} remaining The number of tokens remaining in the bucket.
 * @property {number} reset A unix timestamp indicating when the bucket is going to be full.
 * @property {number} limit The size of the bucket.
 */
/**

 * @typedef WaitParams
 * @property {string} type The name of the bucket type.
 * @property {string} key The key of the bucket instance.
 * @property {number} [count=1] The number of tokens to wait for.
 * @property {type} configOverride Externally provided bucket configruation
 */

/**
 * @typedef WaitResult
 * @property {number} remaining The number of tokens remaining in the bucket.
 * @property {number} reset A unix timestamp indicating when the bucket is going to be full.
 * @property {number} limit The size of the bucket.
 */

/**
 * @typedef PutParams
 * @property {string} type The name of the bucket type.
 * @property {string} key The key of the bucket instance.
 * @property {number} [count=SIZE] The number of tokens to put in the bucket. Defaults to the size of the bucket.
 * @property {type} configOverride Externally provided bucket configruation
 */
 
/**
 * @typedef PutResult
 * @property {number} remaining The number of tokens remaining in the bucket.
 * @property {number} reset A unix timestamp indicating when the bucket is going to be full.
 * @property {number} limit The size of the bucket.
 */

/**
 * @typedef GetParams
 * @property {string} type The name of the bucket type.
 * @property {string} key The key of the bucket instance.
 * @property {type} configOverride Externally provided bucket configuration
 */

/**
 * @typedef GetResult
 * @property {number} remaining The number of tokens remaining in the bucket.
 * @property {number} reset A unix timestamp indicating when the bucket is going to be full.
 * @property {number} limit The size of the bucket.
 */

/**
 * @typedef {Object} TakeElevatedParams
 * @property {string} type - The name of the bucket type.
 * @property {string} key - The key of the bucket instance.
 * @property {number} [count=1] - The number of tokens to take from the bucket.
 * @property {ElevatedLimitParams} [elevated_limits] - (Optional) The elevated limit configuration.
 * @property {type} configOverride Externally provided bucket configuration
 */

/**
 * @typedef {Object} ElevatedLimitParams
 * @property {string} erl_is_active_key - The key to check if the elevated limits are active.
 * @property {string} erl_quota_key - The key to store the quota for the elevated limits.
 * @property {number} erl_activation_period_seconds - The activation period for the elevated limits in seconds.
 * // temporal options
 * @property {number} [per_interval] The number of tokens to add per interval.
 * @property {number} [interval] The length of the interval in milliseconds.
 * @property {number} [size] The maximum number of tokens in the bucket.
 * @property {number} [per_second] The number of tokens to add per second. Equivalent to "interval: 1000, per_interval: x".
 * @property {number} [per_minute] The number of tokens to add per minute. Equivalent to "interval: 60000, per_interval: x".
 * @property {number} [per_hour] The number of tokens to add per hour. Equivalent to "interval: 3600000, per_interval: x".
 * @property {number} [per_day] The number of tokens to add per day. Equivalent to "interval: 86400000, per_interval: x".
 * @property {number} [unlimited] The maximum number of tokens in the bucket. Equivalent to "size: x".
 */

/**
 * @typedef {Object} TakeElevatedResult
 * @property {boolean} conformant - Returns true if there is enough capacity in the bucket and the tokens has been removed.
 * @property {number} remaining - The number of tokens remaining in the bucket.
 * @property {number} reset - A unix timestamp indicating when the bucket is going to be full.
 * @property {number} limit - The size of the bucket.
 * @property {boolean} delayed - Indicates if the operation was delayed.
 * @property {Elevated_result} elevated_limits - The elevated limit result
 */

/**
 * @typedef {Object} Elevated_result
 * @property {boolean} erl_configured_for_bucket - Indicates if the bucket is configured for elevated limits.
 * @property {boolean} triggered - Indicates if the elevated limits were triggered.
 * @property {boolean} activated - Indicates if the elevated limits were activated.
 * @property {number} quota_remaining - The remaining quota for elevated limits.
 * @property {number} quota_allocated - The allocated quota for elevated limits.
 * @property {number} erl_activation_period_seconds - The activation period for elevated limits in seconds.
 */

// --- Internal Types ---

/**
 * @typedef {Object} NormalizedType -- the internal representation of a bucket
 * @property {number} [per_interval] The number of tokens to add per interval.
 * @property {number} [interval] The length of the interval in milliseconds.
 * @property {number} [size] The maximum number of tokens in the bucket.
 * @property {number} [ttl] The time to live for the bucket in seconds.
 * @property {number} [ms_per_interval] The number of milliseconds per interval.
 * @property {number} [drip_interval] The interval for the drip in milliseconds.
 * @property {number} [unlimited] the maximum number of tokens in the bucket. equivalent to "size: x".
 * @property {number} [skip_n_calls] the number of calls to skip. equivalent to "size: x".
 * @property {NormalizedType} [elevated_limits] The elevated limit configuration.
 * @property {boolean} [erl_configured_for_bucket] Indicates if the bucket is configured for elevated limits.
 */

/**
 * @typedef {Object} ElevatedLimitConfiguration
 * @property {string} erl_is_active_key - The key to check if the elevated limits are active.
 * @property {string} erl_quota_key - The key to store the quota for the elevated limits.
 * @property {number} erl_activation_period_seconds - The activation period for the elevated limits in seconds.
 * @property {number} erl_quota - The quota for the elevated limits.
 * @property {string} erl_quota_interval - The interval for the quota.
 */
