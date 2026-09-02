import type { ErrorCode, Solve } from "./types.js";

/**
 * Base class for every error this library throws. Catch `NoneCapError` to
 * handle all of them, or catch a subclass to handle one kind.
 */
export class NoneCapError extends Error {
  /** Machine-readable error code from the API envelope, when there is one. */
  readonly code: ErrorCode | undefined;
  /** HTTP status, when the error came from a response. */
  readonly status: number | undefined;
  /** The request field that was rejected, for validation errors. */
  readonly param: string | null;
  /** The API's correlation id for this request (`X-Request-Id`); quote it to support. */
  readonly requestId: string | undefined;
  /** Seconds to wait before retrying, when the API sent `Retry-After`. */
  readonly retryAfter: number | undefined;

  constructor(
    message: string,
    opts: {
      code?: ErrorCode;
      status?: number;
      param?: string | null;
      requestId?: string;
      retryAfter?: number;
    } = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.code = opts.code;
    this.status = opts.status;
    this.param = opts.param ?? null;
    this.requestId = opts.requestId;
    this.retryAfter = opts.retryAfter;
    // Restore the prototype chain when compiled down to ES5-era targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 401 — the API key is missing, malformed, or revoked. */
export class AuthenticationError extends NoneCapError {}

/** 403 — the key is valid but not allowed to do this (scope or locked account). */
export class PermissionError extends NoneCapError {}

/** 402 — the account is out of credits. */
export class InsufficientCreditsError extends NoneCapError {}

/** 402 — this API key reached its own credit limit (the account may still have credits). */
export class KeyCreditLimitError extends InsufficientCreditsError {}

/** 422 / 400 — the request was rejected. `param` names the offending field. */
export class ValidationError extends NoneCapError {}

/** 413 — the request body exceeds the route's size limit. */
export class PayloadTooLargeError extends ValidationError {}

/** 415 — a JSON route was called without `Content-Type: application/json`. */
export class UnsupportedMediaTypeError extends ValidationError {}

/** 404 — no such resource. */
export class NotFoundError extends NoneCapError {}

/** 409 — the solve is already in a terminal state (e.g. cancelling a finished solve). */
export class ConflictError extends NoneCapError {}

/** 429 — back off and retry; `retryAfter` (seconds) is set when the API sent it. */
export class RateLimitError extends NoneCapError {}

/** 429 — too many solves in flight for this account. Wait for one to finish. */
export class ConcurrencyLimitError extends RateLimitError {}

/** 429 — hCaptcha is refusing challenges for this sitekey, so the submit was shed.
 *  Wait `retryAfter` seconds; the message says whether a different proxy pool can help. */
export class SitekeyRateLimitedError extends RateLimitError {}

/** 5xx, or a response that wasn't the expected shape. `requestId` is the id to quote. */
export class APIError extends NoneCapError {}

/** 503 — new solves are paused for maintenance. Retry shortly. */
export class ServiceUnavailableError extends APIError {}

/** The request never reached the API (DNS, TCP, TLS, timeout, offline). */
export class ConnectionError extends NoneCapError {}

/**
 * Thrown by {@link NoneCap.solve} when a solve reaches a terminal state without
 * a token: `failed`, `expired`, or `cancelled`. The full solve is attached so
 * you can inspect `solve.error` and timings.
 */
export class SolveFailedError extends NoneCapError {
  readonly solve: Solve;

  constructor(solve: Solve) {
    const detail = solve.error ? `${solve.error.code}: ${solve.error.message}` : solve.status;
    super(`Solve ${solve.id} ${solve.status} (${detail})`, {
      code: undefined,
      status: undefined,
    });
    this.solve = solve;
  }

  /** `solve.error.code`, e.g. `proxy_error`; the status when no error object came back. */
  get solveCode(): string {
    return this.solve.error?.code ?? this.solve.status;
  }

  /** `solve.error.reason`, the typed sub-reason, or null. */
  get reason(): string | null {
    return this.solve.error?.reason ?? null;
  }

  /** Whether re-submitting the same request unchanged can succeed. */
  get retryable(): boolean {
    return this.solve.error?.retryable ?? false;
  }
}

/**
 * Thrown by {@link NoneCap.solve} (and {@link SolveHandle.result}) when the
 * client-side timeout elapses first. When the timeout came from waiting on a
 * solve, `solveId` and the last-known `solve` are attached so you can still
 * cancel the in-flight solve. They are `undefined` for transport-level timeouts.
 */
export class TimeoutError extends NoneCapError {
  /** The id of the in-flight solve, when the timeout came from a solve wait. */
  readonly solveId: string | undefined;
  /** The last-known solve state, so you can cancel it after a wait timed out. */
  readonly solve: Solve | undefined;

  constructor(
    message: string,
    opts: {
      code?: ErrorCode;
      status?: number;
      param?: string | null;
      solveId?: string;
      solve?: Solve;
    } = {},
  ) {
    super(message, opts);
    this.solveId = opts.solveId;
    this.solve = opts.solve;
  }
}

/** Map an API error envelope (plus HTTP status) to the right error subclass. */
export function errorFromResponse(
  status: number,
  code: ErrorCode | undefined,
  message: string,
  param: string | null,
  extra: { requestId?: string; retryAfter?: number } = {},
): NoneCapError {
  const opts = { code, status, param, ...extra };
  switch (code) {
    case "unauthorized":
      return new AuthenticationError(message, opts);
    case "forbidden":
    case "account_locked":
      return new PermissionError(message, opts);
    case "insufficient_credits":
      return new InsufficientCreditsError(message, opts);
    case "key_credit_limit_exceeded":
      return new KeyCreditLimitError(message, opts);
    case "invalid_request":
    case "validation_error":
    case "expired_window":
      return new ValidationError(message, opts);
    case "payload_too_large":
      return new PayloadTooLargeError(message, opts);
    case "unsupported_media_type":
      return new UnsupportedMediaTypeError(message, opts);
    case "not_found":
    case "not_eligible":
      return new NotFoundError(message, opts);
    case "conflict":
      return new ConflictError(message, opts);
    case "concurrency_limit_exceeded":
      return new ConcurrencyLimitError(message, opts);
    case "sitekey_rate_limited":
      return new SitekeyRateLimitedError(message, opts);
    case "rate_limited":
    case "ext_daily_limit":
      return new RateLimitError(message, opts);
    case "maintenance":
      return new ServiceUnavailableError(message, opts);
    default:
      return new APIError(message, opts);
  }
}
