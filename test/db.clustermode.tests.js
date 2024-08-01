const LimitDB = require('../lib/db');
const _ = require('lodash');
const { tests: dbTests } = require('./db.tests');
const { assert } = require('chai');
const clusterNodes = [{ host: '127.0.0.1', port: 16371 }, { host: '127.0.0.1', port: 16372 }, { host: '127.0.0.1', port: 16373 }];



describe('when using LimitDB', () => {
  describe('in cluster mode', () => {
    const clientCreator = (params) => {
      return new LimitDB({ nodes: clusterNodes, buckets: {}, prefix: 'tests:', ..._.omit(params, ['uri']) });
    };

    dbTests(clientCreator);

    describe('when using the clustered #constructor', () => {
      it('should allow setting username and password', (done) => {
        db = clientCreator({ buckets: {}, username: 'testuser', password: 'testpass' });
        db.on('ready', () => {
          db.redis.acl("WHOAMI", (err, res) => {
            assert.equal(res, 'testuser');
            done();
          })
        });
        db.on('error', (err) => done(err));
        db.on('node error', (err) => done(err));
      });
    });
  })
});