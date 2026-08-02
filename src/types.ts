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

/**
 * What the downstream target did with a solve's token.
 *
 * Only `accepted` and `rejected` count toward the acceptance rate — the other
 * three are recorded but kept out of the denominator, so a client-side outage
 * can't look like a token-quality regression.
 */
export type FeedbackOutcome =
  /** Downstream accepted the token. */
  | "accepted"
  /** Downstream rejected the token. */
  | "rejected"
  /** Token was submitted but the verdict couldn't be determined. */
  | "unknown"
  /** Token was never submitted downstream (expired, aborted, deduped). */
  | "unused"
  /** Downstream failed for a non-token reason (network, 5xx, maintenance). */
  | "error";

/**
 * One verdict to report, for {@link NoneCap.feedback.report} and
 * {@link NoneCap.feedback.reportMany}.
 */
export interface FeedbackReport {
  /** The solve id returned by `solves.create` / `solve()`. Must be your own, `solved` solve. */
  solve_id: string;
  outcome: FeedbackOutcome;
  /**
   * @deprecated Omit it. A legacy downstream boolean with inverted polarity
   * (`false` = accepted, `true` = rejected), kept working for older
   * integrations. It carries nothing `outcome` does not, and the API rejects an
   * item whose `estado` disagrees with its `outcome`.
   */
  estado?: boolean | null;
  /**
   * Freeform downstream reason or code — whatever your target returned when it
   * refused the token (e.g. `"invalid-response"`). Truncated to 512 chars
   * server-side. Worth populating: it is the only part of a rejection NoneCap
   * cannot observe on its own.
   */
  reason?: string | null;
  /** When the verdict happened. Advisory only — the server stamps its own timestamps. */
  reported_at?: string | Date | null;
}

/** A recorded feedback resource. */
export interface Feedback {
  object: "feedback";
  solve_id: string;
  outcome: FeedbackOutcome;
  estado: boolean | null;
  reason: string | null;
  reported_at: string | null;
  /** How many times this solve's verdict has been written. 1 on first report. */
  report_count: number;
  created_at: string;
  updated_at: string;
}

/** What happened to one item of a batch. */
export type FeedbackStatus =
  /** First report for this solve. */
  | "recorded"
  /** Overwrote an earlier report. */
  | "updated"
  /** Identical to what was already stored — no write. */
  | "unchanged"
  /** Rejected; see `error`. */
  | "error";

/** One item's result, in the same position as the report you sent. */
export interface FeedbackResult {
  solve_id: string;
  status: FeedbackStatus;
  /** Set only when `status === "error"`. Note the bare shape: no `error` wrapper. */
  error: { code: ErrorCode; message: string; param: string | null } | null;
}

/**
 * The result of {@link NoneCap.feedback.reportMany}.
 *
 * Items are resolved independently, so one bad solve id never discards the
 * rest — which also means a broken integration reports zero failures at the
 * HTTP level. Check `failed` (or scan `results`), not just the absence of a
 * thrown error.
 */
export interface FeedbackBatch {
  object: "feedback_batch";
  recorded: number;
  updated: number;
  unchanged: number;
  failed: number;
  /** One entry per report you sent, in request order. */
  results: FeedbackResult[];
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
  /** hCaptcha is rate-limiting this sitekey; the submit was shed. Honour `Retry-After`. */
  | "sitekey_rate_limited"
  /** The submitting API key hit its own spend cap. */
  | "key_credit_limit_exceeded"
  /** Feedback: the solve is missing, not yours, or never produced a token. */
  | "not_eligible"
  /** Feedback: a first report arrived after the reporting window closed. */
  | "expired_window"
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
