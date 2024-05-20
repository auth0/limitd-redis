/* eslint-env node, mocha */
const assert = require('chai').assert;

const { validateParams, validateERLParams } = require('../lib/validation');
const _ = require('lodash');

describe('validation', () => {
  describe('validateParameters', () => {

    const buckets = {
      user: {
        size: 10
      }
    };

    describe('when providing invalid parameters', () => {
      const invalidParameterSets = [
        {
          result: {
            message: 'params are required',
            code: 101
          }
        }, {
          params: {},
          result: {
            message: 'type is required',
            code: 102
          }
        }, {
          params: {
            type: 'ip'
          },
          result: {
            message: 'undefined bucket type ip',
            code: 103
          }
        }, {
          params: {
            type: 'user'
          },
          result: {
            message: 'key is required',
            code: 104
          }
        }, {
          params: {
            type: 'user',
            key: 'tenant|username',
            configOverride: 5
          },
          result: {
            message: 'configuration overrides must be an object',
            code: 105
          }
        }, {
          params: {
            type: 'user',
            key: 'tenant|username',
            configOverride: {}
          },
          result: {
            message: 'configuration overrides must provide either a size or interval',
            code: 106
          }
        }
      ];

      invalidParameterSets.forEach(testcase => {
        it(`Should return a validation error, code ${testcase.result.code}`, () => {
          const result = validateParams(testcase.params, buckets);
          assert.strictEqual(result.name, 'LimitdRedisValidationError');
          assert.strictEqual(result.message, testcase.result.message);
          assert.deepEqual(result.extra, { code: testcase.result.code });
          assert.exists(result.stack);
        });
      });
    });

    describe('when providing valid parameters', () => {
      const validParameterSerts = [
        {
          params: {
            type: 'user',
            key: 'tenant|username',
          },
          name: 'type and key params'
        }, {
          params: {
            type: 'user',
            key: 'tenant|username',
            configOverride: {
              size: 77
            }
          },
          name: 'configOverride with size'
        }, {
          params: {
            type: 'user',
            key: 'tenant|username',
            configOverride: {
              per_hour: 300
            }
          },
          name: 'configOverride with interval'
        }, {
          params: {
            type: 'user',
            key: 'tenant|username',
            configOverride: {
              size: 30,
              per_hour: 300
            }
          },
          name: 'configOverride with size and interval'
        },
      ];

      validParameterSerts.forEach(testcase => {
        it(`Should not cause a validation error for ${testcase.name}`, () => {
          const result = validateParams(testcase.params, buckets);
          assert.isUndefined(result);
        });
      });
    });
  });
  describe('validateERLParams', () => {
    let validParams;
    beforeEach(() => {
      validParams = {
        erl_is_active_key: 'erl_is_active_key',
        erl_quota_key: 'erl_quota_key',
        erl_activation_period_seconds: 900,
        erl_quota: 10,
        erl_quota_interval: 'quota_per_calendar_month'
      };
    });

    it('should return no error for appropriate keys', () => {
      const result = validateERLParams(validParams);
      assert.isUndefined(result);
    });

    describe('when providing invalid parameters', () => {
      const missingParamsCases = [
        { missingParam: 'erl_is_active_key', code: 108, message: 'erl_is_active_key is required for elevated limits' },
        { missingParam: 'erl_quota_key', code: 110, message: 'erl_quota_key is required for elevated limits' },
        { missingParam: 'erl_activation_period_seconds', code: 111, message: 'erl_activation_period_seconds is required for elevated limits' },
        { missingParam: 'erl_quota', code: 112, message: 'a valid quota amount per interval is required for elevated limits' },
        { missingParam: 'erl_quota_interval', code: 112, message: 'a valid quota amount per interval is required for elevated limits' }
      ];
      missingParamsCases.forEach(testcase => {
        it(`should return ${testcase.message} if ${testcase.missingParam} is not provided`, () => {
          const invalidParams = _.omit(validParams, testcase.missingParam);
          const result = validateERLParams(invalidParams);
          assert.strictEqual(result.message, testcase.message);
          assert.deepEqual(result.extra, { code: testcase.code });
        });
      });
    });
  });
});
