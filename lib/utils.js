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

function normalizeTemporals(params) {
  const type = _.pick(params, [
    'per_interval',
    'interval',
    'size',
    'unlimited',
    'fixed_window'
  ]);

  INTERVAL_SHORTCUTS.forEach(intervalShortcut => {
    if (!params[intervalShortcut]) { return; }
    type.interval = INTERVAL_TO_MS[intervalShortcut];
    type.per_interval = params[intervalShortcut];
  });

  if (typeof type.size === 'undefined') {
    type.size = type.per_interval;
  }

  if (type.per_interval) {
    type.ttl = ((type.size * type.interval) / type.per_interval) / 1000;
  }

  return type;
}

function normalizeType(params) {
  const type = normalizeTemporals(params);

  type.overrides = _.map(params.overrides || params.override || {}, (overrideDef, name) => {
    const override = normalizeType(overrideDef);
    override.name = name;
    if (overrideDef.until && !(overrideDef.until instanceof Date)) {
      overrideDef.until = new Date(overrideDef.until);
    }
    override.until = overrideDef.until;
    if (overrideDef.match) {
      // TODO: Allow more flags
      override.match = new RegExp(overrideDef.match, 'i');
    }

    return override;
  }).filter(o => !o.until || o.until >= new Date());

  if (type.overrides) {
    type.overridesCache = new LRU({ max: 50 });
  }

  return type;
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

module.exports = {
  buildBuckets,
  buildBucket,
  INTERVAL_SHORTCUTS,
  normalizeTemporals,
  normalizeType
};
