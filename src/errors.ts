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

  constructor(
    message: string,
    opts: { code?: ErrorCode; status?: number; param?: string | null } = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.code = opts.code;
    this.status = opts.status;
    this.param = opts.param ?? null;
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

/** 422 / 400 — the request was rejected. `param` names the offending field. */
export class ValidationError extends NoneCapError {}

/** 404 — no such resource. */
export class NotFoundError extends NoneCapError {}

/** 409 — the solve is already in a terminal state (e.g. cancelling a finished solve). */
export class ConflictError extends NoneCapError {}

/** 429 — too many concurrent solves, or rate limited. Back off and retry. */
export class RateLimitError extends NoneCapError {}

/** 5xx, or a response that wasn't the expected shape. */
export class APIError extends NoneCapError {}

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
): NoneCapError {
  const opts = { code, status, param };
  switch (code) {
    case "unauthorized":
      return new AuthenticationError(message, opts);
    case "forbidden":
    case "account_locked":
      return new PermissionError(message, opts);
    case "insufficient_credits":
      return new InsufficientCreditsError(message, opts);
    case "invalid_request":
    case "validation_error":
      return new ValidationError(message, opts);
    case "not_found":
      return new NotFoundError(message, opts);
    case "conflict":
      return new ConflictError(message, opts);
    case "rate_limited":
    case "concurrency_limit_exceeded":
    case "ext_daily_limit":
      return new RateLimitError(message, opts);
    default:
      return new APIError(message, opts);
  }
}
