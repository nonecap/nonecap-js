import {
  APIError,
  ConflictError,
  ConnectionError,
  NoneCapError,
  SolveFailedError,
  TimeoutError,
  errorFromResponse,
} from "./errors.js";
import type {
  Account,
  ErrorCode,
  Solve,
  SolveCreateParams,
  SolveList,
  SolveListParams,
  SolveStatus,
} from "./types.js";

const DEFAULT_BASE_URL = "https://api.nonecap.com";
/** The API caps server-side long-poll at 90 seconds. */
const MAX_WAIT_SECONDS = 90;
const TERMINAL: ReadonlySet<SolveStatus> = new Set([
  "solved",
  "failed",
  "cancelled",
  "expired",
]);

/** Is this a terminal solve status? */
export function isTerminal(status: SolveStatus): boolean {
  return TERMINAL.has(status);
}

/** A `fetch` implementation. Defaults to the global `fetch`. */
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** Options for constructing a {@link NoneCap} client. */
export interface NoneCapOptions {
  /** Your NoneCap API key. Find it at https://dashboard.nonecap.com. */
  apiKey: string;
  /** Override the API base URL. Defaults to https://api.nonecap.com. */
  baseURL?: string;
  /**
   * Per-request timeout in milliseconds for a single HTTP call. Defaults to
   * 100000 (just above the 90s server long-poll). Note this bounds one HTTP
   * round trip, not the whole {@link NoneCap.solve} wait — use the `timeout`
   * option on `solve()` for that.
   */
  timeout?: number;
  /** Inject a custom `fetch` (for testing, proxies, or non-standard runtimes). */
  fetch?: FetchLike;
}

/** Per-call options for the long-polling endpoints. */
export interface WaitOptions {
  /**
   * Hold the connection open up to this many seconds (1–90) waiting for the
   * solve to finish before responding. Omit to return immediately.
   */
  wait?: number;
  /** Abort the request. */
  signal?: AbortSignal;
}

/** Options for {@link NoneCap.solve} and {@link SolveHandle.result}. */
export interface SolveHelperOptions {
  /**
   * Give up after this many milliseconds and throw {@link TimeoutError}.
   * Defaults to 180000 (3 minutes).
   */
  timeout?: number;
  /** Abort waiting. */
  signal?: AbortSignal;
}

/** Options for {@link NoneCap.solves.start}. */
export interface SolveStartOptions {
  /** Abort the submission. */
  signal?: AbortSignal;
}

interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  signal?: AbortSignal;
  /** Override the per-request timeout for this call (used by long polls). */
  timeout?: number;
  /** HTTP statuses to treat as success in addition to 2xx (e.g. 202). */
  expect?: number[];
}

/**
 * The NoneCap API client.
 *
 * ```ts
 * const nc = new NoneCap({ apiKey: process.env.NONECAP_KEY! });
 * const { token } = await nc.solve({ type: "hcaptcha", sitekey, url });
 * ```
 */
export class NoneCap {
  readonly #apiKey: string;
  readonly #baseURL: string;
  readonly #timeout: number;
  readonly #fetch: FetchLike;

  constructor(options: NoneCapOptions) {
    if (!options || !options.apiKey) {
      throw new NoneCapError(
        "A NoneCap API key is required. Pass it as `new NoneCap({ apiKey })`.",
      );
    }
    this.#apiKey = options.apiKey;
    this.#baseURL = (options.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#timeout = options.timeout ?? 100_000;
    const f = options.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (!f) {
      throw new NoneCapError(
        "No `fetch` available. Use Node 18+, or pass a `fetch` in the client options.",
      );
    }
    this.#fetch = f;
  }

  /** Operations on solves. */
  readonly solves = {
    /** Submit a solve. Pass `{ wait }` to hold the connection until it finishes. */
    create: (params: SolveCreateParams, options: WaitOptions = {}): Promise<Solve> =>
      this.#request<Solve>("POST", "/v1/solves", {
        body: params,
        query: { wait: options.wait },
        signal: options.signal,
        timeout: this.#timeoutForWait(options.wait),
        expect: [202],
      }),

    /** Fetch a solve by id. Pass `{ wait }` to long-poll until it finishes. */
    retrieve: (id: string, options: WaitOptions = {}): Promise<Solve> =>
      this.#request<Solve>("GET", `/v1/solves/${encodeURIComponent(id)}`, {
        query: { wait: options.wait },
        signal: options.signal,
        timeout: this.#timeoutForWait(options.wait),
        expect: [202],
      }),

    /** Cancel a pending or in-flight solve. */
    cancel: (id: string, options: { signal?: AbortSignal } = {}): Promise<Solve> =>
      this.#request<Solve>("DELETE", `/v1/solves/${encodeURIComponent(id)}`, {
        signal: options.signal,
      }),

    /**
     * Submit a solve and return a {@link SolveHandle} for it.
     *
     * Unlike {@link NoneCap.solve}, this returns as soon as the submission is
     * accepted, so `handle.id` is available immediately. Use the handle to
     * `cancel()` the solve or `await handle.result()` for the finished solve.
     *
     * ```ts
     * const handle = await nc.solves.start({ type: "hcaptcha", sitekey, url });
     * // ...later, e.g. on shutdown:
     * await handle.cancel();
     * // or wait for it:
     * const { token } = await handle.result();
     * ```
     */
    start: async (
      params: SolveCreateParams,
      options: SolveStartOptions = {},
    ): Promise<SolveHandle> => {
      const solve = await this.solves.create(params, { signal: options.signal });
      return new SolveHandle(this, solve);
    },

    /** Fetch one page of solves. */
    list: (params: SolveListParams = {}, options: { signal?: AbortSignal } = {}): Promise<SolveList> =>
      this.#request<SolveList>("GET", "/v1/solves", {
        query: {
          limit: params.limit,
          starting_after: params.starting_after,
          status: params.status,
          type: params.type,
        },
        signal: options.signal,
      }),

    /**
     * Iterate every solve across pages, newest first.
     *
     * ```ts
     * for await (const solve of nc.solves.listAll()) { ... }
     * ```
     */
    listAll: (
      params: SolveListParams = {},
      options: { signal?: AbortSignal } = {},
    ): AsyncIterableIterator<Solve> => this.#listAll(params, options),
  };

  /** Fetch your account, including the current credit balance. */
  me(options: { signal?: AbortSignal } = {}): Promise<Account> {
    return this.#request<Account>("GET", "/v1/me", { signal: options.signal });
  }

  /**
   * Submit a solve and wait for it to finish, returning the solved solve.
   *
   * Uses the server's long-poll under the hood and keeps polling until the
   * solve is terminal or `timeout` elapses. Throws {@link SolveFailedError} if
   * the solve fails/expires/is cancelled, or {@link TimeoutError} on timeout.
   *
   * This is sugar for `(await solves.start(params)).result(options)`. When you
   * need to cancel the solve while it runs, use {@link NoneCap.solves.start}
   * and keep the {@link SolveHandle}.
   */
  async solve(params: SolveCreateParams, options: SolveHelperOptions = {}): Promise<Solve> {
    const handle = await this.solves.start(params, { signal: options.signal });
    return handle.result(options);
  }

  // -- internals ------------------------------------------------------------

  #timeoutForWait(wait?: number): number | undefined {
    if (wait === undefined) return undefined;
    // Give the socket a margin beyond the server's long-poll window.
    return wait * 1000 + 15_000;
  }

  async *#listAll(
    params: SolveListParams,
    options: { signal?: AbortSignal },
  ): AsyncIterableIterator<Solve> {
    let cursor = params.starting_after;
    for (;;) {
      const page = await this.solves.list({ ...params, starting_after: cursor }, options);
      for (const solve of page.data) yield solve;
      if (!page.has_more || page.data.length === 0) return;
      cursor = page.data[page.data.length - 1]!.id;
    }
  }

  async #request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(this.#baseURL + path);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#apiKey}`,
      Accept: "application/json",
    };
    let bodyInit: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      bodyInit = JSON.stringify(options.body);
    }

    const controller = new AbortController();
    const timeoutMs = options.timeout ?? this.#timeout;
    const timer = setTimeout(() => controller.abort(new TimeoutError(`Request timed out after ${timeoutMs}ms.`)), timeoutMs);
    const onAbort = () => controller.abort(options.signal?.reason);
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    let res: Response;
    try {
      res = await this.#fetch(url.toString(), {
        method,
        headers,
        body: bodyInit,
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof TimeoutError) throw err;
      if (isAbort(err)) {
        // A caller-supplied signal aborting surfaces as the caller's reason.
        if (options.signal?.aborted) throw options.signal.reason instanceof Error
          ? options.signal.reason
          : new NoneCapError("Request aborted.");
        throw new TimeoutError(`Request timed out after ${timeoutMs}ms.`);
      }
      throw new ConnectionError(
        `Could not reach the NoneCap API at ${this.#baseURL}: ${(err as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }

    return this.#parse<T>(res, options.expect ?? []);
  }

  async #parse<T>(res: Response, expect: number[]): Promise<T> {
    const text = await res.text();
    let json: unknown;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new APIError(
          `Unexpected non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`,
          { status: res.status },
        );
      }
    }

    if (res.ok || expect.includes(res.status)) {
      return json as T;
    }

    const envelope = json as { error?: { code?: ErrorCode; message?: string; param?: string | null } } | undefined;
    const apiError = envelope?.error;
    throw errorFromResponse(
      res.status,
      apiError?.code,
      apiError?.message ?? `HTTP ${res.status}`,
      apiError?.param ?? null,
    );
  }
}

/**
 * A handle on a started solve, returned by {@link NoneCap.solves.start}.
 *
 * The handle is the cancellable lifecycle object for one solve. It is a plain
 * object, not a promise: `await`ing it does nothing useful. Wait for the result
 * with {@link SolveHandle.result}, and cancel with {@link SolveHandle.cancel}.
 * You do not construct it yourself — `solves.start()` hands you one with `id`
 * already resolved.
 */
export class SolveHandle {
  /** The id of the started solve, available as soon as `start()` resolved. */
  readonly id: string;

  readonly #client: NoneCap;
  /** The latest solve state we have seen, from the create, polls, or cancel. */
  #solve: Solve;
  /**
   * The cached TERMINAL outcome: resolves to the solved solve, or rejects with
   * {@link SolveFailedError} if terminal-but-not-solved. Only ever set once the
   * solve actually reaches a terminal state, so it is safe to replay forever. A
   * timed-out wait does NOT settle this — it is retryable.
   */
  #terminal: Promise<Solve> | undefined;
  /** The poll currently in flight, shared by concurrent result() callers. */
  #inflight: Promise<Solve> | undefined;

  constructor(client: NoneCap, solve: Solve) {
    this.#client = client;
    this.#solve = solve;
    this.id = solve.id;
  }

  /** The last-known solve state for this handle. */
  get solve(): Solve {
    return this.#solve;
  }

  /**
   * Long-poll until the solve is terminal, returning the solved solve. Throws
   * {@link SolveFailedError} if it fails/expires/is cancelled, or
   * {@link TimeoutError} on timeout (with `solveId`/`solve` attached so you can
   * still {@link SolveHandle.cancel} it).
   *
   * Memoizes the *terminal* outcome: once the solve actually finishes, every
   * later call returns that same settled result. A {@link TimeoutError} is not
   * memoized — it just means this wait gave up, so a later call (e.g. with a
   * larger `timeout`) resumes polling. Concurrent calls share one in-flight
   * poll, so they never issue duplicate requests. The first caller's
   * `timeout`/`signal` drive the shared poll; a later call starts a fresh one.
   */
  result(options: SolveHelperOptions = {}): Promise<Solve> {
    if (this.#terminal) return this.#terminal;
    if (this.#inflight) return this.#inflight;
    const run = this.#poll(options).finally(() => {
      // Free the slot so a retry can re-poll after a timeout; a terminal
      // outcome is already memoized in #terminal and wins on the next call.
      if (this.#inflight === run) this.#inflight = undefined;
    });
    this.#inflight = run;
    return run;
  }

  /**
   * Cancel the solve. Cancelled solves are never charged, so this is for clean
   * shutdown / freeing slots / stopping early, not cost protection.
   *
   * If the solve already reached a terminal state the API answers 409; that is
   * not an error a caller cares about, so this swallows {@link ConflictError}
   * and returns the current solve state instead. A cancel that lands on a
   * terminal state (cancelled, or whatever the 409-swallow read back) settles
   * this handle's {@link SolveHandle.result}, so any in-flight or later wait
   * stops polling and reflects that terminal state.
   */
  async cancel(options: { signal?: AbortSignal } = {}): Promise<Solve> {
    try {
      this.#solve = await this.#client.solves.cancel(this.id, options);
    } catch (err) {
      if (!(err instanceof ConflictError)) throw err;
      // Already terminal — report the real state rather than the 409.
      this.#solve = await this.#client.solves.retrieve(this.id, options);
    }
    if (!this.#terminal && isTerminal(this.#solve.status)) this.#cacheTerminal();
    return this.#solve;
  }

  /**
   * Build and memoize the terminal outcome from the current `#solve`. The
   * precondition is that `#solve` is terminal and `#terminal` is unset.
   */
  #cacheTerminal(): Promise<Solve> {
    const settled =
      this.#solve.status === "solved"
        ? Promise.resolve(this.#solve)
        : Promise.reject(new SolveFailedError(this.#solve));
    // Never let the memoized rejection surface as an unhandled rejection; real
    // callers read it explicitly through result().
    settled.catch(() => {});
    this.#terminal = settled;
    return settled;
  }

  async #poll(options: SolveHelperOptions): Promise<Solve> {
    const timeout = options.timeout ?? 180_000;
    const deadline = Date.now() + timeout;

    for (;;) {
      // cancel() (or a previous poll) may have already settled this handle.
      if (this.#terminal) return this.#terminal;
      if (isTerminal(this.#solve.status)) return this.#cacheTerminal();
      if (Date.now() >= deadline) {
        throw new TimeoutError(
          `Solve ${this.id} did not finish within ${timeout}ms (last status: ${this.#solve.status}).`,
          { solveId: this.id, solve: this.#solve },
        );
      }
      this.#solve = await this.#client.solves.retrieve(this.id, {
        wait: waitSeconds(deadline),
        signal: options.signal,
      });
    }
  }
}

/**
 * The `wait` value for the next long-poll: whole seconds until `deadline`,
 * clamped to the server's 1–90 window. The floor of 1 keeps the param valid,
 * so callers must decide whether the deadline has passed with the clock, not
 * with this return value.
 */
function waitSeconds(deadline: number): number {
  const remaining = Math.ceil((deadline - Date.now()) / 1000);
  return Math.max(1, Math.min(MAX_WAIT_SECONDS, remaining));
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}
