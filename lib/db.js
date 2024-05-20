/// <reference path="types.js" />
const ms = require('ms');
const fs = require('fs');
const _ = require('lodash');
const async = require('async');
const LRU = require('lru-cache');
const utils = require('./utils');
const Redis = require('ioredis');
const { validateParams, validateERLParams } = require('./validation');
const DBPing = require("./db_ping");
const { calculateQuotaExpiration, resolveElevatedParams } = require('./utils');
const EventEmitter = require('events').EventEmitter;

const TAKE_LUA = fs.readFileSync(`${__dirname}/take.lua`, "utf8");
const TAKE_ELEVATED_LUA = fs.readFileSync(`${__dirname}/take_elevated.lua`, "utf8");
const PUT_LUA = fs.readFileSync(`${__dirname}/put.lua`, "utf8");

const PING_SUCCESS = "successful";
const PING_ERROR = "error";
const PING_RECONNECT = "reconnect";
const PING_RECONNECT_DRY_RUN = "reconnect-dry-run";

const DEFAULT_COMMAND_TIMEOUT = 125; // Milliseconds

class LimitDBRedis extends EventEmitter {
  static get PING_SUCCESS() {
    return PING_SUCCESS;
  }
  static get PING_ERROR() {
    return PING_ERROR;
  }
  static get PING_RECONNECT() {
    return PING_RECONNECT;
  }
  static get PING_RECONNECT_DRY_RUN() {
    return PING_RECONNECT_DRY_RUN;
  }

  /**
   * Creates an instance of LimitDB client for Redis.
   * @param {LimitDBParams} params - The configuration for the database and client.
   */
  constructor(config) {
    super();
    config = config || {};

    if (!config.nodes && !config.uri) {
      throw new Error('Redis connection information must be specified');
    }

    if (!config.buckets) {
      throw new Error('Buckets must be specified for Limitd');
    }

    this.configurateBuckets(config.buckets);
    this.prefix = config.prefix;
    this.globalTTL = (config.globalTTL || ms('7d')) / 1000;
    this.callCounts = new LRU({ max: 50 });

    const redisOptions = {
      // a low commandTimeout value would likely cause sharded clusters to fail `enableReadyCheck` due to it running `CLUSTER INFO`
      // which is a slow command. timeouts are being handled by the client#dispatch method.
      enableOfflineQueue: false,
      keyPrefix: config.prefix,
      password: config.password,
      tls: config.tls,
      reconnectOnError: (err) => {
        // will force a reconnect when error starts with `READONLY`
        // this code is only triggered when auto-failover is disabled
        // more: https://github.com/luin/ioredis#reconnect-on-error
        return err.message.includes('READONLY');
      },
    };

    const clusterOptions = {
      slotsRefreshTimeout: config.slotsRefreshTimeout || 3000,
      slotsRefreshInterval: config.slotsRefreshInterval || ms('5m'),
      keyPrefix: config.prefix,
      dnsLookup: config.dnsLookup,
      enableReadyCheck: true,
      redisOptions
    };

    this.redis = null;
    if (config.nodes) {
      this.redis = new Redis.Cluster(config.nodes, clusterOptions);
    } else {
      this.redis = new Redis(config.uri, redisOptions);
      this.#setupPing(config);
    }

    this.redis.defineCommand('take', {
      numberOfKeys: 1,
      lua: TAKE_LUA
    });

    this.redis.defineCommand('takeElevated', {
      numberOfKeys: 3,
      lua: TAKE_ELEVATED_LUA
    });

    this.redis.defineCommand('put', {
      numberOfKeys: 1,
      lua: PUT_LUA
    });

    this.redis.on('ready', () => {
      this.emit('ready');
    });

    this.redis.on('error', (err) => {
      this.emit('error', err);
    });

    this.redis.on('node error', (err, node) => {
      this.emit('node error', err, node);
    });

  }

  #setupPing(config) {
    this.redis.on("ready", () => this.#startPing(config));
    this.redis.on("close", () => this.#stopPing());
  }

  #startPing(config) {
    this.#stopPing();
    this.ping = new DBPing(config.ping, this.redis);
    this.ping.on("ping", (data) => this.emit("ping", data));
  }

  #stopPing() {
    this.ping?.stop();
    this.ping?.removeAllListeners();
  }

  close(callback) {
    this.#stopPing();
    this.redis.quit(callback);
  }

  configurateBuckets(buckets) {
    if (buckets) {
      this.buckets = utils.buildBuckets(buckets);
    }
  }

  configurateBucket(key, bucket) {
    this.buckets[key] = utils.buildBucket(bucket);
  }

  /**
   * @param {type & { overrides: Object?, overridesCache: Object?, overridesMatch: Object? }} type
   * @param {GetParams | PutParams | TakeParams | TakeElevatedParams} params
   * @returns {NormalizedType}
   */
  bucketKeyConfig(type, params) {
    if (typeof params.configOverride === 'object') {
      return utils.normalizeTemporals(params.configOverride);
    }

    const fromOverride = type.overrides[params.key];
    if (fromOverride) {
      return fromOverride;
    }

    const fromCache = type.overridesCache && type.overridesCache.get(params.key);
    if (fromCache) {
      return fromCache;
    }

    const fromMatch = _.find(type.overridesMatch, (o) => {
      return o.match.exec(params.key);
    });
    if (fromMatch) {
      type.overridesCache.set(params.key, fromMatch);
      return fromMatch;
    }

    return type;
  }

  // not super accurate given clock drift across redis and host
  calculateReset(bucketKeyConfig, remaining, now) {
    if (!bucketKeyConfig.per_interval) {
      return 0;
    }

    now = now || Date.now();
    const missing = bucketKeyConfig.size - remaining;
    const msToCompletion = Math.ceil(missing * bucketKeyConfig.drip_interval);
    return Math.ceil((now + msToCompletion) / 1000);
  }

  /**
   * Take N elements from a bucket if available.
   *
   * @param {TakeParams} params - The params for take.
   * @param {function(null, TakeResult) | function(Error)} callback
   * @param {function(key: string, bucketKeyConfig: NormalizedType, count: number)} takeFunc
   */
  _doTake(params, callback, takeFunc) {
    const valError = validateParams(params, this.buckets);
    if (valError) {
      return process.nextTick(callback, valError);
    }

    const bucket = this.buckets[params.type];
    const bucketKeyConfig = this.bucketKeyConfig(bucket, params);

    const key = `${params.type}:${params.key}`;

    let count = this._determineCount({
      paramsCount: params.count,
      defaultCount: 1,
      bucketKeyConfigSize: bucketKeyConfig.size,
    });

    if (bucketKeyConfig.unlimited) {
      return process.nextTick(callback, null, {
        conformant: true,
        remaining: bucketKeyConfig.size,
        reset: Math.ceil(Date.now() / 1000),
        limit: bucketKeyConfig.size,
        delayed: false,
      });
    }

    if (bucketKeyConfig.skip_n_calls > 0) {
      const prevCall = this.callCounts.get(key);

      if (prevCall) {
        const shouldGoToRedis = prevCall?.count >= bucketKeyConfig.skip_n_calls


        if (!shouldGoToRedis) {
          prevCall.count ++;
          return process.nextTick(callback, null, prevCall.res);
        }

        // if lastCall not exists it's the first time that we go to redis.
        // so we don't change count; subsequently calls take count should be
        // proportional to the number of call that we skip.
        // if count=3, and we go every 5 times, take should 15
        // This parameter is most likely 1, and doing times is an overkill but better safe than sorry.
        if (shouldGoToRedis) {
          // we need to account for the skipped calls + the current call
          count *= (bucketKeyConfig.skip_n_calls + 1);
        }
      }
    }

    takeFunc(key, bucketKeyConfig, count)
  }

  /**
   * Take N elements from a bucket if available.
   *
   * @param {TakeParams} params
   * @param {function(null, TakeResult) | function(Error)} callback
   */
  take(params, callback) {
    this._doTake(params, callback, (key, bucketKeyConfig, count) => {
      this.redis.take(key,
        bucketKeyConfig.ms_per_interval || 0,
        bucketKeyConfig.size,
        count,
        Math.ceil(bucketKeyConfig.ttl || this.globalTTL),
        bucketKeyConfig.drip_interval || 0,
        (err, results) => {
          if (err) {
            return callback(err);
          }
          const remaining = parseInt(results[0], 10);
          const conformant = parseInt(results[1], 10) ? true : false;
          const currentMS = parseInt(results[2], 10);
          const reset = parseInt(results[3], 10);
          const res = {
            conformant,
            remaining,
            reset: Math.ceil(reset / 1000),
            limit: bucketKeyConfig.size,
            delayed: false,
          };
          if (bucketKeyConfig.skip_n_calls > 0) {
            this.callCounts.set(key, { res, count: 0 });
          }
          return callback(null, res);
        });
    })
  }

  /**
   * Take N elements from a bucket if available, use elevated limits if configured.
   *
   * @param {TakeElevatedParams} params
   * @param {function(null, TakeElevatedResult) | function(Error)} callback
   */
  takeElevated(params, callback) {
    let erlParams;

    if (params.elevated_limits) {
      erlParams = utils.getERLParams(params.elevated_limits);
      const valError = validateERLParams(erlParams);
      if (valError) {
        return callback(valError)
      }
    }

    this._doTake(params, callback, (key, bucketKeyConfig, count) => {
      const elevated_limits = resolveElevatedParams(erlParams, bucketKeyConfig);
      const erl_quota_expiration = calculateQuotaExpiration(elevated_limits);
      this.redis.takeElevated(key, elevated_limits.erl_is_active_key, elevated_limits.erl_quota_key,
        bucketKeyConfig.ms_per_interval || 0,
        bucketKeyConfig.size,
        count,
        Math.ceil(bucketKeyConfig.ttl || this.globalTTL),
        bucketKeyConfig.drip_interval || 0,
        elevated_limits.ms_per_interval,
        elevated_limits.size,
        elevated_limits.erl_activation_period_seconds,
        elevated_limits.erl_quota,
        erl_quota_expiration,
        elevated_limits.erl_configured_for_bucket ? 1 : 0,
        (err, results) => {
          if (err) {
            return callback(err);
          }
          const remaining = parseInt(results[0], 10);
          const conformant = parseInt(results[1], 10) ? true : false;
          const currentMS = parseInt(results[2], 10);
          const reset = parseInt(results[3], 10);
          const erl_triggered = parseInt(results[4], 10) ? true : false;
          let erl_activate_for_bucket = parseInt(results[5], 10) ? true : false;
          // if the bucket is not configured for elevated limits, then it shouldn't be activated
          erl_activate_for_bucket = erl_activate_for_bucket && elevated_limits.erl_configured_for_bucket;
          const erl_quota_count = parseInt(results[6], 10);
          const res = {
            conformant,
            remaining,
            reset: Math.ceil(reset / 1000),
            limit: erl_activate_for_bucket ? elevated_limits.size : bucketKeyConfig.size,
            delayed: false,
            elevated_limits : {
              erl_configured_for_bucket: elevated_limits.erl_configured_for_bucket,
              triggered: erl_triggered,
              activated: erl_activate_for_bucket,
              quota_remaining: erl_quota_count,
              quota_allocated: elevated_limits.erl_quota,
              erl_activation_period_seconds: elevated_limits.erl_activation_period_seconds,
            },
          };
          if (bucketKeyConfig.skip_n_calls > 0) {
            this.callCounts.set(key, { res, count: 0 });
          }
          return callback(null, res);
        });
    })
  }

  /**
   * Take N elements from a bucket if available otherwise wait for them.
   * The callback is called when the number of request tokens is available.
   *
   * @param {WaitParams} params - The params for take.
   * @param {function(null, WaitResult) | function(Error)} callback
   */
  wait(params, callback) {
    this.take(params, (err, result) => {
      if (err || result.conformant) {
        return callback(err, result);
      }

      const bucket = this.buckets[params.type];
      const bucketKeyConfig = this.bucketKeyConfig(bucket, params);
      const count = params.count || 1;
      const required = count - result.remaining;
      const minWait = Math.ceil(required * bucketKeyConfig.interval / bucketKeyConfig.per_interval);

      return setTimeout(() => {
        this.wait(params, (err, result) => {
          if (err) {
            return callback(err);
          }
          result.delayed = true;
          callback(null, result);
        });
      }, minWait);
    });
  }

  /**
   * Put N elements in the bucket.
   *
   * @param {PutParams} params - The params for take.
   * @param {function(null, PutResult) | function(Error)} [callback]
   */
  put(params, callback) {
    callback = callback || _.noop;

    const valError = validateParams(params, this.buckets);
    if (valError) {
      return process.nextTick(callback, valError);
    }

    const bucket = this.buckets[params.type];
    const bucketKeyConfig = this.bucketKeyConfig(bucket, params);

    const count = Math.min(
      this._determineCount({
        paramsCount: params.count,
        defaultCount: bucketKeyConfig.size,
        bucketKeyConfigSize: bucketKeyConfig.size,
      }),
      bucketKeyConfig.size);

    if (bucketKeyConfig.unlimited) {
      return process.nextTick(callback, null, {
        remaining: bucketKeyConfig.size,
        reset: Math.ceil(Date.now() / 1000),
        limit: bucketKeyConfig.size
      });
    }

    const key = `${params.type}:${params.key}`;
    this.redis.put(key,
      count,
      bucketKeyConfig.size,
      Math.ceil(bucketKeyConfig.ttl || this.globalTTL),
      bucketKeyConfig.drip_interval || 0,
      (err, results) => {
        if (err) {
          return callback(err);
        }

        const remaining = parseInt(results[0], 10);
        return callback(null, {
          remaining: remaining,
          reset: Math.ceil(parseInt(results[3], 10) / 1000),
          limit: bucketKeyConfig.size
        });
      });
  }

  /**
   * Get elements in the bucket.
   *
   * @param {GetParams} params - The params for take.
   * @param {function(null, GetResult) | function(Error)} [callback]
   */
  get(params, callback) {
    callback = callback || _.noop;

    const valError = validateParams(params, this.buckets);
    if (valError) {
      return process.nextTick(callback, valError);
    }

    const bucket = this.buckets[params.type];
    const bucketKeyConfig = this.bucketKeyConfig(bucket, params);

    if (bucketKeyConfig.unlimited) {
      return process.nextTick(callback, null, {
        remaining: bucketKeyConfig.size,
        reset: Math.ceil(Date.now() / 1000),
        limit: bucketKeyConfig.size
      });
    }

    const key = `${params.type}:${params.key}`;
    this.redis.hmget(key, 'r', 'd',
      (err, results) => {
        if (err) {
          return callback(err);
        }

        let remaining = parseInt(results[0], 10);
        remaining = Number.isInteger(remaining) ? remaining : bucketKeyConfig.size;
        return callback(null, {
          remaining,
          reset: this.calculateReset(bucketKeyConfig, remaining, parseInt(results[1], 10)),
          limit: bucketKeyConfig.size
        });
      });
  }

  /**
   * Resets/re-fills all keys in all buckets.
   * @param {function(Error)} [callback].
   */
  resetAll(callback) {
    callback = callback || _.noop;

    const dbs = this.redis.nodes ? this.redis.nodes('master') : [this.redis];
    async.each(dbs, (db, cb) => {
      db.flushdb(cb);
    }, callback);
  }

  _determineCount({ paramsCount, defaultCount, bucketKeyConfigSize }) {
    if (paramsCount === 'all') {
      return bucketKeyConfigSize;
    }

    if (Number.isInteger(paramsCount)) {
      return paramsCount;
    }

    if (!paramsCount) {
      return defaultCount;
    }

    throw new Error('if provided, count must be \'all\' or an integer value');
  }
}


module.exports = LimitDBRedis;