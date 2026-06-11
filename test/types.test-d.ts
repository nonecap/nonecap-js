/**
 * Compile-time checks for the public types. This file is type-checked by
 * `tsc --noEmit` (it is part of the build's typecheck), never run. If any
 * assertion below stops holding, the typecheck fails.
 */
import type { SolveCreateParams } from "../src/index.js";

// hcaptcha: rqdata is optional.
const ok1: SolveCreateParams = { type: "hcaptcha", sitekey: "s", url: "u" };
const ok2: SolveCreateParams = { type: "hcaptcha", sitekey: "s", url: "u", rqdata: "r" };

// enterprise: rqdata is required.
const ok3: SolveCreateParams = { type: "hcaptcha_enterprise", sitekey: "s", url: "u", rqdata: "r" };

// @ts-expect-error enterprise without rqdata must not compile.
const bad1: SolveCreateParams = { type: "hcaptcha_enterprise", sitekey: "s", url: "u" };

// @ts-expect-error unknown type must not compile.
const bad2: SolveCreateParams = { type: "recaptcha", sitekey: "s", url: "u" };

void [ok1, ok2, ok3, bad1, bad2];
