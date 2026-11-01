import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { NoneCap } from "../client.js";
import {
  ConnectionError,
  NoneCapError,
  SolveFailedError,
  TimeoutError,
} from "../errors.js";
import type { Solve, SolveCreateParams } from "../types.js";
import { VERSION } from "../version.js";

const DEFAULT_SOLVE_WAIT_SECONDS = 45;
// MCP clients built on the official SDK give up on a request after 60 s (DEFAULT_REQUEST_TIMEOUT_MSEC).
const MAX_WAIT_SECONDS = 50;

const solveTypeSchema = z.enum(["hcaptcha", "hcaptcha_enterprise"]);
const solveStatusSchema = z.enum(["pending", "solving", "solved", "failed", "cancelled", "expired"]);

function ok(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function fail(error: Record<string, unknown>): CallToolResult {
  const clean = Object.fromEntries(Object.entries(error).filter(([, v]) => v !== undefined && v !== null));
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: clean }, null, 2) }] };
}

function errorCode(err: NoneCapError): string {
  if (err.code) return err.code;
  return err instanceof TimeoutError ? "timeout" : err instanceof ConnectionError ? "connection_error" : "api_error";
}

/** A submitted solve that has not finished: the agent must poll it, never resubmit (a resubmit is a second charge). */
function running(solve: Solve, err?: unknown): CallToolResult {
  let note = `Solve ${solve.id} is still ${solve.status}. Call get_solve with this id for the token; do not submit it again.`;
  if (err !== undefined && !(err instanceof TimeoutError)) {
    const detail = err instanceof NoneCapError ? `${errorCode(err)}: ${err.message}` : String(err);
    note += ` The wait stopped early (${detail}).`;
  }
  return { content: [...ok(solve).content, { type: "text", text: note }] };
}

/** Turn anything the SDK throws into an MCP tool error that carries the API's error code. */
export function toolError(err: unknown): CallToolResult {
  if (err instanceof SolveFailedError) {
    return fail({
      code: err.solveCode,
      message: err.solve.error?.message ?? `Solve ${err.solve.status}.`,
      reason: err.reason,
      retryable: err.retryable,
      solve_id: err.solve.id,
      status: err.solve.status,
    });
  }
  if (err instanceof NoneCapError) {
    return fail({
      code: errorCode(err),
      message: err.message,
      http_status: err.status,
      param: err.param,
      retry_after: err.retryAfter,
      request_id: err.requestId,
    });
  }
  return fail({ code: "error", message: err instanceof Error ? err.message : String(err) });
}

const MISSING_KEY = fail({
  code: "missing_api_key",
  message:
    "NONECAP_API_KEY is not set. Get a key at https://dashboard.nonecap.com and add it to this MCP server's env.",
});

/**
 * Build the NoneCap MCP server. `client` is null when no API key was configured:
 * the tools still list, and every call returns a `missing_api_key` error.
 */
export function createMcpServer(client: NoneCap | null): McpServer {
  const server = new McpServer({ name: "nonecap", version: VERSION });

  const run = async (fn: (nc: NoneCap) => Promise<CallToolResult>): Promise<CallToolResult> => {
    if (!client) return MISSING_KEY;
    try {
      return await fn(client);
    } catch (err) {
      return toolError(err);
    }
  };

  server.registerTool(
    "solve_hcaptcha",
    {
      title: "Solve an hCaptcha",
      description:
        "Solve an hCaptcha and return the token. Waits up to wait_seconds; if the solve is still running then, " +
        "returns its id and status: call get_solve with the id rather than solving again. Only successful solves are charged.",
      inputSchema: {
        sitekey: z.string().min(1).describe("The hCaptcha sitekey on the page."),
        url: z.string().min(1).describe("The URL of the page the captcha is on."),
        type: solveTypeSchema
          .optional()
          .describe("hcaptcha (default) or hcaptcha_enterprise."),
        rqdata: z
          .string()
          .optional()
          .describe("Enterprise only: the rqdata the site passes to its widget, if it passes one."),
        user_agent: z
          .string()
          .optional()
          .describe("The user agent of the browser that loaded the page, as is. Leave out if you do not have it."),
        proxy: z
          .string()
          .optional()
          .describe(
            "Proxy to solve through, as a URL: scheme://user:pass@host:port (http, https, socks5, socks5h or socks4).",
          ),
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(MAX_WAIT_SECONDS)
          .optional()
          .describe(
            `Seconds to wait for the result, 0-${MAX_WAIT_SECONDS}. Default ${DEFAULT_SOLVE_WAIT_SECONDS}. 0 returns right after submitting.`,
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args, extra) =>
      run(async (nc) => {
        const params: SolveCreateParams = {
          type: args.type ?? "hcaptcha",
          sitekey: args.sitekey,
          url: args.url,
        };
        if (args.rqdata !== undefined) params.rqdata = args.rqdata;
        if (args.user_agent !== undefined) params.user_agent = args.user_agent;
        if (args.proxy !== undefined) params.proxy = args.proxy;
        const handle = await nc.solves.start(params, { signal: extra.signal });
        const waitSeconds = args.wait_seconds ?? DEFAULT_SOLVE_WAIT_SECONDS;
        if (waitSeconds === 0) return running(handle.solve);
        try {
          return ok(await handle.result({ timeout: waitSeconds * 1000, signal: extra.signal }));
        } catch (err) {
          if (err instanceof SolveFailedError) throw err;
          return running(handle.solve, err);
        }
      }),
  );

  server.registerTool(
    "get_solve",
    {
      title: "Get a solve",
      description:
        "Get a solve by id: its status, and the token once it is solved. Set wait_seconds to wait for it to finish.",
      inputSchema: {
        id: z.string().min(1).describe("The solve id (solve_…)."),
        wait_seconds: z
          .number()
          .int()
          .min(1)
          .max(MAX_WAIT_SECONDS)
          .optional()
          .describe(`Hold up to this many seconds (1-${MAX_WAIT_SECONDS}) for the solve to finish. Omit to return at once.`),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args, extra) =>
      run(async (nc) => ok(await nc.solves.retrieve(args.id, { wait: args.wait_seconds, signal: extra.signal }))),
  );

  server.registerTool(
    "cancel_solve",
    {
      title: "Cancel a solve",
      description: "Cancel a pending or running solve. Cancelled solves are not charged.",
      inputSchema: { id: z.string().min(1).describe("The solve id (solve_…).") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args, extra) => run(async (nc) => ok(await nc.solves.cancel(args.id, { signal: extra.signal }))),
  );

  server.registerTool(
    "list_solves",
    {
      title: "List solves",
      description: "List your recent solves, newest first.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("Page size, 1-100. Default 20."),
        status: solveStatusSchema.optional().describe("Only solves with this status."),
        type: solveTypeSchema.optional().describe("Only solves of this type."),
        starting_after: z
          .string()
          .optional()
          .describe("A solve id: return the page after it (the last id of the previous page)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args, extra) => run(async (nc) => ok(await nc.solves.list(args, { signal: extra.signal }))),
  );

  server.registerTool(
    "get_account",
    {
      title: "Get account",
      description: "Get your NoneCap account: credit balance, and your plan's solves left today.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (_args, extra) => run(async (nc) => ok(await nc.me({ signal: extra.signal }))),
  );

  server.registerTool(
    "report_solve_outcome",
    {
      title: "Report a token's outcome",
      description:
        "Tell NoneCap whether the site accepted a solve's token. Free; reporting the same solve again corrects it.",
      inputSchema: {
        solve_id: z.string().min(1).describe("The id of a solved solve."),
        outcome: z
          .enum(["accepted", "rejected", "unknown", "unused", "error"])
          .describe(
            "accepted or rejected by the site; unknown (submitted, verdict unclear); unused (never submitted); " +
              "error (the site failed for a reason unrelated to the token).",
          ),
        reason: z.string().optional().describe("What the site returned when it refused the token."),
        context: z.string().optional().describe("Anything else about the attempt that would help diagnose it."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (args, extra) => run(async (nc) => ok(await nc.feedback.report(args, { signal: extra.signal }))),
  );

  return server;
}
