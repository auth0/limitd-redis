const { INTERVAL_SHORTCUTS, ERL_QUOTA_INTERVALS_SHORTCUTS } = require('./utils');

class LimitdRedisValidationError extends Error {
  constructor(msg, extra) {
    super();
    this.name = this.constructor.name;
    this.message = msg;
    Error.captureStackTrace(this, this.constructor);
    if (extra) {
      this.extra = extra;
    }
  }
}

function validateParams(params, buckets) {
  if (typeof params !== 'object') {
    return new LimitdRedisValidationError('params are required', { code: 101 });
  }

  if (typeof params.type !== 'string') {
    return new LimitdRedisValidationError('type is required', { code: 102 });
  }

  if (typeof buckets[params.type] === 'undefined') {
    return new LimitdRedisValidationError(`undefined bucket type ${params.type}`, { code: 103 });
  }

  if (typeof params.key !== 'string') {
    return new LimitdRedisValidationError('key is required', { code: 104 });
  }

  if (typeof params.configOverride !== 'undefined') {
    try {
      validateOverride(params.configOverride);
    } catch (error) {
      return error;
    }
  }
}

function validateOverride(configOverride) {
  if (typeof configOverride !== 'object') {
    throw new LimitdRedisValidationError('configuration overrides must be an object', { code: 105 });
  }

  // If size is provided, nothing more is strictly required
  // (as in the case of static bucket configurations)
  if (typeof configOverride.size === 'number') {
    return;
  }

  const interval = Object.keys(configOverride)
    .find(key => INTERVAL_SHORTCUTS.indexOf(key) > -1);

  // If size is not provided, we *must* have a interval specified
  if (typeof interval === 'undefined') {
    throw new LimitdRedisValidationError('configuration overrides must provide either a size or interval', { code: 106 });
  }
}

function validateERLParams(params) {
  // redis' way of knowing whether erl is active or not
  if (typeof params.erlIsActiveKey !== 'string')  {
    return new LimitdRedisValidationError('erlIsActiveKey is required for elevated limits', { code: 107 });
  }

  return validateERLQuota(params.erlQuota)
}

function validateERLQuota(quota) {
  if (typeof quota === 'undefined')  {
    return new LimitdRedisValidationError('erlQuota is required for elevated limits', { code: 109 });
  }

  if (typeof quota.key !== 'string')  {
    return new LimitdRedisValidationError('erlQuota.key is required for elevated limits', { code: 110 });
  }

  if (!containsERLQuotaInterval(quota))  {
    return new LimitdRedisValidationError('corresponding erlQuota.per_interval is required for elevated limits', { code: 111 });
  }
}

function containsERLQuotaInterval(quota) {
  const interval = Object.keys(quota)
    .find(key => ERL_QUOTA_INTERVALS_SHORTCUTS.indexOf(key) > -1)

  return interval !== undefined
}

function validateConfigIsForElevatedBucket(key, bucketKeyConfig) {
  if (!isConfigForElevatedBucket(bucketKeyConfig)) {
    return new LimitdRedisValidationError(`Attempted to takeElevated() for a bucket with no elevated config. bucket:${key}, bucketKeyConfig:${JSON.stringify(bucketKeyConfig)}`,
      { code: 108 });
  }
}

function isConfigForElevatedBucket(bucketKeyConfig) {
  return bucketKeyConfig.elevated_limits
    && bucketKeyConfig.elevated_limits.size
    && bucketKeyConfig.elevated_limits.per_interval
    && bucketKeyConfig.elevated_limits.erl_activation_period_seconds;

}

module.exports = {
  validateParams,
  validateERLParams,
  validateConfigIsForElevatedBucket,
  LimitdRedisValidationError,
};
