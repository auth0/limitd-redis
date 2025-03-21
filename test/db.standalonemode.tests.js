/* eslint-disable */
const LimitDB = require('../lib/db');
const _ = require('lodash');
const { tests: dbTests, buckets} = require('./db.tests');


describe('when using LimitDB', () => {
  describe('in standalone mode', () => {
    const clientCreator = (params) => {
      return new LimitDB({ uri: 'localhost:6379', buckets: {}, prefix: 'tests:', ..._.omit(params, ['nodes']) });
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
  })
});
