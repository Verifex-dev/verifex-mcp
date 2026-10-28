// How a Verifex screening result is read out. Pure functions, no I/O.
//
// The decision is Verifex's, not this file's. The API serves `verdict`, and on a zero-match it
// is "clear" only when Verifex's own clearance rules all pass; otherwise it is "partial". This
// file reads that verdict and may only ADD caution on top of it:
//  - Any match, including one held back because the plan excludes its list, reads
//    "Potential match — review required". It is never a verdict.
//  - "No potential match in the lists checked" is printed ONLY for a served verdict "clear" with
//    nothing else in the response pulling against it, and always names the lists checked and the
//    lists not checked. Never a universal "clear".
//  - verdict "partial", an outage, partial coverage, or any value this server does not recognise
//    reads "Screening incomplete". A missing verdict reads "Review required". Unknown is never clear.

export const STATUS = Object.freeze({
  POTENTIAL_MATCH: "potential_match",
  REVIEW_REQUIRED: "review_required",
  INCOMPLETE: "incomplete",
  NO_MATCH_IN_SCOPE: "no_match_in_scope",
});

const LABELS = {
  potential_match: "Potential match — review required",
  review_required: "Review required — no potential match, but this result is not a clearance",
  incomplete: "Screening incomplete — do not treat as clear",
  no_match_in_scope: "No potential match in the lists checked",
};

const KNOWN_VERDICTS = new Set(["clear", "partial", "possible_match", "confirmed_match", "uncertain"]);
const MAX_LISTED_MATCHES = 5;

// Every enum the response may carry, with the values this server knows. A value outside the set
// means the API has learnt something this server has not: it is never read as reassurance.
const ENUMS = {
  verdict: KNOWN_VERDICTS,
  coverage_status: new Set(["complete", "partial"]),
  risk_level: new Set(["clear", "low", "match", "medium", "high", "critical", "unavailable"]),
  risk_tier: new Set(["clear", "review", "block", "monitor"]),
  screening_mode: new Set(["standard", "exact_only"]),
  clear_scope: new Set(["checked_sources_only"]),
  evidence_persistence: new Set(["available", "pending", "unavailable"]),
  policy_resolution_status: new Set(["resolved", "none", "unavailable"]),
  decision_ceiling: new Set(["CLEAR", "MONITOR", "REVIEW", "BLOCK"]),
  retrieval_limitation: new Set(["non_latin_no_match"]),
};
const BOOLEANS = ["screening_unavailable", "requires_manual_review", "human_review_required", "candidate_set_complete", "clearance_eligible", "identity_conflict", "evasion_detected"];
const NUMBERS = ["total_matches", "restricted_matches"];

/** Field names whose value has a type or enum value this server does not recognise. */
export function unrecognisedFields(r) {
  const bad = [];
  for (const [k, allowed] of Object.entries(ENUMS)) if (r[k] !== undefined && r[k] !== null && !allowed.has(r[k])) bad.push(k);
  for (const k of BOOLEANS) if (r[k] !== undefined && r[k] !== null && typeof r[k] !== "boolean") bad.push(k);
  for (const k of NUMBERS) if (r[k] !== undefined && r[k] !== null && !(typeof r[k] === "number" && Number.isFinite(r[k]))) bad.push(k);
  return bad;
}

// The dashboard's own sentences for a zero-match that cannot be a clearance
// (packages/shared/src/decision-presentation.ts, primarySub), so every surface says the same.
function partialReason(r) {
  if (r.coverage_status === "partial") return null; // the coverage reason is already given
  if (r.retrieval_limitation === "non_latin_no_match") {
    return "No listed-party match was found, but matching names written in this script against the lists is not verified. Screen the Latin spelling as well.";
  }
  if (r.screening_mode === "exact_only") {
    return text(r.mode_limitation_notice) ?? "Exact-only lookup found no exact candidate. It did not check spelling variants, transliterations, aliases or typos, so this is not a compliance clearance.";
  }
  if (r.clear_scope === "checked_sources_only") {
    return "No listed-party match was found in the lists checked, but lists outside your plan or not available at screening time were not checked, so this cannot be treated as a full clearance.";
  }
  if (r.candidate_set_complete === false) return null; // given separately
  if (r.identity_conflict === true) return "Identity evidence conflicts with a supplied detail. This result is not a clearance.";
  return "No listed-party match was found, but Verifex does not treat this result as a clearance. Review the full result before relying on it.";
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Every string below comes from a record: a name someone typed, a list's alias, a notice. It is
// data, and it must not be able to look like this server's own lines or carry text a person cannot
// see. These become spaces: control characters (C0, C1 incl. NEL), line and paragraph separators,
// bidi controls, zero-width space, word joiners, BOM, soft hyphen, fillers and other characters
// that render as nothing (CGJ, Hangul fillers, braille blank, interlinear annotation, musical and
// shorthand format controls), and Unicode tag characters (U+E0000-E007F, "ASCII smuggling").
// ZWJ/ZWNJ (U+200C/D) stay: Persian and Indic names need them.
export const INVISIBLE_OR_CONTROL =
  "\\p{Cc}\\u00AD\\u034F\\u061C\\u115F\\u1160\\u17B4\\u17B5\\u180E\\u200B\\u200E\\u200F\\u2028-\\u202E\\u2060-\\u2064\\u2066-\\u206F" +
  "\\u2800\\u3164\\uFEFF\\uFFA0\\uFFF9-\\uFFFB\\u{1BCA0}-\\u{1BCA3}\\u{1D173}-\\u{1D17A}\\u{E0000}-\\u{E007F}";
// A character takes at most one variation selector (a Japanese name may use one); a run of two or
// more carries hidden bytes ("variation-selector smuggling") and is removed.
export const VARIATION_SELECTOR_RUN = /[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]{2,}/gu;
const UNSAFE = new RegExp(`[${INVISIBLE_OR_CONTROL}]+`, "gu");
// For JSON text: JSON.stringify already escapes C0 controls inside strings, and its own newlines
// are structure, so this class leaves U+0000-001F alone and escapes everything else above.
const UNSAFE_IN_JSON = new RegExp(`[${INVISIBLE_OR_CONTROL.replace("\\p{Cc}", "\\u007F-\\u009F")}]`, "gu");
const MAX_VALUE_CHARS = 200;
const MAX_NOTICE_CHARS = 4000;
export function safe(v, max = MAX_VALUE_CHARS) {
  const flat = String(v).replace(VARIATION_SELECTOR_RUN, "").replace(UNSAFE, " ").replace(/ {2,}/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * JSON text in which every such character inside a string is written as a \\uXXXX escape.
 * JSON.stringify leaves U+2028/2029, NEL, bidi and tag characters raw; escaping them is lossless
 * (the JSON parses to the same value) and means no value can start a line or hide text.
 */
const VS_IN_JSON = /[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu;
export function stringifyEscaped(value, space) {
  const escape = (ch) =>
    [...ch].flatMap((c) => { const u = c.codePointAt(0); return u > 0xffff ? [Math.floor((u - 0x10000) / 0x400) + 0xd800, ((u - 0x10000) % 0x400) + 0xdc00] : [u]; })
      .map((u) => `\\u${u.toString(16).padStart(4, "0")}`).join("");
  return JSON.stringify(value, null, space).replace(UNSAFE_IN_JSON, escape).replace(VS_IN_JSON, escape);
}
/** A record value shown in quotes, so it reads as quoted data, never as the server's prose. */
const quoted = (v) => JSON.stringify(safe(v));

const strings = (v) => (Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : x?.source)).filter((x) => typeof x === "string" && x.trim()).map((x) => safe(x)) : []);
// Verifex's own notices are long by design (they name every list not consulted); never cut them.
const text = (v) => (typeof v === "string" && v.trim() ? safe(v, MAX_NOTICE_CHARS) : null);
const count = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * GET /v1/screenings/{id} serves the original result under `full_result` and re-projects the
 * finalized decision fields at the root. The root wins wherever it has a value.
 */
export function flattenStoredScreening(body) {
  if (!isObject(body)) return body;
  const base = isObject(body.full_result) ? body.full_result : {};
  const out = { ...base };
  for (const [k, v] of Object.entries(body)) {
    // An own "__proto__" key from JSON.parse would SET the prototype on plain assignment.
    if (k === "full_result" || k === "__proto__" || v === null || v === undefined) continue;
    Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** Classify one served screening result. Returns { status, label, incompleteReasons, reviewReasons }. */
export function classify(r) {
  if (!isObject(r)) return { status: STATUS.INCOMPLETE, label: LABELS.incomplete, incompleteReasons: ["The response was not a screening result."], reviewReasons: [] };

  const incompleteReasons = [];
  const reviewReasons = [];

  const bad = unrecognisedFields(r);
  if (bad.length) incompleteReasons.push(`The result carries values this server does not recognise (${bad.join(", ")}). Review it in the Verifex dashboard.`);
  if (r.screening_unavailable === true || r.risk_level === "unavailable") incompleteReasons.push("The screen could not be completed. This is not a result.");
  if (r.coverage_status === "partial") incompleteReasons.push(text(r.coverage_notice) ?? "Required coverage was incomplete: a required list was not screened.");
  else if (r.coverage_status !== "complete") incompleteReasons.push("The result did not state its coverage.");
  if (r.verdict === "partial") {
    const why = partialReason(r);
    if (why) incompleteReasons.push(why);
  }
  if (r.retrieval_limitation === "non_latin_no_match" && r.verdict !== "partial") {
    incompleteReasons.push("Matching names written in this script against the lists is not verified. Screen the Latin spelling as well.");
  }
  if (r.candidate_set_complete === false) incompleteReasons.push("Not every available candidate was evaluated.");
  if (r.policy_resolution_status === "unavailable") incompleteReasons.push("The account's screening policy could not be loaded.");

  // A hit is a candidate, a match held back by the plan, or a match verdict. A non-clear
  // risk_level alone is not a hit: a non-Latin no-match is served as "medium" with no candidate.
  const hasMatches =
    count(r.total_matches) > 0 ||
    (Array.isArray(r.matches) && r.matches.length > 0) ||
    count(r.restricted_matches) > 0 ||
    r.verdict === "possible_match" ||
    r.verdict === "confirmed_match";

  if (r.verdict === undefined || r.verdict === null) reviewReasons.push("This record does not carry Verifex's decision. Review it in the Verifex dashboard before relying on it.");
  if (r.verdict === "uncertain") reviewReasons.push("The evidence is ambiguous. Treat it as unresolved, not as a clear.");
  if (r.human_review_required === true || r.requires_manual_review === true) reviewReasons.push("Verifex flags this result for human review.");
  if (r.screening_mode === "exact_only" && r.verdict !== "partial") {
    reviewReasons.push(text(r.mode_limitation_notice) ?? "Exact-only lookup: spelling variants, transliterations and aliases were not checked.");
  }
  if (r.clearance_eligible === false && incompleteReasons.length === 0) reviewReasons.push("Verifex marks this result as not eligible to be treated as a clearance.");
  if (r.identity_conflict === true && r.verdict !== "partial") reviewReasons.push("Identity evidence conflicts with a supplied detail.");
  if (r.deciding_engine === "v3" && r.identity_conflict == null && Array.isArray(r.identity_conflict_attributes) && r.identity_conflict_attributes.length > 0) {
    reviewReasons.push("Conflicting identity details were reported but not assessed.");
  }
  if (typeof r.risk_tier === "string" && r.risk_tier !== "clear") reviewReasons.push(`Verifex placed this result in its ${quoted(r.risk_tier)} tier.`);
  if (typeof r.risk_level === "string" && !["clear", "unavailable"].includes(r.risk_level) && !hasMatches) {
    reviewReasons.push(`Risk level is ${quoted(r.risk_level)} with no candidate listed.`);
  }

  let status;
  if (hasMatches) status = STATUS.POTENTIAL_MATCH;
  else if (incompleteReasons.length > 0) status = STATUS.INCOMPLETE;
  else if (reviewReasons.length > 0 || r.verdict !== "clear") status = STATUS.REVIEW_REQUIRED;
  else status = STATUS.NO_MATCH_IN_SCOPE;

  return { status, label: LABELS[status], incompleteReasons, reviewReasons };
}

/** Scope facts that must travel with every result. */
export function scope(r) {
  if (!isObject(r)) return { listsChecked: [], notCheckedOnPlan: [], requiredNotScreened: [], notAvailable: [], notes: [] };
  const listsChecked = strings(r.lists_checked).length ? strings(r.lists_checked) : strings(r.sources_checked);
  const notCheckedOnPlan = strings(r.sources_excluded_by_plan);
  // unavailable_sources is the coverage gate's list: required lists that were not screened,
  // whether the plan did not ask for them or they were down. Not the same as "withheld".
  const requiredNotScreened = strings(r.unavailable_sources);
  const notAvailable = strings(r.sources_withheld_unavailable).filter((x) => !requiredNotScreened.includes(x));
  const notes = [r.plan_scope_notice, r.availability_scope_notice, r.restricted_match_notice, r.coverage_status === "complete" ? r.coverage_notice : null]
    .map(text)
    .filter(Boolean);
  if (r.clear_scope === "checked_sources_only") notes.push("This result covers the checked lists only.");
  return { listsChecked, notCheckedOnPlan, requiredNotScreened, notAvailable, notes: [...new Set(notes)] };
}

const MAX_NAMED = 10;
function named(list) {
  if (list.length <= MAX_NAMED) return list.join(", ");
  return `${list.slice(0, MAX_NAMED).join(", ")} and ${list.length - MAX_NAMED} more (all listed in the full result)`;
}

function evidenceLine(r, stored) {
  const id = text(r.evidence_capsule_id) ?? (stored ? text(r.request_id) : null);
  if (r.evidence_persistence === "unavailable") return "Evidence Capsule: none was saved for this screening.";
  if (!id) return "Evidence Capsule: not referenced in this result.";
  // "pending" is true only at the moment the screening was served; a stored copy may still say it.
  const pending = !stored && r.evidence_persistence === "pending" ? " (still being written; it can take a few seconds)" : "";
  return `Evidence Capsule: ${quoted(id)}${pending} — open it with get_evidence_capsule.`;
}

function matchLines(r) {
  const matches = Array.isArray(r.matches) ? r.matches : [];
  const lines = matches.slice(0, MAX_LISTED_MATCHES).map((m, i) => {
    const name = text(m?.name) ? quoted(m.name) : "(unnamed)";
    const parts = [text(m?.source) ? `list ${quoted(m.source)}` : null, typeof m?.confidence === "number" && Number.isFinite(m.confidence) ? `confidence ${Math.round(m.confidence)}` : null, strings(m?.programs).length ? `programs ${strings(m.programs).join(", ")}` : null].filter(Boolean);
    return `  ${i + 1}. ${name}${parts.length ? ` — ${parts.join(", ")}` : ""}`;
  });
  const total = Math.max(count(r.total_matches), matches.length);
  if (total > lines.length && lines.length > 0) lines.push(`  … ${total - lines.length} more in the full result.`);
  const restricted = count(r.restricted_matches);
  if (restricted > 0) lines.push(`  ${restricted} further potential match${restricted === 1 ? "" : "es"} on lists this plan does not include.`);
  return lines;
}

/** The status block an assistant shows the user, ahead of the raw result. */
export function renderSummary(r, { stored = false } = {}) {
  const c = classify(r);
  const s = scope(r);
  const lines = [`Verifex status: ${c.label}`];
  if (isObject(r)) {
    const q = isObject(r.query) ? r.query : {};
    const who = [text(q.name) ? `name ${quoted(q.name)}` : null, text(q.type) ? `type ${quoted(q.type)}` : null, text(q.country) ? `country ${quoted(q.country)}` : null].filter(Boolean).join(", ");
    const when = [who || null, text(r.screened_at) ? `screened ${quoted(r.screened_at)}` : null, text(r.request_id) ? `request_id ${quoted(r.request_id)}` : null].filter(Boolean);
    if (when.length) lines.push(`Screened: ${when.join(" · ")}`);
  }
  if (c.status === STATUS.POTENTIAL_MATCH) {
    lines.push("Potential matches:", ...matchLines(r));
    lines.push("This is not a verdict. A person must review each potential match before any decision.");
  }
  for (const reason of c.incompleteReasons) lines.push(`Incomplete: ${reason}`);
  for (const reason of c.reviewReasons) lines.push(`Review: ${reason}`);
  lines.push(`Lists checked (${s.listsChecked.length}): ${s.listsChecked.length ? s.listsChecked.join(", ") : "none reported"}`);
  if (s.requiredNotScreened.length) lines.push(`Required lists not screened: ${named(s.requiredNotScreened)}`);
  if (s.notCheckedOnPlan.length) lines.push(`Not checked on this plan: ${named(s.notCheckedOnPlan)}`);
  if (s.notAvailable.length) lines.push(`Not available at screening time (${s.notAvailable.length}): ${named(s.notAvailable)}`);
  for (const note of s.notes) lines.push(note);
  if (c.status === STATUS.NO_MATCH_IN_SCOPE) lines.push("This covers only the lists checked above. It does not say the party is absent from every list.");
  if (isObject(r)) lines.push(evidenceLine(r, stored));
  return { ...c, scope: s, text: lines.join("\n") };
}

/** The status block for a request that never produced a result (network, timeout, 5xx, 429). */
export function renderFailure(reason) {
  return {
    status: STATUS.INCOMPLETE,
    label: LABELS.incomplete,
    incompleteReasons: [reason],
    reviewReasons: [],
    scope: { listsChecked: [], notCheckedOnPlan: [], requiredNotScreened: [], notAvailable: [], notes: [] },
    text: [`Verifex status: ${LABELS.incomplete}`, `Incomplete: ${reason}`, "No lists were confirmed as checked. Do not treat the party as clear; screen again."].join("\n"),
  };
}
