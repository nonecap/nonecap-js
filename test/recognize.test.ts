import { describe, it, expect } from "vitest";
import {
  NoneCap,
  NotFoundError,
  RateLimitError,
  RecognitionFailedError,
  ValidationError,
  type FetchLike,
} from "../src/index.js";

type Handler = (url: URL, init: RequestInit) => { status: number; body: unknown; headers?: Record<string, string> };

function client(handlers: Handler[]) {
  const calls: { url: URL; method: string | undefined; body: any }[] = [];
  let i = 0;
  const fetch: FetchLike = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body as string) : undefined });
    const handler = handlers[Math.min(i, handlers.length - 1)]!;
    i++;
    const { status, body, headers } = handler(url, init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });
  };
  return { nc: new NoneCap({ apiKey: "nc_test", fetch }), calls };
}

const apiError = (status: number, code: string, message: string, param: string | null = null) => () => ({
  status,
  body: { error: { code, message, param } },
});

describe("recognize", () => {
  it("POSTs the simple grid body to /v1/recognize and returns one boolean per tile", async () => {
    const { nc, calls } = client([
      () => ({
        status: 200,
        body: { id: "extsess_1", data: [true, false, true], credits_charged: 10 },
      }),
    ]);
    const result = await nc.recognize({
      type: "hcaptcha",
      task: "Please click each image containing a bus",
      image_data: ["aGVsbG8=", "aGVsbG8=", "data:image/png;base64,aGVsbG8="],
      host: "example.com",
    });

    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url.pathname).toBe("/v1/recognize");
    expect(calls[0]!.body).toEqual({
      type: "hcaptcha",
      task: "Please click each image containing a bus",
      image_data: ["aGVsbG8=", "aGVsbG8=", "data:image/png;base64,aGVsbG8="],
      host: "example.com",
    });
    expect(result).toEqual({ id: "extsess_1", data: [true, false, true], credits_charged: 10 });
  });

  it("returns the area-select point and every point", async () => {
    const { nc, calls } = client([
      () => ({
        status: 200,
        body: {
          id: "extsess_2",
          data: { x: 41.5, y: 62, w: 0, h: 0 },
          points: [{ x: 41.5, y: 62 }, { x: 10, y: 20 }],
          credits_charged: 10,
        },
      }),
    ]);
    const result = await nc.recognize({
      type: "hcaptcha_area_select",
      task: "Click on the animal",
      image_urls: ["https://imgs.hcaptcha.com/abc"],
    });

    expect(calls[0]!.body.image_urls).toEqual(["https://imgs.hcaptcha.com/abc"]);
    expect(result.data).toEqual({ x: 41.5, y: 62, w: 0, h: 0 });
    expect(result.points).toHaveLength(2);
  });

  it("sends a full tasklist under data unchanged", async () => {
    const data = {
      request_type: "image_drag_drop" as const,
      requester_question: { en: "Drag the piece into place" },
      tasklist: [
        {
          task_key: "t1",
          datapoint_uri: "aGVsbG8=",
          entities: [{ entity_id: "e1", entity_uri: "aGVsbG8=", coords: [10, 20] as [number, number], size: [30, 30] as [number, number] }],
        },
      ],
    };
    const { nc, calls } = client([
      () => ({
        status: 200,
        body: { id: "extsess_3", data: [[{ entity_id: "e1", x: 50, y: 40, w: 10, h: 10 }]], credits_charged: 10 },
      }),
    ]);
    const result = await nc.recognize({ data });

    expect(calls[0]!.body).toEqual({ data });
    expect(result.data[0]![0]!.entity_id).toBe("e1");
  });

  it("throws RecognitionFailedError when no answer came back", async () => {
    const { nc } = client([apiError(422, "recognition_failed", "no answer for these images; nothing was charged")]);
    const err = await nc
      .recognize({ type: "hcaptcha", task: "bus", image_data: ["aGVsbG8="] })
      .catch((e) => e);
    expect(err).toBeInstanceOf(RecognitionFailedError);
    expect(err).not.toBeInstanceOf(ValidationError);
    expect(err.code).toBe("recognition_failed");
    expect(err.status).toBe(422);
  });

  it("throws ValidationError naming the bad field", async () => {
    const { nc } = client([apiError(422, "validation_error", "send image_data or image_urls, not both", "image_data")]);
    const err = await nc
      .recognize({ type: "hcaptcha", task: "bus", image_data: [] })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.param).toBe("image_data");
  });

  it("surfaces Retry-After on a 429", async () => {
    const { nc } = client([
      () => ({
        status: 429,
        body: { error: { code: "rate_limited", message: "too many recognitions", param: null } },
        headers: { "Retry-After": "3" },
      }),
    ]);
    const err = await nc
      .recognize({ type: "hcaptcha", task: "bus", image_data: ["aGVsbG8="] })
      .catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfter).toBe(3);
  });
});

describe("reportRecognitionOutcome", () => {
  it("POSTs the id and result and returns the refund", async () => {
    const { nc, calls } = client([
      () => ({ status: 200, body: { id: "extsess_1", result: "failed", refunded_credits: 10 } }),
    ]);
    const result = await nc.reportRecognitionOutcome("extsess_1", "failed");

    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url.pathname).toBe("/v1/recognize/outcome");
    expect(calls[0]!.body).toEqual({ id: "extsess_1", result: "failed" });
    expect(result.refunded_credits).toBe(10);
  });

  it("throws NotFoundError for a recognition that is not yours", async () => {
    const { nc } = client([apiError(404, "not_found", "no recognition with that id belongs to this account")]);
    await expect(nc.reportRecognitionOutcome("extsess_x", "solved")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws ValidationError with expired_window after the window", async () => {
    const { nc } = client([apiError(422, "expired_window", "the outcome window closed", "id")]);
    const err = await nc.reportRecognitionOutcome("extsess_old", "failed").catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.code).toBe("expired_window");
  });
});
