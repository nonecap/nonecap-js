/**
 * Wire types for the NoneCap API. Field names are snake_case to match the JSON
 * on the wire exactly, so what you read in the docs is what you write in code.
 */

/** Captcha type a solve targets. */
export type SolveType = "hcaptcha" | "hcaptcha_enterprise";

/** Lifecycle of a solve. `solved` and `failed`/`expired`/`cancelled` are terminal. */
export type SolveStatus =
  | "pending"
  | "solving"
  | "solved"
  | "failed"
  | "cancelled"
  | "expired";

/** Proxy scheme. Defaults to `http` when omitted. */
export type ProxyScheme = "http" | "https" | "socks5" | "socks5h" | "socks4";

/** A proxy the solve should egress through. `host` and `port` are required; the
 *  API rejects a partial proxy object with a 422. `port` must be 1–65535. */
export interface Proxy {
  scheme?: ProxyScheme;
  host: string;
  port: string | number;
  username?: string;
  password?: string;
}

/** Fields common to every solve submission. */
interface SolveCreateBase {
  /** The captcha's sitekey. */
  sitekey: string;
  /** The page URL the captcha is served on. */
  url: string;
  /** User agent to present to the captcha. */
  user_agent?: string;
  /** Proxy to route the solve through, as a structured object or a URL string. */
  proxy?: Proxy | string;
  /** URL to POST the solve to when it reaches a terminal state. */
  webhook_url?: string;
}

/**
 * Parameters for {@link NoneCap.solves.create} and {@link NoneCap.solve}.
 *
 * Modeled as a discriminated union on `type`: `rqdata` is optional for
 * `hcaptcha` but required for `hcaptcha_enterprise`, enforced at compile time.
 */
export type SolveCreateParams =
  | (SolveCreateBase & { type: "hcaptcha"; rqdata?: string })
  | (SolveCreateBase & { type: "hcaptcha_enterprise"; rqdata: string });

/** The error attached to a solve that did not succeed. */
export interface SolveError {
  code: string;
  message: string;
}

/** A solve resource. */
export interface Solve {
  id: string;
  object: "solve";
  type: SolveType;
  status: SolveStatus;
  sitekey: string;
  url: string;
  /** The captcha token once `status === "solved"`, otherwise null. */
  token: string | null;
  /** Set when the solve did not succeed, otherwise null. */
  error: SolveError | null;
  /** Credits charged for this solve. Only successful solves are charged. */
  credits_charged: number | null;
  /** Bytes that egressed through the metered proxy, or null if none was used. */
  proxy_bytes: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  /** Milliseconds the solve waited in the queue before a worker picked it up. */
  queue_ms: number | null;
  /** Milliseconds of actual solving. */
  resolve_ms: number | null;
}

/** Parameters for {@link NoneCap.solves.list}. */
export interface SolveListParams {
  /** Page size, 1–100. Defaults to 20. */
  limit?: number;
  /** Return solves created after this solve id (cursor pagination). */
  starting_after?: string;
  /** Only solves with this status. */
  status?: SolveStatus;
  /** Only solves of this type. */
  type?: SolveType;
}

/** One page of solves. */
export interface SolveList {
  object: "list";
  data: Solve[];
  has_more: boolean;
}

/** Your account, including the current credit balance. */
export interface Account {
  object: "account";
  id: string;
  email: string;
  credits_balance: number;
  created_at: string;
}

/** Error codes returned in the API's error envelope. */
export type ErrorCode =
  | "unauthorized"
  | "forbidden"
  | "account_locked"
  | "insufficient_credits"
  | "invalid_request"
  | "validation_error"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "ext_daily_limit"
  | "concurrency_limit_exceeded"
  | "internal_error"
  | "pool_exhausted";

/** The Stripe-style error envelope every non-2xx response carries. */
export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    param: string | null;
  };
}
