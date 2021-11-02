/* eslint-env node, mocha */
const _ = require('lodash');
const assert = require('chai').assert;
const Redis = require('ioredis');
const LimitRedis = require('../lib/client');
const ValidationError = LimitRedis.ValidationError;

describe('LimitdRedis', () => {
  let client;
  beforeEach((done) => {
    client = new LimitRedis({ uri: 'localhost', buckets: {}, prefix: 'tests:' });
    client.on('error', done);
    client.on('ready', done);
  });

  describe('#constructor', () => {
    it('should call error if db fails', (done) => {
      let called = false; // avoid uncaught
      client = new LimitRedis({ uri: 'localhost:fail', buckets: {} });
      client.on('error', () => {
        if (!called) {
          called = true;
          return done();
        }
      });
    });

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
      client = new LimitRedis({ uri: 'localhost', buckets: {}, circuitbreaker: { onTrip: () => {} } });
      assert.ok(client.breakerOpts.onTrip);
    });

    it('should accept retry parameters', () => {
      client = new LimitRedis({ uri: 'localhost', buckets: {}, retry: { retries: 5 } });
      assert.equa;(client.retryOpts.retries, 5);
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
      client = new LimitRedis({ uri: 'localhost', buckets: {}, circuitbreaker: { maxFailures: 3, onTrip: () => {} } });
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
      client = new LimitRedis({ uri: 'localhost', buckets: {}, circuitbreaker: { maxFailures: 3, onTrip: () => {} } });
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

  describe('#getClient', () => {
    it('should be instanceof Redis', () => {
      assert.instanceOf(client.getClient(), Redis);
    });
  });
});
