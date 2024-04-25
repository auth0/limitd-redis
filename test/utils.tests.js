/* eslint-env node, mocha */
//const assert = require('chai').assert;
const chai = require('chai');
const chaiExclude = require('chai-exclude');
chai.use(chaiExclude);
const assert = chai.assert;

const { getERLParams, calculateQuotaExpiration, normalizeType, randomBetween, normalizeTemporals} = require('../lib/utils');
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
        erl_quota_amount: 192,
        erl_quota_interval: 'quota_per_calendar_month',
        interval: 1000,
        per_interval: 300,
        ttl: 1,
        ms_per_interval: 0.3,
        erl_activation_period_seconds: 300
      });
    });
    it('should add default ERL configuration', () => {
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

      expect(elevated_limits).excluding('drip_interval').to.deep.equal({
        size: 100,
        interval: 1000,
        per_interval: 100,
        ttl: 1,
        ms_per_interval: 0.1,
        erl_activation_period_seconds: 900,
        erl_quota_amount: 0,
        erl_quota_interval: 'quota_per_calendar_month',
      });
    });

    it('should add overrides', () => {
      const bucket = {
        size: 100,
        per_second: 100,
        overrides: {
          '127.0.0.1': {
            size: 200,
            per_second: 200
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
        erl_activation_period_seconds: 900,
        erl_quota_amount: 0,
        erl_quota_interval: "quota_per_calendar_month",
        size: 100,
        interval: 1000,
        per_interval: 100,
        ttl: 1,
        ms_per_interval: 0.1,
      });
    });
  });

  describe('normalizeTemporals', () => {
    const oneDayInSeconds = 24 * 60 * 60;
    const oneDayInMs = oneDayInSeconds * 1000;
    const oneHourInSeconds = 60 * 60;
    const oneHourInMs = oneHourInSeconds * 1000;
    const oneMinuteInSeconds = 60;
    const oneMinuteInMs = oneMinuteInSeconds * 1000;

    const testCasesWithoutElevatedLimits = [
      ['when per_interval and interval are defined', {
        given: {
          per_interval: 5,
          interval: 1000,
          size: 10,
        },
        expected: {
          size: 10,
          interval: 1000,
          per_interval: 5,
          ttl: 2,
          ms_per_interval: 0.005,
          drip_interval: 200
        }
      }],
      ['when per_second is defined', {
        given: {
          per_second: 5,
          size: 10,
        },
        expected: {
          size: 10,
          interval: 1000,
          per_interval: 5,
          ttl: 2,
          ms_per_interval: 0.005,
          drip_interval: 200
        }
      }],
      ['when per_minute is defined', {
        given: {
          per_minute: 5,
          size: 10,
        },
        expected: {
          size: 10,
          interval: oneMinuteInMs,
          per_interval: 5,
          ttl: oneMinuteInSeconds * 2,
          ms_per_interval: 5 / oneMinuteInMs,
          drip_interval: oneMinuteInMs / 5
        }
      }],
      ['when per_hour is defined', {
        given: {
          per_hour: 5,
          size: 10,
        },
        expected: {
            size: 10,
            interval: oneHourInMs,
            per_interval: 5,
            ttl: oneHourInSeconds * 2,
            ms_per_interval: 5 / oneHourInMs,
            drip_interval: oneHourInMs / 5
        }
      }],
      ['when per_day is defined', {
        given: {
          per_day: 5,
          size: 10,
        },
        expected: {
          size: 10,
          interval: oneDayInMs,
          per_interval: 5,
          ttl: oneDayInSeconds * 2,
          ms_per_interval: 5 / oneDayInSeconds,
          drip_interval: oneDayInMs / 5
        }
      }],
      ['when size is undefined', {
        given: {
          per_second: 5
        },
        expected: {
            size: 5, // takes per_second as size
            interval: 1000,
            per_interval: 5,
            ttl: 1,
            ms_per_interval: 0.005,
            drip_interval: 200
        }
      }],
    ];

    testCasesWithoutElevatedLimits.forEach(([ description, { given, expected } ]) => {
      it(`should return normalized temporals ${description}`, () => {
        const result = normalizeTemporals(given);
        expect(result.size).to.equal(expected.size, 'size');
        expect(result.interval).to.equal(expected.interval, 'interval');
        expect(result.per_interval).to.equal(expected.per_interval, 'per_interval');
        expect(result.ttl).to.equal(expected.ttl, 'ttl');
        expect(result.ms_per_interval).to.be.closeTo(expected.ms_per_interval, 0.001, 'ms_per_interval');
        expect(result.drip_interval).to.be.closeTo(expected.drip_interval, 0.001, 'drip_interval');
      });
    });

    describe('normalizeElevatedLimits tests', () => {
      it('should normalize elevated limits', () => {
        const input = {
          size: 2,
          per_second: 2,
          erl_activation_period_seconds: 900,
          quota_per_calendar_month: 2
        };

        const expectedOutput = {
          size: 2,
          per_second: 2,
          erl_activation_period_seconds: 900,
          quota_per_calendar_month: 2
        };

        const result = normalizeTemporals(input);
        assert.deepEqual(result, expectedOutput);
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

  describe('randomBetween', () => {
    it('should return a number between min and max', () => {
      const min = 1;
      const max = 5;
      const result = randomBetween(min, max);
      assert(result >= min && result < max, 'Returned number is within the range');
    });

    it('should swap min and max if min is greater than max', () => {
      const min = 5;
      const max = 1;
      const result = randomBetween(min, max);
      assert(result >= max && result < min, 'Returned number is within the swapped range');
    });
  });
});
