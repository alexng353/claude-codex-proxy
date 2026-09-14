#!/usr/bin/env bun
import { handleRequest } from "./app";

const hostname = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3456);

if (!["127.0.0.1", "localhost", "::1"].includes(hostname) && !process.env.PROXY_API_KEY) {
  throw new Error("PROXY_API_KEY is required when binding outside localhost");
}

const server = Bun.serve({ hostname, port, fetch: handleRequest });
console.log(`Claude Codex Proxy listening at ${server.url}`);
