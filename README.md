[![Build Status](https://travis-ci.org/auth0/limitd-redis.svg?branch=master)](https://travis-ci.org/auth0/limitd-redis)

`limitd-redis` is client for limits on top of `redis` using [Token Buckets](https://en.wikipedia.org/wiki/Token_bucket).
It's a fork from [LimitDB](https://github.com/limitd/limitdb).

## Installation

```
npm i limitd-redis
```

## Configure

Create an instance of `limitd-redis` as follows:

```js
const Limitd = require('limitd-redis');

const limitd = new Limitd({
  uri: 'localhost',
  //or
  nodes: [{
    port: 7000,
    host: 'localhost'
  }],
  buckets: {
    ip: {
      size: 10,
      per_second: 5
    }
  },
  prefix: 'test:'
});
```

Options available:

- `uri` (string): Redis Connection String.
- `nodes` (array): [Redis Cluster Configuration](https://github.com/luin/ioredis#cluster).
- `buckets` (object): Setup your bucket types.
- `prefix` (string): Prefix keys in Redis.

Buckets:

- `size` (number): is the maximun content of the bucket. This is the maximun burst you allow.
- `per_interval` (number): is the amount of tokens that the bucket receive on every interval.
- `interval` (number): defines the inverval in milliseconds.
- `unlimited` (boolean = false): unlimited requests (skip take).
- `fixed_window` (boolean = false): refill at specified interval instead of granular.

You can also define your rates using `per_second`, `per_minute`, `per_hour`, `per_day`. So `per_second: 1` is equivalent to `per_interval: 1, interval: 1000`.

If you omit `size`, limitdb assumes that `size` is the value of `per_interval`. So `size: 10, per_second: 10` is the same than `per_second: 10`.

If you don't specify a filling rate with `per_interval` or any other `per_x`, the bucket is fixed and you have to manually reset it using `PUT`.

You can also define `overrides` inside your type definitions as follows:

```js
buckets = {
  ip: {
    size: 10,
    per_second: 5,
    overrides: {
      '127.0.0.1': {
        size: 100,
        per_second: 50
      }
    }
  }
}
```

In this case the specific bucket for `127.0.0.1` of type `ip` will have a greater limit.

It is also possible to define overrides by regex:

```js
overrides: {
  'local-ips': {
    match:      /192\.168\./
    size:       100,
    per_second: 50
  }
}
```

It's possible to configure expiration of overrides:

```js
overrides: {
  '54.32.12.31': {
    size:       100,
    per_second: 50,
    until:      new Date(2016, 4, 1)
  }
}
```

## Breaking changes from `Limitdb`

* Elements will have a default TTL of a week unless specified otherwise.

## TAKE

```js
limitd.take(type, key, [count], (err, result) => {
  console.log(result);
});
```

`limitd.take` takes the following arguments:

-  `type`: the bucket type.
-  `key`: the identifier of the bucket.
-  `count`: the amount of tokens you need. This is optional and the default is 1.
-  `configOverride`: caller-provided bucket configuration for this operation

The result object has:

-  `conformant` (boolean): true if the requested amount is conformant to the limit.
-  `remaining` (int): the amount of remaining tokens in the bucket.
-  `reset` (int / unix timestamp): unix timestamp of the date when the bucket will be full again.
-  `limit` (int): the size of the bucket.

## PUT

You can manually reset a fill a bucket using PUT:

```js
limitd.put(type, key, [count], (err, result) => {
  console.log(result);
});
```

`limitd.put` takes the following arguments:

-  `type`: the bucket type.
-  `key`: the identifier of the bucket.
-  `count`: the amount of tokens you want to put in the bucket. This is optional and the default is the size of the bucket.
-  `configOverride`: caller-provided bucket configuration for this operation

## Overriding Configuration at Runtime
Since the method of storing overrides for buckets in memory does not scale to a large number, limitd-redis provides a way for callers to pass in configuration from an external data store.  The shape of this `configOverride` parameter (available on `take`, `put`, `get`, and `wait`) is exactly the same as `Buckets` above ^.

An example configuration override call might look like this:

```js
const configOverride = {
  size: 45,
  per_hour: 15
}
// take one
limitd.take(type, key, { configOverride }, (err, result) => {
  console.log(result);
}
// take multiple
limitd.take(type, key, { count: 3, configOverride }, (err, result) => {
  console.log(result);
}););
```

Config overrides follow the same rules as Bucket configuration elements with respect to default size when not provided and ttl.

## Author

[Auth0](auth0.com)

## License

This project is licensed under the MIT license. See the [LICENSE](LICENSE) file for more info.
