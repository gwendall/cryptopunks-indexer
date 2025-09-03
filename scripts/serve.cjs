#!/usr/bin/env node
/*
  Idempotent start-or-restart for the API server on a Linux host.
  - Stops any existing instance (via PID file or port scan)
  - Starts a new detached server process
  - Logs to data/server.log
*/
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execSync } = require('node:child_process');

const PORT = Number(process.env.PORT || 8080);
const cwd = process.cwd();
const dataDir = path.join(cwd, 'data');
const pidPath = path.join(dataDir, '.server.pid');
const logPath = path.join(dataDir, 'server.log');

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function ensureDirs() {
  try { if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true }); } catch {}
}

async function stopIfRunning() {
  // Prefer PID file if present
  if (fs.existsSync(pidPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(pidPath, 'utf-8'));
      const pid = Number(raw?.pid);
      if (pid && pid > 0 && isAlive(pid)) {
        process.stdout.write(`[serve] Stopping existing server pid ${pid}...\n`);
        try { process.kill(pid, 'SIGTERM'); } catch {}
        for (let i = 0; i < 30; i++) { if (!isAlive(pid)) break; await sleep(200); }
        if (isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      }
    } catch {}
    try { fs.unlinkSync(pidPath); } catch {}
  }

  // Fallback: if something is listening on PORT, kill it
  try {
    const out = execSync(`lsof -iTCP:${PORT} -sTCP:LISTEN -nP | awk 'NR>1 {print $2}'`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (out) {
      const pids = Array.from(new Set(out.split(/\s+/).map(x => Number(x)).filter(n => Number.isFinite(n) && n > 1)));
      if (pids.length) {
        process.stdout.write(`[serve] Port ${PORT} busy; terminating ${pids.join(', ')}...\n`);
        for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch {} }
        await sleep(500);
        for (const pid of pids) { if (isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} } }
      }
    }
  } catch {}
}

async function startDetached() {
  ensureDirs();
  // Open log streams (append)
  const out = fs.openSync(logPath, 'a');
  const err = fs.openSync(logPath, 'a');
  // Start the TS server via tsx
  const child = spawn(process.execPath, ['--import', 'tsx', path.join('src', 'server.ts')], {
    cwd,
    env: process.env,
    detached: true,
    stdio: ['ignore', out, err],
  });
  child.unref();
  process.stdout.write(`[serve] Started server (pid ${child.pid}) on :${PORT}. Logs -> ${path.relative(cwd, logPath)}\n`);
}

(async () => {
  try {
    await stopIfRunning();
    await startDetached();
  } catch (e) {
    console.error('[serve] Failed:', e?.message || e);
    process.exit(1);
  }
})();

