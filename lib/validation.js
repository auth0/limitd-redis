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
  if (!params) {
    return new LimitdRedisValidationError('elevatedLimits object is required for elevated limits', { code: 107 });
  }

  // redis' way of knowing whether erl is active or not
  if (typeof params.erlIsActiveKey !== 'string') {
    return new LimitdRedisValidationError('erlIsActiveKey is required for elevated limits', { code: 108 });
  }

  return validateERLQuota(params);
}

function validateERLQuota(params) {
  if (typeof params.erlQuotaKey !== 'string') {
    return new LimitdRedisValidationError('erlQuotaKey is required for elevated limits', { code: 110 });
  }

  if (!containsERLQuotaInterval(params)) {
    return new LimitdRedisValidationError('corresponding per_interval is required for elevated limits', { code: 111 });
  }
}

function containsERLQuotaInterval(params) {
  const interval = Object.keys(params)
    .find(key => ERL_QUOTA_INTERVALS_SHORTCUTS.indexOf(key) > -1);

  return interval !== undefined;
}

function validateConfigIsForElevatedBucket(key, bucketKeyConfig) {
  if (!isConfigForElevatedBucket(bucketKeyConfig)) {
    return new LimitdRedisValidationError(`Attempted to takeElevated() for a bucket with no elevated config. bucket:${key}, bucketKeyConfig:${JSON.stringify(bucketKeyConfig)}`,
      { code: 109 });
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
