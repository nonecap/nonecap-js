/**
 * Compile-time checks for the public types. This file is type-checked by
 * `tsc --noEmit` (it is part of the build's typecheck), never run. If any
 * assertion below stops holding, the typecheck fails.
 */
import type {
  NoneCap,
  RecognizeAreaSelectResult,
  RecognizeBinaryResult,
  RecognizeParams,
  RecognizeTasklistAreaSelectResult,
  RecognizeTasklistBinaryResult,
  RecognizeTasklistDragDropResult,
  SolveCreateParams,
  SolveErrorReason,
} from "../src/index.js";

// hcaptcha: rqdata is optional.
const ok1: SolveCreateParams = { type: "hcaptcha", sitekey: "s", url: "u" };
const ok2: SolveCreateParams = { type: "hcaptcha", sitekey: "s", url: "u", rqdata: "r" };

// enterprise: rqdata is optional too.
const ok3: SolveCreateParams = { type: "hcaptcha_enterprise", sitekey: "s", url: "u", rqdata: "r" };
const ok4: SolveCreateParams = { type: "hcaptcha_enterprise", sitekey: "s", url: "u" };

// @ts-expect-error rqdata must be a string.
const bad1: SolveCreateParams = { type: "hcaptcha_enterprise", sitekey: "s", url: "u", rqdata: 1 };

// @ts-expect-error unknown type must not compile.
const bad2: SolveCreateParams = { type: "recaptcha", sitekey: "s", url: "u" };

// The egress guard's reasons are part of the typed vocabulary.
const reason1: SolveErrorReason = "proxy_egress_blocked";
const reason2: SolveErrorReason = "target_egress_blocked";
const reason3: SolveErrorReason = "profile_engine_unavailable";
const reason4: SolveErrorReason = "type_not_served";
const reason5: SolveErrorReason = "browser_lane_capped";
const reason6: SolveErrorReason = "recaptcha_not_loaded";
const reason7: SolveErrorReason = "refused_wording_unescaped";
const reason8: SolveErrorReason = "session_capped";

// @ts-expect-error a reason the API never defined must not compile.
const badReason: SolveErrorReason = "proxy_egress_blockd";

void [ok1, ok2, ok3, ok4, bad1, bad2, reason1, reason2, reason3, reason4, reason5, badReason];

// recognize: images go inline or as URLs, never both.
const rec1: RecognizeParams = { type: "hcaptcha", task: "t", image_data: ["b64"] };
const rec2: RecognizeParams = { type: "hcaptcha_area_select", task: "t", image_urls: ["https://imgs.hcaptcha.com/x"] };
// @ts-expect-error image_data and image_urls together must not compile.
const recBad1: RecognizeParams = { type: "hcaptcha", task: "t", image_data: ["b64"], image_urls: ["u"] };
// @ts-expect-error a type the endpoint does not serve must not compile.
const recBad2: RecognizeParams = { type: "hcaptcha_multiple_choice", task: "t", image_data: ["b64"] };

// recognize: the result type follows the request shape.
type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
declare const nc: NoneCap;
const tasklist = { requester_question: { en: "q" }, tasklist: [{ task_key: "k", datapoint_uri: "b64" }] };
const recResult1: Eq<Awaited<ReturnType<typeof callBinary>>, RecognizeBinaryResult> = true;
const recResult2: Eq<Awaited<ReturnType<typeof callArea>>, RecognizeAreaSelectResult> = true;
const recResult3: Eq<Awaited<ReturnType<typeof callFullBinary>>, RecognizeTasklistBinaryResult> = true;
const recResult4: Eq<Awaited<ReturnType<typeof callFullArea>>, RecognizeTasklistAreaSelectResult> = true;
const recResult5: Eq<Awaited<ReturnType<typeof callFullDrag>>, RecognizeTasklistDragDropResult> = true;
function callBinary() {
  return nc.recognize({ type: "hcaptcha", task: "t", image_data: ["b64"] });
}
function callArea() {
  return nc.recognize({ type: "hcaptcha_area_select", task: "t", image_data: ["b64"] });
}
function callFullBinary() {
  return nc.recognize({ data: { ...tasklist, request_type: "image_label_binary" } });
}
function callFullArea() {
  return nc.recognize({ data: { ...tasklist, request_type: "image_label_area_select" } });
}
function callFullDrag() {
  return nc.recognize({ data: { ...tasklist, request_type: "image_drag_drop" } });
}

void [rec1, rec2, recBad1, recBad2, recResult1, recResult2, recResult3, recResult4, recResult5];
