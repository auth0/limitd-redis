const { INTERVAL_SHORTCUTS } = require('./utils');

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
    return new LimitdRedisValidationError('elevated_limits object is required for elevated limits', { code: 107 });
  }

  // redis' way of knowing whether erl is active or not
  if (typeof params.erl_is_active_key !== 'string') {
    return new LimitdRedisValidationError('erl_is_active_key is required for elevated limits', { code: 108 });
  }

  if (typeof params.erl_quota_key !== 'string') {
    return new LimitdRedisValidationError('erl_quota_key is required for elevated limits', { code: 110 });
  }
}

module.exports = {
  validateParams,
  validateERLParams,
  LimitdRedisValidationError,
};
