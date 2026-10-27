#!/usr/bin/env bun
import { dashboardHandler } from "../src/dashboard";
import { stateDir } from "../src/sessions";

const port = Number(process.env.DASHBOARD_PORT ?? 3458);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch: dashboardHandler(stateDir()),
});
console.log(`Claude usage dashboard listening at ${server.url}`);
