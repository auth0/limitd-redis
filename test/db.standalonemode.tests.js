if (process.env.CLUSTERED_ENV === 'true') {
  return;
}

const LimitDB = require('../lib/db');
const _ = require('lodash');
const { tests: dbTests, buckets} = require('./db.tests');
const { assert } = require('chai');
const { Toxiproxy, Toxic } = require('toxiproxy-node-client');
const crypto = require('crypto');



describe('when using LimitDB', () => {
  describe('in standalone mode', () => {
    const clientCreator = (params) => {
      return new LimitDB({ uri: 'localhost', buckets: {}, prefix: 'tests:', ..._.omit(params, ['nodes']) });
    };

    dbTests(clientCreator);

    describe('when using the standalone #constructor', () => {
      it('should emit error on failure to connect to redis', (done) => {
        let called = false;
        db = clientCreator({ uri: 'localhost:fail' })
        db.on('error', () => {
          if (!called) {
            called = true;
            return done();
          }
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
  })
});