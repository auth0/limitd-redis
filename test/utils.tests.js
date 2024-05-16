const chai = require('chai');
const chaiExclude = require('chai-exclude');
chai.use(chaiExclude);
const assert = chai.assert;

const { getERLParams, calculateQuotaExpiration, normalizeType } = require('../lib/utils');
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
          erl_activation_period_seconds: 300,
          quota_per_calendar_month: 192
        }
      };
      const response = normalizeType(bucket);
      // eslint-disable-next-line no-unused-vars
      const { elevated_limits, ...rest } = response;
      expect(rest).excluding(['drip_interval', 'overrides', 'overridesMatch', 'overridesCache']).to.deep.equal({
        size: 100,
        interval: 1000,
        per_interval: 100,
        ttl: 1,
        ms_per_interval: 0.1,
      });

      expect(elevated_limits).excluding('drip_interval').to.deep.equal({
        size: 300,
        erl_quota: 192,
        erl_quota_interval: 'quota_per_calendar_month',
        interval: 1000,
        per_interval: 300,
        ttl: 1,
        ms_per_interval: 0.3,
        erl_activation_period_seconds: 300,
        erl_configured_for_bucket: true,
      });
    });

    it('should return normalized bucket without ERL', () => {
      const bucket = {
        size: 100,
        per_second: 100,
      };
      const response = normalizeType(bucket);
      const { elevated_limits, ...rest } = response;
      expect(rest).excluding(['drip_interval', 'overrides', 'overridesMatch']).to.deep.equal({
        size: 100,
        interval: 1000,
        per_interval: 100,
        ttl: 1,
        ms_per_interval: 0.1,
      });

      expect(elevated_limits).to.be.undefined;
    });


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
      const { overrides } = response;
      expect(overrides['127.0.0.1']).to.not.be.null;
      expect(overrides['127.0.0.1']).excluding('drip_interval').excluding('elevated_limits').to.deep.equal({
        size: 200,
        interval: 1000,
        per_interval: 200,
        ttl: 1,
        ms_per_interval: 0.2,
        name: '127.0.0.1',
        until: undefined
      });
      expect(overrides['127.0.0.1'].elevated_limits).excluding('drip_interval').to.deep.equal({
        erl_activation_period_seconds: 900,
        erl_quota: 10,
        erl_quota_interval: 'quota_per_calendar_month',
        size: 400,
        interval: 1000,
        per_interval: 400,
        ttl: 1,
        ms_per_interval: 0.4,
        erl_configured_for_bucket: true,
      });
    });
  });

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
        }
      };

      const result = getERLParams(params.elevated_limits);

      assert.equal(result.erl_is_active_key, params.elevated_limits.erl_is_active_key);
      assert.equal(result.erl_quota_key, params.elevated_limits.erl_quota_key);
    });
  });
});
