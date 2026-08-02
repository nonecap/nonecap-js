import { describe, it, expect } from "vitest";
import { NoneCap, type FetchLike } from "../src/index.js";
import { VERSION } from "../src/version.js";

// VERSION is checked against package.json by the `version constant matches
// package.json` step in ci.yml — this package has no @types/node, so reading
// the file here would not typecheck.
describe("version", () => {
  it("is sent as the User-Agent on every request", async () => {
    let sent: string | undefined;
    const fetch: FetchLike = async (_input, init = {}) => {
      sent = (init.headers as Record<string, string>)["User-Agent"];
      return new Response("{}", { status: 200 });
    };
    await new NoneCap({ apiKey: "k", fetch }).me();
    expect(sent).toBe(`nonecap-js/${VERSION}`);
  });
});
