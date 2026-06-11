/**
 * Official TypeScript / JavaScript client for the NoneCap hCaptcha solving API.
 *
 * @packageDocumentation
 */

export { NoneCap, isTerminal } from "./client.js";
export type {
  NoneCapOptions,
  WaitOptions,
  SolveHelperOptions,
  FetchLike,
} from "./client.js";

export {
  NoneCapError,
  AuthenticationError,
  PermissionError,
  InsufficientCreditsError,
  ValidationError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  APIError,
  ConnectionError,
  SolveFailedError,
  TimeoutError,
} from "./errors.js";

export type {
  SolveType,
  SolveStatus,
  Solve,
  SolveError,
  SolveCreateParams,
  SolveListParams,
  SolveList,
  Proxy,
  Account,
  ErrorCode,
  ErrorEnvelope,
} from "./types.js";
