/* eslint-disable */
const { assert } = require("chai");
const sinon = require("sinon");
const LimitDBRedis = require("../../lib/db");
const Redis = require("ioredis");

describe("LimitDBRedis", () => {
  let db;
  let redisMock;

  beforeEach(() => {
    // Mock Redis instance
    redisMock = {
      defineCommand: sinon.stub(),
      on: sinon.stub(),
      take: sinon.stub(),
      takeElevated: sinon.stub(),
      takeExponential: sinon.stub(),
      put: sinon.stub(),
      hmget: sinon.stub(),
      del: sinon.stub(),
      quit: sinon.stub(),
      nodes: null,
    };

    // Create test instance
    db = new LimitDBRedis({
      uri: "redis://localhost:6379",
      buckets: {
        ip: {
          size: 10,
          per_second: 5,
        },
      },
      redis: redisMock,
    });

    // Simulate ready event
    redisMock.on
      .getCalls()
      .find((call) => call.args[0] === "ready")
      ?.args[1]();
  });

  afterEach(() => {
    sinon.restore();
  });

  describe("#take", () => {
    it("should call redis take with correct parameters", (done) => {
      // Mock redis response
      const now = Date.now();
      redisMock.take.callsFake((key, ms, size, count, ttl, drip, fixed, cb) => {
        cb(null, [5, 1, now, now + 1000]);
      });

      db.take(
        {
          type: "ip",
          key: "1.2.3.4",
          count: 1,
        },
        (err, result) => {
          assert.isNull(err);
          assert.isTrue(result.conformant);
          assert.equal(result.remaining, 5);
          assert.equal(result.limit, 10);
          assert.isFalse(result.delayed);

          sinon.assert.calledWith(
            redisMock.take,
            "ip:1.2.3.4",
            0.005, // ms_per_interval (5/1000 tokens per ms)
            10, // size
            1, // count
            sinon.match.number, // ttl
            200, // drip_interval
            0 // fixed window interval
          );
          done();
        }
      );
    });

    it("should handle redis errors", (done) => {
      redisMock.take.callsFake((key, ms, size, count, ttl, drip, fixed, cb) => {
        cb(new Error("Redis error"));
      });

      db.take(
        {
          type: "ip",
          key: "1.2.3.4",
        },
        (err, result) => {
          assert.isNotNull(err);
          assert.equal(err.message, "Redis error");
          assert.isUndefined(result);
          done();
        }
      );
    });

    it("should validate params", (done) => {
      db.take({}, (err) => {
        assert.match(err.message, /type is required/);
        done();
      });
    });

    it("should handle unlimited buckets", (done) => {
      db.configurateBucket("unlimited", {
        unlimited: true,
      });

      db.take(
        {
          type: "unlimited",
          key: "test",
        },
        (err, result) => {
          assert.isNull(err);
          assert.isTrue(result.conformant);
          assert.isFalse(result.delayed);
          done();
        }
      );
    });
  });

  describe("#wait", () => {
    it("should retry when bucket is not conformant", (done) => {
      const clock = sinon.useFakeTimers();
      let calls = 0;

      redisMock.take.callsFake((key, ms, size, count, ttl, drip, fixed, cb) => {
        calls++;
        if (calls === 1) {
          cb(null, [0, 0, Date.now(), Date.now() + 1000]);
        } else {
          cb(null, [5, 1, Date.now(), Date.now() + 1000]);
        }
      });

      db.wait(
        {
          type: "ip",
          key: "1.2.3.4",
        },
        (err, result) => {
          assert.isNull(err);
          assert.isTrue(result.conformant);
          assert.isTrue(result.delayed);
          assert.equal(calls, 2);
          done();
        }
      );

      clock.tick(200);
      clock.restore();
    });
  });

  describe("#put", () => {
    it("should call redis put with correct parameters", (done) => {
      const now = Date.now();
      redisMock.put.callsFake((key, count, size, ttl, drip, cb) => {
        cb(null, [10, now, now, now + 1000]);
      });

      db.put(
        {
          type: "ip",
          key: "1.2.3.4",
          count: 5,
        },
        (err, result) => {
          assert.isNull(err);
          assert.equal(result.remaining, 10);
          assert.equal(result.limit, 10);

          sinon.assert.calledWith(
            redisMock.put,
            "ip:1.2.3.4",
            5, // count
            10, // size
            sinon.match.number, // ttl
            200 // drip interval
          );
          done();
        }
      );
    });
  });

  describe("#del", () => {
    it("should call redis del with correct key", (done) => {
      redisMock.del.callsFake((key, cb) => cb(null, 1));

      db.del(
        {
          key: "test:key",
        },
        (err, result) => {
          assert.isNull(err);
          assert.equal(result, 1);
          sinon.assert.calledWith(redisMock.del, "test:key");
          done();
        }
      );
    });
  });

  describe("#get", () => {
    it("should return bucket info", (done) => {
      redisMock.hmget.callsFake((key, r, d, cb) => {
        cb(null, [5, Date.now()]);
      });

      db.get(
        {
          type: "ip",
          key: "1.2.3.4",
        },
        (err, result) => {
          assert.isNull(err);
          assert.equal(result.remaining, 5);
          assert.equal(result.limit, 10);
          assert.isNumber(result.reset);
          done();
        }
      );
    });
  });

  describe("#configurateBuckets", () => {
    it("should update buckets configuration", () => {
      assert.equal(db.buckets.ip.size, 10);
      assert.equal(db.buckets.ip.per_interval, 5);
      assert.equal(db.buckets.ip.interval, 1000);

      db.configurateBuckets({
        ip: { size: 5, per_second: 1 },
      });
      assert.equal(db.buckets.ip.size, 5);
      assert.equal(db.buckets.ip.per_interval, 1);
      assert.equal(db.buckets.ip.interval, 1000);
    });
  });

  describe("#configurateBucket", () => {
    it("should add new bucket configuration", () => {
      db.configurateBucket("test", { size: 5, per_second: 1 });
      assert.equal(db.buckets.test.size, 5);
      assert.equal(db.buckets.test.per_interval, 1);
      assert.equal(db.buckets.test.interval, 1000);
    });
  });

  describe("#bucketKeyConfig", () => {
    beforeEach(() => {
      db.configurateBucket("test", {
        size: 10,
        per_second: 5, // Will be normalized to per_interval: 5, interval: 1000
        overrides: {
          "exact-match": {
            size: 20,
            per_second: 10,
          },
          "override-with-erl": {
            elevated_limits: {
              size: 100,
              per_second: 50,
            },
          },
          "pattern-match": {
            match: "^pattern-.*",
            size: 30,
          },
          "local-ips": {
            match: "^192\\.168\\.",
            size: 40,
          },
          expired: {
            size: 50,
            until: new Date(Date.now() - 1000), // Past date
          },
          future: {
            size: 60,
            until: new Date(Date.now() + 1000 * 60 * 60), // 1 hour in future
          },
        },
      });
    });

    it("should return config override when provided", () => {
      const config = db.bucketKeyConfig(db.buckets.test, {
        key: "any-key",
        configOverride: { size: 15, per_second: 7 },
      });
      assert.equal(config.size, 15);
      assert.equal(config.per_interval, 7);
      assert.equal(config.interval, 1000); // 1 second in ms
    });

    it("should return exact match from overrides", () => {
      const config = db.bucketKeyConfig(db.buckets.test, {
        key: "exact-match",
      });
      assert.equal(config.size, 20);
      assert.equal(config.per_interval, 10);
      assert.equal(config.interval, 1000);
    });

    it("should handle override with only elevated limits", () => {
      const config = db.bucketKeyConfig(db.buckets.test, {
        key: "override-with-erl",
      });
      assert.equal(config.size, 10); // Base config
      assert.equal(config.per_interval, 5); // Base config
      assert.equal(config.interval, 1000);
      // Assert only the properties we care about in elevated_limits
      assert.equal(config.elevated_limits.size, 100);
      assert.equal(config.elevated_limits.per_interval, 50);
      assert.equal(config.elevated_limits.interval, 1000);
    });

    it("should return regex match from overrides", () => {
      const config = db.bucketKeyConfig(db.buckets.test, {
        key: "pattern-123",
      });
      assert.equal(config.size, 30);
    });

    it("should return IP pattern match from overrides", () => {
      const config = db.bucketKeyConfig(db.buckets.test, {
        key: "192.168.1.1",
      });
      assert.equal(config.size, 40);
    });

    it("should ignore expired overrides", () => {
      const config = db.bucketKeyConfig(db.buckets.test, {
        key: "expired",
      });
      assert.equal(config.size, 10); // Default size
    });

    it("should use future overrides", () => {
      const config = db.bucketKeyConfig(db.buckets.test, {
        key: "future",
      });
      assert.equal(config.size, 60);
    });

    it("should return cached match for repeated regex lookups", () => {
      const key = "pattern-123";
      // First call should cache
      const config1 = db.bucketKeyConfig(db.buckets.test, { key });
      assert.equal(config1.size, 30);

      // Modify cache to verify next call uses cached value
      db.buckets.test.overridesCache.set(key, { size: 999 });

      const config2 = db.bucketKeyConfig(db.buckets.test, { key });
      assert.equal(config2.size, 999);
    });

    it("should handle keys with hashtags", () => {
      const config = db.bucketKeyConfig(db.buckets.test, {
        key: "{exact-match}",
      });
      assert.equal(config.size, 20);
    });

    it("should return base config when no matches found", () => {
      const config = db.bucketKeyConfig(db.buckets.test, {
        key: "no-match",
      });
      assert.equal(config.size, 10);
      assert.equal(config.per_interval, 5);
      assert.equal(config.interval, 1000);
    });

    it("should normalize temporal values in returned config", () => {
      const config = db.bucketKeyConfig(db.buckets.test, {
        key: "exact-match",
      });
      assert.exists(config.per_interval);
      assert.exists(config.interval);
      assert.exists(config.ms_per_interval);
    });

    describe("fixed_window behavior", () => {
      beforeEach(() => {
        db.configurateBucket("fixed-window-test", {
          size: 10,
          per_second: 5,
          fixed_window: true, // Base fixed_window config
          overrides: {
            "override-fixed-window": {
              size: 20,
              fixed_window: false, // Override base fixed_window
            },
            "inherit-fixed-window": {
              size: 30,
              // Should inherit fixed_window from base
            },
            "pattern-fixed-window": {
              match: "^pattern-.*",
              size: 40,
              // Should inherit fixed_window from base
            },
          },
        });
      });

      it("should inherit base fixed_window in overrides when not specified", () => {
        const config = db.bucketKeyConfig(db.buckets["fixed-window-test"], {
          key: "inherit-fixed-window",
        });
        assert.equal(config.size, 30);
        assert.isTrue(config.fixed_window);
      });

      it("should respect override-specific fixed_window value", () => {
        const config = db.bucketKeyConfig(db.buckets["fixed-window-test"], {
          key: "override-fixed-window",
        });
        assert.equal(config.size, 20);
        assert.isFalse(config.fixed_window);
      });

      it("should inherit base fixed_window in regex matches", () => {
        const config = db.bucketKeyConfig(db.buckets["fixed-window-test"], {
          key: "pattern-123",
        });
        assert.equal(config.size, 40);
        assert.isTrue(config.fixed_window);
      });

      it("should respect override fixed_window in config override", () => {
        const config = db.bucketKeyConfig(db.buckets["fixed-window-test"], {
          key: "any-key",
          configOverride: { size: 15, fixed_window: false },
        });
        assert.equal(config.size, 15);
        assert.isFalse(config.fixed_window);
      });

      it("should inherit base fixed_window in config override when not specified", () => {
        const config = db.bucketKeyConfig(db.buckets["fixed-window-test"], {
          key: "any-key",
          configOverride: { size: 15 },
        });
        assert.equal(config.size, 15);
        assert.isTrue(config.fixed_window);
      });
    });
  });

  describe("#takeExponential", () => {
    it("should call redis takeExponential with correct parameters", (done) => {
      const now = Date.now();
      redisMock.takeExponential.callsFake(
        (key, ms, size, count, ttl, drip, factor, unit, fixed, cb) => {
          cb(null, [5, 1, now, now + 1000, 2, 1000, now + 2000]);
        }
      );

      db.takeExponential(
        {
          type: "ip",
          key: "1.2.3.4",
        },
        (err, result) => {
          assert.isNull(err);
          assert.isTrue(result.conformant);
          assert.equal(result.remaining, 5);
          assert.equal(result.backoff_factor, 2);
          assert.equal(result.backoff_time, 1000);
          done();
        }
      );
    });
  });

  describe("#takeElevated", () => {
    it("should call redis takeElevated with correct parameters", (done) => {
      const now = Date.now();
      redisMock.takeElevated.callsFake(
        (
          key,
          active,
          quota,
          ms,
          size,
          count,
          ttl,
          drip,
          fixed,
          erlMs,
          erlSize,
          period,
          quota_max,
          exp,
          config,
          cb
        ) => {
          cb(null, [5, 1, now, now + 1000, 1, 1, 10]);
        }
      );

      db.configurateBucket("elevated", {
        size: 10,
        per_second: 5,
        elevated_limits: {
          size: 20,
          per_second: 10,
        },
      });

      db.takeElevated(
        {
          type: "elevated",
          key: "test",
          elevated_limits: {
            erl_is_active_key: "active",
            erl_quota_key: "quota",
            erl_activation_period_seconds: 900,
            quota_per_calendar_month: 100,
          },
        },
        (err, result) => {
          assert.isNull(err);
          assert.isTrue(result.conformant);
          assert.equal(result.remaining, 5);
          assert.isTrue(result.elevated_limits.triggered);
          assert.isTrue(result.elevated_limits.activated);
          done();
        }
      );
    });
  });

  describe("#resetAll", () => {
    it("should call flushdb on all master nodes", (done) => {
      redisMock.nodes = () => [redisMock];
      redisMock.flushdb = sinon.stub().callsFake((cb) => cb());

      db.resetAll((err) => {
        assert.isNull(err);
        assert.isTrue(redisMock.flushdb.called);
        done();
      });
    });
  });
});
