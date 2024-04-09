/* eslint-env node, mocha */
const assert = require('chai').assert;

const { getERLKeysQuotaAmountAndExpiration } = require('../lib/utils');
const { set, reset } = require('mockdate');

describe('utils', () => {
  describe('extractERLQuota', () => {
    const dateTests = [{
      date: '2024-03-15T12:00:00.000Z', expiration: 1711929600000, name: '16 days, 12 hs left to end of month'
    }, {
      date: '2024-03-31T23:00:00.000Z', expiration: 1711929600000, name: '1 hour left to end of month'
    }, {
      date: '2024-03-31T23:59:59.000Z', expiration: 1711929600000, name: '1 second left to end of month'
    }];

    dateTests.forEach(test => {
      it(`should return appropriate key, amount, and expiration when there's ${test.name}`, () => {
        set(test.date);

        const params = {
          elevatedLimits: {
            erlIsActiveKey: 'erlIsActiveKey',
            erlQuotaKey: 'erlQuotaKey',
            per_calendar_month: 192
          }
        };

        const result = getERLKeysQuotaAmountAndExpiration(params.elevatedLimits);

        assert.equal(result.erlIsActiveKey, params.elevatedLimits.erlIsActiveKey);
        assert.equal(result.erlQuotaKey, params.elevatedLimits.erlQuotaKey);
        assert.equal(result.amount, params.elevatedLimits.per_calendar_month);
        assert.equal(result.expiration, test.expiration);
      });
    });

    afterEach(() => {
      reset();
    });
  });
});
