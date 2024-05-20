const cbControl = require('./cb');
const utils = require('./utils');
const EventEmitter = require('events').EventEmitter;

const PING_SUCCESS = 'successful';
const PING_ERROR = 'error';
const PING_RECONNECT = 'reconnect';
const PING_RECONNECT_DRY_RUN = 'reconnect-dry-run';

const DEFAULT_PING_INTERVAL = 3000; // Milliseconds

class DBPing extends EventEmitter {
  constructor(config, redis) {
    super();

    this.redis = redis;
    this.config = {
      commandTimeout: 125,
      enabled: config ? true : false,
      interval: config?.interval || DEFAULT_PING_INTERVAL,
      maxFailedAttempts: config?.maxFailedAttempts || 5,
      reconnectIfFailed:
        utils.functionOrFalse(config?.reconnectIfFailed) || (() => false),
    };

    this.failedPings = 0;

    this.#start();
  }

  #start() {
    const doPing = () => {
      if (!this.config.enabled) {
        return;
      }

      let start = Date.now();
      this.redis.ping(cbControl((err) => {
        let duration = Date.now() - start;
        err
          ? this.#pingKO(triggerLoop, err, duration)
          : this.#pingOK(triggerLoop, duration);
      }).timeout(this.config.commandTimeout));
    };

    const triggerLoop = () => setTimeout(doPing, this.config.interval);

    doPing();
  }

  stop() {
    this.enabled = false;
  }

  #pingOK(callback, duration) {
    this.reconnecting = false;
    this.failedPings = 0;
    this.#emitPingResult(PING_SUCCESS, undefined, duration, 0);
    callback();
  }

  #pingKO(callback, err, duration) {
    this.failedPings++;
    this.#emitPingResult(PING_ERROR, err, duration, this.failedPings);

    if (this.failedPings < this.config.maxFailedAttempts) {
      return callback();
    }

    if (!this.config.reconnectIfFailed()) {
      return this.#emitPingResult(
        PING_RECONNECT_DRY_RUN,
        undefined,
        0,
        this.failedPings
      );
    }

    this.#retryStrategy(() => {
      this.#emitPingResult(PING_RECONNECT, undefined, 0, this.failedPings);
      this.redis.disconnect(true);
    });
  }

  #emitPingResult(status, err, duration, failedPings) {
    const result = {
      status: status,
      duration: duration,
      error: err,
      failedPings: failedPings,
    };
    this.emit('ping', result);
  }

  #retryStrategy(callback) {
    //jitter between 0% and 10% of the total wait time needed to reconnect
    //i.e. if interval = 100 and maxFailedAttempts = 3 => it'll randomly jitter between 0 and 30 ms
    const deviation =
      utils.randomBetween(0, 0.1) *
      this.config.interval *
      this.config.maxFailedAttempts;
    setTimeout(callback, deviation);
  }
}

module.exports = DBPing;
