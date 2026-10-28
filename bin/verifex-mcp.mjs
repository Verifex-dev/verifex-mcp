#!/usr/bin/env node
// Verifex screening MCP server (stdio). Configure in your MCP client:
//   command: npx -y verifex-mcp   (or: node /path/to/bin/verifex-mcp.mjs)
//   env: VERIFEX_API_KEY (required), VERIFEX_API_URL (optional, default https://api.verifex.dev)
import { configFromEnv, serveStdio } from "../src/server.mjs";

let config;
try {
  config = configFromEnv();
} catch (err) {
  process.stderr.write(`verifex-mcp: ${err.message}\n`);
  process.exit(1);
}
serveStdio(config);
