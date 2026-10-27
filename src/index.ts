#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Account } from "./account.ts";
import { loadConfig } from "./config.ts";
import { KimaiClient } from "./kimai.ts";
import { createServer } from "./server.ts";

try {
  const config = loadConfig(process.env);
  const client = new KimaiClient(config);
  const server = createServer(client, new Account(client, config.timeZone));

  await server.connect(new StdioServerTransport());
  console.error(`kimai-mcp: connected over stdio, using ${config.baseUrl}`);
} catch (error) {
  console.error(`kimai-mcp: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
