// Verifex screening MCP server: JSON-RPC 2.0 over stdio (newline-delimited), no dependencies.
// Implements initialize, ping, tools/list and tools/call. Each tool is one Verifex API call made
// with the caller's own API key (src/tools.mjs). The key comes from the environment and is never
// written to stdout or stderr, nor echoed in a tool result.

import { pathParams, TOOLS } from "./tools.mjs";
import { flattenStoredScreening, renderFailure, renderSummary } from "./summary.mjs";

export const SERVER_INFO = { name: "verifex-screening", title: "Verifex sanctions screening", version: "0.1.0" };
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_RESULT_CHARS = 100_000;
const REQUEST_TIMEOUT_MS = 30_000;

const INSTRUCTIONS =
  "Verifex screens people and companies against sanctions and watchlists. Every screening result starts with a " +
  "'Verifex status:' line written by this server. Repeat it word for word and keep its scope lines. " +
  "'Potential match — review required' is not a confirmed match and not a verdict; a person decides. " +
  "'No potential match in the lists checked' covers only the lists named; never shorten it to 'clear', 'safe' or 'not sanctioned'. " +
  "'Screening incomplete' is not a no-match anyone can rely on: say which lists were checked and which were not, and never present it as clear. " +
  "'Review required' means a person must look at the record before relying on it. Mention the Evidence Capsule id so the user can keep the audit record.";

/** Read and validate the configuration. Throws with a message safe to print (no secret values). */
export function configFromEnv(env = process.env) {
  const apiKey = env.VERIFEX_API_KEY?.trim();
  if (!apiKey) throw new Error("VERIFEX_API_KEY is not set (create a key in the Verifex dashboard under API Keys).");
  const baseUrl = (env.VERIFEX_API_URL?.trim() || "https://api.verifex.dev").replace(/\/+$/, "");
  let parsed;
  try { parsed = new URL(baseUrl); } catch { throw new Error("VERIFEX_API_URL is not a valid URL."); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
    throw new Error("VERIFEX_API_URL must use https (http is allowed only for localhost).");
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") throw new Error("VERIFEX_API_URL must be an origin only, e.g. https://api.verifex.dev");
  return { apiKey, baseUrl: parsed.origin };
}

function typeOk(value, schema) {
  switch (schema.type) {
    case "string": return typeof value === "string";
    case "integer": return Number.isInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    default: return true;
  }
}

/** Validate tool arguments against the tool's inputSchema. Returns an error message or null. */
export function validateArgs(tool, args) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return "arguments must be an object";
  const schema = tool.inputSchema;
  for (const k of schema.required ?? []) if (args[k] === undefined) return `missing required argument: ${k}`;
  for (const [k, v] of Object.entries(args)) {
    // Own properties only: "constructor" / "__proto__" must not pass as known arguments.
    const s = Object.prototype.hasOwnProperty.call(schema.properties, k) ? schema.properties[k] : undefined;
    if (!s) return `unknown argument: ${k}`;
    if (!typeOk(v, s)) return `${k} must be a ${s.type}`;
    if (s.enum && !s.enum.includes(v)) return `${k} must be one of: ${s.enum.join(", ")}`;
    if (typeof v === "string") {
      if (s.minLength !== undefined && v.trim().length < s.minLength) return `${k} is too short`;
      if (s.maxLength !== undefined && v.length > s.maxLength) return `${k} is too long`;
      if (s.pattern && !new RegExp(s.pattern).test(v)) return `${k} has the wrong format`;
    }
  }
  return null;
}

/** Build the HTTP request for a tool call (exported for tests). */
export function buildRequest(tool, args, config) {
  let path = tool.path;
  for (const p of pathParams(tool)) path = path.replace(`{${p}}`, encodeURIComponent(String(args[p])));
  const url = new URL(path, config.baseUrl);
  const headers = { authorization: `Bearer ${config.apiKey}`, accept: "application/json", "user-agent": `verifex-mcp/${SERVER_INFO.version}` };
  let body;
  if (tool.kind === "screen") {
    // Data minimisation: exactly these four fields leave the client, nothing else.
    body = {};
    for (const k of ["name", "type", "country", "date_of_birth"]) if (typeof args[k] === "string" && args[k].trim()) body[k] = args[k].trim();
    headers["content-type"] = "application/json";
  }
  return { url: url.toString(), init: { method: tool.method, headers, ...(body ? { body: JSON.stringify(body) } : {}) } };
}

function truncate(s) {
  return s.length > MAX_RESULT_CHARS ? `${s.slice(0, MAX_RESULT_CHARS)}\n… (truncated: ${s.length} characters)` : s;
}

function failureResult(tool, reason) {
  if (tool.kind === "capsule") return { isError: true, content: [{ type: "text", text: `Evidence Capsule not retrieved: ${reason}` }] };
  const f = renderFailure(reason);
  return { isError: true, content: [{ type: "text", text: f.text }], structuredContent: { verifex: { status: f.status, label: f.label, incomplete_reasons: f.incompleteReasons } } };
}

function screeningResult(served, stored) {
  const s = renderSummary(served, { stored });
  const raw = JSON.stringify(served, null, 2);
  return {
    content: [{ type: "text", text: `${s.text}\n\nFull result (as served by the Verifex API):\n${truncate(raw)}` }],
    structuredContent: {
      verifex: {
        status: s.status,
        label: s.label,
        incomplete_reasons: s.incompleteReasons,
        review_reasons: s.reviewReasons,
        lists_checked: s.scope.listsChecked,
        not_checked_on_plan: s.scope.notCheckedOnPlan,
        required_not_screened: s.scope.requiredNotScreened,
        not_available: s.scope.notAvailable,
        scope_notes: s.scope.notes,
      },
      ...(raw.length <= MAX_RESULT_CHARS ? { result: served } : {}),
    },
  };
}

function capsuleResult(status, parsed, text) {
  if (status === 202) {
    const wait = typeof parsed?.retry_after_seconds === "number" ? ` Try again in about ${parsed.retry_after_seconds} s.` : "";
    return { content: [{ type: "text", text: `Evidence Capsule pending: the screening completed and its evidence is still being written. This is not an audit gap.${wait}` }] };
  }
  const out = { content: [{ type: "text", text: truncate(text) }] };
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && text.length <= MAX_RESULT_CHARS) out.structuredContent = parsed;
  return out;
}

function httpFailureReason(status, parsed) {
  const code = typeof parsed?.code === "string" ? parsed.code : null;
  if (status === 401) return "the API key was rejected (HTTP 401). Check VERIFEX_API_KEY.";
  if (status === 403) return `the API key may not use this endpoint (HTTP 403${code ? `, ${code}` : ""}).`;
  if (status === 404) return `not found on this account (HTTP 404${code ? `, ${code}` : ""}).`;
  if (status === 429) return `rate limit or monthly quota reached (HTTP 429${code ? `, ${code}` : ""}).`;
  if (status >= 500) return `Verifex could not complete the request (HTTP ${status}${code ? `, ${code}` : ""}).`;
  const detail = typeof parsed?.error === "string" ? parsed.error : typeof parsed?.detail === "string" ? parsed.detail : null;
  return `the request was refused (HTTP ${status}${detail ? `: ${detail}` : ""}).`;
}

async function callTool(tool, args, config, fetchImpl) {
  const { url, init } = buildRequest(tool, args, config);
  let res;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    const why = err?.name === "TimeoutError" ? `no answer within ${REQUEST_TIMEOUT_MS / 1000} s` : "network error";
    return failureResult(tool, `the Verifex API was unreachable (${why}).`);
  }
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* non-JSON body */ }
  if (tool.kind === "capsule") {
    if (res.status === 200 || res.status === 202) return capsuleResult(res.status, parsed, text);
    return failureResult(tool, httpFailureReason(res.status, parsed));
  }
  if (res.status !== 200) return failureResult(tool, httpFailureReason(res.status, parsed));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return failureResult(tool, "the API answered with something that is not a screening result.");
  return tool.kind === "screening" ? screeningResult(flattenStoredScreening(parsed), true) : screeningResult(parsed, false);
}

function toolListing(t) {
  return {
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: { title: t.title, readOnlyHint: t.readOnly, destructiveHint: false, idempotentHint: t.readOnly, openWorldHint: true },
  };
}

/** Handle one JSON-RPC message; returns the response object, or null for a notification. */
export async function handleMessage(msg, config, fetchImpl = fetch) {
  const isRequest = msg && typeof msg === "object" && "id" in msg && msg.id !== null;
  const reply = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id: isRequest ? msg.id : null, error: { code, message } });
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return fail(-32600, "Invalid Request");
  if (!isRequest) return null; // notifications (notifications/initialized, cancelled, …) need no answer

  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS.map(toolListing) });
    case "tools/call": {
      const name = msg.params?.name;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return fail(-32602, `Unknown tool: ${name}`);
      const args = msg.params?.arguments ?? {};
      const invalid = validateArgs(tool, args);
      if (invalid) return reply({ isError: true, content: [{ type: "text", text: `Invalid arguments: ${invalid}` }] });
      return reply(await callTool(tool, args, config, fetchImpl));
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

/** Run over stdio: one JSON message per line in, one per line out. */
export function serveStdio(config, { input = process.stdin, output = process.stdout, fetchImpl = fetch } = {}) {
  let buffer = "";
  let queue = Promise.resolve();
  const write = (obj) => { if (obj) output.write(`${JSON.stringify(obj)}\n`); };
  input.setEncoding("utf8");
  input.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); continue; }
      // Answer in order; a slow API call does not reorder responses.
      queue = queue.then(async () => {
        if (Array.isArray(msg)) { for (const m of msg) write(await handleMessage(m, config, fetchImpl)); }
        else write(await handleMessage(msg, config, fetchImpl));
      }).catch(() => write({ jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32603, message: "Internal error" } }));
    }
  });
  return () => queue;
}
