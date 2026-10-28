import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { buildRequest, configFromEnv, handleMessage, validateArgs } from "../src/server.mjs";
import { TOOLS } from "../src/tools.mjs";

const KEY = "vfx_test_not_a_real_key_0000";
const config = { apiKey: KEY, baseUrl: "https://api.verifex.dev" };
const tool = (name) => TOOLS.find((t) => t.name === name);
const call = (name, args, fetchImpl) => handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, config, fetchImpl);
const respond = (status, body) => async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

const noMatch = {
  request_id: "scr_1", coverage_status: "complete", total_matches: 0, risk_level: "clear", verdict: "clear", matches: [],
  lists_checked: ["OFAC", "UN"], sources_excluded_by_plan: ["EU", "UK"], plan_scope_notice: "Free plan: OFAC and UN only.", evidence_capsule_id: "scr_1",
};

test("configuration needs a key and an https origin", () => {
  assert.throws(() => configFromEnv({}), /VERIFEX_API_KEY is not set/);
  assert.throws(() => configFromEnv({ VERIFEX_API_KEY: "k", VERIFEX_API_URL: "http://api.example.com" }), /must use https/);
  assert.throws(() => configFromEnv({ VERIFEX_API_KEY: "k", VERIFEX_API_URL: "https://api.example.com/v1" }), /origin only/);
  assert.equal(configFromEnv({ VERIFEX_API_KEY: "k", VERIFEX_API_URL: "http://localhost:3001" }).baseUrl, "http://localhost:3001");
});

test("the screening request carries only name, type, country and date of birth", () => {
  const { url, init } = buildRequest(tool("screen_name"), { name: " Ivan Petrov ", type: "person", country: "RU", date_of_birth: "1970", email: "x@y.z" }, config);
  assert.equal(url, "https://api.verifex.dev/v1/screen");
  assert.deepEqual(JSON.parse(init.body), { name: "Ivan Petrov", type: "person", country: "RU", date_of_birth: "1970" });
  assert.equal(init.headers.authorization, `Bearer ${KEY}`);
});

test("unknown or malformed arguments are refused before any call", () => {
  assert.match(validateArgs(tool("screen_name"), { name: "A", email: "x" }), /unknown argument: email/);
  assert.match(validateArgs(tool("screen_name"), { name: "   " }), /too short/);
  assert.match(validateArgs(tool("screen_name"), { name: "A", date_of_birth: "70" }), /wrong format/);
  assert.match(validateArgs(tool("get_screening"), { request_id: "../x" }), /wrong format/);
  assert.match(validateArgs(tool("screen_name"), JSON.parse('{"name":"A","constructor":"x"}')), /unknown argument: constructor/);
});

test("a no-match result leads with the scoped status line and keeps the served JSON", async () => {
  const res = await call("screen_name", { name: "Made Up Person" }, respond(200, noMatch));
  const text = res.result.content[0].text;
  assert.match(text, /^Verifex status: No potential match in the lists checked/);
  assert.match(text, /Not checked on this plan: EU, UK/);
  assert.equal(res.result.structuredContent.verifex.status, "no_match_in_scope");
  assert.deepEqual(res.result.structuredContent.result, noMatch);
});

test("an outage, a 503 and a quota refusal are all 'screening incomplete', never clear", async () => {
  for (const fetchImpl of [
    async () => { throw new TypeError("fetch failed"); },
    respond(503, { screening_unavailable: true, requires_manual_review: true }),
    respond(429, { code: "QUOTA_EXCEEDED" }),
    respond(200, "<html>proxy error</html>"),
  ]) {
    const res = await call("screen_name", { name: "Anyone" }, fetchImpl);
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /^Verifex status: Screening incomplete — do not treat as clear/);
    assert.equal(res.result.structuredContent.verifex.status, "incomplete");
  }
});

test("the API key never appears in any tool result", async () => {
  const outputs = await Promise.all([
    call("screen_name", { name: "A" }, respond(200, noMatch)),
    call("screen_name", { name: "A" }, respond(401, { error: "bad key" })),
    call("screen_name", { name: "A" }, async () => { throw new Error(`boom ${KEY}`); }),
    call("get_evidence_capsule", { capsule_id: "scr_1" }, respond(404, { code: "CAPSULE_NOT_FOUND" })),
  ]);
  for (const o of outputs) assert.doesNotMatch(JSON.stringify(o), new RegExp(KEY));
});

test("a pending capsule is reported as pending, not as missing", async () => {
  const res = await call("get_evidence_capsule", { capsule_id: "scr_1" }, respond(202, { code: "CAPSULE_PENDING", retry_after_seconds: 3 }));
  assert.notEqual(res.result.isError, true);
  assert.match(res.result.content[0].text, /pending.*not an audit gap.*3 s/s);
});

test("tools/list offers exactly the three tools", async () => {
  const res = await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, config);
  assert.deepEqual(res.result.tools.map((t) => t.name), ["screen_name", "get_screening", "get_evidence_capsule"]);
});

test("end to end over stdio against a local HTTP API", async () => {
  const seen = [];
  const api = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(noMatch));
    });
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  const port = api.address().port;
  const bin = fileURLToPath(new URL("../bin/verifex-mcp.mjs", import.meta.url));
  const child = spawn(process.execPath, [bin], { env: { PATH: process.env.PATH, VERIFEX_API_KEY: KEY, VERIFEX_API_URL: `http://127.0.0.1:${port}` } });
  let out = "";
  let err = "";
  child.stdout.on("data", (c) => { out += c; });
  child.stderr.on("data", (c) => { err += c; });
  const lines = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "screen_name", arguments: { name: "Made Up Person", type: "person" } } },
  ];
  child.stdin.write(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const deadline = Date.now() + 10_000;
  while (out.trim().split("\n").filter(Boolean).length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  child.kill();
  api.close();
  const msgs = out.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(msgs[0].result.serverInfo.name, "verifex-screening");
  assert.match(msgs[1].result.content[0].text, /^Verifex status: No potential match in the lists checked/);
  assert.deepEqual(seen.map((s) => [s.method, s.url]), [["POST", "/v1/screen"]]);
  assert.equal(seen[0].auth, `Bearer ${KEY}`);
  assert.deepEqual(JSON.parse(seen[0].body), { name: "Made Up Person", type: "person" });
  assert.doesNotMatch(out + err, new RegExp(KEY));
});
