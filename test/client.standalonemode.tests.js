if (process.env.CLUSTERED_ENV === "true") {
  return;
}

/* eslint-env node, mocha */
const _ = require('lodash');
const assert = require('chai').assert;
const LimitRedis = require('../lib/client');
const clientTests = require('./client.tests');


describe('when using LimitdClient', () => {
  describe('Standalone Redis', () => {
    const standaloneClientFn = (params) => {
      return new LimitRedis({ uri: 'localhost', buckets: {}, prefix: 'tests:', ..._.omit(params, ['nodes']) });
    };

    clientTests(standaloneClientFn);

    describe('when using the standalone #constructor', () => {
      // in cluster mode, ioredis doesn't fail when given a bad node address, it keeps retrying
      it('should call error if db fails', (done) => {
        let called = false; // avoid uncaught
        let client = standaloneClientFn({ uri: 'localhost:fail' });
        client.on('error', () => {
          if (!called) {
            called = true;
            return done();
          }
        });
      });
    });
  });
});