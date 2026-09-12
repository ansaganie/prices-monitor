// Standalone daemon: executes check immediately, then repeats every 30 minutes.
// Useful for running 24/7 locally, on a VPS, or in a Docker container without relying on GitHub Actions.
// Usage: bun run daemon

import { spawn } from "node:child_process";

const INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

function runCheck() {
  console.log(`\n[${new Date().toISOString()}] Running parking price check...`);
  const proc = spawn("bun", ["run", "src/check.js"], {
    stdio: "inherit",
    env: process.env,
  });

  proc.on("close", (code) => {
    console.log(`[${new Date().toISOString()}] Check finished with code ${code}. Next run in 30m.`);
  });
}

console.log("Starting BI Parking Monitor daemon (interval: 30 minutes)...");
runCheck();
setInterval(runCheck, INTERVAL_MS);
