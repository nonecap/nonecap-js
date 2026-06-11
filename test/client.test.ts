import { describe, it, expect, vi } from "vitest";
import {
  NoneCap,
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
