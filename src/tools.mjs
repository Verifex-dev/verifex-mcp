// The tool table. Every tool is one Verifex API call made with the caller's own API key.
// The screening tool sends only name, type, country and date of birth — nothing else.

/** @typedef {{ name: string, title: string, description: string, method: "GET"|"POST", path: string, kind: "screen"|"screening"|"capsule", readOnly: boolean, inputSchema: object }} VerifexTool */

const ID = { type: "string", minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9_-]+$" };

/** @type {VerifexTool[]} */
export const TOOLS = [
  {
    name: "screen_name",
    title: "Screen a person or company",
    description:
      "Screen one person or company against the sanctions and watchlists on the caller's Verifex plan. " +
      "Uses one screening from the plan's quota. Sends only the name, type, country and date of birth. " +
      "The result starts with a status line written by this server: report it word for word. " +
      "A potential match is not a confirmed match; zero matches cover only the lists named in the result; " +
      "an incomplete screening must never be reported as clear.",
    method: "POST",
    path: "/v1/screen",
    kind: "screen",
    readOnly: false,
    inputSchema: {
      type: "object",
      required: ["name"],
      additionalProperties: false,
      properties: {
        name: { type: "string", minLength: 1, maxLength: 500, pattern: "^[^\\u0000-\\u001F\\u007F-\\u009F\\u00AD\\u061C\\u180E\\u200B\\u200E\\u200F\\u2028-\\u202E\\u2060-\\u2064\\u2066-\\u206F\\uFEFF]+$", description: "Full name of the person or company, on one line." },
        type: { type: "string", enum: ["person", "entity"], description: "person, or entity for a company or organisation." },
        country: { type: "string", pattern: "^[A-Za-z]{2}$", description: "Two-letter ISO 3166-1 country code of nationality, residence or registration, e.g. AE, DE, RU." },
        date_of_birth: { type: "string", pattern: "^\\d{4}(-\\d{2}-\\d{2})?$", description: "YYYY or YYYY-MM-DD. People only; narrows the candidates." },
      },
    },
  },
  {
    name: "get_screening",
    title: "Get a past screening",
    description:
      "Return the stored record of an earlier screening on this account by its request_id, with its scope. " +
      "A stored record may not carry Verifex's final decision; then the status reads 'Review required'. " +
      "Does not run a new screening and uses no quota.",
    method: "GET",
    path: "/v1/screenings/{request_id}",
    kind: "screening",
    readOnly: true,
    inputSchema: {
      type: "object",
      required: ["request_id"],
      additionalProperties: false,
      properties: { request_id: { ...ID, description: "The request_id returned by screen_name." } },
    },
  },
  {
    name: "get_evidence_capsule",
    title: "Get the Evidence Capsule",
    description:
      "Return the Evidence Capsule for a screening: the audit record of what was screened, which list versions were checked, " +
      "what was found and how the result was reached. Uses no quota. A capsule that is still being written is reported as pending, not missing.",
    method: "GET",
    path: "/v1/evidence-capsules/{capsule_id}",
    kind: "capsule",
    readOnly: true,
    inputSchema: {
      type: "object",
      required: ["capsule_id"],
      additionalProperties: false,
      properties: { capsule_id: { ...ID, description: "evidence_capsule_id from a screening (the same value as its request_id)." } },
    },
  },
];

/** Path parameters named in a tool's path, e.g. ["request_id"]. */
export function pathParams(tool) {
  return [...tool.path.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]);
}
