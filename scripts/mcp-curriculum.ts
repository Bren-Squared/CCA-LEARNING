import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildCurriculumServer } from "../lib/mcp/curriculum-server";

/**
 * Phase 18 / E5 — stdio-launched MCP server entry point.
 *
 * Registered via `.mcp.json` so a Claude Code session running in this repo can
 * connect on demand. Read-only by surface (no write tools registered).
 */
async function main() {
  const server = buildCurriculumServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The transport keeps the process alive on stdin; no explicit await needed.
}

main().catch((err) => {
  // Stderr only — stdio is the JSON-RPC channel; never write JSON-RPC noise to it.
  console.error("[mcp-curriculum] fatal:", err);
  process.exit(1);
});
