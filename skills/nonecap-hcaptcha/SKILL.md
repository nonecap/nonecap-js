---
name: nonecap-hcaptcha
description: >-
  Get a valid hCaptcha token from the NoneCap API and submit it in the page's
  h-captcha-response field. Use when an agent meets an hCaptcha widget, an
  "I am human" checkbox or an hCaptcha challenge it cannot pass while browsing
  or automating a site (Playwright, Puppeteer, browser-use, computer use), when
  asked to solve, bypass or get past an hCaptcha or hCaptcha Enterprise
  (rqdata) captcha, or when code calls the nonecap npm package, the nonecap-mcp
  server or api.nonecap.com.
license: MIT
compatibility: Needs network access to api.nonecap.com and a NoneCap API key in NONECAP_API_KEY. The MCP server and the npm package need Node 18+.
metadata:
  author: nonecap
  homepage: https://nonecap.com
---

# Solve hCaptcha with NoneCap

[NoneCap](https://nonecap.com) is a hosted hCaptcha solver. You send the page's sitekey and URL, it returns a real hCaptcha token (`P1_…`), and you submit that token the way the widget would have. Regular, invisible and Enterprise sitekeys all work the same way. Only solves that return a token are charged; failed, cancelled and expired solves are not.

## 1. Get an API key

Sign up at [dashboard.nonecap.com](https://dashboard.nonecap.com/signup) and create a key (`nc_live_…`). Keep it in the environment as `NONECAP_API_KEY`; never paste it into a page, a URL or a log. If no key is set, ask the user for one rather than inventing it.

## 2. Read what the solve needs from the page

| Field | Where to find it |
| --- | --- |
| `sitekey` | The `data-sitekey` attribute on the `.h-captcha` element. For invisible widgets: the `sitekey` passed to `hcaptcha.render()`, or the `sitekey=` parameter in the hCaptcha iframe's `src`. Searching the rendered DOM for `sitekey` finds it. It is a UUID; a `6L…` key is reCAPTCHA, not hCaptcha. |
| `url` | The full URL of the page the captcha is on. |
| `type` | `hcaptcha`, or `hcaptcha_enterprise` when the site runs hCaptcha Enterprise. |
| `rqdata` | Enterprise only, and only when the page's widget config passes one. Read it fresh for each challenge. |
| `user_agent` | Optional: the user agent of the browser that loaded the page, as is. Leave it out if you do not have it. |
| `proxy` | Optional: `scheme://user:pass@host:port` (`http`, `https`, `socks5`, `socks5h`, `socks4`). Must be reachable from the internet, so no `localhost` or private addresses. On Enterprise sitekeys pass the proxy your browser uses, on one sticky exit, so the token is solved and submitted from the same address. |

## 3. Get the token

Pick whichever fits the environment.

### MCP server (Claude Code, Cursor, Claude Desktop, other MCP clients)

Claude Code:

```sh
claude mcp add nonecap --env NONECAP_API_KEY=<your key> -- npx -y -p nonecap@latest nonecap-mcp
```

Other clients take this JSON (`~/.cursor/mcp.json`, `claude_desktop_config.json`, …):

```json
{
  "mcpServers": {
    "nonecap": {
      "command": "npx",
      "args": ["-y", "-p", "nonecap@latest", "nonecap-mcp"],
      "env": { "NONECAP_API_KEY": "<your key>" }
    }
  }
}
```

Then call `solve_hcaptcha` with `sitekey` and `url` (plus `type`, `rqdata`, `user_agent`, `proxy` when they apply). It returns the solve with its `token`, `resp_key` and `user_agent`. If it returns a solve id with status `pending` or `solving` instead, call `get_solve` with that id (set `wait_seconds` to hold for the result). Do not call `solve_hcaptcha` again for the same captcha: that starts and bills a second solve. The other tools are `cancel_solve`, `list_solves`, `get_account` (credit balance and plan solves left today) and `report_solve_outcome`.

### npm package (Node 18+, Bun, Deno, edge runtimes)

```sh
npm install nonecap
```

```ts
import { NoneCap } from "nonecap";

const nc = new NoneCap({ apiKey: process.env.NONECAP_API_KEY! });

const solve = await nc.solve({
  type: "hcaptcha",
  sitekey: "<data-sitekey>",
  url: "https://example.com/login",
});
// solve.token, solve.resp_key, solve.user_agent
```

`solve()` submits and waits for the result. It throws a `NoneCapError` subclass on failure: `SolveFailedError` (the solve failed, not charged; `err.retryable` says whether resubmitting the same request can succeed), `InsufficientCreditsError`, `RateLimitError` (wait `err.retryAfter` seconds), `ValidationError` (`err.param` names the bad field). The [README](../../README.md) covers cancelling, timeouts and the lower-level methods.

### Plain HTTP

```sh
curl "https://api.nonecap.com/v1/solves?wait=30" \
  -H "Authorization: Bearer $NONECAP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type": "hcaptcha", "sitekey": "<data-sitekey>", "url": "https://example.com/login"}'
```

- `?wait=N` (1-90) holds the request until the solve finishes or N seconds pass. `200` means it reached a terminal state; `202` means it is still running with `token: null`.
- On a `202`, poll `GET https://api.nonecap.com/v1/solves/{id}?wait=30` until `status` is `solved`, `failed`, `cancelled` or `expired`. Poll the same id; never resubmit while one is running.
- `status: "solved"` carries `token`, `resp_key` and `user_agent`. `failed` carries `error.code`, `error.message` (what happened and what to do) and `error.retryable`.
- Errors: `401` bad key, `402 insufficient_credits` or `key_credit_limit_exceeded`, `422 validation_error` (`param` names the field), `429` (`concurrency_limit_exceeded`, `sitekey_rate_limited`, `proxy_unavailable`, `rate_capped`, `rate_limited`): wait the `Retry-After` seconds before trying again.
- Full reference: [nonecap.com/api-reference](https://nonecap.com/api-reference/).

## 4. Submit the token

Tokens are single-use and expire within minutes, so solve right before you submit.

In a browser you control (Playwright `page.evaluate`, Puppeteer, CDP, browser-use), put the token in the widget's fields and fire its callback if it has one:

```js
(token) => {
  for (const name of ["h-captcha-response", "g-recaptcha-response"]) {
    document.querySelectorAll(`textarea[name="${name}"]`).forEach((el) => { el.value = token; });
  }
  const cb = document.querySelector("[data-callback]")?.getAttribute("data-callback");
  if (cb && typeof window[cb] === "function") window[cb](token);
}
```

Then submit the form or click the button the user would click. For an HTTP-only flow, send the token as the `h-captcha-response` form field (the site may also read `g-recaptcha-response`).

- Send the request with the solve's `user_agent` as the `User-Agent` header. Some sites refuse a token sent from a different browser version.
- If you passed a `proxy`, submit from the same exit IP.
- Sites that verify the hCaptcha response key too (`hcaptcha.getRespKey()`) need `resp_key` alongside the token.

## 5. Report refused tokens

If the site refuses the token, report it. This is free and is the only way NoneCap learns that a token passed hCaptcha but the site still said no:

```sh
curl https://api.nonecap.com/v1/feedback \
  -H "Authorization: Bearer $NONECAP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"feedback": [{"solve_id": "<solve id>", "outcome": "rejected"}]}'
```

Outcomes are `accepted`, `rejected`, `unknown`, `unused` and `error`. With the npm package: `nc.feedback.report({ solve_id, outcome })`; with MCP: `report_solve_outcome`. If a later solve comes back with a `proxy_session_refused` or `proxy_recommended` entry in `warnings`, follow its `message`.

## When it does not work

- `failed` with `retryable: true`: submit a new solve. A failed solve costs nothing.
- `402`: the account is out of credits. Tell the user to top up at [dashboard.nonecap.com](https://dashboard.nonecap.com); do not loop.
- `422` on `sitekey`: the value is not an hCaptcha sitekey. Re-read it from the page.
- Each error response carries a `request_id`; quote it when contacting support.
