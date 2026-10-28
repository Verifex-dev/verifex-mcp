// Build dist/verifex-mcp.mcpb: a zip of manifest.json, icon.png, the server and its licence.
// The bundle has no dependencies to install. Prints the SHA-256 for release notes.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
if (manifest.version !== pkg.version) throw new Error(`manifest.json version ${manifest.version} != package.json ${pkg.version}`);

const out = "dist/verifex-mcp.mcpb";
mkdirSync(new URL("../dist", import.meta.url), { recursive: true });
rmSync(new URL(`../${out}`, import.meta.url), { force: true });
execFileSync("zip", ["-q", "-X", "-r", out, "manifest.json", "icon.png", "bin", "src", "LICENSE", "README.md"], { cwd: root, stdio: "inherit" });
const sha = createHash("sha256").update(readFileSync(new URL(`../${out}`, import.meta.url))).digest("hex");
process.stdout.write(`${out}\nsha256 ${sha}\n`);
