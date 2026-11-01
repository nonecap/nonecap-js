#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { NoneCap } from "../client.js";
import { createMcpServer } from "./server.js";

// The package has no @types/node: the library itself must stay runtime-agnostic.
declare const process: { env: Record<string, string | undefined>; exit(code: number): never };

const apiKey = process.env.NONECAP_API_KEY?.trim();
const baseURL = process.env.NONECAP_BASE_URL?.trim() || undefined;

if (!apiKey) {
  console.error("nonecap-mcp: NONECAP_API_KEY is not set; every tool call will return missing_api_key.");
}

const client = apiKey ? new NoneCap({ apiKey, baseURL }) : null;

createMcpServer(client)
  .connect(new StdioServerTransport())
  .catch((err: unknown) => {
    console.error("nonecap-mcp:", err);
    process.exit(1);
  });
