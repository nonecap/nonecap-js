/**
 * The published package version, sent as the `User-Agent` on every request.
 *
 * Hardcoded rather than imported from package.json: a JSON import would need
 * `resolveJsonModule` and would resolve differently under the ESM and CJS
 * builds. `test/version.test.ts` fails if this drifts from package.json.
 */
export const VERSION = "0.4.1";
