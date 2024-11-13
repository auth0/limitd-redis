const LimitDB = require('../lib/db');
const _ = require('lodash');
const { tests: dbTests, buckets} = require('./db.tests');
const { assert } = require('chai');
const { Toxiproxy, Toxic } = require('toxiproxy-node-client');
const crypto = require('crypto');



describe('when using LimitDB', () => {
  describe('in standalone mode', () => {
    const clientCreator = (params) => {
      return new LimitDB({ uri: 'localhost:6379', buckets: {}, prefix: 'tests:', ..._.omit(params, ['nodes']) });
    };

    dbTests(clientCreator, { uri: 'localhost:6379' } );

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
  })
});
