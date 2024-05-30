/* eslint-env node, mocha */
//const assert = require('chai').assert;
const chai = require('chai');
const chaiExclude = require('chai-exclude');
chai.use(chaiExclude);
const assert = chai.assert;

const { getERLParams, calculateQuotaExpiration, normalizeType, resolveElevatedParams } = require('../lib/utils');
const { set, reset } = require('mockdate');
const { expect } = require('chai');

describe('utils', () => {
  describe('bucketNormalization', () => {
    it('should return normalized bucket', () => {
      const bucket = {
        size: 100,
        per_second: 100,
        elevated_limits: {
          size: 300,
          per_second: 300,
        }
      };
      const response = normalizeType(bucket);
      const { elevated_limits, overrides, overridesMatch, overridesCache, ...rest } = response;
      expect(rest).excluding('drip_interval').to.deep.equal({
        size: 100,
        interval: 1000,
        per_interval: 100,
        ttl: 1,
        ms_per_interval: 0.1,
      });

      expect(elevated_limits).excluding('drip_interval').to.deep.equal({
        size: 300,
        interval: 1000,
        per_interval: 300,
        ttl: 1,
        ms_per_interval: 0.3,
        erl_configured_for_bucket: true,
      });
    });

    it('should return normalized bucket without ERL', () => {
      const bucket = {
        size: 100,
        per_second: 100,
      };
      const response = normalizeType(bucket);
      const { elevated_limits, overrides, overridesMatch, overridesCache, ...rest } = response;
      expect(rest).excluding('drip_interval').to.deep.equal({
        size: 100,
        interval: 1000,
        per_interval: 100,
        ttl: 1,
        ms_per_interval: 0.1,
      });

      expect(elevated_limits).to.be.undefined;
    });

    describe('when overrides are provided', () => {
      it('should add overrides', () => {
        const bucket = {
          size: 100,
          per_second: 100,
          elevated_limits: {
            size: 200,
            per_second: 200,
            erl_activation_period_seconds: 300,
            quota_per_calendar_month: 5
          },
          overrides: {
            '127.0.0.1': {
              size: 200,
              per_second: 200,
              elevated_limits: {
                size: 400,
                per_second: 400,
                erl_activation_period_seconds: 900,
                quota_per_calendar_month: 10,
              },
            }
          }
        };
        const response = normalizeType(bucket);
        const { elevated_limits, overrides, overridesMatch, overridesCache, ...rest } = response;
        expect(overrides['127.0.0.1']).to.not.be.null;
        expect(overrides['127.0.0.1']).excluding('drip_interval').excluding('elevated_limits').to.deep.equal({
          size: 200,
          interval: 1000,
          per_interval: 200,
          ttl: 1,
          ms_per_interval: 0.2,
          name: "127.0.0.1",
          until: undefined
        });
        expect(overrides['127.0.0.1'].elevated_limits).excluding('drip_interval').to.deep.equal({
          size: 400,
          interval: 1000,
          per_interval: 400,
          ttl: 1,
          ms_per_interval: 0.4,
          erl_configured_for_bucket: true,
        });
      });



      it('should allow to only override elevated_limits', () => {
        const bucket = {
          size: 100,
          per_second: 100,
          elevated_limits: {
            size: 200,
            per_second: 200,
          },
          overrides: {
            '127.0.0.1': {
              elevated_limits: {
                size: 400,
                per_second: 400,
              },
            }
          }
        };
        const response = normalizeType(bucket);
        const { elevated_limits, overrides, overridesMatch, overridesCache, ...rest } = response;
        expect(overrides['127.0.0.1']).to.not.be.null;
        expect(overrides['127.0.0.1']).excluding('drip_interval').excluding('elevated_limits').to.deep.equal({
          size: 100,
          interval: 1000,
          per_interval: 100,
          ttl: 1,
          ms_per_interval: 0.1,
          name: "127.0.0.1",
          until: undefined
        });
        expect(overrides['127.0.0.1'].elevated_limits).excluding('drip_interval').to.deep.equal({
          size: 400,
          interval: 1000,
          per_interval: 400,
          ttl: 1,
          ms_per_interval: 0.4,
          erl_configured_for_bucket: true,
        });

      });
    });
    })


  describe('quotaExpiration', () => {
    const tests = [{
      date: '2024-03-15T12:00:00.000Z', expiration: 1711929600000, name: '16 days, 12 hs left to end of month'
    }, {
      date: '2024-03-31T23:00:00.000Z', expiration: 1711929600000, name: '1 hour left to end of month'
    }, {
      date: '2024-03-31T23:59:59.000Z', expiration: 1711929600000, name: '1 second left to end of month'
    }, {
      date: '2024-04-01T00:00:00.000Z', expiration: 1714521600000, name: 'the whole next month'
    }];

    tests.forEach(test => {
      it(`should return appropriate expiration when there's ${test.name}`, () => {
        set(test.date);

        const result = calculateQuotaExpiration({ erl_quota_interval: 'quota_per_calendar_month' });

        assert.equal(result, test.expiration);
      });

    });

    afterEach(() => {
      reset();
    });

  });

  describe('extractERLKeys', () => {
    it('should return appropriate keys', () => {
      const params = {
        elevated_limits: {
          erl_is_active_key: 'erl_is_active_key',
          erl_quota_key: 'erl_quota_key',
          erl_activation_period_seconds: 900,
          quota_per_calendar_month: 10,
        }
      };

      const result = getERLParams(params.elevated_limits);

      assert.equal(result.erl_is_active_key, params.elevated_limits.erl_is_active_key);
      assert.equal(result.erl_quota_key, params.elevated_limits.erl_quota_key);
      assert.equal(result.erl_activation_period_seconds, params.elevated_limits.erl_activation_period_seconds);
      assert.equal(result.erl_quota, params.elevated_limits.quota_per_calendar_month);
      assert.equal(result.erl_quota_interval, 'quota_per_calendar_month');
    });
  });

  describe('resolveElevatedParams', () => {
    describe('when bucketKeyConfig does not have elevated limits', () => {
      const erlParams = {
        erl_is_active_key: 'erl_is_active_key',
        erl_quota_key: 'erl_quota_key',
        erl_activation_period_seconds: 900,
        erl_quota: 10,
        erl_quota_interval: 'quota_per_calendar_month'
      };
      const bucketKeyConfig = {
        size: 1,
        interval: 60000,
        per_interval: 1,
        ttl: 60,
        ms_per_interval: 0.000016666666666666667,
        drip_interval: 60000
      };
      it('should return erl_configured_for_bucket=false', () => {
        const result = resolveElevatedParams(erlParams, bucketKeyConfig);
        assert.equal(result.ms_per_interval, bucketKeyConfig.ms_per_interval);
        assert.equal(result.size, bucketKeyConfig.size);
        assert.equal(result.erl_activation_period_seconds, erlParams.erl_activation_period_seconds);
        assert.equal(result.erl_quota, erlParams.erl_quota);
        assert.equal(result.erl_quota_interval, erlParams.erl_quota_interval);
        assert.equal(result.erl_is_active_key, erlParams.erl_is_active_key);
        assert.equal(result.erl_quota_key, erlParams.erl_quota_key);
        assert.isFalse(result.erl_configured_for_bucket);
      });
    });

    describe('when erlParams is undefined', () => {
      const erlParams = undefined;
      const bucketKeyConfig = {
        size: 1,
        interval: 60000,
        per_interval: 1,
        ttl: 60,
        ms_per_interval: 0.000016666666666666667,
        drip_interval: 60000
      };
      it('should return default ERL keys and erl_configured_for_bucket=false', () => {
        const result = resolveElevatedParams(erlParams, bucketKeyConfig);
        assert.equal(result.ms_per_interval, bucketKeyConfig.ms_per_interval);
        assert.equal(result.size, bucketKeyConfig.size);
        assert.equal(result.erl_activation_period_seconds, 0);
        assert.equal(result.erl_quota, 0);
        assert.equal(result.erl_quota_interval, 'quota_per_calendar_month');
        assert.equal(result.erl_is_active_key, 'defaultActiveKey');
        assert.equal(result.erl_quota_key, 'defaultQuotaKey');
        assert.isFalse(result.erl_configured_for_bucket);
      });
    });
    describe('when bucketKeyConfig has elevated limits and erlParams are provided', () => {
      const erlParams = {
        erl_is_active_key: 'erl_is_active_key',
        erl_quota_key: 'erl_quota_key',
        erl_activation_period_seconds: 900,
        erl_quota: 10,
        erl_quota_interval: 'quota_per_calendar_month'
      };
      const bucketKeyConfig = {
        size: 1,
        interval: 60000,
        per_interval: 1,
        ttl: 60,
        ms_per_interval: 0.000016666666666666667,
        drip_interval: 60000,
        elevated_limits: {
          size: 2,
          interval: 60000,
          per_interval: 2,
          ttl: 60,
          ms_per_interval: 0.000033333333333333335,
          drip_interval: 30000,
          erl_configured_for_bucket: true,
        }
      };
      it('should return appropriate keys and indicate erl_configured_for_bucket=true', () => {
        const result = resolveElevatedParams(erlParams, bucketKeyConfig);
        assert.equal(result.ms_per_interval, bucketKeyConfig.elevated_limits.ms_per_interval);
        assert.equal(result.size, bucketKeyConfig.elevated_limits.size);
        assert.equal(result.interval, bucketKeyConfig.elevated_limits.interval);
        assert.equal(result.per_interval, bucketKeyConfig.elevated_limits.per_interval);
        assert.equal(result.ttl, bucketKeyConfig.elevated_limits.ttl);
        assert.equal(result.drip_interval, bucketKeyConfig.elevated_limits.drip_interval);
        assert.equal(result.erl_activation_period_seconds, erlParams.erl_activation_period_seconds);
        assert.equal(result.erl_quota, erlParams.erl_quota);
        assert.equal(result.erl_quota_interval, erlParams.erl_quota_interval);
        assert.equal(result.erl_is_active_key, erlParams.erl_is_active_key);
        assert.equal(result.erl_quota_key, erlParams.erl_quota_key);
        assert.equal(result.erl_configured_for_bucket, true);
      });
    });

  });
});
