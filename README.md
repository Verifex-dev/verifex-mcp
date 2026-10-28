# Verifex sanctions screening — MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets an AI assistant
screen a person or company with [Verifex](https://verifex.dev), read back a past screening, and
fetch the screening's **Evidence Capsule** — the audit record of what was checked and found.

- Uses **your own Verifex API key**. Screenings bill to your existing Verifex plan.
- Sends Verifex **only** the name, type (person or company), country and date of birth.
- No runtime dependencies. Node.js 18.17 or later. Runs locally over stdio.

## How results read

Every result starts with a status line, then the scope, then the full result exactly as the
Verifex API served it. The status follows the decision Verifex itself served (`verdict`); this
server only ever adds caution to it, never removes it.

| Status line | Meaning |
|---|---|
| `Potential match — review required` | At least one candidate on a checked list, or a match held back because your plan excludes its list. Not a verdict: a person decides. |
| `No potential match in the lists checked` | Verifex served a clear decision, and nothing was found **in the lists named underneath**. It is not a statement that the party is on no list anywhere. |
| `Screening incomplete — do not treat as clear` | No match was found, but Verifex does not treat the result as a clearance, and the reason is given. Examples: a required list (OFAC, UN, EU or UK) was not screened; lists in your plan were unavailable at screening time; the name is in a non-Latin script; an exact-only lookup. It is also shown when the screening could not complete or the response could not be read. |
| `Review required — no potential match, but this result is not a clearance` | A person must look at the record first. Example: a stored record read back with `get_screening` that does not carry Verifex's decision. |

On the Free plan Verifex screens OFAC and UN only, and every result says so. EU and UK are
required lists, so a Free-plan result with no match reads `Screening incomplete` and names the
lists the plan did not check.

## Get an API key

Sign in at [verifex.dev](https://verifex.dev) → **Dashboard → API Keys** → create a key.
**Create a separate key just for your MCP client**, so you can revoke it on its own. The key
has full access to your account's API, not only screening. Keep it in your MCP client's
configuration; never paste it into a chat.

## Set up

### Claude Desktop

Settings → Developer → Edit Config, then add:

```json
{
  "mcpServers": {
    "verifex": {
      "command": "npx",
      "args": ["-y", "verifex-mcp"],
      "env": { "VERIFEX_API_KEY": "<your Verifex API key>" }
    }
  }
}
```

Restart Claude Desktop. You can also install the `verifex-mcp.mcpb` bundle from the
[releases page](https://github.com/dvecy/verifex-mcp/releases); Claude Desktop asks for the key.

### Claude Code

```bash
claude mcp add verifex --env VERIFEX_API_KEY=<your Verifex API key> -- npx -y verifex-mcp
```

### Cursor, Windsurf and other clients

Use the same `command`, `args` and `env` as the Claude Desktop example in the client's MCP
settings (Cursor: `~/.cursor/mcp.json`).

### VS Code

`.vscode/mcp.json`:

```json
{
  "inputs": [{ "type": "promptString", "id": "verifex-key", "description": "Verifex API key", "password": true }],
  "servers": {
    "verifex": {
      "command": "npx",
      "args": ["-y", "verifex-mcp"],
      "env": { "VERIFEX_API_KEY": "${input:verifex-key}" }
    }
  }
}
```

| Variable | Required | Meaning |
|---|---|---|
| `VERIFEX_API_KEY` | yes | Your secret Verifex API key. |
| `VERIFEX_API_URL` | no | Default `https://api.verifex.dev`. Must be https (http only for localhost). |

## Tools

| Tool | What it does | Quota |
|---|---|---|
| `screen_name` | Screen one person or company (`name`, optional `type`, `country`, `date_of_birth`). | One screening |
| `get_screening` | Read the stored record of an earlier screening on your account by `request_id`. A stored record may not carry Verifex's decision; then it reads `Review required`. | None |
| `get_evidence_capsule` | Get the Evidence Capsule for a screening. A capsule still being written is reported as pending. | None |

## Example prompts

1. *"Screen Acme Trading FZE, a company registered in the United Arab Emirates, and tell me exactly which lists were checked."*
2. *"We're onboarding a new distributor contact, Ivan Petrov, born 1971, Russian national. Screen him and, if there is a potential match, list each candidate with its list and programmes."*
3. *"Get the Evidence Capsule for request scr_… and summarise what was screened, when, and against which list versions, so I can attach it to our customer file."*

## Data and privacy

Only the four fields above are sent to Verifex, over HTTPS to `api.verifex.dev`, with your API
key as a bearer token. The key is read from the environment and is never written to the
assistant, to stdout or to logs. Verifex keeps the screening and its Evidence Capsule on your
account as described in the [privacy policy](https://verifex.dev/privacy) and
[DPA](https://verifex.dev/dpa).

The name you ask about, and the results this server returns (including candidate records and,
with `get_screening`, earlier screenings on your account), become part of your conversation
with your AI assistant. They are handled by that assistant's provider under its own terms.

Verifex results support your compliance decision; they are not legal advice.

## Develop

```bash
npm test                # node --test, no dependencies
npm run pack:mcpb       # builds dist/verifex-mcp.mcpb
```

Support: [verifex.dev/support](https://verifex.dev/support). Security reports: see
[SECURITY.md](SECURITY.md). Licence: MIT.
