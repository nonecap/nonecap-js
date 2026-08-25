/**
 * The published package version, sent as the `User-Agent` on every request.
 *
 * Hardcoded rather than imported from package.json: a JSON import would need
 * `resolveJsonModule` and would resolve differently under the ESM and CJS
 * builds. Bump it in the SAME commit as package.json: the drift check is the
 * `Version constant matches package.json` step in ci.yml and lives ONLY there,
 * so `npm test` and `tsc` both stay green on a mismatch (test/version.test.ts
 * asserts the User-Agent uses VERSION, never that VERSION is right).
 */
export const VERSION = "0.6.0";
