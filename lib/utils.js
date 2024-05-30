const ms = require('ms');
const _ = require('lodash');
const LRU = require('lru-cache');

const INTERVAL_TO_MS = {
  'per_second': ms('1s'),
  'per_minute': ms('1m'),
  'per_hour': ms('1h'),
  'per_day': ms('1d')
};

const INTERVAL_SHORTCUTS = Object.keys(INTERVAL_TO_MS);

const ERL_QUOTA_INTERVAL_PER_CALENDAR_MONTH = 'quota_per_calendar_month';
const ERL_QUOTA_INTERVALS = {
  [ERL_QUOTA_INTERVAL_PER_CALENDAR_MONTH]: () => endOfMonthTimestamp()
};
const ERL_QUOTA_INTERVALS_SHORTCUTS = Object.keys(ERL_QUOTA_INTERVALS);

function normalizeTemporals(params) {
  const type = _.pick(params, [
    'per_interval',
    'interval',
    'size',
    'unlimited',
    'skip_n_calls'
  ]);

  INTERVAL_SHORTCUTS.forEach(intervalShortcut => {
    if (!params[intervalShortcut]) {
      return;
    }
    type.interval = INTERVAL_TO_MS[intervalShortcut];
    type.per_interval = params[intervalShortcut];
  });

  if (typeof type.size === 'undefined') {
    type.size = type.per_interval;
  }

  if (type.per_interval) {
    type.ttl = ((type.size * type.interval) / type.per_interval) / 1000;
    type.ms_per_interval = type.per_interval / type.interval;
    type.drip_interval = type.interval / type.per_interval;
  }

  if (params.elevated_limits) {
    type.elevated_limits = normalizeElevatedTemporals(params.elevated_limits);
  }

  return type;
}

function normalizeElevatedTemporals(params) {
  let type = normalizeTemporals(params);

  if (typeof type.size !== 'undefined' && typeof type.per_interval !== 'undefined') {
    type.erl_configured_for_bucket = true;
  }

  return type;
}

function normalizeType(params) {
  const type = normalizeTemporals(params);

  type.overridesMatch = {};
  type.overrides = _.reduce(params.overrides || params.override, (result, overrideDef, name) => {
    const override = normalizeTemporals(overrideDef);
    override.name = name;
    if (overrideDef.until && !(overrideDef.until instanceof Date)) {
      overrideDef.until = new Date(overrideDef.until);
    }
    override.until = overrideDef.until;
    if (overrideDef.match) {
      // TODO: Allow more flags
      override.match = new RegExp(overrideDef.match, 'i');
    }

    normalizeElevatedOverrides(type, override);

    if (!override.until || override.until >= new Date()) {
      if (override.match) {
        type.overridesMatch[name] = override;
      } else {
        result[name] = override;
      }
    }

    return result;
  }, {});

  if (Object.keys(type.overridesMatch).length > 0) {
    type.overridesCache = new LRU({ max: 50 });
  }

  return type;
}

function normalizeElevatedOverrides(type, override) {
  // If the override doesn't provide elevated_limits use the ones defined in the upper level (if any)
  if (!override.elevated_limits) {
    override.elevated_limits = type.elevated_limits;
    return;
  }

  // If size, per_interval, and unlimited are undefined for the override, and it contains elevated_limits,
  // copy the size, per_interval, and unlimited from the base type configuration.
  if (typeof override.unlimited === 'undefined'
    && typeof override.size === 'undefined'
    && typeof override.per_interval === 'undefined') {
      let { overrides, overridesMatch, ...baseType } = type;
      Object.assign(override, baseType, {elevated_limits: override.elevated_limits})
  }
}

/**
 * Load the buckets configuration.
 *
 * @param {Object.<string, type>} bucketsConfig The buckets configuration.
 * @memberof LimitDB
 */
function buildBuckets(bucketsConfig) {
  return _.reduce(bucketsConfig, (result, bucket, name) => {
    result[name] = normalizeType(bucket);
    return result;
  }, {});
}

function buildBucket(bucket) {
  return normalizeType(bucket);
}

function functionOrFalse(fun) {
  return !!(fun && fun.constructor && fun.call && fun.apply)
    ? fun
    : false;
}

function randomBetween(min, max) {
  if (min > max) {
    let tmp = max;
    max = min;
    min = tmp;
  }
  return Math.random() * (max - min) + min;
}

function getERLParams(params) {
  const type = _.pick(params, [
    'erl_is_active_key',
    'erl_quota_key',
    'erl_activation_period_seconds',
  ]);

  // extract erl quota information
  ERL_QUOTA_INTERVALS_SHORTCUTS.forEach(intervalShortcut => {
    if (!(intervalShortcut in params)) {
      return;
    }
    type.erl_quota = params[intervalShortcut];
    type.erl_quota_interval = intervalShortcut;
  });
  return type;
}

function calculateQuotaExpiration(params) {
  return ERL_QUOTA_INTERVALS[params.erl_quota_interval]();
}

function endOfMonthTimestamp() {
  const curDate = new Date();
  return Date.UTC(curDate.getUTCFullYear(), curDate.getUTCMonth() + 1, 1, 0, 0, 0, 0);
}

function resolveElevatedParams(erlParams, bucketKeyConfig) {
  // provide default values for elevated_limits unless the bucketKeyConfig has them
  return {
    ms_per_interval: bucketKeyConfig.ms_per_interval,
    size: bucketKeyConfig.size,
    erl_activation_period_seconds: 0,
    erl_quota: 0,
    erl_quota_interval: 'quota_per_calendar_month',
    erl_is_active_key: 'defaultActiveKey',
    erl_quota_key: 'defaultQuotaKey',
    ...erlParams,
    ...bucketKeyConfig.elevated_limits,
    erl_configured_for_bucket: !!(erlParams && bucketKeyConfig.elevated_limits?.erl_configured_for_bucket),
  };
}

class LimitdRedisConfigurationError extends Error {
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

module.exports = {
  buildBuckets,
  buildBucket,
  INTERVAL_SHORTCUTS,
  ERL_QUOTA_INTERVALS_SHORTCUTS,
  normalizeTemporals,
  normalizeType,
  functionOrFalse,
  randomBetween,
  getERLParams,
  endOfMonthTimestamp,
  calculateQuotaExpiration,
  resolveElevatedParams
};
