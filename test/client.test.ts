import { describe, it, expect, vi } from "vitest";
import {
  NoneCap,
  SolveHandle,
  AuthenticationError,
  InsufficientCreditsError,
  ValidationError,
  RateLimitError,
  ConflictError,
  NotFoundError,
  APIError,
  SolveFailedError,
  TimeoutError,
  isTerminal,
  type Solve,
  type FetchLike,
} from "../src/index.js";

type Handler = (url: URL, init: RequestInit) => { status: number; body: unknown };

/** A fake fetch that records calls and replies from a queue of handlers. */
function fakeFetch(handlers: Handler[]): { fetch: FetchLike; calls: { url: URL; init: RequestInit }[] } {
  const calls: { url: URL; init: RequestInit }[] = [];
  let i = 0;
  const fetch: FetchLike = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init });
    const handler = handlers[Math.min(i, handlers.length - 1)];
    i++;
    const { status, body } = handler!(url, init);
    return new Response(body === undefined ? "" : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetch, calls };
}

const baseSolve = (over: Partial<Solve> = {}): Solve => ({
  id: "solve_1",
  object: "solve",
  type: "hcaptcha",
  status: "pending",
  sitekey: "sk",
  url: "https://example.com",
  token: null,
  error: null,
  credits_charged: null,
  proxy_bytes: null,
  created_at: "2026-06-11T00:00:00Z",
  started_at: null,
  finished_at: null,
  queue_ms: null,
  resolve_ms: null,
  ...over,
});

function client(handlers: Handler[]) {
  const { fetch, calls } = fakeFetch(handlers);
  return { nc: new NoneCap({ apiKey: "nc_test", fetch }), calls };
}

describe("construction", () => {
  it("requires an api key", () => {
    // @ts-expect-error missing apiKey
    expect(() => new NoneCap({})).toThrow(/api key is required/i);
  });

  it("trims a trailing slash from baseURL", async () => {
    const { nc, calls } = (() => {
      const { fetch, calls } = fakeFetch([() => ({ status: 200, body: baseSolve() })]);
      return { nc: new NoneCap({ apiKey: "k", baseURL: "https://x.test/", fetch }), calls };
    })();
    await nc.solves.retrieve("solve_1");
    expect(calls[0]!.url.toString()).toBe("https://x.test/v1/solves/solve_1");
  });
});

describe("solves.create", () => {
  it("POSTs to /v1/solves with bearer auth and a JSON body", async () => {
    const { nc, calls } = client([() => ({ status: 202, body: baseSolve() })]);
    await nc.solves.create({ type: "hcaptcha", sitekey: "sk", url: "https://e.com" });
    const call = calls[0]!;
    expect(call.init.method).toBe("POST");
    expect(call.url.pathname).toBe("/v1/solves");
    expect((call.init.headers as Record<string, string>).Authorization).toBe("Bearer nc_test");
    expect(JSON.parse(call.init.body as string)).toMatchObject({ type: "hcaptcha", sitekey: "sk" });
  });

  it("passes wait as a query param", async () => {
    const { nc, calls } = client([() => ({ status: 200, body: baseSolve({ status: "solved", token: "t" }) })]);
    await nc.solves.create({ type: "hcaptcha", sitekey: "sk", url: "https://e.com" }, { wait: 30 });
    expect(calls[0]!.url.searchParams.get("wait")).toBe("30");
  });

  it("treats 202 as success, not an error", async () => {
    const { nc } = client([() => ({ status: 202, body: baseSolve({ status: "solving" }) })]);
    const solve = await nc.solves.create({ type: "hcaptcha", sitekey: "sk", url: "https://e.com" });
    expect(solve.status).toBe("solving");
  });
});

describe("solves.list", () => {
  it("forwards list params as query", async () => {
    const { nc, calls } = client([() => ({ status: 200, body: { object: "list", data: [], has_more: false } })]);
    await nc.solves.list({ limit: 50, status: "solved", type: "hcaptcha", starting_after: "solve_9" });
    const q = calls[0]!.url.searchParams;
    expect(q.get("limit")).toBe("50");
    expect(q.get("status")).toBe("solved");
    expect(q.get("type")).toBe("hcaptcha");
    expect(q.get("starting_after")).toBe("solve_9");
  });

  it("listAll walks pages until has_more is false", async () => {
    const page1 = { object: "list", data: [baseSolve({ id: "a" }), baseSolve({ id: "b" })], has_more: true };
    const page2 = { object: "list", data: [baseSolve({ id: "c" })], has_more: false };
    const { nc, calls } = client([
      () => ({ status: 200, body: page1 }),
      () => ({ status: 200, body: page2 }),
    ]);
    const ids: string[] = [];
    for await (const s of nc.solves.listAll()) ids.push(s.id);
    expect(ids).toEqual(["a", "b", "c"]);
    expect(calls[1]!.url.searchParams.get("starting_after")).toBe("b");
  });
});

describe("me", () => {
  it("GETs /v1/me", async () => {
    const account = { object: "account", id: "u_1", email: "a@b.com", credits_balance: 42, created_at: "x" };
    const { nc, calls } = client([() => ({ status: 200, body: account })]);
    const me = await nc.me();
    expect(me.credits_balance).toBe(42);
    expect(calls[0]!.url.pathname).toBe("/v1/me");
  });
});

describe("error mapping", () => {
  const cases: [number, string, new (...a: any[]) => Error][] = [
    [401, "unauthorized", AuthenticationError],
    [402, "insufficient_credits", InsufficientCreditsError],
    [422, "validation_error", ValidationError],
    [429, "concurrency_limit_exceeded", RateLimitError],
    [409, "conflict", ConflictError],
    [404, "not_found", NotFoundError],
    [500, "internal_error", APIError],
  ];
  for (const [status, code, Klass] of cases) {
    it(`maps ${status}/${code} to ${Klass.name}`, async () => {
      const { nc } = client([() => ({ status, body: { error: { code, message: "nope", param: null } } })]);
      await expect(nc.me()).rejects.toBeInstanceOf(Klass);
    });
  }

  it("exposes param on validation errors", async () => {
    const { nc } = client([
      () => ({ status: 422, body: { error: { code: "validation_error", message: "bad", param: "sitekey" } } }),
    ]);
    await expect(nc.me()).rejects.toMatchObject({ param: "sitekey", code: "validation_error", status: 422 });
  });

  it("wraps a non-JSON body in APIError", async () => {
    const { fetch } = (() => {
      const f: FetchLike = async () => new Response("<html>502</html>", { status: 502 });
      return { fetch: f };
    })();
    const nc = new NoneCap({ apiKey: "k", fetch });
    await expect(nc.me()).rejects.toBeInstanceOf(APIError);
  });
});

describe("solve() helper", () => {
  it("returns immediately when create already resolves to solved", async () => {
    const { nc, calls } = client([() => ({ status: 200, body: baseSolve({ status: "solved", token: "TOK" }) })]);
    const solve = await nc.solve({ type: "hcaptcha", sitekey: "sk", url: "https://e.com" });
    expect(solve.token).toBe("TOK");
    expect(calls).toHaveLength(1); // no extra polling
  });

  it("polls retrieve until terminal", async () => {
    const { nc, calls } = client([
      () => ({ status: 202, body: baseSolve({ status: "pending" }) }),
      () => ({ status: 202, body: baseSolve({ status: "solving" }) }),
      () => ({ status: 200, body: baseSolve({ status: "solved", token: "TOK" }) }),
    ]);
    const solve = await nc.solve({ type: "hcaptcha", sitekey: "sk", url: "https://e.com" });
    expect(solve.token).toBe("TOK");
    expect(calls).toHaveLength(3);
    expect(calls[1]!.init.method).toBe("GET");
  });

  it("throws SolveFailedError with the solve attached when it fails", async () => {
    const failed = baseSolve({ status: "failed", error: { code: "unsolvable", message: "no" } });
    const { nc } = client([() => ({ status: 200, body: failed })]);
    const err = await nc.solve({ type: "hcaptcha", sitekey: "sk", url: "https://e.com" }).catch((e) => e);
    expect(err).toBeInstanceOf(SolveFailedError);
    expect((err as SolveFailedError).solve.error?.code).toBe("unsolvable");
  });

  it("times out if the solve never finishes", async () => {
    const { nc } = client([() => ({ status: 202, body: baseSolve({ status: "solving" }) })]);
    await expect(
      nc.solve({ type: "hcaptcha", sitekey: "sk", url: "https://e.com" }, { timeout: 0 }),
    ).rejects.toBeInstanceOf(TimeoutError);
  });
});

describe("solves.start + SolveHandle", () => {
  it("exposes id synchronously after start resolves", async () => {
    const { nc, calls } = client([() => ({ status: 202, body: baseSolve({ id: "solve_x", status: "pending" }) })]);
    const handle = await nc.solves.start({ type: "hcaptcha", sitekey: "sk", url: "https://e.com" });
    expect(handle.id).toBe("solve_x");
    expect(handle.solve.status).toBe("pending");
    expect(calls).toHaveLength(1); // start does not long-poll
    expect(calls[0]!.init.method).toBe("POST");
  });

  it("result() polls retrieve until terminal", async () => {
    const { nc, calls } = client([
      () => ({ status: 202, body: baseSolve({ status: "pending" }) }),
      () => ({ status: 202, body: baseSolve({ status: "solving" }) }),
      () => ({ status: 200, body: baseSolve({ status: "solved", token: "TOK" }) }),
    ]);
    const handle = await nc.solves.start({ type: "hcaptcha", sitekey: "sk", url: "https://e.com" });
    const solve = await handle.result();
    expect(solve.token).toBe("TOK");
    expect(calls).toHaveLength(3);
    expect(calls[1]!.init.method).toBe("GET");
  });

  it("start() returns a real SolveHandle instance (value export)", async () => {
    const { nc } = client([() => ({ status: 202, body: baseSolve({ status: "pending" }) })]);
    const handle = await nc.solves.start({ type: "hcaptcha", sitekey: "sk", url: "https://e.com" });
    expect(handle).toBeInstanceOf(SolveHandle);
    expect(typeof SolveHandle).toBe("function"); // importable at runtime, not type-only
  });

  it("result() called again after a terminal outcome replays the cache (one poll)", async () => {
    let gets = 0;
    const { nc } = client([
      () => ({ status: 202, body: baseSolve({ status: "pending" }) }),
      () => {
        gets++;
        return { status: 200, body: baseSolve({ status: "solved", token: "TOK" }) };
      },
    ]);
    const handle = await nc.solves.start({ type: "hcaptcha", sitekey: "sk", url: "https://e.com" });
    const a = await handle.result();
    const b = await handle.result();
    expect(a).toBe(b); // identical, memoized terminal outcome
    expect(gets).toBe(1); // polled exactly once, second call replayed the cache
  });

  it("two concurrent result() calls share one in-flight poll", async () => {
    let gets = 0;
    const { nc } = client([
      () => ({ status: 202, body: baseSolve({ status: "pending" }) }),
      () => {
        gets++;
        return { status: 200, body: baseSolve({ status: "solved", token: "TOK" }) };
      },
    ]);
    const handle = await nc.solves.start({ type: "hcaptcha", sitekey: "sk", url: "https://e.com" });
    const p1 = handle.result();
    const p2 = handle.result();
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toBe(b);
    expect(gets).toBe(1); // one shared poll, no duplicate GETs
  });

  it("result() throws TimeoutError carrying the solve id and state", async () => {
    const { nc } = client([() => ({ status: 202, body: baseSolve({ id: "solve_t", status: "solving" }) })]);
    const handle = await nc.solves.start({ type: "hcaptcha", sitekey: "sk", url: "https://e.com" });
    const err = await handle.result({ timeout: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).solveId).toBe("solve_t");
    expect((err as TimeoutError).solve?.status).toBe("solving");
  });

  it("a timed-out result() does not poison the handle — a later call resumes polling", async () => {
    let gets = 0;
    const { nc } = client([
      () => ({ status: 202, body: baseSolve({ status: "pending" }) }),
      () => {
        gets++;
        return { status: 200, body: baseSolve({ status: "solved", token: "TOK" }) };
      },
    ]);
    const handle = await nc.solves.start({ type: "hcaptcha", sitekey: "sk", url: "https://e.com" });
    // First wait gives up immediately, before issuing any retrieve.
    await expect(handle.result({ timeout: 0 })).rejects.toBeInstanceOf(TimeoutError);
    expect(gets).toBe(0);
    // A fresh wait must resume polling rather than replaying the timeout.
    const solve = await handle.result({ timeout: 5000 });
    expect(solve.token).toBe("TOK");
    expect(gets).toBe(1);
  });

  it("cancel() DELETEs and returns the cancelled solve", async () => {
    const { nc, calls } = client([
      () => ({ status: 202, body: baseSolve({ status: "pending" }) }),
      () => ({ status: 200, body: baseSolve({ status: "cancelled" }) }),
    ]);
    const handle = await nc.solves.start({ type: "hcaptcha", sitekey: "sk", url: "https://e.com" });
    const solve = await handle.cancel();
    expect(solve.status).toBe("cancelled");
    expect(handle.solve.status).toBe("cancelled");
    expect(calls[1]!.init.method).toBe("DELETE");
  });

  it("cancel() swallows a 409 on an already-terminal solve and returns its state", async () => {
    const { nc, calls } = client([
      () => ({ status: 202, body: baseSolve({ status: "solving" }) }),
      () => ({ status: 409, body: { error: { code: "conflict", message: "already done", param: null } } }),
      () => ({ status: 200, body: baseSolve({ status: "solved", token: "TOK" }) }),
    ]);
    const handle = await nc.solves.start({ type: "hcaptcha", sitekey: "sk", url: "https://e.com" });
    const solve = await handle.cancel();
    expect(solve.status).toBe("solved");
    expect(solve.token).toBe("TOK");
    expect(calls[1]!.init.method).toBe("DELETE"); // tried to cancel
    expect(calls[2]!.init.method).toBe("GET"); // then read current state
  });

  it("cancel() settles a later result() to the cancelled terminal state without polling", async () => {
    const { nc, calls } = client([
      () => ({ status: 202, body: baseSolve({ status: "pending" }) }),
      () => ({ status: 200, body: baseSolve({ status: "cancelled" }) }),
    ]);
    const handle = await nc.solves.start({ type: "hcaptcha", sitekey: "sk", url: "https://e.com" });
    await handle.cancel();
    const err = await handle.result().catch((e) => e);
    expect(err).toBeInstanceOf(SolveFailedError);
    expect((err as SolveFailedError).solve.status).toBe("cancelled");
    // Only the POST and the DELETE — result() never issued a GET.
    expect(calls).toHaveLength(2);
    expect(calls.some((c) => c.init.method === "GET")).toBe(false);
  });

  it("a result() in flight when cancel() lands settles to cancelled, not more polling", async () => {
    let resolveGet!: (r: Response) => void;
    const getPromise = new Promise<Response>((r) => {
      resolveGet = r;
    });
    let gets = 0;
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    const fetch: FetchLike = async (_input, init = {}) => {
      const method = init.method ?? "GET";
      if (method === "POST") return json(202, baseSolve({ status: "pending" }));
      if (method === "DELETE") return json(200, baseSolve({ status: "cancelled" }));
      gets++;
      return getPromise; // retrieve hangs until we resolve it
    };
    const nc = new NoneCap({ apiKey: "k", fetch });
    const handle = await nc.solves.start({ type: "hcaptcha", sitekey: "sk", url: "https://e.com" });

    const resultP = handle.result();
    await Promise.resolve(); // let the poll issue its (hanging) retrieve
    expect(gets).toBe(1);

    await handle.cancel(); // lands while the poll is awaiting the retrieve
    // The hung retrieve now comes back non-terminal; the poll must still settle
    // to the cancelled state rather than continuing to poll.
    resolveGet(json(202, baseSolve({ status: "solving" })));

    const err = await resultP.catch((e) => e);
    expect(err).toBeInstanceOf(SolveFailedError);
    expect((err as SolveFailedError).solve.status).toBe("cancelled");
    expect(gets).toBe(1); // no further retrieves after cancel settled it
  });
});

describe("abort + timeout", () => {
  it("propagates an aborted signal", async () => {
    const slow: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
    const nc = new NoneCap({ apiKey: "k", fetch: slow });
    const ac = new AbortController();
    const p = nc.me({ signal: ac.signal });
    ac.abort(new Error("user cancelled"));
    await expect(p).rejects.toThrow(/cancelled/);
  });

  it("throws TimeoutError when a request exceeds its timeout", async () => {
    vi.useFakeTimers();
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("abort");
          e.name = "AbortError";
          reject(e);
        });
      });
    const nc = new NoneCap({ apiKey: "k", fetch: hang, timeout: 1000 });
    const p = nc.me();
    const assertion = expect(p).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
    vi.useRealTimers();
  });
});

describe("isTerminal", () => {
  it("classifies statuses", () => {
    expect(isTerminal("solved")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("expired")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
    expect(isTerminal("pending")).toBe(false);
    expect(isTerminal("solving")).toBe(false);
  });
});
