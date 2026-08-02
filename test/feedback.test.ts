import { describe, it, expect } from "vitest";
import {
  NoneCap,
  NotFoundError,
  ValidationError,
  FEEDBACK_BATCH_MAX,
  type Feedback,
  type FeedbackBatch,
  type FeedbackReport,
  type FetchLike,
} from "../src/index.js";

type Handler = (url: URL, init: RequestInit) => { status: number; body: unknown };

function client(handlers: Handler[]) {
  const calls: { url: URL; body: any }[] = [];
  let i = 0;
  const fetch: FetchLike = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, body: init.body ? JSON.parse(init.body as string) : undefined });
    const handler = handlers[Math.min(i, handlers.length - 1)]!;
    i++;
    const { status, body } = handler(url, init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { nc: new NoneCap({ apiKey: "nc_test", fetch }), calls };
}

const feedback = (over: Partial<Feedback> = {}): Feedback => ({
  object: "feedback",
  solve_id: "solve_1",
  outcome: "accepted",
  reason: null,
  context: null,
  reported_at: null,
  report_count: 1,
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-01T00:00:00Z",
  ...over,
});

/** A batch reply for `n` items, all recorded. */
const batchOf = (ids: string[]): FeedbackBatch => ({
  object: "feedback_batch",
  recorded: ids.length,
  updated: 0,
  unchanged: 0,
  failed: 0,
  results: ids.map((id) => ({ solve_id: id, status: "recorded" as const, error: null })),
});

describe("feedback.report", () => {
  it("POSTs the outcome to the solve's feedback path", async () => {
    const { nc, calls } = client([() => ({ status: 200, body: feedback({ outcome: "rejected" }) })]);
    const result = await nc.feedback.report({
      solve_id: "solve_1",
      outcome: "rejected",
      reason: "invalid-response",
      context: "3rd retry, rotating residential pool",
    });

    expect(calls[0]!.url.pathname).toBe("/v1/solves/solve_1/feedback");
    expect(calls[0]!.body).toEqual({
      outcome: "rejected",
      reason: "invalid-response",
      context: "3rd retry, rotating residential pool",
    });
    expect(result.outcome).toBe("rejected");
  });

  it("omits fields the caller left unset", async () => {
    const { nc, calls } = client([() => ({ status: 200, body: feedback() })]);
    await nc.feedback.report({ solve_id: "solve_1", outcome: "accepted" });
    expect(calls[0]!.body).toEqual({ outcome: "accepted" });
  });

  it("serializes a Date reported_at as ISO", async () => {
    const { nc, calls } = client([() => ({ status: 200, body: feedback() })]);
    await nc.feedback.report({
      solve_id: "solve_1",
      outcome: "accepted",
      reported_at: new Date("2026-08-01T14:03:00Z"),
    });
    expect(calls[0]!.body.reported_at).toBe("2026-08-01T14:03:00.000Z");
  });

  it("url-encodes the solve id", async () => {
    const { nc, calls } = client([() => ({ status: 200, body: feedback() })]);
    await nc.feedback.report({ solve_id: "a/b", outcome: "unused" });
    expect(calls[0]!.url.pathname).toBe("/v1/solves/a%2Fb/feedback");
  });

  it("throws NotFoundError for a solve that is not reportable", async () => {
    const { nc } = client([
      () => ({
        status: 404,
        body: { error: { code: "not_found", message: "solve not found or not reportable", param: null } },
      }),
    ]);
    await expect(nc.feedback.report({ solve_id: "solve_x", outcome: "accepted" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("throws ValidationError once the reporting window has closed", async () => {
    const { nc } = client([
      () => ({
        status: 422,
        body: {
          error: {
            code: "expired_window",
            message: "solve is older than the feedback window",
            param: "solve_id",
          },
        },
      }),
    ]);
    const err = await nc.feedback
      .report({ solve_id: "solve_old", outcome: "accepted" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.code).toBe("expired_window");
    expect(err.param).toBe("solve_id");
  });
});

describe("feedback.reportMany", () => {
  it("POSTs one batch under the wire format", async () => {
    const { nc, calls } = client([
      () => ({ status: 200, body: batchOf(["solve_1", "solve_2"]) }),
    ]);
    const batch = await nc.feedback.reportMany([
      { solve_id: "solve_1", outcome: "accepted" },
      { solve_id: "solve_2", outcome: "rejected", context: "3rd retry" },
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.pathname).toBe("/v1/feedback");
    expect(calls[0]!.body).toEqual({
      feedback: [
        { solve_id: "solve_1", outcome: "accepted" },
        { solve_id: "solve_2", outcome: "rejected", context: "3rd retry" },
      ],
    });
    expect(batch.recorded).toBe(2);
  });

  it("returns an empty batch without a request for an empty array", async () => {
    const { nc, calls } = client([() => ({ status: 500, body: {} })]);
    const batch = await nc.feedback.reportMany([]);
    expect(calls).toHaveLength(0);
    expect(batch).toEqual({
      object: "feedback_batch",
      recorded: 0,
      updated: 0,
      unchanged: 0,
      failed: 0,
      results: [],
    });
  });

  it("splits over the batch cap and merges the tallies in request order", async () => {
    const reports: FeedbackReport[] = Array.from({ length: FEEDBACK_BATCH_MAX + 3 }, (_, i) => ({
      solve_id: `solve_${i}`,
      outcome: "accepted" as const,
    }));
    const { nc, calls } = client([
      (_u, init) => ({
        status: 200,
        body: batchOf(
          (JSON.parse(init.body as string) as { feedback: { solve_id: string }[] }).feedback.map(
            (f) => f.solve_id,
          ),
        ),
      }),
    ]);

    const batch = await nc.feedback.reportMany(reports);

    expect(calls).toHaveLength(2);
    expect(calls[0]!.body.feedback).toHaveLength(FEEDBACK_BATCH_MAX);
    expect(calls[1]!.body.feedback).toHaveLength(3);
    expect(batch.recorded).toBe(FEEDBACK_BATCH_MAX + 3);
    expect(batch.results).toHaveLength(FEEDBACK_BATCH_MAX + 3);
    expect(batch.results[0]!.solve_id).toBe("solve_0");
    expect(batch.results.at(-1)!.solve_id).toBe(`solve_${FEEDBACK_BATCH_MAX + 2}`);
  });

  it("does not throw when individual items fail", async () => {
    const { nc } = client([
      () => ({
        status: 200,
        body: {
          object: "feedback_batch",
          recorded: 1,
          updated: 0,
          unchanged: 0,
          failed: 1,
          results: [
            { solve_id: "solve_1", status: "recorded", error: null },
            {
              solve_id: "solve_x",
              status: "error",
              error: { code: "not_eligible", message: "solve not found or not reportable", param: "solve_id" },
            },
          ],
        },
      }),
    ]);

    const batch = await nc.feedback.reportMany([
      { solve_id: "solve_1", outcome: "accepted" },
      { solve_id: "solve_x", outcome: "accepted" },
    ]);
    expect(batch.failed).toBe(1);
    expect(batch.results[1]!.error?.code).toBe("not_eligible");
  });
});
