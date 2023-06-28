const ms = require('ms');
const fs = require('fs');
const _ = require('lodash');
const async = require('async');
const utils = require('./utils');
const Redis = require('ioredis');
const EventEmitter = require('events').EventEmitter;
const { validateParams } = require('./validation');

const TAKE_LUA = fs.readFileSync(`${__dirname}/take.lua`, 'utf8');
const PUT_LUA = fs.readFileSync(`${__dirname}/put.lua`, 'utf8');

const PING_SUCCESS = "successful"
const PING_ERROR = "error"
const PING_RECONNECT = "reconnect"
const PING_RECONNECT_DRY_RUN = "reconnect-dry-run"

class LimitDBRedis extends EventEmitter {
  static get PING_SUCCESS () { return PING_SUCCESS };
  static get PING_ERROR () { return PING_ERROR };
  static get PING_RECONNECT () { return PING_RECONNECT };
  static get PING_RECONNECT_DRY_RUN () { return PING_RECONNECT_DRY_RUN };

  /**
   * Creates an instance of LimitDB client for Redis.
   * @param {params} params - The configuration for the database and client.
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

    const redisOptions = {
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

    this.pingConfig = {
      enabled: config.ping ? true : false,
      interval: config.ping?.interval || 1000,
      maxFailedAttempts: config.ping?.maxFailedAttempts || 5,
      reconnectIfFailed: utils.functionOrFalse(config.ping?.reconnectIfFailed) || (() => false),
      maxFailedAttemptsToRetryReconnect: config.ping?.maxFailedAttemptsToRetryReconnect || 10
    }

    this.redis = null;
    if (config.nodes) {
      this.redis = new Redis.Cluster(config.nodes, clusterOptions);
    } else {
      this.redis = new Redis(config.uri, redisOptions);
      this.#setupPing();
    }

    this.redis.defineCommand('take', {
      numberOfKeys: 1,
      lua: TAKE_LUA
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

  #setupPing() {
    if (!this.pingConfig.enabled) {
      return;
    }
    this.failedPings = 0;
    this.redis.on('ready', () => this.#startPing())
  }

  #startPing() {
    this.#stopPing();
    
    const doPing = (pingTaskId) => {
      if (pingTaskId !== this.pingTaskId) {
        return;
      }
      
      let start = Date.now();
      this.redis.ping((err) => {
        let duration = Date.now()-start;
        let callback = () => triggerLoop(pingTaskId);
        err ? this.#pingKO(callback, err, duration) : this.#pingOK(callback, duration);
      });
    }

    const triggerLoop = (pingTaskId) => 
      this.pingTimeoutId = setTimeout(() => doPing(pingTaskId), this.pingConfig.interval)

    doPing(this.pingTaskId);
  }

  #pingOK(callback, duration) {
    this.reconnecting = false
    this.failedPings = 0;
    this.#emitPingResult(PING_SUCCESS, undefined, duration, 0)
    callback();
  }

  #pingKO(callback, err, duration) {
    this.failedPings++;
    this.#emitPingResult(PING_ERROR, err, duration, this.failedPings)

    if (this.failedPings < this.pingConfig.maxFailedAttempts) {
      return callback();
    }

    if(!this.pingConfig.reconnectIfFailed() ) {
      return this.#emitPingResult(PING_RECONNECT_DRY_RUN, undefined, 0, this.failedPings)
    }

    this.#retryStrategy(() => {
      this.#emitPingResult(PING_RECONNECT, undefined, 0, this.failedPings)
      this.redis.disconnect(true);
    })
  }

  #emitPingResult(status, err, duration, failedPings) {
    const result = {
      status: status,
      duration: duration,
      error: err,
      failedPings: failedPings
    };
    this.emit('ping', result);
  }

  #retryStrategy(callback) {
    //jitter between 0% and 10% of the total wait time needed to reconnect
    //i.e. if interval = 100 and maxFailedAttempts = 3 => it'll randomly jitter between 0 and 30 ms
    const deviation = utils.randomBetween(0, 0.1) * this.pingConfig.interval * this.pingConfig.maxFailedAttempts
    setTimeout(callback, deviation)
  }

  #stopPing() {
    if (this.pingTimeoutId) {
      clearTimeout(this.pingTimeoutId);
    }
    this.pingTaskId = crypto.randomUUID();
  }

  close(callback) {
    this.#stopPing();
    this.redis.removeAllListeners()
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
   * @param {string} type
   * @param {object} params
   * @returns
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

  calculateReset(bucketKeyConfig, remaining, now) {
    if (!bucketKeyConfig.per_interval) {
      return 0;
    }

    now = now || Date.now();
    const missing = bucketKeyConfig.size - remaining;
    const msToCompletion = Math.ceil(missing * bucketKeyConfig.interval / bucketKeyConfig.per_interval);
    return Math.ceil((now + msToCompletion) / 1000);
  }


  /**
   * Take N elements from a bucket if available.
   *
   * @param {takeParams} params - The params for take.
   * @param {function(Error, takeResult)} callback.
   */
  take(params, callback) {
    const valError = validateParams(params, this.buckets);
    if (valError) {
      return process.nextTick(callback, valError);
    }

    const bucket = this.buckets[params.type];
    const bucketKeyConfig = this.bucketKeyConfig(bucket, params);

    const count = this._determineCount({
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
        delayed: false
      });
    }

    this.redis.take(`${params.type}:${params.key}`,
      bucketKeyConfig.per_interval / bucketKeyConfig.interval || 0,
      bucketKeyConfig.size,
      count,
      Math.floor(bucketKeyConfig.ttl || this.globalTTL),
      (err, results) => {
        if (err) {
          return callback(err);
        }

        const remaining = parseInt(results[0], 10);
        return callback(null, {
          conformant: parseInt(results[1], 10) ? true : false,
          remaining,
          reset: this.calculateReset(bucketKeyConfig, remaining, parseInt(results[2], 10)),
          limit: bucketKeyConfig.size,
          delayed: false
        });
      });
  }

  /**
   * Take N elements from a bucket if available otherwise wait for them.
   * The callback is called when the number of request tokens is available.
   *
   * @param {waitParams} params - The params for take.
   * @param {function(Error, waitResult)} callback.
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
   * @param {putParams} params - The params for take.
   * @param {function(Error, putResult)} [callback].
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
      Math.floor(bucketKeyConfig.ttl || this.globalTTL),
      (err, results) => {
        if (err) {
          return callback(err);
        }

        const remaining = parseInt(results[0], 10);
        return callback(null, {
          remaining: remaining,
          reset: this.calculateReset(bucketKeyConfig, remaining, parseInt(results[1], 10)),
          limit: bucketKeyConfig.size
        });
      });
  }

  /**
   * Get elements in the bucket.
   *
   * @param {getParams} params - The params for take.
   * @param {function(Error, getResult)} [callback].
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

/**
 * And now some typedefs for you:
 *
 * @typedef {Object} type
 * @property {integer} [per_interval] The number of tokens to add per interval.
 * @property {integer} [interval] The length of the interval in milliseconds.
 * @property {integer} [size] The maximum number of tokens in the bucket.
 * @property {integer} [per_second] The number of tokens to add per second. Equivalent to "interval: 1000, per_interval: x".
 * @property {integer} [per_minute] The number of tokens to add per minute. Equivalent to "interval: 60000, per_interval: x".
 * @property {integer} [per_hour] The number of tokens to add per hour. Equivalent to "interval: 3600000, per_interval: x".
 * @property {integer} [per_day] The number of tokens to add per day. Equivalent to "interval: 86400000, per_interval: x".
 *
 * @typedef {Object} params
 * uri nodes buckets prefix
 * @property {string} [params.uri] Address of Redis.
 * @property {Object.<string, object>} [params.nodes] Redis Cluster Configuration https://github.com/luin/ioredis#cluster".
 * @property {Object.<string, type>} [params.types] The buckets configuration.
 * @property {string} [params.prefix] Prefix keys in Redis.
 * @property {type} [params.configOverride] Bucket configuration override
 *
 * @typedef takeParams
 * @property {string} type The name of the bucket type.
 * @property {string} key The key of the bucket instance.
 * @property {integer} [count=1] The number of tokens to take from the bucket.
 * @property {type} configOverride Externally provided bucket configruation
 *
 * @typedef takeResult
 * @property {boolean} conformant Returns true if there is enough capacity in the bucket and the tokens has been removed.
 * @property {integer} remaining The number of tokens remaining in the bucket.
 * @property {integer} reset A unix timestamp indicating when the bucket is going to be full.
 * @property {integer} limit The size of the bucket.
 *
 * @typedef waitParams
 * @property {string} type The name of the bucket type.
 * @property {string} key The key of the bucket instance.
 * @property {integer} [count=1] The number of tokens to wait for.
 * @property {type} configOverride Externally provided bucket configruation
 *
 * @typedef waitResult
 * @property {integer} remaining The number of tokens remaining in the bucket.
 * @property {integer} reset A unix timestamp indicating when the bucket is going to be full.
 * @property {integer} limit The size of the bucket.
 *
 * @typedef putParams
 * @property {string} type The name of the bucket type.
 * @property {string} key The key of the bucket instance.
 * @property {integer} [count=SIZE] The number of tokens to put in the bucket. Defaults to the size of the bucket.
 * @property {type} configOverride Externally provided bucket configruation
 *
 * @typedef putResult
 * @property {integer} remaining The number of tokens remaining in the bucket.
 * @property {integer} reset A unix timestamp indicating when the bucket is going to be full.
 * @property {integer} limit The size of the bucket.
 *
 * @typedef getParams
 * @property {string} type The name of the bucket type.
 * @property {string} key The key of the bucket instance.
 * @property {type} configOverride Externally provided bucket configruation
 *
 * @typedef getResult
 * @property {integer} remaining The number of tokens remaining in the bucket.
 * @property {integer} reset A unix timestamp indicating when the bucket is going to be full.
 * @property {integer} limit The size of the bucket.
*/
