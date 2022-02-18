const _ = require('lodash');
const agent = require('@a0/instrumentation');
const retry = require('retry');
const cbControl = require('cb');
const validation = require('./validation');
const LimitDBRedis = require('./db');
const disyuntor = require('disyuntor');
const EventEmitter = require('events').EventEmitter;

const ValidationError = validation.LimitdRedisValidationError;

const circuitBreakerDefaults = {
  timeout: '0.15s',
  maxFailures: 10,
  cooldown: '1s',
  maxCooldown: '3s',
  name: 'limitr',
  trigger: (err) => {
    return !(err instanceof ValidationError);
  },
  onTrip: (err, failures) => {
    this.emit('limitd_redis_primary_store_circuit_breaker_open');
    agent.metrics.increment('limitd_redis.client.circuit_breaker_open', 1, { store: 'primary' });
    agent.logger.warn({
      log_type: 'limitd_redis_primary_store_circuit_breaker_open',
      err,
      tags: { associated_service: 'limitd_redis' },
    }, `An error occurred while reading from primary store after ${failures} attempts.`);
  }
};

const retryDefaults = {
  retries: 1,
  minTimeout: 10,
  maxTimeout: 30
};

class LimitdRedis extends EventEmitter {
  constructor(params) {
    super();

    this.db = new LimitDBRedis(_.pick(params, ['uri', 'nodes', 'buckets', 'prefix', 'slotsRefreshTimeout', 'slotsRefreshInterval', 'password', 'tls', 'dnsLookup', 'globalTTL']));

    this.db.on('error', (err) => {
      this.emit('error', err);
    });

    this.db.on('ready', () => {
      this.emit('ready');
    });

    this.db.on('node error', (err, node) => {
      this.emit('node error', err, node);
    });

    this.breakerOpts = _.merge(circuitBreakerDefaults, params.circuitbreaker);
    this.retryOpts = _.merge(retryDefaults, params.retry);
    // ioredis is implementing this configuration, when it's stable we can switch to it
    this.commandTimeout = params.commandTimeout || 75;

    this.dispatch = disyuntor(this.dispatch.bind(this), this.breakerOpts);
  }

  static buildParams(type, key, opts, cb) {
    const params = { type, key };
    const optsType = typeof opts;

    // handle lack of opts and/or cb
    if (cb == null) {
      if (optsType === 'function') {
        cb = opts;
        opts = undefined;
      } else {
        cb = _.noop;
      }
    }

    if (optsType === 'number' || opts === 'all') {
      params.count = opts;
    }

    if (optsType === 'object') {
      _.assign(params, opts);
    }

    return [params, cb];
  }

  handler(method, type, key, opts, cb) {
    let [params, callback] = LimitdRedis.buildParams(type, key, opts, cb);
    this.dispatch(method, params, callback);
  }

  dispatch(method, params, cb) {
    const operation = retry.operation(this.retryOpts);
    operation.attempt((attempts) => {
      this.db[method](params, cbControl((err, results) => {
        if (err instanceof ValidationError) {
          return cb(err, null, { attempts });
        }

        if (operation.retry(err)) {
          return;
        }

        return cb(err ? operation.mainError() : null, results, { attempts });
      }).timeout(this.commandTimeout));
    });
  }

  take(type, key, opts, cb) {
    this.handler('take', type, key, opts, cb);
  }

  wait(type, key, opts, cb) {
    this.handler('wait', type, key, opts, cb);
  }

  get(type, key, opts, cb) {
    this.handler('get', type, key, opts, cb);
  }

  put(type, key, opts, cb) {
    this.handler('put', type, key, opts, cb);
  }

  reset(type, key, opts, cb) {
    this.put(type, key, opts, cb);
  }

  resetAll(cb) {
    this.db.resetAll(cb);
  }

  close(callback) {
    this.db.close((err) => {
      this.db.removeAllListeners();
      callback(err);
    });
  }
}

module.exports = LimitdRedis;
module.exports.ValidationError = ValidationError;
