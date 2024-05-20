/// <reference path="types.js" />
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

/**
 *
 * @param {Bucket} params
 * @returns {NormalizedType}
 */
function parseIntervals(params) {
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
  return type
}

/**
 *
 * @param {Bucket} params
 * @returns {NormalizedType}
 */
function normalizeTemporals(params) {
  const type = parseIntervals(params);

  if (params.elevated_limits) {
    const elevatedLimits = parseIntervals(params.elevated_limits);
    const isErlDefined = !_.isUndefined(elevatedLimits.size) && !_.isUndefined(elevatedLimits.per_interval);
    type.elevated_limits = {
      ...elevatedLimits,
      erl_configured_for_bucket: isErlDefined,
    };
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

    // If the override doesn't provide elevated_limits use the ones defined in the upper level (if any)
    if (!override.elevated_limits && type.elevated_limits) {
      override.elevated_limits = type.elevated_limits;
    }

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

/**
 * Load the buckets configuration.
 *
 * @param {Object.<string, Bucket>} bucketsConfig The buckets configuration.
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

/**
 * Extracts ERL configuration from the ERL parameters
 *
 * @param {ElevatedLimitParams} params The object to extract the ERL parameters from.
 * @returns {ElevatedLimitConfiguration} The extracted ERL parameters.
 */
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

/**
 * Resolves the elevated parameters by providing default values for elevated_limits unless they are defined in the bucketKeyConfig.
 *
 * @param {ElevatedLimitParams} erlParams - The ERL parameters to resolve.
 * @param {NormalizedType} bucketKeyConfig - The configuration of the bucket key.
 * @returns {NormalizedType & ElevatedLimitConfiguration} The resolved ERL parameters.
 */
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
