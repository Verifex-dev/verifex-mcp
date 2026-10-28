import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, flattenStoredScreening, renderFailure, renderSummary, STATUS } from "../src/summary.mjs";

const complete = {
  request_id: "scr_test_1",
  screened_at: "2026-10-28T10:00:00.000Z",
  query: { name: "Test Name", type: "person" },
  coverage_status: "complete",
  lists_checked: ["OFAC", "UN", "EU", "UK"],
  sources_excluded_by_plan: [],
  evidence_capsule_id: "scr_test_1",
  evidence_persistence: "available",
};

test("a sanctions hit is a potential match, never a verdict", () => {
  const r = {
    ...complete,
    total_matches: 1,
    risk_level: "critical",
    verdict: "confirmed_match",
    matches: [{ name: "Listed Person", source: "OFAC", confidence: 97, programs: ["RUSSIA-EO14024"] }],
  };
  const s = renderSummary(r);
  assert.equal(s.status, STATUS.POTENTIAL_MATCH);
  assert.match(s.text, /^Verifex status: Potential match — review required/);
  assert.match(s.text, /"Listed Person" — list "OFAC", confidence 97, programs RUSSIA-EO14024/);
  assert.match(s.text, /This is not a verdict/);
  assert.doesNotMatch(s.text, /confirmed/i);
});

test("a PEP candidate (risk_level match) is a potential match", () => {
  const s = renderSummary({ ...complete, total_matches: 1, risk_level: "match", verdict: "possible_match", matches: [{ name: "A Politician", source: "PEP" }] });
  assert.equal(s.status, STATUS.POTENTIAL_MATCH);
});

test("zero matches name the lists checked and the plan's exclusions, and never say clear", () => {
  const r = {
    ...complete,
    total_matches: 0,
    risk_level: "clear",
    verdict: "clear",
    matches: [],
    lists_checked: ["OFAC", "UN", "EU", "UK", "SECO"],
    sources_excluded_by_plan: ["PEP"],
    plan_scope_notice: "Your plan does not include PEP screening.",
    clear_scope: "checked_sources_only",
  };
  const s = renderSummary(r);
  assert.equal(s.status, STATUS.NO_MATCH_IN_SCOPE);
  assert.match(s.text, /^Verifex status: No potential match in the lists checked/);
  assert.match(s.text, /Lists checked \(5\): OFAC, UN, EU, UK, SECO/);
  assert.match(s.text, /Not checked on this plan: PEP/);
  assert.match(s.text, /Your plan does not include PEP screening\./);
  assert.match(s.text, /This result covers the checked lists only\./);
  assert.match(s.text, /does not say the party is absent from every list/);
  assert.doesNotMatch(s.text.split("\n")[0], /\bclear\b/i);
});

test("a Free-plan no-match (OFAC and UN only) is incomplete and names the lists it skipped", () => {
  const r = {
    ...complete,
    total_matches: 0,
    risk_level: "clear",
    verdict: "partial",
    coverage_status: "partial",
    coverage_notice: "EU and UK are required lists and were not screened on this plan.",
    lists_checked: ["OFAC", "UN"],
    sources_excluded_by_plan: ["EU", "UK"],
    plan_scope_notice: "Your Free plan screens OFAC and UN only.",
  };
  const s = renderSummary(r);
  assert.equal(s.status, STATUS.INCOMPLETE);
  assert.match(s.text, /Lists checked \(2\): OFAC, UN/);
  assert.match(s.text, /Not checked on this plan: EU, UK/);
  assert.match(s.text, /Your Free plan screens OFAC and UN only\./);
});

test("zero matches with partial coverage is incomplete, not a no-match", () => {
  const s = renderSummary({ ...complete, total_matches: 0, risk_level: "clear", verdict: "partial", coverage_status: "partial", coverage_notice: "UK could not be screened.", unavailable_sources: [{ source: "UK" }] });
  assert.equal(s.status, STATUS.INCOMPLETE);
  assert.match(s.text, /Screening incomplete — do not treat as clear/);
  assert.match(s.text, /UK could not be screened\./);
  assert.match(s.text, /Required lists not screened: UK/);
});

test("matches the plan withheld still make it a potential match", () => {
  const s = renderSummary({ ...complete, total_matches: 0, risk_level: "clear", verdict: "clear", restricted_matches: 2 });
  assert.equal(s.status, STATUS.POTENTIAL_MATCH);
  assert.match(s.text, /2 further potential matches on lists this plan does not include/);
});

test("an unknown verdict, missing coverage or an unavailable screen is incomplete", () => {
  assert.equal(classify({ ...complete, total_matches: 0, risk_level: "clear", verdict: "something_new" }).status, STATUS.INCOMPLETE);
  const { coverage_status: _c, ...noCoverage } = complete;
  assert.equal(classify({ ...noCoverage, total_matches: 0, risk_level: "clear", verdict: "clear" }).status, STATUS.INCOMPLETE);
  assert.equal(classify({ ...complete, total_matches: 0, screening_unavailable: true }).status, STATUS.INCOMPLETE);
  assert.equal(classify({ ...complete, total_matches: 0, candidate_set_complete: false }).status, STATUS.INCOMPLETE);
  assert.equal(classify(null).status, STATUS.INCOMPLETE);
  assert.equal(classify([]).status, STATUS.INCOMPLETE);
});

test("an exact-only or uncertain no-match needs review, it is not a no-match", () => {
  assert.equal(classify({ ...complete, total_matches: 0, risk_level: "clear", verdict: "clear", screening_mode: "exact_only" }).status, STATUS.REVIEW_REQUIRED);
  assert.equal(classify({ ...complete, total_matches: 0, risk_level: "clear", verdict: "uncertain" }).status, STATUS.REVIEW_REQUIRED);
  assert.equal(classify({ ...complete, total_matches: 0, risk_level: "clear", verdict: "clear", identity_conflict: true }).status, STATUS.REVIEW_REQUIRED);
});

test("the evidence line tells pending and missing apart", () => {
  assert.match(renderSummary({ ...complete, total_matches: 0, evidence_persistence: "pending" }).text, /still being written/);
  assert.match(renderSummary({ ...complete, total_matches: 0, evidence_persistence: "unavailable" }).text, /none was saved/);
  assert.match(renderSummary({ ...complete, total_matches: 0 }).text, /Evidence Capsule: "scr_test_1" — open it with get_evidence_capsule/);
});

test("a stored screening reads its finalized root fields over the original result", () => {
  const flat = flattenStoredScreening({ request_id: "scr_9", risk_level: "medium", coverage_status: "complete", total_matches: 1, full_result: { ...complete, risk_level: "clear", total_matches: 1, matches: [{ name: "X" }] } });
  assert.equal(flat.risk_level, "medium");
  assert.equal(flat.request_id, "scr_9");
  assert.equal(classify(flat).status, STATUS.POTENTIAL_MATCH);
});

test("a failure never names a list as checked", () => {
  const f = renderFailure("the Verifex API was unreachable (network error).");
  assert.equal(f.status, STATUS.INCOMPLETE);
  assert.match(f.text, /No lists were confirmed as checked/);
});

// Responses served by a real Verifex API (local test instance, synthetic data, 2026-10-28).
import { readFileSync } from "node:fs";
const served = (name) => JSON.parse(readFileSync(new URL(`./fixtures/served-${name}.json`, import.meta.url), "utf8"));

test("served: a sanctioned person and a PEP are potential matches", () => {
  for (const name of ["sanctioned-person", "pep"]) {
    const s = renderSummary(served(name));
    assert.equal(s.status, STATUS.POTENTIAL_MATCH, name);
    assert.match(s.text, /This is not a verdict/);
  }
});

test("served: a Free-plan no-match is incomplete, names OFAC and UN, and never claims exact-only", () => {
  const s = renderSummary(served("made-up-free"));
  assert.equal(s.status, STATUS.INCOMPLETE);
  assert.match(s.text, /Lists checked \(2\): OFAC, UN/);
  assert.match(s.text, /Required lists not screened: EU, UK/);
  assert.doesNotMatch(s.text, /Exact-only/);
});

test("served: a long unavailable list is shortened in the status block, not dropped", () => {
  const r = served("made-up");
  const s = renderSummary(r);
  const line = s.text.split("\n").find((l) => l.startsWith("Not available at screening time"));
  assert.match(line, new RegExp(`\\(${r.sources_withheld_unavailable.length}\\)`));
  assert.match(line, /more \(all listed in the full result\)/);
});

// ── The served verdict is the decision; this server only adds caution ────────────────────────

const clearBase = { ...complete, total_matches: 0, matches: [], risk_level: "clear", risk_tier: "clear", verdict: "clear", screening_mode: "standard", policy_resolution_status: "resolved" };

test("the only path to 'no potential match' is a served verdict of clear", () => {
  assert.equal(classify(clearBase).status, STATUS.NO_MATCH_IN_SCOPE);
  for (const verdict of [undefined, null, "partial", "uncertain", "possible_match", "confirmed_match", "CLEAR", "clear ", "", "pending"]) {
    assert.notEqual(classify({ ...clearBase, verdict }).status, STATUS.NO_MATCH_IN_SCOPE, `verdict ${JSON.stringify(verdict)}`);
  }
});

test("results the platform refuses to call clear never read 'no potential match'", () => {
  const cases = {
    "verdict missing": (() => { const { verdict: _v, ...r } = clearBase; return r; })(),
    "verdict null": { ...clearBase, verdict: null },
    "risk_tier review": { ...clearBase, risk_tier: "review" },
    "unknown screening_mode": { ...clearBase, screening_mode: "fuzzy_v2" },
    "candidate_set_complete as a string": { ...clearBase, candidate_set_complete: "false" },
    "restricted_matches as a string": { ...clearBase, restricted_matches: "3" },
    "v3 identity conflict unassessed": { ...clearBase, deciding_engine: "v3", identity_conflict: null, identity_conflict_attributes: [{ attribute: "date_of_birth" }] },
    "unknown decision_ceiling": { ...clearBase, decision_ceiling: "WEIRD" },
    "clearance_eligible as a string": { ...clearBase, clearance_eligible: "no" },
  };
  for (const [name, r] of Object.entries(cases)) assert.notEqual(classify(r).status, STATUS.NO_MATCH_IN_SCOPE, name);
});

test("an unrecognised value in any enum field never reads as reassurance", () => {
  for (const field of ["verdict", "coverage_status", "risk_level", "risk_tier", "screening_mode", "clear_scope", "evidence_persistence", "policy_resolution_status", "decision_ceiling", "retrieval_limitation"]) {
    const s = classify({ ...clearBase, [field]: "SOMETHING_NEW" });
    assert.notEqual(s.status, STATUS.NO_MATCH_IN_SCOPE, field);
  }
  for (const field of ["screening_unavailable", "candidate_set_complete", "clearance_eligible", "identity_conflict", "requires_manual_review", "human_review_required"]) {
    assert.notEqual(classify({ ...clearBase, [field]: "yes" }).status, STATUS.NO_MATCH_IN_SCOPE, field);
  }
});

test("a non-Latin no-match is incomplete with the Latin-spelling advice, not a phantom match", () => {
  const s = renderSummary({ ...clearBase, verdict: "partial", risk_level: "medium", retrieval_limitation: "non_latin_no_match", query: { name: "Владимир" } });
  assert.equal(s.status, STATUS.INCOMPLETE);
  assert.match(s.text, /Screen the Latin spelling as well/);
  assert.doesNotMatch(s.text, /Potential matches:/);
});

test("exact-only and identity-conflict no-matches, as the API serves them (verdict partial), are incomplete", () => {
  assert.equal(classify({ ...clearBase, verdict: "partial", screening_mode: "exact_only", clearance_eligible: false }).status, STATUS.INCOMPLETE);
  assert.equal(classify({ ...clearBase, verdict: "partial", identity_conflict: true }).status, STATUS.INCOMPLETE);
});

test("a paid no-match scoped to the checked lists explains why it is incomplete", () => {
  const s = renderSummary(served("made-up"));
  assert.equal(s.status, STATUS.INCOMPLETE);
  assert.match(s.text, /lists outside your plan or not available at screening time were not checked/);
  assert.doesNotMatch(s.text, /marked this result partial/);
});

test("get_screening on a stored record without the decision is never more reassuring than the screen", () => {
  // The stored full_response is the engine result before the trust layer added `verdict`.
  const { verdict: _v, risk_tier: _t, evidence_persistence: _e, ...engine } = served("made-up");
  const body = { request_id: engine.request_id, risk_level: "clear", coverage_status: "complete", clear_scope: "checked_sources_only", total_matches: 0, lists_checked: engine.lists_checked, full_result: engine };
  const s = renderSummary(flattenStoredScreening(body), { stored: true });
  assert.notEqual(s.status, STATUS.NO_MATCH_IN_SCOPE);
  assert.match(s.text, /does not carry Verifex's decision/);
  assert.doesNotMatch(s.text, /still being written/);
});

test("served: get_screening read-back of a paid no-match reads review required, not no-match", () => {
  const s = renderSummary(served("made-up-readback"), { stored: true });
  assert.equal(s.status, STATUS.REVIEW_REQUIRED);
  assert.doesNotMatch(s.text, /still being written/);
});
