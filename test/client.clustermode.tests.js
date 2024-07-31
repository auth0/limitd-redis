if (process.env.CLUSTERED_ENV === "false") {
  return;
}

/* eslint-env node, mocha */
const _ = require('lodash');
const assert = require('chai').assert;
const LimitRedis = require('../lib/client');
const clusterNodes = [{ host: '127.0.0.1', port: 16371 }, { host: '127.0.0.1', port: 16372 }, { host: '127.0.0.1', port: 16373 }];
const clientTests = require('./client.tests');

describe('when using LimitdClient', () => {
  describe('in Cluster mode', () => {
    const clusteredClientFn = (params) => {
      return new LimitRedis({ nodes: clusterNodes, buckets: {}, prefix: 'tests:', ..._.omit(params, ['uri']) });
    };

    clientTests(clusteredClientFn);

    describe('when using the clustered #constructor', () => {
      it('should allow setting username and password', (done) => {
        let client = clusteredClientFn({ username: 'testuser', password: 'testpass' });
        client.on('ready', () => {
          client.db.redis.acl("WHOAMI", (err, res) => {
            assert.equal(res, 'testuser');
            done();
          })
        });
      });
      it('should use the default user if no one is provided', (done) => {
        let client = clusteredClientFn();
        client.on('ready', () => {
          client.db.redis.acl("WHOAMI", (err, res) => {
            assert.equal(res, 'default');
            done();
          })
        });
      });
    });
  });
});


