/* eslint-env node, mocha */
const _ = require('lodash');
const assert = require('chai').assert;
const LimitRedis = require('../lib/client');
const ValidationError = LimitRedis.ValidationError;
const clusterNodes = [{ host: 'localhost', port: 16371 }, { host: 'localhost', port: 16372 }, { host: 'localhost', port: 16373 }];

const standaloneClientFn = (params) => {
  return new LimitRedis({ uri: 'localhost', buckets: {}, prefix: 'tests:', ..._.omit(params, ['nodes']) });
};
const clusteredClientFn = (params) => {
  return new LimitRedis({ nodes: clusterNodes, buckets: {}, prefix: 'tests:', ..._.omit(params, ['uri']) });
};
let clientCreator = standaloneClientFn;
let clusteredEnv = false;

if (process.env.CLUSTERED_ENV && process.env.CLUSTERED_ENV === "true") {
  clusteredEnv = true;
  clientCreator = clusteredClientFn;
}

describe("LimitdRedis", () => {
  let client;
  beforeEach((done) => {
    client = clientCreator();
    client.on('error', done);
    client.on('ready', done);
  });

  describe('#constructor', () => {
    if (!clusteredEnv) {
      it('should call error if db fails', (done) => {
        let called = false; // avoid uncaught
        client = clientCreator({ uri: 'localhost:fail', nodes: [{ host: 'fakehost', port: 6379 }] });
        client.on('error', () => {
          if (!called) {
            called = true;
            return done();
          }
        });
      });
    }

    it('should set up retry and circuitbreaker defaults', () => {
      assert.equal(client.retryOpts.retries, 3);
      assert.equal(client.retryOpts.minTimeout, 10);
      assert.equal(client.retryOpts.maxTimeout, 30);
      assert.equal(client.breakerOpts.timeout, '0.25s');
      assert.equal(client.breakerOpts.maxFailures, 50);
      assert.equal(client.breakerOpts.cooldown, '1s');
      assert.equal(client.breakerOpts.maxCooldown, '3s');
      assert.equal(client.breakerOpts.name, 'limitr');
      assert.equal(client.commandTimeout, 75);
    });

    it('should accept circuitbreaker parameters', () => {
      client = clientCreator({ circuitbreaker: { onTrip: () => {} } });
      assert.ok(client.breakerOpts.onTrip);
    });

    it('should accept retry parameters', () => {
      client = clientCreator({ retry: { retries: 5 } });
      assert.equal(client.retryOpts.retries, 5);
    });
  });

  describe('#handler', () => {
    it('should handle count & cb-less calls', (done) => {
      client.db.take = (params, cb) => {
        cb();
        done();
      };
      client.handler('take', 'test', 'test', 1);
    });
    it('should handle count-less & cb-less calls', (done) => {
      client.db.take = (params, cb) => {
        cb();
        done();
      };
      client.handler('take', 'test', 'test');
    });
    it('should handle count-less & cb calls', (done) => {
      client.db.take = (params, cb) => {
        cb();
      };
      client.handler('take', 'test', 'test', done);
    });
    it('should not retry or circuitbreak on ValidationError', (done) => {
      client = clientCreator({ circuitbreaker: { maxFailures: 3, onTrip: () => {} } });
      client.db.take = (params, cb) => {
        return cb(new ValidationError('invalid config'));
      };
      client.handler('take', 'invalid', 'test', _.noop);
      client.handler('take', 'invalid', 'test', _.noop);
      client.handler('take', 'invalid', 'test', _.noop);
      client.handler('take', 'invalid', 'test', _.noop);
      client.handler('take', 'invalid', 'test', _.noop);
      client.handler('take', 'invalid', 'test', _.noop);
      client.handler('take', 'invalid', 'test', (err) => {
        assert.notEqual(err.message, 'limitr: the circuit-breaker is open');
        assert.equal(err.message, 'invalid config');
        done();
      });
    });
    it('should retry on redis errors', (done) => {
      let calls = 0;
      client.db.take = (params, cb) => {
        if (calls === 0) {
          calls++;
          return cb(new Error());
        }
        return cb();
      };
      client.handler('take', 'test', 'test', done);
    });
    it('should retry on timeouts against redis', (done) => {
      let calls = 0;
      client.db.take = (params, cb) => {
        if (calls === 0) {
          calls++;
          return;
        }
        assert.equal(calls, 1);
        return cb();
      };
      client.handler('take', 'test', 'test', done);
    });
    it('should circuitbreak', (done) => {
      client = clientCreator({ circuitbreaker: { maxFailures: 3, onTrip: () => {} } });
      client.db.take = () => {};
      client.handler('take', 'test', 'test', _.noop);
      client.handler('take', 'test', 'test', _.noop);
      client.handler('take', 'test', 'test', _.noop);
      client.handler('take', 'test', 'test', _.noop);
      client.handler('take', 'test', 'test', _.noop);
      client.handler('take', 'test', 'test', () => {
        client.handler('take', 'test', 'test', (err) => {
          assert.equal(err.message, 'limitr: the circuit-breaker is open');
          done();
        });
      });
    });
  });

  describe('#take', () => {
    it('should call #handle with take as the method', (done) => {
      client.handler = (method, type, key, count, cb) => {
        assert.equal(method, 'take');
        cb();
      };
      client.take('test', 'test', 1, done);
    });
  });

  describe('#takeElevated', () => {
    it('should call #handle with takeElevated as the method', (done) => {
      const elevated_limits = { erl_is_active_key: 'erlKEY', erl_quota_key: 'quotaKEY' };
      client.handler = (method, type, key, opts, cb) => {
        assert.equal(method, 'takeElevated');
        assert.isNotNull(opts.elevated_limits);
        assert.equal(opts.elevated_limits.erl_is_active_key, elevated_limits.erl_is_active_key);
        assert.equal(opts.elevated_limits.erl_quota_key, elevated_limits.erl_quota_key);
        cb();
      };
      client.takeElevated('test', 'test', { elevated_limits: elevated_limits }, done);
    });
  });

  describe('#wait', () => {
    it('should call #handle with take as the method', (done) => {
      client.handler = (method, type, key, count, cb) => {
        assert.equal(method, 'wait');
        cb();
      };
      client.wait('test', 'test', 1, done);
    });
  });

  describe('#put', () => {
    it('should call #handle with take as the method', (done) => {
      client.handler = (method, type, key, count, cb) => {
        assert.equal(method, 'put');
        cb();
      };
      client.put('test', 'test', 1, done);
    });
  });

  describe('#get', () => {
    it('should call #handle with get as the method', (done) => {
      client.handler = (method, type, key, cb) => {
        assert.equal(method, 'get');
        cb();
      };
      client.get('test', 'test', done);
    });
  });

  describe('#reset', () => {
    it('should call #put', (done) => {
      client.put = (type, key, count, cb) => {
        cb();
      };
      client.reset('test', 'test', 1, done);
    });
  });

  describe('#resetAll', () => {
    it('should call db.resetAll', (done) => {
      client.db.resetAll = (cb) => cb();
      client.resetAll(done);
    });
  });

  describe('#close', () => {
    it('should call db.close', (done) => {
      client.db.close = (cb) => cb();
      client.close((err) => {
        assert.equal(client.db.listenerCount('error'), 0);
        assert.equal(client.db.listenerCount('ready'), 0);
        done(err);
      });
    });
  });
}, 'LimitdRedis');
