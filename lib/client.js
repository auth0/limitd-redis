const _ = require('lodash');
const retry = require('retry');
const cbControl = require('./cb');
const LimitDBRedis = require('./db');
const disyuntor = require('disyuntor');
const validation = require('./validation');
const EventEmitter = require('events').EventEmitter;

const ValidationError = validation.LimitdRedisValidationError;

const circuitBreakerDefaults = {
  timeout: '0.25s',
  maxFailures: 50,
  cooldown: '1s',
  maxCooldown: '3s',
  name: 'limitr',
  trigger: (err) => {
    return !(err instanceof ValidationError);
  }
};

const retryDefaults = {
  retries: 3,
  minTimeout: 10,
  maxTimeout: 30
};

class LimitdRedis extends EventEmitter {
  constructor(params) {
    super();

    this.db = new LimitDBRedis(_.pick(params, [
      'uri', 'nodes', 'buckets', 'prefix', 'slotsRefreshTimeout', 'slotsRefreshInterval',
      'username', 'password', 'tls', 'dnsLookup', 'globalTTL', 'cacheSize', 'keepAlive']));

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
    this.commandTimeout = params.commandTimeout || 75;

    this.dispatch = disyuntor.wrapCallbackApi(this.breakerOpts, this.dispatch.bind(this));
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

  takeElevated(type, key, opts, cb) {
    this.handler('takeElevated', type, key, opts, cb);
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
