/* eslint-env node, mocha */
const ms       = require('ms');
const async    = require('async');
const _        = require('lodash');
const LimitDB  = require('../lib/db');
const assert   = require('chai').assert;

const buckets = {
  ip: {
    size: 10,
    per_second: 5,
    overrides: {
      '127.0.0.1': {
        per_second: 100
      },
      'local-lan': {
        match: '192\\.168\\.',
        per_second: 50
      },
      '10.0.0.123': {
        until: new Date(Date.now() - ms('24h') - ms('1m')), //yesterday
        per_second: 50
      },
      '10.0.0.124': {
        until: Date.now() - ms('24h') - ms('1m'), //yesterday
        per_second: 50
      },
      '10.0.0.1': {
        size: 1,
        per_hour: 2
      },
      '0.0.0.0': {
        size: 100,
        unlimited: true
      },
      '8.8.8.8': {
        size: 10
      }
    }
  },
  user: {
    size: 1,
    per_second: 5,
    overrides: {
      'regexp': {
        match: '^regexp',
        size: 10
      }
    }
  }
};

describe('LimitDBRedis', () => {
  let db;

  beforeEach(function(done) {
    db = new LimitDB({ uri: 'localhost', buckets, prefix: 'tests:' });
    db.once('error', done);
    db.once('ready', () => {
      db.resetAll(done);
    });
  });

  afterEach(function(done) {
    db.close((err) => {
      // Can't close DB if it was never open
      if (err && err.message.indexOf('enableOfflineQueue') > 0) {
        err = undefined;
      }
      done(err);
    });
  });

  describe('#constructor', () => {
    it('should throw an when missing redis information', () => {
      assert.throws(() => new LimitDB({}), /Redis connection information must be specified/);
    });
    it('should throw an when missing bucket configuration', () => {
      assert.throws(() => new LimitDB({ uri: 'localhost:test' }), /Buckets must be specified for Limitd/);
    });
    it('should emit error on failure to connect to redis', (done) => {
      let called = false;
      db = new LimitDB({ uri: 'localhost:test', buckets: {} });
      db.on('error', () => {
        if (!called) {
          called = true;
          return done();
        }
      });
    });
  });

  describe('#validateParms', () => {
    it('should fail when params are not provided', () => {
      const err = db.validateParams();
      assert.match(err.message, /params are required/);
    });

    it('should fail when type is not provided', () => {
      const err = db.validateParams({});
      assert.match(err.message, /type is required/);
    });

    it('should fail when type is not defined', () => {
      const err = db.validateParams({ type: 'cc' });
      assert.match(err.message, /undefined bucket type cc/);
    });

    it('should fail when key is not provided', () => {
      const err = db.validateParams({ type: 'ip' }, 'key');
      assert.match(err.message, /key is required/);
    });

    it('should fail when prefix is not provided', () => {
      const err = db.validateParams({ type: 'ip' }, 'prefix');
      assert.match(err.message, /prefix is required/);
    });
  });

  describe('#configurateBucketKey', () => {
    it('should add new bucket to existing configuration', () => {
      db.configurateBucket('test', { size: 5 });
      assert.containsAllKeys(db.buckets, ['ip', 'test']);
    });

    it('should replace configuration of existing type',  () => {
      db.configurateBucket('ip', { size: 1 });
      assert.equal(db.buckets.ip.size, 1);
      assert.equal(db.buckets.ip.overrides.length, 0);
    });
  });

  describe('TAKE', () => {
    it('should fail on validation', (done) => {
      db.take({}, (err) => {
        assert.match(err.message, /type is required/);
        done();
      });
    });

    it('should keep track of a key', (done) => {
      const params = { type: 'ip',  key: '21.17.65.41'};
      db.take(params, (err) => {
        if (err) {
          return done(err);
        }
        db.take(params, (err, result) => {
          if (err) {
            return done(err);
          }
          assert.equal(result.conformant, true);
          assert.equal(result.remaining, 8);
          done();
        });
      });
    });

    it('should add a ttl to buckets', function (done) {
      const params = { type: 'ip', key: '211.45.66.1'};
      db.take(params, function (err) {
        if (err) {
          return done(err);
        }
        db.redis.ttl(`${params.type}:${params.key}`, (err, ttl) => {
          if (err) {
            return done(err);
          }
          assert.equal(db.buckets['ip'].ttl, ttl);
          done();
        });
      });
    });

    it('should return TRUE with right remaining and reset after filling up the bucket', (done) => {
      const now = Date.now();
      db.take({
        type: 'ip',
        key:  '5.5.5.5'
      }, (err) => {
        if (err) {
          return done(err);
        }
        db.put({
          type: 'ip',
          key:  '5.5.5.5',
        }, (err) => {
          if (err) {
            return done(err);
          }
          db.take({
            type: 'ip',
            key:  '5.5.5.5'
          }, function (err, result) {
            if (err) {
              return done(err);
            }

            assert.ok(result.conformant);
            assert.equal(result.remaining, 9);
            assert.closeTo(result.reset, now / 1000, 3);
            assert.equal(result.limit, 10);
            done();
          });
        });
      });
    });

    it('should return TRUE when traffic is conformant', (done) => {
      const now = Date.now();
      db.take({
        type: 'ip',
        key:  '1.1.1.1'
      }, function (err, result) {
        if (err) return done(err);
        assert.ok(result.conformant);
        assert.equal(result.remaining, 9);
        assert.closeTo(result.reset, now / 1000, 3);
        assert.equal(result.limit, 10);
        done();
      });
    });

    it('should return FALSE when requesting more than the size of the bucket', (done) => {
      const now = Date.now();
      db.take({
        type:  'ip',
        key:   '2.2.2.2',
        count: 12
      }, function (err, result) {
        if (err) return done(err);
        assert.notOk(result.conformant);
        assert.equal(result.remaining, 10);
        assert.closeTo(result.reset, now / 1000, 3);
        assert.equal(result.limit, 10);
        done();
      });
    });

    it('should return FALSE when traffic is not conformant', (done) => {
      const takeParams = {
        type:  'ip',
        key:   '3.3.3.3'
      };
      async.map(_.range(10), (i, done) => {
        db.take(takeParams, done);
      }, (err, responses) => {
        if (err) return done(err);
        assert.ok(responses.every(function (r) { return r.conformant; }));
        db.take(takeParams, (err, response) => {
          assert.notOk(response.conformant);
          assert.equal(response.remaining, 0);
          done();
        });
      });
    });

    it('should return TRUE if an override by name allows more', (done) => {
      const takeParams = {
        type:  'ip',
        key:   '127.0.0.1'
      };
      async.each(_.range(10), (i, done) => {
        db.take(takeParams, done);
      }, (err) => {
        if (err) return done(err);
        db.take(takeParams, function (err, result) {
          if (err) return done(err);
          assert.ok(result.conformant);
          assert.ok(result.remaining, 89);
          done();
        });
      });
    });

    it('should return TRUE if an override allows more', (done) => {
      const takeParams = {
        type:  'ip',
        key:   '192.168.0.1'
      };
      async.each(_.range(10), (i, done) => {
        db.take(takeParams, done);
      }, (err) => {
        if (err) return done(err);
        db.take(takeParams, function (err, result) {
          assert.ok(result.conformant);
          assert.ok(result.remaining, 39);
          done();
        });
      });
    });

    it('can expire an override', (done) => {
      const takeParams = {
        type: 'ip',
        key:  '10.0.0.123'
      };
      async.each(_.range(10), (i, cb) => {
        db.take(takeParams, cb);
      }, (err) => {
        if (err) {
          return done(err);
        }
        db.take(takeParams, (err, response) => {
          assert.notOk(response.conformant);
          done();
        });
      });
    });

    it('can parse a date and expire and override', (done) => {
      const takeParams = {
        type: 'ip',
        key:  '10.0.0.124'
      };
      async.each(_.range(10), (i, cb) => {
        db.take(takeParams, cb);
      }, (err) => {
        if (err) {
          return done(err);
        }
        db.take(takeParams, (err, response) => {
          assert.notOk(response.conformant);
          done();
        });
      });
    });

    it('should use seconds ceiling for next reset', (done) => {
      // it takes ~1790 msec to fill the bucket with this test
      const now = Date.now();
      const requests = _.range(9).map(() => {
        return cb => db.take({ type: 'ip', key: '211.123.12.36' }, cb);
      });
      async.series(requests, function (err, results) {
        if (err) return done(err);
        var lastResult = results[results.length -1];
        assert.ok(lastResult.conformant);
        assert.equal(lastResult.remaining, 1);
        assert.closeTo(lastResult.reset, now / 1000, 3);
        assert.equal(lastResult.limit, 10);
        done();
      });
    });

    it('should set reset to UNIX timestamp regardless of period', function(done){
      const now = Date.now();
      db.take({ type: 'ip', key: '10.0.0.1' }, (err, result) => {
        if (err) { return done(err); }
        assert.ok(result.conformant);
        assert.equal(result.remaining, 0);
        assert.closeTo(result.reset, now / 1000 + 1800, 1);
        assert.equal(result.limit, 1);
        done();
      });
    });

    it('should work for unlimited', (done) => {
      const now = Date.now();
      db.take({ type: 'ip', key: '0.0.0.0' }, (err, response) => {
        if (err) return done(err);
        assert.ok(response.conformant);
        assert.equal(response.remaining, 100);
        assert.closeTo(response.reset, now / 1000, 1);
        assert.equal(response.limit, 100);
        done();
      });
    });

    it('should work with a fixed bucket', (done) => {
      async.map(_.range(10), (i, done) => {
        db.take({ type: 'ip', key: '8.8.8.8' }, done);
      }, (err, results) => {
        if (err) return done(err);
        results.forEach((r, i) => {
          assert.equal(r.remaining + i + 1, 10);
        });
        assert.ok(results.every(r => r.conformant));
        db.take({ type: 'ip', key: '8.8.8.8' }, (err, response) => {
          assert.notOk(response.conformant);
          done();
        });
      });
    });

    it('should work with RegExp', (done) => {
      db.take({ type: 'user', key: 'regexp|test'}, (err, response) => {
        if (err) {
          return done(err);
        }
        assert.ok(response.conformant);
        assert.equal(response.remaining, 9);
        assert.equal(response.limit, 10);
        done();
      });
    });

    it('should return non-conformant-attempts stats', (done) => {
      async.waterfall([
        cb => async.map(_.range(10), (i, done) => {
          db.take({ type: 'ip', key: '8.8.8.8' }, done);
        }, cb),

        (results, cb) => {
          assert.ok(results.every(r => r.conformant));

          results.forEach((r, i) => {
            assert.equal(r.stats.nonConformantAttempts, 0);
          });

          cb();
        },

        cb => async.map(_.range(10), (i, done) => {
          db.take({ type: 'ip', key: '8.8.8.8' }, done);
        }, cb),

        (results, cb) => {
          results.forEach((r, i) => {
            assert.notOk(r.conformant);
            assert.equal(r.stats.nonConformantAttempts, i);
          });

          cb();
        },

        cb => db.put({ type: 'ip', key: '8.8.8.8', count: 1 }, (err) => done(err)),

        cb => db.take({ type: 'ip', key: '8.8.8.8' }, cb),

        (result, cb) => {
          assert.notOk(result.conformant);
          assert.equal(result.stats.nonConformantAttempts, 10);

          cb();
        }
      ], done);
    });
  });

  describe('PUT', function () {
    it('should fail on validation', (done) => {
      db.put({}, (err) => {
        assert.match(err.message, /type is required/);
        done();
      });
    });

    it('should add to the bucket', (done) => {
      db.take({ type: 'ip', key: '8.8.8.8', count: 5 }, (err) => {
        if (err) {
          return done(err);
        }

        db.put({ type: 'ip', key: '8.8.8.8', count: 4 }, (err, result) => {
          if (err) {
            return done(err);
          }
          assert.equal(result.remaining, 9);
          done();
        });
      });
    });

    it('should not override on unlimited buckets', (done) => {
      const bucketKey = { type: 'ip',  key: '0.0.0.0', count: 1000 };
      db.put(bucketKey, (err, result) => {
        if (err) {
          return done(err);
        }
        assert.equal(result.remaining, 100);
        done();
      });
    });

    it('should restore the bucket when reseting', (done) => {
      const bucketKey = { type: 'ip',  key: '211.123.12.12'};
      db.take(bucketKey, (err) => {
        if (err) return done(err);
        db.put(bucketKey, (err) => {
          if (err) return done(err);
          db.take(bucketKey, function (err, response) {
            if (err) return done(err);
            assert.equal(response.remaining, 9);
            done();
          });
        });
      });
    });

    it('should restore the bucket when reseting with all', (done) => {
      const takeParams = { type: 'ip',  key: '21.17.65.41', count: 9 };
      db.take(takeParams, (err) => {
        if (err) return done(err);
        db.put({ type: 'ip', key: '21.17.65.41', all: true }, (err) => {
          if (err) return done(err);
          db.take(takeParams, function (err, response) {
            if (err) return done(err);
            assert.equal(response.conformant, true);
            assert.equal(response.remaining, 1);
            done();
          });
        });
      });
    });

    it('should be able to reset without callback', (done) => {
      const bucketKey = { type: 'ip',  key: '211.123.12.12'};
      db.take(bucketKey, (err) => {
        if (err) return done(err);
        db.put(bucketKey);
        setImmediate(() => {
          db.take(bucketKey, function (err, response) {
            if (err) return done(err);
            assert.equal(response.remaining, 9);
            done();
          });
        });
      });
    });

    it('should work for a fixed bucket', (done) => {
      db.take({ type: 'ip', key: '8.8.8.8' }, (err, result) => {
        assert.ok(result.conformant);
        db.put({ type: 'ip', key: '8.8.8.8' }, (err, result) => {
          if (err) return done(err);
          assert.equal(result.remaining, 10);
          done();
        });
      });
    });

    it('should work with negative values', (done) => {
      db.put({ type: 'ip', key: '8.8.8.1', count: -100 }, (err) => {
        if (err) {
          return done(err);
        }
        db.take({ type: 'ip', key: '8.8.8.1' }, (err, result) => {
          if (err) {
            return done(err);
          }
          assert.equal(result.conformant, false);
          assert.closeTo(result.remaining, -99, 1);
          done();
        });
      });
    });
  });

  describe('GET', function () {
    it('should fail on validation', (done) => {
      db.get({}, (err) => {
        assert.match(err.message, /type is required/);
        done();
      });
    });

    it('should return the bucket default for remaining when key does not exist', (done) => {
      db.get({type: 'ip', key: '8.8.8.8'}, (err, result) => {
        if (err) {
          return done(err);
        }
        assert.equal(result.remaining, 10);
        done();
      });
    });


    it('should retrieve the bucket for an existing key', (done) => {
      db.take({ type: 'ip', key: '8.8.8.8', count: 1 }, (err) => {
        if (err) {
          return done(err);
        }
        db.get({type: 'ip', key: '8.8.8.8'}, (err, result) => {
          if (err) {
            return done(err);
          }
          assert.equal(result.remaining, 9);

          db.get({type: 'ip', key: '8.8.8.8'}, (err, result) => {
            if (err) {
              return done(err);
            }
            assert.equal(result.remaining, 9);
            done();
          });
        });
      });
    });

    it('should return the bucket for an unlimited key', (done) => {
      db.get({type: 'ip', key: '0.0.0.0'}, (err, result) => {
        if (err) {
          return done(err);
        }
        assert.equal(result.remaining, 100);

        db.take({ type: 'ip', key: '0.0.0.0', count: 1 }, (err) => {
          if (err) {
            return done(err);
          }
          db.get({type: 'ip', key: '0.0.0.0'}, (err, result) => {
            if (err) {
              return done(err);
            }
            assert.equal(result.remaining, 100);
            assert.equal(result.limit, 100);
            assert.exists(result.reset);
            done();
          });
        });
      });
    });
  });

  describe('WAIT', function () {
    it('should work with a simple request', (done) => {
      const now = Date.now();
      db.wait({ type: 'ip', key: '211.76.23.4' }, (err, response) => {
        if (err) return done(err);
        assert.ok(response.conformant);
        assert.notOk(response.delayed);
        assert.equal(response.remaining, 9);
        assert.closeTo(response.reset, now / 1000, 3);
        done();
      });
    });

    it('should be delayed when traffic is non conformant', function (done) {
      db.take({
        type: 'ip',
        key: '211.76.23.5',
        count: 10
      }, (err) => {
        if (err) return done(err);
        const waitingSince = Date.now();
        db.wait({
          type: 'ip',
          key: '211.76.23.5',
          count: 3
        }, function (err, response) {
          if (err) { return done(err); }
          var waited = Date.now() - waitingSince;
          assert.ok(response.conformant);
          assert.ok(response.delayed);
          assert.closeTo(waited, 600, 20);
          done();
        });
      });
    });
  });

  describe('#resetAll', function () {
    it('should reset all keys of all buckets', (done) => {
      async.parallel([
        // Empty those buckets...
        (cb) => db.take({ type: 'ip', key: '1.1.1.1', count: buckets.ip.size }, cb),
        (cb) => db.take({ type: 'ip', key: '2.2.2.2', count: buckets.ip.size }, cb),
        (cb) => db.take({ type: 'user', key: 'some_user', count: buckets.user.size }, cb)
      ], (err) => {
        if (err) {
          return done(err);
        }

        db.resetAll((err) => {
          if (err) {
            return done(err);
          }
          async.parallel([
            (cb) => db.take({ type: 'ip', key: '1.1.1.1' }, cb),
            (cb) => db.take({ type: 'ip', key: '2.2.2.2' }, cb),
            (cb) => db.take({ type: 'user', key: 'some_user' }, cb)
          ], (err, results) => {
            if (err) {
              return done(err);
            }

            assert.equal(results[0].remaining, buckets.ip.size - 1);
            assert.equal(results[0].conformant, true);
            assert.equal(results[1].remaining, buckets.ip.size - 1);
            assert.equal(results[0].conformant, true);
            assert.equal(results[2].remaining, buckets.user.size - 1);
            assert.equal(results[2].conformant, true);
            done();
          });
        });
      });
    });
  });
});
