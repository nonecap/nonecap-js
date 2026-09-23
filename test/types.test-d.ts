/**
 * Compile-time checks for the public types. This file is type-checked by
 * `tsc --noEmit` (it is part of the build's typecheck), never run. If any
 * assertion below stops holding, the typecheck fails.
 */
import type { SolveCreateParams, SolveErrorReason } from "../src/index.js";

// hcaptcha: rqdata is optional.
const ok1: SolveCreateParams = { type: "hcaptcha", sitekey: "s", url: "u" };
const ok2: SolveCreateParams = { type: "hcaptcha", sitekey: "s", url: "u", rqdata: "r" };

// enterprise: rqdata is required.
const ok3: SolveCreateParams = { type: "hcaptcha_enterprise", sitekey: "s", url: "u", rqdata: "r" };

// @ts-expect-error enterprise without rqdata must not compile.
const bad1: SolveCreateParams = { type: "hcaptcha_enterprise", sitekey: "s", url: "u" };

// @ts-expect-error unknown type must not compile.
const bad2: SolveCreateParams = { type: "recaptcha", sitekey: "s", url: "u" };

// The egress guard's reasons are part of the typed vocabulary.
const reason1: SolveErrorReason = "proxy_egress_blocked";
const reason2: SolveErrorReason = "target_egress_blocked";
const reason3: SolveErrorReason = "profile_engine_unavailable";
const reason4: SolveErrorReason = "type_not_served";
const reason5: SolveErrorReason = "browser_lane_capped";

// @ts-expect-error a reason the API never defined must not compile.
const badReason: SolveErrorReason = "proxy_egress_blockd";

void [ok1, ok2, ok3, bad1, bad2, reason1, reason2, reason3, reason4, reason5, badReason];
