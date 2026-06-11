<h1 align="center">nonecap</h1>

<p align="center">
  <a href="https://github.com/nonecap/nonecap-js/actions/workflows/ci.yml"><img src="https://github.com/nonecap/nonecap-js/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/nonecap"><img src="https://img.shields.io/npm/v/nonecap.svg" alt="npm"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
</p>

<p align="center">Official TypeScript client for the <a href="https://nonecap.com">NoneCap</a> hCaptcha solving API.</p>

Submit a captcha, get back a token. The client handles the polling, the timeouts, and the error cases so you do not have to write the fetch loop yourself.

## Install

```sh
npm install nonecap
```

Works on Node 18+, Bun, Deno, and edge runtimes. No dependencies.

## Quick start

Grab an API key from [dashboard.nonecap.com](https://dashboard.nonecap.com), then:

```ts
import { NoneCap } from "nonecap";

const nc = new NoneCap({ apiKey: process.env.NONECAP_KEY! });

const solve = await nc.solve({
  type: "hcaptcha",
  sitekey: "10000000-ffff-ffff-ffff-000000000001",
  url: "https://example.com/login",
});

console.log(solve.token); // the hCaptcha token, ready to submit
```

`solve()` submits the captcha and waits until it is done, using the API's long-poll so you are not hammering it with requests. It returns the solved solve, or throws if the solve fails or your timeout runs out.

## Handling failures

Every error this library throws extends `NoneCapError`, so you can catch the whole family or pick out the one you care about.

```ts
import {
  NoneCap,
  SolveFailedError,
  InsufficientCreditsError,
  RateLimitError,
} from "nonecap";

try {
  const { token } = await nc.solve({ type: "hcaptcha", sitekey, url });
  // use token
} catch (err) {
  if (err instanceof SolveFailedError) {
    console.error("Could not solve it:", err.solve.error?.code);
  } else if (err instanceof InsufficientCreditsError) {
    console.error("Out of credits. Top up at dashboard.nonecap.com");
  } else if (err instanceof RateLimitError) {
    console.error("Too many in flight, back off and retry");
  } else {
    throw err;
  }
}
```

The error subclasses are `AuthenticationError` (401), `PermissionError` (403), `InsufficientCreditsError` (402), `ValidationError` (422/400, with a `param` naming the bad field), `NotFoundError` (404), `ConflictError` (409), `RateLimitError` (429), `APIError` (5xx), and `ConnectionError` (the request never landed). `SolveFailedError` carries the full `solve` so you can read `solve.error` and the timing fields.

## Enterprise captchas

For `hcaptcha_enterprise`, `rqdata` is required. The types enforce it, so leaving it out is a compile error, not a runtime surprise.

```ts
const { token } = await nc.solve({
  type: "hcaptcha_enterprise",
  sitekey,
  url,
  rqdata: "...", // required for enterprise
});
```

## Proxies

Pass a proxy as a structured object or a URL string. Solves run through it, and the bytes are metered back on the solve.

```ts
await nc.solve({
  type: "hcaptcha",
  sitekey,
  url,
  proxy: { scheme: "http", host: "1.2.3.4", port: 8080, username: "u", password: "p" },
  // or: proxy: "http://u:p@1.2.3.4:8080"
});
```

## Lower-level API

`solve()` is the convenient path. When you want control over submission and polling, the raw resource methods map one to one to the REST API.

```ts
// Submit without waiting: returns immediately with a pending solve
const pending = await nc.solves.create({ type: "hcaptcha", sitekey, url });

// Submit and hold the connection up to 30s for it to finish
const maybeDone = await nc.solves.create({ type: "hcaptcha", sitekey, url }, { wait: 30 });

// Poll one solve, long-polling up to 30s
const solve = await nc.solves.retrieve(pending.id, { wait: 30 });

// Cancel a pending or in-flight solve
await nc.solves.cancel(pending.id);

// List a page of solves
const page = await nc.solves.list({ limit: 50, status: "solved" });

// Or iterate every solve, newest first
for await (const s of nc.solves.listAll()) {
  console.log(s.id, s.status);
}

// Your account and credit balance
const me = await nc.me();
console.log(me.credits_balance);
```

## Cancelling and timeouts

Pass an `AbortSignal` to cancel any call, and a `timeout` to bound how long `solve()` waits.

```ts
const ac = new AbortController();
setTimeout(() => ac.abort(), 60_000);

await nc.solve(
  { type: "hcaptcha", sitekey, url },
  { timeout: 120_000, signal: ac.signal },
);
```

## Configuration

```ts
new NoneCap({
  apiKey: "nc_live_...",        // required
  baseURL: "https://api.nonecap.com", // override if you need to
  timeout: 100_000,             // per HTTP request, ms
  fetch: customFetch,           // inject your own fetch
});
```

## License

MIT, see [LICENSE](LICENSE).
