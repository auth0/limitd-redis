/* eslint-env node, mocha */
const ms = require('ms');
const async = require('async');
const _ = require('lodash');
const LimitDB = require('../lib/db');
const assert = require('chai').assert;
const { Toxiproxy, Toxic } = require('toxiproxy-node-client');
const crypto = require('crypto');
const { endOfMonthTimestamp } = require('../lib/utils');

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
      },
      '9.8.7.6': {
        size: 200,
      },
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
  },
  tenant: {
    size: 1,
    per_second: 1
  },
  global: {
    size: 3,
    per_hour: 2,
    overrides: {
      skipit: {
        skip_n_calls: 2,
        size: 3,
        per_hour: 3
      },
      skipOneSize10: {
        skip_n_calls: 1,
        size: 10,
        per_hour: 0
      },
      skipOneSize3: {
        skip_n_calls: 1,
        size: 3,
        per_hour: 0
      }
    }
  },
};

const elevatedBuckets = {
  ip: {
    ...buckets.ip,
    elevated_limits: {
      size: buckets.ip.size,
      per_minute: buckets.ip.per_second,
      erl_activation_period_seconds: 900,
      quota_per_calendar_month: 192,
    },
  },
  user: {
    ...buckets.user,
    elevated_limits: {
      size: buckets.user.size,
      per_minute: buckets.user.per_second,
      erl_activation_period_seconds: 900,
      quota_per_calendar_month: 192,
    },
  },
  global: {
    ...buckets.global,
    elevated_limits: {
      size: buckets.global.size,
      per_minute: buckets.global.per_hour,
      erl_activation_period_seconds: 900,
      quota_per_calendar_month: 192,
    },
  },
  tenant: {
    ...buckets.tenant,
    elevated_limits: {
      size: buckets.tenant.size,
      per_minute: buckets.tenant.per_second,
      erl_activation_period_seconds: 900,
      quota_per_calendar_month: 192,
    },
  },
};

describe('LimitDBRedis', () => {
  let db;

  beforeEach((done) => {
    db = new LimitDB({ uri: 'localhost', buckets, prefix: 'tests:' });
    db.once('error', done);
    db.once('ready', () => {
      db.resetAll(done);
    });
  });

  afterEach((done) => {
    db.close((err) => {
      // Can't close DB if it was never open
      if (err?.message.indexOf('enableOfflineQueue') > 0) {
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

  describe('#configurateBucketKey', () => {
    it('should add new bucket to existing configuration', () => {
      db.configurateBucket('test', { size: 5 });
      assert.containsAllKeys(db.buckets, ['ip', 'test']);
    });

    it('should replace configuration of existing type', () => {
      db.configurateBucket('ip', { size: 1 });
      assert.equal(db.buckets.ip.size, 1);
      assert.equal(Object.keys(db.buckets.ip.overrides).length, 0);
    });
  });

  describe('TAKE', () => {
    const testsParams = [
      {
        name: 'regular take',
        init: () => db.configurateBuckets(buckets),
        take: (params, callback) => db.take(params, callback),
        params: {}
      },
      {
        name: 'elevated take with no elevated configuration',
        init: () => db.configurateBuckets(buckets),
        take: (params, callback) => db.takeElevated(params, callback),
        params: {
          elevated_limits: {
            erl_is_active_key: 'some_erl_active_identifier',
            erl_quota_key: 'erlquotakey',
          }
        }
      },
      {
        name: 'elevated take',
        init: () => db.configurateBuckets(elevatedBuckets),
        take: (params, callback) => db.takeElevated(params, callback),
        params: {
          elevated_limits: {
            erl_is_active_key: 'some_erl_active_identifier',
            erl_quota_key: 'erlquotakey',
          }
        }
      }
    ];

    testsParams.forEach(testParams => {
      describe(`${testParams.name}`, () => {
        it(`should fail on validation`, (done) => {
          testParams.init();
          testParams.take({ ...testParams.params }, (err) => {
            assert.match(err.message, /type is required/);
            done();
          });
        });

        it(`should keep track of a key`, (done) => {
          testParams.init();
          const params = { ...testParams.params, type: 'ip', key: '21.17.65.41' };
          testParams.take(params, (err) => {
            if (err) {
              return done(err);
            }
            testParams.take(params, (err, result) => {
              if (err) {
                return done(err);
              }
              assert.equal(result.conformant, true);
              assert.equal(result.limit, 10);
              assert.equal(result.remaining, 8);
              done();
            });
          });
        });

        it(`should add a ttl to buckets`, (done) => {
          testParams.init();
          const params = { ...testParams.params, type: 'ip', key: '211.45.66.1' };
          testParams.take(params, (err) => {
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

        it(`should return TRUE with right remaining and reset after filling up the bucket`, (done) => {
          testParams.init();
          const now = Date.now();
          testParams.take({
            ...testParams.params,
            type: 'ip',
            key: '5.5.5.5'
          }, (err) => {
            if (err) {
              return done(err);
            }
            db.put({
              type: 'ip',
              key: '5.5.5.5',
            }, (err) => {
              if (err) {
                return done(err);
              }
              testParams.take({
                ...testParams.params,
                type: 'ip',
                key: '5.5.5.5'
              }, (err, result) => {
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

        it(`should return TRUE when traffic is conformant`, (done) => {
          testParams.init();
          const now = Date.now();
          testParams.take({
            ...testParams.params,
            type: 'ip',
            key: '1.1.1.1'
          }, (err, result) => {
            if (err) return done(err);
            assert.ok(result.conformant);
            assert.equal(result.remaining, 9);
            assert.closeTo(result.reset, now / 1000, 3);
            assert.equal(result.limit, 10);
            done();
          });
        });

        it(`should return FALSE when requesting more than the size of the bucket`, (done) => {
          testParams.init();
          const now = Date.now();
          testParams.take({
            ...testParams.params,
            type: 'ip',
            key: '2.2.2.2',
            count: 12
          }, (err, result) => {
            if (err) return done(err);
            assert.notOk(result.conformant);
            assert.equal(result.remaining, 10);
            assert.closeTo(result.reset, now / 1000, 3);
            assert.equal(result.limit, 10);
            done();
          });
        });

        it(`should return FALSE when traffic is not conformant`, (done) => {
          testParams.init();
          const takeParams = {
            ...testParams.params,
            type: 'ip',
            key: '3.3.3.3'
          };
          async.map(_.range(10), (i, done) => {
            testParams.take(takeParams, done);
          }, (err, responses) => {
            if (err) return done(err);
            assert.ok(responses.every((r) => {
              return r.conformant;
            }));
            testParams.take(takeParams, (err, response) => {
              assert.notOk(response.conformant);
              assert.equal(response.limit, 10);
              assert.equal(response.remaining, 0);
              done();
            });
          });
        });

        it(`should return TRUE if an override by name allows more`, (done) => {
          testParams.init();
          const takeParams = {
            ...testParams.params,
            type: 'ip',
            key: '127.0.0.1'
          };
          async.each(_.range(10), (i, done) => {
            testParams.take(takeParams, done);
          }, (err) => {
            if (err) return done(err);
            testParams.take(takeParams, (err, result) => {
              if (err) return done(err);
              assert.ok(result.conformant);
              assert.ok(result.remaining, 89);
              assert.equal(result.limit, 100);
              done();
            });
          });
        });

        it(`should return TRUE if an override allows more`, (done) => {
          testParams.init();
          const takeParams = {
            ...testParams.params,
            type: 'ip',
            key: '192.168.0.1'
          };
          async.each(_.range(10), (i, done) => {
            testParams.take(takeParams, done);
          }, (err) => {
            if (err) return done(err);
            testParams.take(takeParams, (err, result) => {
              assert.ok(result.conformant);
              assert.ok(result.remaining, 39);
              assert.equal(result.limit, 50);
              done();
            });
          });
        });

        it(`can expire an override`, (done) => {
          testParams.init();
          const takeParams = {
            ...testParams.params,
            type: 'ip',
            key: '10.0.0.123'
          };
          async.each(_.range(10), (i, cb) => {
            testParams.take(takeParams, cb);
          }, (err) => {
            if (err) {
              return done(err);
            }
            testParams.take(takeParams, (err, response) => {
              assert.notOk(response.conformant);
              done();
            });
          });
        });

        it(`can parse a date and expire and override`, (done) => {
          testParams.init();
          const takeParams = {
            ...testParams.params,
            type: 'ip',
            key: '10.0.0.124'
          };
          async.each(_.range(10), (i, cb) => {
            testParams.take(takeParams, cb);
          }, (err) => {
            if (err) {
              return done(err);
            }
            testParams.take(takeParams, (err, response) => {
              assert.notOk(response.conformant);
              done();
            });
          });
        });

        it(`should use seconds ceiling for next reset`, (done) => {
          testParams.init();
          // it takes ~1790 msec to fill the bucket with this test
          const now = Date.now();
          const requests = _.range(9).map(() => {
            return cb => testParams.take({ ...testParams.params, type: 'ip', key: '211.123.12.36' }, cb);
          });
          async.series(requests, (err, results) => {
            if (err) return done(err);
            const lastResult = results[results.length - 1];
            assert.ok(lastResult.conformant);
            assert.equal(lastResult.remaining, 1);
            assert.closeTo(lastResult.reset, now / 1000, 3);
            assert.equal(lastResult.limit, 10);
            done();
          });
        });

        it(`should set reset to UNIX timestamp regardless of period`, (done) => {
          testParams.init();
          const now = Date.now();
          testParams.take({ ...testParams.params, type: 'ip', key: '10.0.0.1' }, (err, result) => {
            if (err) {
              return done(err);
            }
            assert.ok(result.conformant);
            assert.equal(result.remaining, 0);
            assert.closeTo(result.reset, now / 1000 + 1800, 1);
            assert.equal(result.limit, 1);
            done();
          });
        });

        it(`should not reduce tokens for unlimited`, (done) => {
          testParams.init();
          const now = Date.now();
          testParams.take({ ...testParams.params, type: 'ip', key: '0.0.0.0' }, (err, response) => {
            if (err) return done(err);
            assert.ok(response.conformant);
            assert.equal(response.limit, 100);
            assert.equal(response.remaining, 100);
            assert.closeTo(response.reset, now / 1000, 1);
            done();
          });
        });

        it(`should work with a fixed bucket`, (done) => {
          testParams.init();
          async.map(_.range(10), (i, done) => {
            testParams.take({ ...testParams.params, type: 'ip', key: '8.8.8.8' }, done);
          }, (err, results) => {
            if (err) return done(err);
            results.forEach((r, i) => {
              assert.equal(r.remaining + i + 1, 10);
            });
            assert.ok(results.every(r => r.conformant));
            testParams.take({ ...testParams.params, type: 'ip', key: '8.8.8.8' }, (err, response) => {
              assert.notOk(response.conformant);
              done();
            });
          });
        });

        it(`should work with RegExp`, (done) => {
          testParams.init();
          testParams.take({ ...testParams.params, type: 'user', key: 'regexp|test' }, (err, response) => {
            if (err) {
              return done(err);
            }
            assert.ok(response.conformant);
            assert.equal(response.remaining, 9);
            assert.equal(response.limit, 10);
            done();
          });
        });

        it(`should work with "all"`, (done) => {
          testParams.init();
          testParams.take({ ...testParams.params, type: 'user', key: 'regexp|test', count: 'all' }, (err, response) => {
            if (err) {
              return done(err);
            }
            assert.ok(response.conformant);
            assert.equal(response.remaining, 0);
            assert.equal(response.limit, 10);
            done();
          });
        });

        it(`should work with count=0`, (done) => {
          testParams.init();
          testParams.take({ ...testParams.params, type: 'ip', key: '9.8.7.6', count: 0 }, (err, response) => {
            if (err) {
              return done(err);
            }
            assert.ok(response.conformant);
            assert.equal(response.remaining, 200);
            assert.equal(response.limit, 200);
            done();
          });
        });

        [
          '0',
          0.5,
          'ALL',
          true,
          1n,
          {},
        ].forEach((count) => {
          it(`should not work for non-integer count=${count}`, (done) => {
            testParams.init();
            const opts = {
              ...testParams.params,
              type: 'ip',
              key: '9.8.7.6',
              count,
            };

            assert.throws(() => testParams.take(opts, () => {
            }), /if provided, count must be 'all' or an integer value/);
            done();
          });
        });

        it(`should call redis and not set local cache count`, (done) => {
          testParams.init();
          const params = { ...testParams.params, type: 'global', key: 'aTenant' };
          testParams.take(params, (err) => {
            if (err) {
              return done(err);
            }

            assert.equal(db.callCounts['global:aTenant'], undefined);
            done();
          });
        });

        describe(`${testParams.name} skip calls`, () => {
          it('should skip calls', (done) => {
            testParams.init();
            const params = { ...testParams.params, type: 'global', key: 'skipit' };

            async.series([
              (cb) => testParams.take(params, cb), // redis
              (cb) => testParams.take(params, cb), // cache
              (cb) => testParams.take(params, cb), // cache
              (cb) => {
                assert.equal(db.callCounts.get('global:skipit').count, 2);
                cb();
              },
              (cb) => testParams.take(params, cb), // redis
              (cb) => testParams.take(params, cb), // cache
              (cb) => testParams.take(params, cb), // cache
              (cb) => testParams.take(params, cb), // redis (first nonconformant)
              (cb) => testParams.take(params, cb), // cache (first cached)
              (cb) => {
                assert.equal(db.callCounts.get('global:skipit').count, 1);
                assert.notOk(db.callCounts.get('global:skipit').res.conformant);
                cb();
              },
            ], (err, _results) => {
              if (err) {
                return done(err);
              }

              done();
            });
          });

          it('should take correct number of tokens for skipped calls with single count', (done) => {
            testParams.init();
            const params = { ...testParams.params, type: 'global', key: 'skipOneSize3' };

            // size = 3
            // skip_n_calls = 1
            // no refill
            async.series([
              (cb) => db.get(params, (_, { remaining }) => {
                assert.equal(remaining, 3);
                cb();
              }),

              // call 1 - redis
              // takes 1 token
              (cb) => testParams.take(params, (_, { remaining, conformant }) => {
                assert.equal(remaining, 2);
                assert.ok(conformant);
                cb();
              }),

              // call 2 - skipped
              (cb) => testParams.take(params, (_, { remaining, conformant }) => {
                assert.equal(remaining, 2);
                assert.ok(conformant);
                cb();
              }),

              // call 3 - redis
              // takes 2 tokens here, 1 for current call and one for previously skipped call
              (cb) => testParams.take(params, (_, { remaining, conformant }) => {
                assert.equal(remaining, 0);
                assert.ok(conformant);
                cb();
              }),

              // call 4 - skipped
              // Note: this is the margin of error introduced by skip_n_calls. Without skip_n_calls, this call would be
              // non-conformant.
              (cb) => testParams.take(params, (_, { remaining, conformant }) => {
                assert.equal(remaining, 0);
                assert.ok(conformant);
                cb();
              }),

              // call 5 - redis
              (cb) => testParams.take(params, (_, { remaining, conformant }) => {
                assert.equal(remaining, 0);
                assert.notOk(conformant);
                cb();
              }),
            ], (err, _results) => {
              if (err) {
                return done(err);
              }
              done();
            });
          });

          it('should take correct number of tokens for skipped calls with multi count', (done) => {
            testParams.init();
            const params = { ...testParams.params, type: 'global', key: 'skipOneSize10', count: 2 };

            // size = 10
            // skip_n_calls = 1
            // no refill
            async.series([
              (cb) => db.get(params, (_, { remaining }) => {
                assert.equal(remaining, 10);
                cb();
              }),

              // call 1 - redis
              // takes 2 tokens
              (cb) => testParams.take(params, (_, { remaining, conformant }) => {
                assert.equal(remaining, 8);
                assert.ok(conformant);
                cb();
              }),

              // call 2 - skipped
              (cb) => testParams.take(params, (_, { remaining, conformant }) => {
                assert.equal(remaining, 8);
                assert.ok(conformant);
                cb();
              }),

              // call 3 - redis
              // takes 4 tokens here, 2 for current call and 2 for previously skipped call
              (cb) => testParams.take(params, (_, { remaining, conformant }) => {
                assert.equal(remaining, 4);
                assert.ok(conformant);
                cb();
              }),
            ], (err, _results) => {
              if (err) {
                return done(err);
              }
              done();
            });
          });
        });
      });
    });

    it('should use size config override when provided', (done) => {
      const configOverride = { size: 7 };
      db.take({ type: 'ip', key: '7.7.7.7', configOverride }, (err, response) => {
        if (err) {
          return done(err);
        }
        assert.ok(response.conformant);
        assert.equal(response.remaining, 6);
        assert.equal(response.limit, 7);
        done();
      });
    });

    it('should use per interval config override when provided', (done) => {
      const oneDayInMs = ms('24h');
      const configOverride = { per_day: 1 };
      db.take({ type: 'ip', key: '7.7.7.8', configOverride }, (err, response) => {
        if (err) {
          return done(err);
        }
        const dayFromNow = Date.now() + oneDayInMs;
        assert.closeTo(response.reset, dayFromNow / 1000, 3);
        done();
      });
    });

    it('should use size AND interval config override when provided', (done) => {
      const oneDayInMs = ms('24h');
      const configOverride = { size: 3, per_day: 1 };
      db.take({ type: 'ip', key: '7.7.7.8', configOverride }, (err, response) => {
        if (err) {
          return done(err);
        }
        assert.ok(response.conformant);
        assert.equal(response.remaining, 2);
        assert.equal(response.limit, 3);

        const dayFromNow = Date.now() + oneDayInMs;
        assert.closeTo(response.reset, dayFromNow / 1000, 3);
        done();
      });
    });

    it('should set ttl to reflect config override', (done) => {
      const configOverride = { per_day: 5 };
      const params = { type: 'ip', key: '7.7.7.9', configOverride };
      db.take(params, (err) => {
        if (err) {
          return done(err);
        }
        db.redis.ttl(`${params.type}:${params.key}`, (err, ttl) => {
          if (err) {
            return done(err);
          }
          assert.equal(ttl, 86400);
          done();
        });
      });
    });

    it('should work with no overrides', (done) => {
      const takeParams = { type: 'tenant', key: 'foo' };
      db.take(takeParams, (err, response) => {
        assert.ok(response.conformant);
        assert.equal(response.limit, 1);
        assert.equal(response.remaining, 0);
        done();
      });
    });

    it('should work with thousands of overrides', (done) => {
      const big = _.cloneDeep(buckets);
      for (let i = 0; i < 10000; i++) {
        big.ip.overrides[`regex${i}`] = {
          match: `172\\.16\\.${i}`,
          per_second: 10
        };
      }
      db.configurateBuckets(big);

      const takeParams = { type: 'ip', key: '172.16.1.1' };
      async.map(_.range(10), (i, done) => {
        db.take(takeParams, done);
      }, (err, responses) => {
        if (err) return done(err);
        assert.ok(responses.every((r) => {
          return r.conformant;
        }));
        db.take(takeParams, (err, response) => {
          assert.notOk(response.conformant);
          assert.equal(response.limit, 10);
          assert.equal(response.remaining, 0);
          done();
        });
      });
    });

    describe('elevated limits specific tests', () => {
      const takeElevatedPromise = (params) => new Promise((resolve, reject) => {
        db.takeElevated(params, (err, response) => {
          if (err) {
            return reject(err);
          }
          resolve(response);
        });
      });
      const takePromise = (params) => new Promise((resolve, reject) => {
        db.take(params, (err, response) => {
          if (err) {
            return reject(err);
          }
          resolve(response);
        });
      });
      const redisExistsPromise = (key) => new Promise((resolve, reject) => {
        db.redis.exists(key, (err, exists) => {
          if (err) {
            return reject(err);
          }
          resolve(exists);
        });
      });
      const redisGetPromise = (key) => new Promise((resolve, reject) => {
        db.redis.get(key, (err, value) => {
          if (err) {
            return reject(err);
          }
          resolve(value);
        });
      });
      const redisSetPromise = (key, value) => new Promise((resolve, reject) => {
        db.redis.set(key, value, (err, value) => {
          if (err) {
            return reject(err);
          }
          resolve(value);
        });
      });
      const redisSetWithExpirePromise = (key, value, expireSecs) => new Promise((resolve, reject) => {
        db.redis.set(key, value, 'EX', expireSecs, (err, value) => {
          if (err) {
            return reject(err);
          }
          resolve(value);
        });
      });
      const redisTTLPromise = (key) => new Promise((resolve, reject) => {
        db.redis.ttl(key, (err, value) => {
          if (err) {
            return reject(err);
          }
          resolve(value);
        });
      });

      const redisDeletePromise = (key) => new Promise((resolve, reject) => {
        db.redis.del(key, (err, value) => {
          if (err) {
            return reject(err);
          }
          resolve(value);
        });
      });

      it('should set a key at erl_is_active_key when erl is activated for a bucket with elevated_limits configuration', async () => {
        const bucketName = 'bucket_with_elevated_limits_config';
        const erl_is_active_key = 'some_erl_active_identifier';
        db.configurateBucket(bucketName, {
          size: 1,
          per_minute: 1,
          elevated_limits: {
            size: 2,
            per_minute: 2,
            erl_activation_period_seconds: 900,
            quota_per_calendar_month: 10,
          },
        });
        const params = {
          type: bucketName,
          key: 'some_key',
          elevated_limits: { erl_is_active_key: erl_is_active_key, erl_quota_key: 'erlquotakey' },
        };

        // erl not activated yet
        await takeElevatedPromise(params);
        await redisExistsPromise(erl_is_active_key).then((isActive) => assert.equal(isActive, 0));

        // erl now activated
        await takeElevatedPromise(params);
        await redisExistsPromise(erl_is_active_key).then((isActive) => assert.equal(isActive, 1));
      });
      it('should return erl_active=false when erl is activated for the given key but the bucket has no elevated_limits configuration', async () => {
        const bucketName = 'bucket_with_elevated_limits_config';
        const erl_is_active_key = 'some_erl_active_identifier';
        db.configurateBucket(bucketName, {
          size: 1,
          per_minute: 1,
        });
        const params = {
          type: bucketName,
          key: 'some_key',
          elevated_limits: { erl_is_active_key: erl_is_active_key, erl_quota_key: 'erlquotakey' },
        };

        // erl not activated yet
        await takeElevatedPromise(params);
        await redisExistsPromise(erl_is_active_key).then((isActive) => assert.equal(isActive, 0));

        // activate ERL manually (simulates other call activated it)
        await redisSetPromise(erl_is_active_key, 1);

        // erl now activated, verify call is non-conformant and erl_active=false
        await takeElevatedPromise(params).then((result) => {
          assert.isFalse(result.conformant);
          assert.isFalse(result.elevated_limits.activated);
          assert.isFalse(result.elevated_limits.erl_configured_for_bucket)
        });
      });
      it('should raise an error if elevated_limits object is not provided for a bucket with elevated_limits configuration', (done) => {
        const bucketName = 'bucket_with_elevated_limits_config';
        const params = { type: bucketName, key: 'some_bucket_key' };
        db.configurateBucket(bucketName, {
          size: 1,
          per_minute: 1,
          elevated_limits: {
            size: 2,
            per_minute: 2,
            erl_activation_period_seconds: 900,
            quota_per_calendar_month: 10,
          },
        });

        db.takeElevated(params, (err) => {
          assert.match(err.message, /elevated_limits object is required for elevated limits/);
          done();
        });
      });
      it('should raise an error if elevated_limits.erl_is_active_key is not provided for a bucket with elevated_limits configuration', (done) => {
        const bucketName = 'bucket_with_elevated_limits_config';
        db.configurateBucket(bucketName, {
          size: 1,
          per_minute: 1,
          elevated_limits: {
            size: 2,
            per_minute: 2,
            erl_activation_period_seconds: 900,
            quota_per_calendar_month: 10,
          },
        });
        const params = {
          type: bucketName,
          key: 'some_bucket_key',
          elevated_limits: { erl_quota_key: 'erlquotakey' },
        };

        db.takeElevated(params, (err) => {
          assert.match(err.message, /erl_is_active_key is required for elevated limits/);
          done();
        });
      });
      it('should raise an error if elevated_limits.erl_quota_key is not provided for a bucket with elevated_limits configuration', (done) => {
        const bucketName = 'bucket_with_elevated_limits_config';
        db.configurateBucket(bucketName, {
          size: 1,
          per_minute: 1,
          elevated_limits: {
            size: 2,
            per_minute: 2,
            erl_activation_period_seconds: 900,
            quota_per_calendar_month: 10,
          },
        });
        const params = {
          type: bucketName,
          key: 'some_bucket_key',
          elevated_limits: { erl_is_active_key: 'some_erl_active_identifier' },
        };

        db.takeElevated(params, (err) => {
          assert.match(err.message, /erl_quota_key is required for elevated limits/);
          done();
        });
      });
      it('should apply erl limits if normal rate limits are exceeded', async () => {
        const bucketName = 'bucket_with_elevated_limits_config';
        db.configurateBucket(bucketName, {
          size: 1,
          per_minute: 1,
          elevated_limits: {
            size: 10,
            per_minute: 2,
            erl_activation_period_seconds: 900,
            quota_per_calendar_month: 10
          },
        });
        const params = {
          type: bucketName,
          key: 'some_bucket_key',
          elevated_limits: { erl_is_active_key: 'some_erl_active_identifier', erl_quota_key: 'erlquotakey' },
        };

        // first call, still within normal rate limits
        await takeElevatedPromise(params).then((result) => {
          assert.isFalse(result.elevated_limits.activated);
          assert.equal(result.limit, 1);
          assert.isTrue(result.elevated_limits.erl_configured_for_bucket)
        });
        // second call, normal rate limits exceeded and erl is activated
        await takeElevatedPromise(params).then((result) => {
          assert.isTrue(result.elevated_limits.activated);
          assert.isTrue(result.elevated_limits.erl_configured_for_bucket)
          assert.isTrue(result.conformant);
          assert.equal(result.limit, 10);
          assert.equal(result.remaining, 8);
        });

      });
      it('should rate limit if both normal and erl rate limit are exceeded', async () => {
        const bucketName = 'bucket_with_elevated_limits_config';
        db.configurateBucket(bucketName, {
          size: 1,
          per_minute: 1,
          elevated_limits: {
            size: 2,
            per_minute: 2,
            erl_activation_period_seconds: 900,
            quota_per_calendar_month: 10
          },
        });
        const params = {
          type: bucketName,
          key: 'some_bucket_key',
          elevated_limits: { erl_is_active_key: 'some_erl_active_identifier', erl_quota_key: 'erlquotakey' },
        };

        // first call, still within normal rate limits
        await takeElevatedPromise(params).then((result) => {
          assert.isTrue(result.conformant);
          assert.isFalse(result.elevated_limits.activated);
          assert.isTrue(result.elevated_limits.erl_configured_for_bucket)
          assert.equal(result.remaining, 0);
          assert.equal(result.limit, 1);
        });
        // second call, normal rate limits exceeded and erl is activated.
        // tokens in bucket is going to be 0 after this call (size 2 - 2 calls)
        await takeElevatedPromise(params).then((result) => {
          assert.isTrue(result.conformant);
          assert.isTrue(result.elevated_limits.activated);
          assert.isTrue(result.elevated_limits.erl_configured_for_bucket)
          assert.equal(result.remaining, 0);
          assert.equal(result.limit, 2);
        });
        // third call, erl rate limit exceeded
        await takeElevatedPromise(params).then((result) => {
          assert.isFalse(result.conformant); // being rate limited
          assert.isTrue(result.elevated_limits.activated);
          assert.isTrue(result.elevated_limits.erl_configured_for_bucket)
          assert.equal(result.remaining, 0);
          assert.equal(result.limit, 2);
        });
      });
      it('should deduct already used tokens from new bucket when erl is activated', async () => {
        const bucketName = 'test-bucket';
        await db.configurateBucket(bucketName, {
          size: 2,
          per_minute: 1,
          elevated_limits: {
            size: 10,
            per_minute: 1,
            erl_activation_period_seconds: 900,
            quota_per_calendar_month: 10
          }
        });
        const params = {
          type: bucketName,
          key: 'some_key ',
          elevated_limits: { erl_is_active_key: 'some_erl_active_identifier', erl_quota_key: 'erlquotakey' },
        };

        await takeElevatedPromise(params);
        await takeElevatedPromise(params);
        await takeElevatedPromise(params).then((result) => {
          assert.isTrue(result.conformant);
          assert.isTrue(result.elevated_limits.activated);
          assert.isTrue(result.elevated_limits.erl_configured_for_bucket)
          assert.equal(result.limit, 10);
          assert.equal(result.remaining, 7); // Total used tokens so far: 3
        });
      });
      it('should return a config error if erl_activation_period is not provided', () => {
        const bucketName = 'test-bucket';
        try {
          db.configurateBucket(bucketName, {
            size: 1,
            per_minute: 1,
            elevated_limits: {
              size: 10,
              per_minute: 1,
            }
          });
        } catch (err) {
          assert.equal(err.message, 'erl_activation_period_seconds is required for elevated limits')
        }
      });
      it('should return a config error if quota per interval is not provided', () => {
        const bucketName = 'test-bucket';
        try {
          db.configurateBucket(bucketName, {
            size: 1,
            per_minute: 1,
            elevated_limits: {
              size: 10,
              per_minute: 1,
              erl_activation_period_seconds: 900,
            }
          });
        } catch (err) {
          assert.equal(err.message, 'a valid quota amount per interval is required for elevated limits')
        }
      });
      it('should use ttl calculated using erl activation period if erl activation period is configured', (done) => {
        const bucketName = 'test-bucket';
        db.configurateBucket(bucketName, {
          size: 1,
          per_minute: 1,
          elevated_limits: {
            size: 10,
            per_minute: 1,
            erl_activation_period_seconds: 1200,
            quota_per_calendar_month: 10
          }
        });
        const params = {
          type: bucketName,
          key: 'some_key',
          elevated_limits: { erl_is_active_key: 'some_erl_active_identifier', erl_quota_key: 'erlquotakey' },
        };

        takeElevatedPromise(params)
          .then(() => takeElevatedPromise(params))
          .then(() => db.redis.ttl('some_erl_active_identifier', (err, ttl) => {
            assert.equal(ttl, 1200); // 20 minutes in seconds
            done();
          }));
      });
      it('should refill with erl refill rate when erl is active', (done) => {
        const bucketName = 'test-bucket';
        db.configurateBucket(bucketName, {
          size: 1,
          per_minute: 1,
          elevated_limits: {
            size: 5,
            per_interval: 1,
            interval: 10,
            erl_activation_period_seconds: 900,
            quota_per_calendar_month: 10
          }
        });
        const params = {
          type: bucketName,
          key: 'some_key ',
          elevated_limits: { erl_is_active_key: 'some_erl_active_identifier', erl_quota_key: 'erlquotakey' },
        };

        takeElevatedPromise(params)
          .then(() => takeElevatedPromise(params)) // erl activated
          .then(() => new Promise((resolve) => setTimeout(resolve, 10))) // wait for 10ms
          .then(() => takeElevatedPromise(params)) // refill with erl refill rate
          .then((result) => {
            assert.isTrue(result.conformant);
            assert.isTrue(result.elevated_limits.activated);
            assert.isTrue(result.elevated_limits.erl_configured_for_bucket)
            assert.equal(result.limit, 5);
            assert.equal(result.remaining, 3);
            done();
          });
      });
      it('should go back to standard bucket size and refill rate when we stop using takeElevated', (done) => {
        const bucketName = 'test-bucket';
        db.configurateBucket(bucketName, {
          size: 1,
          per_interval: 1,
          interval: 20, // 1 token every 20 ms (50 RPS)
          elevated_limits: {
            size: 5,
            per_interval: 1,
            interval: 10, // 1 token every 10 ms (100 RPS)
            erl_activation_period_seconds: 900,
            quota_per_calendar_month: 10
          }
        });
        const params = {
          type: bucketName,
          key: 'some_key',
          elevated_limits: { erl_is_active_key: 'some_erl_active_identifier', erl_quota_key: 'erlquotakey' },
        };

        // first call to take a token
        takeElevatedPromise(params)
          .then((result) => {
            assert.equal(result.limit, 1);
            assert.equal(result.remaining, 0);
          })
          // second call. erl activated and token taken. tokens in bucket: 3
          .then(() => takeElevatedPromise(params))
          .then((result) => {
            assert.equal(result.limit, 5);
            assert.equal(result.remaining, 3);
          })
          // wait for 10ms, refill 1 token while erl active. tokens in bucket: 4
          .then(() => new Promise((resolve) => setTimeout(resolve, 10)))
          // take 1 token. tokens in bucket: 3
          .then(() => takeElevatedPromise(params))
          .then((result) => {
            assert.isTrue(result.conformant);
            assert.isTrue(result.elevated_limits.activated);
            assert.isTrue(result.elevated_limits.erl_configured_for_bucket)
            assert.equal(result.remaining, 3);
            assert.equal(result.limit, 5);
          })
          // disable ERL, go back to standard bucket size and refill rate
          // tokens in bucket: 1 (= bucket size)
          // take 1 token. tokens in bucket: 0
          .then(() => takePromise(params))
          .then((result) => {
            assert.isTrue(result.conformant);
            assert.notExists(result.elevated_limits);
            assert.equal(result.remaining, 0);
            assert.equal(result.limit, 1);
          })
          // wait for 2ms, refill 1 token while erl inactive. tokens in bucket: 1
          .then(() => new Promise((resolve) => setTimeout(resolve, 20)))
          // take 1 token. tokens in bucket: 0
          .then(() => takePromise(params))
          .then((result) => {
            assert.isTrue(result.conformant);
            assert.notExists(result.elevated_limits);
            assert.equal(result.remaining, 0);
            assert.equal(result.limit, 1);
            done();
          });
      });

      describe('when erl is activated for the tenant with multiple bucket configurations', () => {
        const nonERLTestBucket = 'nonerl-test-bucket';
        const ERLBucketName = 'erl-test-bucket';
        const erlParams = {
          type: ERLBucketName,
          key: 'some_key',
          elevated_limits: { erl_is_active_key: 'some_erl_active_identifier', erl_quota_key: 'erlquotakey' },
        };
        const otherErlParams = {
          type: ERLBucketName,
          key: 'some_key',
          elevated_limits: { erl_is_active_key: 'other_erl_key', erl_quota_key: 'other_quota_key' },
        };
        const nonErlParams = {
          type: nonERLTestBucket,
          key: 'some_key',
          elevated_limits: { erl_is_active_key: 'some_erl_active_identifier', erl_quota_key: 'erlquotakey' },
        };

        beforeEach(async () => {
            db.configurateBucket(nonERLTestBucket, {
              size: 1,
              per_minute: 1,
            });
            db.configurateBucket(ERLBucketName, {
              size: 1,
              per_minute: 1,
              elevated_limits: {
                size: 5,
                per_minute: 1,
                interval: 10,
                erl_activation_period_seconds: 900,
                quota_per_calendar_month: 10
              }
            });
            await takeElevatedPromise(erlParams)
            await takeElevatedPromise(erlParams) // erl activated
        });

        describe('when the limit is exceeded for a bucket without erl configuration', async () => {
          it('should be non conformant', async () => {
            await takeElevatedPromise(nonErlParams) // non-erl bucket now empty
            assert.isFalse((await takeElevatedPromise(nonErlParams)).conformant)
          });
        })

        describe('when the limit is exceeded for a bucket with erl configuration', () => {
          it('should use ERL to take from the bucket if the given erl_is_active_key is set in Redis ', async () => {
            const activeKey = await redisExistsPromise(erlParams.elevated_limits.erl_is_active_key)
            assert.equal(activeKey, 1)
            await takeElevatedPromise(erlParams)
            const result = await takeElevatedPromise(erlParams);
            assert.isTrue(result.conformant);
            assert.isTrue(result.elevated_limits.activated)
            assert.equal(result.limit, 5);
          });
          it('should NOT use ERL to take from the bucket if the given erl_is_active_key is NOT set in Redis', async() => {
            const activeKey = await redisExistsPromise(erlParams.elevated_limits.erl_is_active_key)
            assert.equal(activeKey, 1)
            const inactiveKey = await redisExistsPromise(otherErlParams.elevated_limits.erl_is_active_key)
            assert.equal(inactiveKey, 0)
            const result = await takeElevatedPromise(otherErlParams);
            assert.isTrue(result.conformant);
            assert.isFalse(result.elevated_limits.activated)
            assert.equal(result.limit, 1);
          });
        });
      });

      describe('overrides', () => {
        it('should use elevated_limits config override when provided', (done) => {
          const bucketName = 'bucket_with_no_elevated_limits_config';
          const erl_is_active_key = 'some_erl_active_identifier';
          db.configurateBucket(bucketName, {
            size: 1,
            per_minute: 1
          });
          const configOverride = { size: 1,
            elevated_limits: {
              size: 3,
              per_second: 3,
              erl_activation_period_seconds: 900,
              quota_per_calendar_month: 10
            }
          };
          const params = {
            type: bucketName,
            key: 'some_key',
            elevated_limits: { erl_is_active_key: erl_is_active_key, erl_quota_key: 'erlquotakey' },
            configOverride
          };
          takeElevatedPromise(params)
            .then((result) => {
              assert.isTrue(result.conformant);
              assert.isFalse(result.elevated_limits.activated);
              assert.isTrue(result.elevated_limits.erl_configured_for_bucket)
              assert.equal(result.limit, 1);
              assert.equal(result.remaining, 0);
            })
            .then(() => takeElevatedPromise(params))
            .then(() => takeElevatedPromise(params))
            .then((result) => {
              assert.isTrue(result.conformant);
              assert.isTrue(result.elevated_limits.activated);
              assert.isTrue(result.elevated_limits.erl_configured_for_bucket)
              assert.equal(result.limit, 3);
              assert.equal(result.remaining, 0);
            })
            .then(() => takeElevatedPromise(params))
            .then((result) => {
              assert.isFalse(result.conformant);
              db.redis.ttl(erl_is_active_key, (err, ttl) => {
                assert.equal(ttl, 900);
                done();
              });
            });
        });
        describe('should use config override when elevated_limits is not provided and erl is active for the given key', ()=> {
          const tests = [
            {
              name: "overrides by param",
              bucketConfig: {
                size: 1,
                per_minute: 1,
              },
              configOverride: {
                size: 2,
                per_minute: 2,
              },
            },
            {
              name: "overrides in bucket config",
              bucketConfig: {
                size: 1,
                per_minute: 1,
                overrides: {
                  'some_key': {
                    size: 2,
                    per_minute: 2,
                  },
                },
              },
              configOverride: undefined,
            },
            {
              name: "overrides in bucket config by matching key",
              bucketConfig: {
                size: 1,
                per_minute: 1,
                overrides: {
                  'local key': {
                    size: 2,
                    per_minute: 2,
                    match: 'some_key',
                  },
                },
              },
              configOverride: undefined,
            },
          ]
          tests.forEach((test) => {
            it(test.name, (done) => {
              const bucketName = 'bucket_with_no_elevated_limits_config';
              const erl_is_active_key = 'some_erl_active_identifier';
              db.configurateBucket(bucketName, test.bucketConfig);
              const params = {
                type: bucketName,
                key: 'some_key',
                elevated_limits: { erl_is_active_key: erl_is_active_key, erl_quota_key: 'erlquotakey' },
                configOverride: test.configOverride,
              };
              redisSetPromise(erl_is_active_key, 1)
                .then(() => takeElevatedPromise(params))
                .then((result) => {
                  assert.isTrue(result.conformant);
                  assert.isFalse(result.elevated_limits.activated);
                  assert.isFalse(result.elevated_limits.erl_configured_for_bucket)
                  assert.equal(result.remaining, 1);
                })
                .then(() => takeElevatedPromise(params))
                .then((result) => {
                  assert.isTrue(result.conformant);
                  assert.isFalse(result.elevated_limits.activated);
                  assert.isFalse(result.elevated_limits.erl_configured_for_bucket);
                  assert.equal(result.remaining, 0);
                })
                .then(() => takeElevatedPromise(params))
                .then((result) => {
                  assert.isFalse(result.conformant);
                  assert.isFalse(result.elevated_limits.activated);
                  assert.isFalse(result.elevated_limits.erl_configured_for_bucket);
                  assert.equal(result.remaining, 0);
                })
                .then(done)
            });
          });
        });

        it('should use erl_activation_period from elevated_limits config override when provided', (done) => {
          const bucketName = 'bucket_with_no_elevated_limits_config';
          const erl_is_active_key = 'some_erl_active_identifier';
          db.configurateBucket(bucketName, {
            size: 1,
            per_minute: 1,
            elevated_limits: {
              size: 2,
              per_second: 2,
              erl_activation_period_seconds: 900,
              quota_per_calendar_month: 2
            }
          });
          const configOverride = {
            size: 1,
            elevated_limits: { size: 3, per_second: 3, erl_activation_period_seconds: 60, quota_per_calendar_month: 10 }
          };
          const params = {
            type: bucketName,
            key: 'some_key',
            elevated_limits: { erl_is_active_key: erl_is_active_key, erl_quota_key: 'erlquotakey' },
            configOverride
          };
          takeElevatedPromise(params)
            .then((result) => {
              assert.isTrue(result.conformant);
              assert.isFalse(result.elevated_limits.activated);
              assert.isTrue(result.elevated_limits.erl_configured_for_bucket)
            })
            .then(() => takeElevatedPromise(params))
            .then((result) => {
              assert.isTrue(result.conformant);
              assert.isTrue(result.elevated_limits.activated);
              assert.isTrue(result.elevated_limits.erl_configured_for_bucket)
              db.redis.ttl(erl_is_active_key, (err, ttl) => {
                assert.equal(ttl, 60); // uses specified activation period
                done();
              });
            });
        });
      });

      // erlquota tests
      describe('erlQuota tests', () => {
        const bucketName = 'bucket_for_erl_testing';
        const erl_is_active_key = 'some_erl_active_identifier';
        const quota_per_calendar_month = 10;
        const params = {
          type: bucketName,
          key: 'some_key',
        };
        beforeEach(() => {
          db.configurateBucket(bucketName, {
            size: 1,
            per_minute: 1,
            elevated_limits: {
              size: 2,
              per_second: 2,
              erl_activation_period_seconds: 900,
              quota_per_calendar_month: quota_per_calendar_month
            }
          });
        });

        it('should return quota_remaining = quota_per_calendar_month-1, quota_allocated and erl_activation_period_seconds when ERL is triggered for the first time in the month', (done) => {
          params.elevated_limits = { erl_is_active_key: erl_is_active_key, erl_quota_key: 'erlquotakey' };

          // check erl not activated yet
          redisExistsPromise(erl_is_active_key)
            .then((erlIsActiveExists) => assert.equal(erlIsActiveExists, 0))
            // check erl_quota_key does not exist
            .then(() => redisExistsPromise(params.elevated_limits.erl_quota_key))
            .then((erl_quota_keyExists) => assert.equal(erl_quota_keyExists, 0))
            // attempt to take elevated should work for first token
            .then(() => takeElevatedPromise(params))
            .then(() => redisExistsPromise(erl_is_active_key))
            .then((erl_is_active_keyExists) => assert.equal(erl_is_active_keyExists, 0))
            // next takeElevated should activate ERL
            .then(() => takeElevatedPromise(params))
            .then((response) => {
              assert.isTrue(response.elevated_limits.triggered);
              assert.isTrue(response.elevated_limits.activated);
              assert.isTrue(response.elevated_limits.erl_configured_for_bucket)
              assert.equal(response.elevated_limits.quota_remaining, quota_per_calendar_month-1);
              assert.isAtLeast(response.elevated_limits.erl_activation_period_seconds, 900);
              assert.isAtLeast(response.elevated_limits.quota_allocated, quota_per_calendar_month);
              assert.equal(response.limit, 2);
            })
            .then(() => done());
        });

        it('should return quota_remaining = -1 when ERL had already been activated', (done) => {
          params.elevated_limits = { erl_is_active_key: erl_is_active_key, erl_quota_key: 'erlquotakey' };

          // setup ERL
          redisSetPromise(erl_is_active_key, 1)
            .then(() => redisSetPromise(params.elevated_limits.erl_quota_key, params.elevated_limits.per_calendar_month - 1))
            // takeElevated with ERL activated
            .then(() => takeElevatedPromise(params))
            .then((response) => {
              assert.isFalse(response.elevated_limits.triggered);
              assert.isTrue(response.elevated_limits.activated);
              assert.isTrue(response.elevated_limits.erl_configured_for_bucket)
              assert.equal(response.elevated_limits.quota_remaining, -1);
              assert.equal(response.limit, 2);
            })
            .then(() => done());
        });

        it('should set ttl accordingly on erl_quota_key when we activate ERL', (done) => {
          params.elevated_limits = { erl_is_active_key: erl_is_active_key, erl_quota_key: 'erlquotakey' };

          const eom = endOfMonthTimestamp();
          // get ms between now and eom
          const expectedTTL = Math.floor((eom - Date.now()) / 1000);

          // check erl not activated yet
          redisExistsPromise(erl_is_active_key)
            .then((erlIsActiveExists) => assert.equal(erlIsActiveExists, 0))
            // check erl_quota_key does not exist
            .then(() => redisExistsPromise(params.elevated_limits.erl_quota_key))
            .then((erl_quota_keyExists) => assert.equal(erl_quota_keyExists, 0))
            // attempt to take elevated should work for first token
            .then(() => takeElevatedPromise(params))
            .then(() => redisExistsPromise(erl_is_active_key))
            .then((erl_is_active_keyExists) => assert.equal(erl_is_active_keyExists, 0))
            // next takeElevated should activate ERL
            .then(() => takeElevatedPromise(params))
            .then(() => redisExistsPromise(erl_is_active_key))
            .then((erl_is_active_keyExists) => assert.equal(erl_is_active_keyExists, 1))
            // check erlQuota should be decreased by 1
            .then(() => redisGetPromise(params.elevated_limits.erl_quota_key))
            .then((erl_quota_keyValue) => assert.equal(erl_quota_keyValue, 1))
            // check ttl on erl_quota_key
            .then(() => redisTTLPromise(params.elevated_limits.erl_quota_key))
            .then((ttl) => assert.closeTo(ttl, expectedTTL, 2))
            .then(() => done());
        });

        it('should keep ttl on erl_quota_key after increasing it', (done) => {
          params.elevated_limits = {
            erl_is_active_key: erl_is_active_key,
            erl_quota_key: 'erlquotakey',
            per_calendar_month: 10
          };
          let expectedTTL = 0;

          // check erl not activated yet
          redisExistsPromise(erl_is_active_key)
            .then((erlIsActiveExists) => assert.equal(erlIsActiveExists, 0))
            // check erl_quota_key does not exist
            .then(() => redisExistsPromise(params.elevated_limits.erl_quota_key)
              .then((erl_quota_keyExists) => assert.equal(erl_quota_keyExists, 0)))
            // attempt to take elevated should work for first token
            .then(() => takeElevatedPromise(params))
            .then(() => redisExistsPromise(erl_is_active_key))
            .then((erl_is_active_keyExists) => assert.equal(erl_is_active_keyExists, 0))
            // next takeElevated should activate ERL
            .then(() => takeElevatedPromise(params))
            .then(() => redisExistsPromise(erl_is_active_key))
            .then((erl_is_active_keyExists) => assert.equal(erl_is_active_keyExists, 1))
            // check erlQuota should be decreased by 1
            .then(() => redisGetPromise(params.elevated_limits.erl_quota_key))
            .then((erl_quota_keyValue) => assert.equal(erl_quota_keyValue, 1))
            // check ttl on erl_quota_key
            .then(() => redisTTLPromise(params.elevated_limits.erl_quota_key))
            .then((ttl) => expectedTTL = ttl)
            // stop ERL
            .then(() => redisDeletePromise(erl_is_active_key))
            // next takeElevated should re-activate ERL
            .then(() => takeElevatedPromise(params))
            .then(() => redisExistsPromise(erl_is_active_key))
            .then((erl_is_active_keyExists) => assert.equal(erl_is_active_keyExists, 1))
            // check erlQuota should be decreased by 1
            .then(() => redisGetPromise(params.elevated_limits.erl_quota_key))
            .then((erl_quota_keyValue) => assert.equal(erl_quota_keyValue, 2))
            // check erlQuota keeps the TTL
            .then(() => redisTTLPromise(params.elevated_limits.erl_quota_key))
            .then((ttl) => assert.equal(ttl, expectedTTL))
            .then(() => done());
        });

        it('should increase erlQuota when we activate ERL', (done) => {
          // activating ERL with per_calendar_month=1 is testing a border case to make sure decreasing the quota
          // is not interpreted in the script as no quota left for activating ERL
          params.elevated_limits = {
            erl_is_active_key: erl_is_active_key,
            erl_quota_key: 'erlquotakey',
            per_calendar_month: 1
          };

          // check erl not activated yet
          redisExistsPromise(erl_is_active_key)
            .then((erlIsActiveExists) => assert.equal(erlIsActiveExists, 0))
            // check erl_quota_key does not exist
            .then(() => redisExistsPromise(params.elevated_limits.erl_quota_key))
            .then((erl_quota_keyExists) => assert.equal(erl_quota_keyExists, 0))
            // attempt to take elevated should work for first token
            .then(() => takeElevatedPromise(params))
            .then((result) => {
              assert.isTrue(result.conformant);
              assert.isFalse(result.elevated_limits.activated);
            })
            .then(() => redisExistsPromise(erl_is_active_key))
            .then((erl_is_active_keyExists) => assert.equal(erl_is_active_keyExists, 0))
            // next takeElevated should activate ERL and return conformant
            .then(() => takeElevatedPromise(params))
            .then((result) => {
              assert.isTrue(result.conformant);
              assert.isTrue(result.elevated_limits.activated);
            })
            .then(() => redisExistsPromise(erl_is_active_key))
            .then((erl_is_active_keyExists) => assert.equal(erl_is_active_keyExists, 1))
            // check erlQuota should be decreased by 1
            .then(() => redisGetPromise(params.elevated_limits.erl_quota_key))
            .then((erl_quota_keyValue) => assert.equal(erl_quota_keyValue, 1))
            .then(() => done());
        });

        it('should not activate ERL when erlQuota is 0', (done) => {
          db.configurateBucket(bucketName, {
            size: 1,
            per_minute: 1,
            elevated_limits: {
              size: 2,
              per_second: 2,
              erl_activation_period_seconds: 900,
              quota_per_calendar_month: 0
            }
          });
          params.elevated_limits = { erl_is_active_key: erl_is_active_key, erl_quota_key: 'erlquotakey' };

          // check erl not activated yet
          redisExistsPromise(erl_is_active_key)
            .then((erlIsActiveExists) => assert.equal(erlIsActiveExists, 0))
            // check erl_quota_key does not exist
            .then(() => redisExistsPromise(params.elevated_limits.erl_quota_key)
              .then((erl_quota_keyExists) => assert.equal(erl_quota_keyExists, 0)))
            // attempt to take elevated should work for first token
            .then(() => takeElevatedPromise(params))
            .then((result) => {
              assert.isTrue(result.conformant);
              assert.isFalse(result.elevated_limits.activated);
              assert.isTrue(result.elevated_limits.erl_configured_for_bucket)
              assert.equal(result.limit, 1);
            })
            .then(() => redisExistsPromise(erl_is_active_key))
            .then((erl_is_active_keyExists) => assert.equal(erl_is_active_keyExists, 0))
            // next takeElevated should have attempted to activate ERL but failed
            .then(() => takeElevatedPromise(params))
            .then((result) => {
              assert.isFalse(result.conformant);
              assert.isFalse(result.elevated_limits.activated);
              assert.isTrue(result.elevated_limits.erl_configured_for_bucket)
              assert.equal(result.limit, 1);
            })
            .then(() => redisExistsPromise(erl_is_active_key))
            .then((erl_is_active_keyExists) => assert.equal(erl_is_active_keyExists, 0))
            // check erlQuota was not set
            .then(() => redisGetPromise(params.elevated_limits.erl_quota_key))
            .then((erl_quota_keyValue) => assert.isNull(erl_quota_keyValue))
            .then(() => done());
        });

        it('should not activate ERL if erl_quota_key exists and is at its max allowed', (done) => {
          params.elevated_limits = { erl_is_active_key: erl_is_active_key, erl_quota_key: 'erlquotakey' };

          // set erl_quota_key to the given max allowed per month in redis
          redisSetPromise(params.elevated_limits.erl_quota_key, quota_per_calendar_month)
            .then(() => redisGetPromise(params.elevated_limits.erl_quota_key))
            .then((erl_quota_keyValue) => assert.equal(erl_quota_keyValue, quota_per_calendar_month))
            // check erl not activated yet
            .then(() => redisExistsPromise(erl_is_active_key))
            .then((erlIsActiveExists) => assert.equal(erlIsActiveExists, 0))
            // attempt to take elevated should work for first token
            .then(() => takeElevatedPromise(params))
            .then((result) => {
              assert.isTrue(result.conformant);
              assert.isFalse(result.elevated_limits.activated);
              assert.isTrue(result.elevated_limits.erl_configured_for_bucket)
              assert.equal(result.limit, 1);
            })
            .then(() => redisExistsPromise(erl_is_active_key))
            .then((erl_is_active_keyExists) => assert.equal(erl_is_active_keyExists, 0))
            // next takeElevated should have attempted to activate ERL but failed as quota is at its max allowed
            .then(() => takeElevatedPromise(params))
            .then((result) => {
              assert.isFalse(result.conformant);
              assert.isFalse(result.elevated_limits.activated);
              assert.isTrue(result.elevated_limits.erl_configured_for_bucket)
              assert.equal(result.limit, 1);
            })
            .then(() => redisExistsPromise(erl_is_active_key))
            .then((erl_is_active_keyExists) => assert.equal(erl_is_active_keyExists, 0))
            // check erlQuota wasn't modified
            .then(() => redisGetPromise(params.elevated_limits.erl_quota_key))
            .then((erl_quota_keyValue) => assert.equal(erl_quota_keyValue, quota_per_calendar_month))
            .then(() => done());
        });

        it('should activate ERL when erl_quota_key expires after reaching allowed per month quota', (done) => {
          params.elevated_limits = { erl_is_active_key: erl_is_active_key, erl_quota_key: 'erlquotakey' };

          // set erl_quota_key to given max quota per month in redis
          redisSetWithExpirePromise(params.elevated_limits.erl_quota_key, quota_per_calendar_month, 1)
            .then(() => redisGetPromise(params.elevated_limits.erl_quota_key))
            .then((erl_quota_keyValue) => assert.equal(erl_quota_keyValue, quota_per_calendar_month))
            .then(() => redisTTLPromise(params.elevated_limits.erl_quota_key))
            .then((quotaTTL) => assert.equal(quotaTTL, 1))
            // check erl not activated yet
            .then(() => redisExistsPromise(erl_is_active_key))
            .then((erlIsActiveExists) => assert.equal(erlIsActiveExists, 0))
            // attempt to take elevated should work for first token
            .then(() => takeElevatedPromise(params))
            .then((result) => {
              assert.isTrue(result.conformant);
              assert.isFalse(result.elevated_limits.activated);
              assert.isTrue(result.elevated_limits.erl_configured_for_bucket)
              assert.equal(result.limit, 1);
            })
            .then(() => redisExistsPromise(erl_is_active_key))
            .then((erl_is_active_keyExists) => assert.equal(erl_is_active_keyExists, 0))
            // next takeElevated should have attempted to activate ERL but failed as quota is at its max allowed
            .then(() => takeElevatedPromise(params))
            .then((result) => {
              assert.isFalse(result.conformant);
              assert.isFalse(result.elevated_limits.activated);
              assert.isTrue(result.elevated_limits.erl_configured_for_bucket)
              assert.equal(result.limit, 1);
            })
            .then(() => redisExistsPromise(erl_is_active_key))
            .then((erl_is_active_keyExists) => assert.equal(erl_is_active_keyExists, 0))
            // check erlQuota wasn't modified
            .then(() => redisGetPromise(params.elevated_limits.erl_quota_key))
            .then((erl_quota_keyValue) => assert.equal(erl_quota_keyValue, quota_per_calendar_month))
            // wait for a second for erl_quota_key to expire
            .then(() => new Promise((resolve) => setTimeout(resolve, 1000)))
            .then(() => redisTTLPromise(params.elevated_limits.erl_quota_key))
            .then((quotaTTL) => assert.isBelow(quotaTTL, 0))
            .then(() => redisGetPromise(params.elevated_limits.erl_quota_key))
            .then((erl_quota_keyValue) => assert.isNull(erl_quota_keyValue))
            // next takeElevated should activate ERL and return conformant
            .then(() => takeElevatedPromise(params))
            .then((result) => {
              assert.isTrue(result.conformant);
              assert.isTrue(result.elevated_limits.activated);
              assert.isTrue(result.elevated_limits.erl_configured_for_bucket)
              assert.equal(result.limit, 2);
            })
            .then(() => redisExistsPromise(erl_is_active_key))
            .then((erl_is_active_keyExists) => assert.equal(erl_is_active_keyExists, 1))
            // check erlQuota was increased
            .then(() => redisGetPromise(params.elevated_limits.erl_quota_key))
            .then((erl_quota_keyValue) => assert.equal(erl_quota_keyValue, 1))
            .then(() => done());
        });
      });
    });
  });

  describe('PUT', () => {
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

    it('should do nothing if bucket is already full', (done) => {
      const key = '1.2.3.4';
      db.put({ type: 'ip', key, count: 1 }, (err, result) => {
        if (err) {
          return done(err);
        }
        assert.equal(result.remaining, 10);

        db.take({ type: 'ip', key, count: 1 }, (err, result) => {
          if (err) {
            return done(err);
          }
          assert.equal(result.remaining, 9);
          done();
        });
      });
    });

    it('should not put more than the bucket size', (done) => {
      db.take({ type: 'ip', key: '8.8.8.8', count: 2 }, (err) => {
        if (err) {
          return done(err);
        }

        db.put({ type: 'ip', key: '8.8.8.8', count: 4 }, (err, result) => {
          if (err) {
            return done(err);
          }
          assert.equal(result.remaining, 10);
          done();
        });
      });
    });

    it('should not override on unlimited buckets', (done) => {
      const bucketKey = { type: 'ip', key: '0.0.0.0', count: 1000 };
      db.put(bucketKey, (err, result) => {
        if (err) {
          return done(err);
        }
        assert.equal(result.remaining, 100);
        done();
      });
    });

    it('should restore the bucket when reseting', (done) => {
      const bucketKey = { type: 'ip', key: '211.123.12.12' };
      db.take(Object.assign({ count: 'all' }, bucketKey), (err) => {
        if (err) return done(err);
        db.put(bucketKey, (err) => {
          if (err) return done(err);
          db.take(bucketKey, (err, response) => {
            if (err) return done(err);
            assert.equal(response.remaining, 9);
            done();
          });
        });
      });
    });

    it('should restore the bucket when reseting with all', (done) => {
      const takeParams = { type: 'ip', key: '21.17.65.41', count: 9 };
      db.take(takeParams, (err) => {
        if (err) return done(err);
        db.put({ type: 'ip', key: '21.17.65.41', count: 'all' }, (err) => {
          if (err) return done(err);
          db.take(takeParams, (err, response) => {
            if (err) return done(err);
            assert.equal(response.conformant, true);
            assert.equal(response.remaining, 1);
            done();
          });
        });
      });
    });

    it('should restore nothing when count=0', (done) => {
      db.take({ type: 'ip', key: '9.8.7.6', count: 123 }, (err) => {
        if (err) return done(err);
        db.put({ type: 'ip', key: '9.8.7.6', count: 0 }, (err) => {
          if (err) return done(err);
          db.take({ type: 'ip', key: '9.8.7.6', count: 0 }, (err, response) => {
            if (err) return done(err);
            assert.equal(response.conformant, true);
            assert.equal(response.remaining, 77);
            done();
          });
        });
      });
    });

    [
      '0',
      0.5,
      'ALL',
      true,
      1n,
      {},
    ].forEach((count) => {
      it(`should not work for non-integer count=${count}`, (done) => {
        const opts = {
          type: 'ip',
          key: '9.8.7.6',
          count,
        };

        assert.throws(() => db.put(opts, () => {
        }), /if provided, count must be 'all' or an integer value/);
        done();
      });
    });

    it('should be able to reset without callback', (done) => {
      const bucketKey = { type: 'ip', key: '211.123.12.12' };
      db.take(bucketKey, (err) => {
        if (err) return done(err);
        db.put(bucketKey);
        setImmediate(() => {
          db.take(bucketKey, (err, response) => {
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
      db.put({ type: 'ip', key: '8.8.8.1', count: -100 }, (err, result) => {
        if (err) {
          return done(err);
        }
        assert.closeTo(result.remaining, -90, 1);

        db.take({ type: 'ip', key: '8.8.8.1' }, (err, result) => {
          if (err) {
            return done(err);
          }
          assert.equal(result.conformant, false);
          assert.closeTo(result.remaining, -89, 1);
          done();
        });
      });
    });

    it('should use size config override when provided', (done) => {
      const configOverride = { size: 4 };
      const bucketKey = { type: 'ip', key: '7.7.7.9', configOverride };
      db.take(Object.assign({ count: 'all' }, bucketKey), (err) => {
        if (err) return done(err);
        db.put(bucketKey, (err) => { // restores all 4
          if (err) return done(err);
          db.take(bucketKey, (err, response) => { // takes 1, 3 remain
            if (err) return done(err);
            assert.equal(response.remaining, 3);
            done();
          });
        });
      });
    });

    it('should use per interval config override when provided', (done) => {
      const oneDayInMs = ms('24h');
      const configOverride = { per_day: 1 };
      const bucketKey = { type: 'ip', key: '7.7.7.10', configOverride };
      db.take(Object.assign({ count: 'all' }, bucketKey), (err) => {
        if (err) return done(err);
        db.put(bucketKey, (err) => { // restores all 4
          if (err) return done(err);
          db.take(bucketKey, (err, response) => { // takes 1, 3 remain
            if (err) return done(err);
            const dayFromNow = Date.now() + oneDayInMs;
            assert.closeTo(response.reset, dayFromNow / 1000, 3);
            done();
          });
        });
      });
    });

    it('should use size AND per interval config override when provided', (done) => {
      const oneDayInMs = ms('24h');
      const configOverride = { size: 4, per_day: 1 };
      const bucketKey = { type: 'ip', key: '7.7.7.11', configOverride };
      db.take(Object.assign({ count: 'all' }, bucketKey), (err) => {
        if (err) return done(err);
        db.put(bucketKey, (err) => { // restores all 4
          if (err) return done(err);
          db.take(bucketKey, (err, response) => { // takes 1, 3 remain
            if (err) return done(err);
            assert.equal(response.remaining, 3);
            const dayFromNow = Date.now() + oneDayInMs;
            assert.closeTo(response.reset, dayFromNow / 1000, 3);
            done();
          });
        });
      });
    });

    it('should set ttl to reflect config override', (done) => {
      const configOverride = { per_day: 5 };
      const bucketKey = { type: 'ip', key: '7.7.7.12', configOverride };
      db.take(Object.assign({ count: 'all' }, bucketKey), (err) => {
        if (err) return done(err);
        db.put(bucketKey, (err) => { // restores all 4
          if (err) return done(err);
          db.take(bucketKey, (err) => { // takes 1, 3 remain
            if (err) return done(err);
            db.redis.ttl(`${bucketKey.type}:${bucketKey.key}`, (err, ttl) => {
              if (err) {
                return done(err);
              }
              assert.equal(ttl, 86400);
              done();
            });
          });
        });
      });
    });
  });

  describe('GET', () => {
    it('should fail on validation', (done) => {
      db.get({}, (err) => {
        assert.match(err.message, /type is required/);
        done();
      });
    });

    it('should return the bucket default for remaining when key does not exist', (done) => {
      db.get({ type: 'ip', key: '8.8.8.8' }, (err, result) => {
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
        db.get({ type: 'ip', key: '8.8.8.8' }, (err, result) => {
          if (err) {
            return done(err);
          }
          assert.equal(result.remaining, 9);

          db.get({ type: 'ip', key: '8.8.8.8' }, (err, result) => {
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
      db.get({ type: 'ip', key: '0.0.0.0' }, (err, result) => {
        if (err) {
          return done(err);
        }
        assert.equal(result.remaining, 100);

        db.take({ type: 'ip', key: '0.0.0.0', count: 1 }, (err) => {
          if (err) {
            return done(err);
          }
          db.get({ type: 'ip', key: '0.0.0.0' }, (err, result) => {
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

    it('should use size config override when provided', (done) => {
      const configOverride = { size: 7 };
      db.get({ type: 'ip', key: '7.7.7.13', configOverride }, (err, result) => {
        if (err) {
          return done(err);
        }
        assert.equal(result.remaining, 7);
        assert.equal(result.limit, 7);
        done();
      });
    });

    it('should use per interval config override when provided', (done) => {
      const oneDayInMs = ms('24h');
      const configOverride = { per_day: 1 };
      db.take({ type: 'ip', key: '7.7.7.14', configOverride }, (err) => {
        if (err) {
          return done(err);
        }
        db.get({ type: 'ip', key: '7.7.7.14', configOverride }, (err, result) => {
          if (err) {
            return done(err);
          }
          const dayFromNow = Date.now() + oneDayInMs;
          assert.closeTo(result.reset, dayFromNow / 1000, 3);
          done();
        });
      });
    });
  });

  describe('WAIT', () => {
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

    it('should be delayed when traffic is non conformant', (done) => {
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
        }, (err, response) => {
          if (err) {
            return done(err);
          }
          var waited = Date.now() - waitingSince;
          assert.ok(response.conformant);
          assert.ok(response.delayed);
          assert.closeTo(waited, 600, 20);
          done();
        });
      });
    });

    it('should not be delayed when traffic is non conformant and count=0', (done) => {
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
          count: 0
        }, (err, response) => {
          if (err) {
            return done(err);
          }
          var waited = Date.now() - waitingSince;
          assert.ok(response.conformant);
          assert.notOk(response.delayed);
          assert.closeTo(waited, 0, 20);
          done();
        });
      });
    });


    it('should use per interval config override when provided', (done) => {
      const oneSecondInMs = ms('1s') / 3;
      const configOverride = { per_second: 3, size: 10 };
      db.take({
        type: 'ip',
        key: '211.76.23.6',
        count: 10,
        configOverride
      }, (err) => {
        if (err) return done(err);
        const waitingSince = Date.now();
        db.wait({
          type: 'ip',
          key: '211.76.23.6',
          count: 1,
          configOverride
        }, (err, response) => {
          if (err) {
            return done(err);
          }
          var waited = Date.now() - waitingSince;
          assert.ok(response.conformant);
          assert.ok(response.delayed);
          assert.closeTo(waited, oneSecondInMs, 20);
          done();
        });
      });
    });
  });

  describe('#resetAll', () => {
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

describe('LimitDBRedis Ping', () => {
  let ping = {
    enabled: () => true,
    interval: 10,
    maxFailedAttempts: 3,
    reconnectIfFailed: () => true,
    maxFailedAttemptsToRetryReconnect: 10
  };

  let config = {
    uri: 'localhost:22222',
    buckets,
    prefix: 'tests:',
    ping,
  };

  let redisProxy;
  let toxiproxy;
  let db;

  beforeEach((done) => {
    toxiproxy = new Toxiproxy('http://localhost:8474');
    proxyBody = {
      listen: '0.0.0.0:22222',
      name: crypto.randomUUID(), //randomize name to avoid concurrency issues
      upstream: 'redis:6379'
    };
    toxiproxy.createProxy(proxyBody)
      .then((proxy) => {
        redisProxy = proxy;
        done();
      });

  });

  afterEach((done) => {
    redisProxy.remove().then(() =>
      db.close((err) => {
        // Can't close DB if it was never open
        if (err?.message.indexOf('enableOfflineQueue') > 0 || err?.message.indexOf('Connection is closed') >= 0) {
          err = undefined;
        }
        done(err);
      })
    );
  });

  it('should emit ping success', (done) => {
    db = createDB({ uri: 'localhost:22222', buckets, prefix: 'tests:', ping }, done);
    db.once(('ping'), (result) => {
      if (result.status === LimitDB.PING_SUCCESS) {
        done();
      }
    });
  });

  it('should emit "ping - error" when redis stops responding pings', (done) => {
    let called = false;

    db = createDB(config, done);
    db.once(('ready'), () => addLatencyToxic(redisProxy, 20000, noop));
    db.on(('ping'), (result) => {
      if (result.status === LimitDB.PING_ERROR && !called) {
        called = true;
        db.removeAllListeners('ping');
        done();
      }
    });
  });

  it('should emit "ping - reconnect" when redis stops responding pings and client is configured to reconnect', (done) => {
    let called = false;
    db = createDB(config, done);
    db.once(('ready'), () => addLatencyToxic(redisProxy, 20000, noop));
    db.on(('ping'), (result) => {
      if (result.status === LimitDB.PING_RECONNECT && !called) {
        called = true;
        db.removeAllListeners('ping');
        done();
      }
    });
  });

  it('should emit "ping - reconnect dry run" when redis stops responding pings and client is NOT configured to reconnect', (done) => {
    let called = false;
    db = createDB({ ...config, ping: { ...ping, reconnectIfFailed: () => false } }, done);
    db.once(('ready'), () => addLatencyToxic(redisProxy, 20000, noop));
    db.on(('ping'), (result) => {
      if (result.status === LimitDB.PING_RECONNECT_DRY_RUN && !called) {
        called = true;
        db.removeAllListeners('ping');
        done();
      }
    });
  });

  it(`should NOT emit ping events when config.ping is not set`, (done) => {
    db = createDB({ ...config, ping: undefined }, done);

    db.once(('ping'), (result) => {
      done(new Error(`unexpected ping event emitted ${result}`));
    });

    //If after 100ms there are no interactions, we mark the test as passed.
    setTimeout(done, 100);
  });

  it('should recover from a connection loss', (done) => {
    let pingResponded = false;
    let reconnected = false;
    let toxic = undefined;
    let timeoutId;
    db = createDB({ ...config, ping: { ...ping, interval: 50 } }, done);

    db.on(('ping'), (result) => {
      if (result.status === LimitDB.PING_SUCCESS) {
        if (!pingResponded) {
          pingResponded = true;
          toxic = addLatencyToxic(redisProxy, 20000, (t) => toxic = t);
        } else if (reconnected) {
          clearTimeout(timeoutId);
          db.removeAllListeners('ping');
          done();
        }
      } else if (result.status === LimitDB.PING_RECONNECT) {
        if (pingResponded && !reconnected) {
          reconnected = true;
          toxic.remove();
        }
      }
    });

    timeoutId = setTimeout(() => done(new Error('Not reconnected')), 1800);
  });

  const createDB = (config, done) => {
    let tmpDB = new LimitDB(config);

    tmpDB.on(('error'), (err) => {
      //As we actively close the connection, there might be network-related errors while attempting to reconnect
      if (err?.message.indexOf('enableOfflineQueue') > 0 || err?.message.indexOf('Command timed out') >= 0) {
        err = undefined;
      }

      if (err) {
        console.log(err, err.message);
        done(err);
      }
    });

    return tmpDB;
  };

  const addLatencyToxic = (proxy, latency, callback) => {
    let toxic = new Toxic(
      proxy,
      { type: 'latency', attributes: { latency: latency } }
    );
    proxy.addToxic(toxic).then(callback);
  };


  const noop = () => {
  };
});
