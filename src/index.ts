/**
 * Official TypeScript / JavaScript client for the NoneCap hCaptcha solving API.
 *
 * @packageDocumentation
 */

export { NoneCap, SolveHandle, isTerminal, FEEDBACK_BATCH_MAX } from "./client.js";
export type {
  NoneCapOptions,
  WaitOptions,
  SolveHelperOptions,
  SolveStartOptions,
  FetchLike,
} from "./client.js";

export {
  NoneCapError,
  AuthenticationError,
  PermissionError,
  InsufficientCreditsError,
  KeyCreditLimitError,
  ValidationError,
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  ConcurrencyLimitError,
  SitekeyRateLimitedError,
  APIError,
  ServiceUnavailableError,
  ConnectionError,
  SolveFailedError,
  TimeoutError,
} from "./errors.js";

export type {
  SolveType,
  SolveStatus,
  Solve,
  SolveError,
  SolveErrorCode,
  SolveErrorReason,
  SolveCreateParams,
  SolveListParams,
  SolveList,
  Proxy,
  Account,
  FeedbackOutcome,
  FeedbackReport,
  Feedback,
  FeedbackStatus,
  FeedbackResult,
  FeedbackBatch,
  ErrorCode,
  ErrorEnvelope,
} from "./types.js";
