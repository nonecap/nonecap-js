import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { NoneCap, type FetchLike, type Solve } from "../src/index.js";
import { createMcpServer } from "../src/mcp/server.js";

type Reply = { status: number; body: unknown; headers?: Record<string, string> };
type Handler = (url: URL, init: RequestInit) => Reply;

function fakeFetch(handlers: Handler[]) {
  const calls: { url: URL; init: RequestInit }[] = [];
  let i = 0;
  const fetch: FetchLike = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init });
    const handler = handlers[Math.min(i, handlers.length - 1)];
    i++;
    const { status, body, headers } = handler!(url, init);
    return new Response(body === undefined ? "" : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
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
  resp_key: null,
  user_agent: null,
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

async function connect(handlers: Handler[] | null) {
  const fake = handlers ? fakeFetch(handlers) : null;
  const nc = fake ? new NoneCap({ apiKey: "nc_test", fetch: fake.fetch }) : null;
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(nc).connect(serverSide);
  const mcp = new Client({ name: "test", version: "0" });
  await mcp.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await mcp.callTool({ name, arguments: args })) as CallToolResult;
    const first = res.content[0];
    const text = first && first.type === "text" ? first.text : "";
    const rest = res.content.slice(1).map((c) => (c.type === "text" ? c.text : "")).join("\n");
    return { isError: res.isError === true, json: JSON.parse(text) as Record<string, any>, note: rest };
  };
  return { mcp, call, calls: fake?.calls ?? [] };
}

const body = (init: RequestInit) => JSON.parse(String(init.body)) as Record<string, unknown>;

describe("mcp tools/list", () => {
  it("lists every tool with an input schema", async () => {
    const { mcp } = await connect(null);
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "cancel_solve",
      "get_account",
      "get_solve",
      "list_solves",
      "report_solve_outcome",
      "solve_hcaptcha",
    ]);
    const solve = tools.find((t) => t.name === "solve_hcaptcha")!;
    expect(solve.inputSchema.required).toEqual(["sitekey", "url"]);
    expect(Object.keys(solve.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(["type", "rqdata", "user_agent", "proxy", "wait_seconds"]),
    );
  });
});

describe("mcp without an api key", () => {
  it("answers every call with missing_api_key", async () => {
    const { call } = await connect(null);
    const res = await call("get_account");
    expect(res.isError).toBe(true);
    expect(res.json.error.code).toBe("missing_api_key");
  });
});

describe("solve_hcaptcha", () => {
  it("submits the optional fields and returns the solved solve", async () => {
    const { call, calls } = await connect([
      () => ({ status: 202, body: baseSolve() }),
      () => ({ status: 200, body: baseSolve({ status: "solved", token: "P1_tok", resp_key: "E0_key" }) }),
    ]);
    const res = await call("solve_hcaptcha", {
      sitekey: "sk",
      url: "https://example.com",
      type: "hcaptcha_enterprise",
      rqdata: "rq",
      user_agent: "UA",
      proxy: "http://u:p@1.2.3.4:8080",
    });
    expect(res.isError).toBe(false);
    expect(res.json.token).toBe("P1_tok");
    expect(res.json.resp_key).toBe("E0_key");
    expect(calls[0]!.init.method).toBe("POST");
    expect(body(calls[0]!.init)).toEqual({
      type: "hcaptcha_enterprise",
      sitekey: "sk",
      url: "https://example.com",
      rqdata: "rq",
      user_agent: "UA",
      proxy: "http://u:p@1.2.3.4:8080",
    });
    expect(calls[1]!.url.pathname).toBe("/v1/solves/solve_1");
  });

  it("defaults to type hcaptcha and leaves unset fields off the wire", async () => {
    const { call, calls } = await connect([() => ({ status: 202, body: baseSolve({ status: "solved", token: "t" }) })]);
    await call("solve_hcaptcha", { sitekey: "sk", url: "https://example.com" });
    expect(body(calls[0]!.init)).toEqual({ type: "hcaptcha", sitekey: "sk", url: "https://example.com" });
  });

  it("returns right after submitting when wait_seconds is 0", async () => {
    const { call, calls } = await connect([() => ({ status: 202, body: baseSolve() })]);
    const res = await call("solve_hcaptcha", { sitekey: "sk", url: "https://example.com", wait_seconds: 0 });
    expect(res.isError).toBe(false);
    expect(res.json).toMatchObject({ id: "solve_1", status: "pending" });
    expect(calls).toHaveLength(1);
  });

  it("returns the still-running solve, not an error, when the wait runs out", async () => {
    const { call } = await connect([
      () => ({ status: 202, body: baseSolve() }),
      () => ({ status: 202, body: baseSolve({ status: "solving" }) }),
    ]);
    const res = await call("solve_hcaptcha", { sitekey: "sk", url: "https://example.com", wait_seconds: 1 });
    expect(res.isError).toBe(false);
    expect(res.json).toMatchObject({ id: "solve_1", status: "solving" });
    expect(res.note).toMatch(/get_solve/);
    expect(res.note).not.toMatch(/stopped early/);
  }, 10_000);

  it("keeps the solve id when polling breaks after the submit went through", async () => {
    const { call, calls } = await connect([
      () => ({ status: 202, body: baseSolve() }),
      () => ({ status: 500, body: { error: { code: "internal_error", message: "Boom.", param: null } } }),
    ]);
    const res = await call("solve_hcaptcha", { sitekey: "sk", url: "https://example.com" });
    expect(res.isError).toBe(false);
    expect(res.json).toMatchObject({ id: "solve_1", status: "pending" });
    expect(res.note).toMatch(/get_solve/);
    expect(res.note).toMatch(/internal_error: Boom\./);
    expect(calls.filter((c) => c.init.method === "POST")).toHaveLength(1);
  });

  it("caps wait_seconds under the 60 s client request timeout", async () => {
    const { mcp, calls } = await connect([() => ({ status: 202, body: baseSolve() })]);
    const res = (await mcp.callTool({
      name: "solve_hcaptcha",
      arguments: { sitekey: "sk", url: "https://example.com", wait_seconds: 120 },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("turns a failed solve into a tool error with the solve's error code", async () => {
    const { call } = await connect([
      () => ({ status: 202, body: baseSolve() }),
      () => ({
        status: 200,
        body: baseSolve({
          status: "failed",
          error: {
            code: "proxy_error",
            message: "Your proxy refused the connection. Not charged.",
            reason: "proxy_rejected",
            retryable: false,
            docs_url: "https://nonecap.com/docs/errors",
          },
        }),
      }),
    ]);
    const res = await call("solve_hcaptcha", { sitekey: "sk", url: "https://example.com" });
    expect(res.isError).toBe(true);
    expect(res.json.error).toEqual({
      code: "proxy_error",
      message: "Your proxy refused the connection. Not charged.",
      reason: "proxy_rejected",
      retryable: false,
      solve_id: "solve_1",
      status: "failed",
    });
  });

  it("turns an API error into a tool error with the API's code", async () => {
    const { call } = await connect([
      () => ({
        status: 402,
        body: { error: { code: "insufficient_credits", message: "Out of credits.", param: null, request_id: "req_1" } },
      }),
    ]);
    const res = await call("solve_hcaptcha", { sitekey: "sk", url: "https://example.com" });
    expect(res.isError).toBe(true);
    expect(res.json.error).toEqual({
      code: "insufficient_credits",
      message: "Out of credits.",
      http_status: 402,
      request_id: "req_1",
    });
  });

  it("carries retry_after on a 429", async () => {
    const { call } = await connect([
      () => ({
        status: 429,
        headers: { "Retry-After": "7" },
        body: { error: { code: "sitekey_rate_limited", message: "Slow down.", param: null } },
      }),
    ]);
    const res = await call("solve_hcaptcha", { sitekey: "sk", url: "https://example.com" });
    expect(res.json.error).toMatchObject({ code: "sitekey_rate_limited", retry_after: 7, http_status: 429 });
  });

  it("rejects a call without a sitekey before any request", async () => {
    const { mcp, calls } = await connect([() => ({ status: 202, body: baseSolve() })]);
    const res = (await mcp.callTool({ name: "solve_hcaptcha", arguments: { url: "https://example.com" } })) as CallToolResult;
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/sitekey/);
    expect(calls).toHaveLength(0);
  });
});

describe("get_solve", () => {
  it("long-polls with wait_seconds", async () => {
    const { call, calls } = await connect([() => ({ status: 200, body: baseSolve({ status: "solved", token: "t" }) })]);
    const res = await call("get_solve", { id: "solve_1", wait_seconds: 30 });
    expect(res.json.token).toBe("t");
    expect(calls[0]!.url.pathname).toBe("/v1/solves/solve_1");
    expect(calls[0]!.url.searchParams.get("wait")).toBe("30");
  });

  it("returns not_found as a tool error", async () => {
    const { call } = await connect([
      () => ({ status: 404, body: { error: { code: "not_found", message: "No such solve.", param: "id" } } }),
    ]);
    const res = await call("get_solve", { id: "solve_x" });
    expect(res.isError).toBe(true);
    expect(res.json.error).toMatchObject({ code: "not_found", param: "id", http_status: 404 });
  });
});

describe("cancel_solve", () => {
  it("sends DELETE and returns the cancelled solve", async () => {
    const { call, calls } = await connect([() => ({ status: 200, body: baseSolve({ status: "cancelled" }) })]);
    const res = await call("cancel_solve", { id: "solve_1" });
    expect(res.json.status).toBe("cancelled");
    expect(calls[0]!.init.method).toBe("DELETE");
  });
});

describe("list_solves", () => {
  it("passes the filters as query params", async () => {
    const { call, calls } = await connect([
      () => ({ status: 200, body: { object: "list", data: [baseSolve()], has_more: false } }),
    ]);
    const res = await call("list_solves", { limit: 5, status: "failed", type: "hcaptcha" });
    expect(res.json.data).toHaveLength(1);
    const q = calls[0]!.url.searchParams;
    expect([q.get("limit"), q.get("status"), q.get("type")]).toEqual(["5", "failed", "hcaptcha"]);
  });
});

describe("get_account", () => {
  it("returns the balance and plan", async () => {
    const account = {
      object: "account",
      id: "acct_1",
      email: "a@b.c",
      credits_balance: 1234,
      created_at: "2026-01-01T00:00:00Z",
      plan: null,
    };
    const { call, calls } = await connect([() => ({ status: 200, body: account })]);
    const res = await call("get_account");
    expect(res.json).toEqual(account);
    expect(calls[0]!.url.pathname).toBe("/v1/me");
  });

  it("returns unauthorized as a tool error", async () => {
    const { call } = await connect([
      () => ({ status: 401, body: { error: { code: "unauthorized", message: "Invalid API key.", param: null } } }),
    ]);
    const res = await call("get_account");
    expect(res.isError).toBe(true);
    expect(res.json.error).toMatchObject({ code: "unauthorized", http_status: 401 });
  });

  it("reports a network failure as connection_error", async () => {
    const nc = new NoneCap({
      apiKey: "k",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createMcpServer(nc).connect(serverSide);
    const mcp = new Client({ name: "test", version: "0" });
    await mcp.connect(clientSide);
    const res = (await mcp.callTool({ name: "get_account", arguments: {} })) as CallToolResult;
    expect(res.isError).toBe(true);
    const first = res.content[0];
    expect(JSON.parse(first && first.type === "text" ? first.text : "").error.code).toBe("connection_error");
  });
});

describe("report_solve_outcome", () => {
  it("posts the verdict to the solve's feedback route", async () => {
    const { call, calls } = await connect([
      () => ({
        status: 200,
        body: {
          object: "feedback",
          solve_id: "solve_1",
          outcome: "rejected",
          reason: "invalid-response",
          context: null,
          reported_at: null,
          report_count: 1,
          created_at: "2026-06-11T00:00:00Z",
          updated_at: "2026-06-11T00:00:00Z",
        },
      }),
    ]);
    const res = await call("report_solve_outcome", {
      solve_id: "solve_1",
      outcome: "rejected",
      reason: "invalid-response",
    });
    expect(res.json.report_count).toBe(1);
    expect(calls[0]!.url.pathname).toBe("/v1/solves/solve_1/feedback");
    expect(body(calls[0]!.init)).toEqual({ outcome: "rejected", reason: "invalid-response" });
  });
});
