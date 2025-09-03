#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const dataDir = path.join(process.cwd(), 'data');
const pidPath = path.join(dataDir, '.server.pid');

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  if (!fs.existsSync(pidPath)) {
    console.log('[stop] No PID file found at', pidPath);
    // Fallback: attempt to find a listener on PORT and kill
    const PORT = process.env.PORT || '8080';
    try {
      const { execSync } = require('node:child_process');
      const out = execSync(`lsof -iTCP:${PORT} -sTCP:LISTEN -nP | awk 'NR>1 {print $2, $1}'`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      if (out) {
        const line = out.split('\n')[0];
        const pid = Number(line.split(/\s+/)[0]);
        if (pid && pid > 0) {
          console.log('[stop] Killing process on port', PORT, 'pid', pid);
          try { process.kill(pid, 'SIGTERM'); } catch {}
          await sleep(500);
          if (isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
          console.log('[stop] Done.');
        }
      }
    } catch {}
    process.exit(0);
  }
  let pid = null;
  try {
    const raw = JSON.parse(fs.readFileSync(pidPath, 'utf-8'));
    pid = Number(raw?.pid);
  } catch {}
  if (!pid || pid <= 0) {
    console.log('[stop] Invalid PID file; removing');
    try { fs.unlinkSync(pidPath); } catch {}
    process.exit(0);
  }
  if (!isAlive(pid)) {
    console.log('[stop] Process not running; cleaning up PID file');
    try { fs.unlinkSync(pidPath); } catch {}
    process.exit(0);
  }
  console.log('[stop] Stopping server pid', pid);
  try { process.kill(pid, 'SIGTERM'); } catch {}
  for (let i = 0; i < 30; i++) {
    if (!isAlive(pid)) break;
    await sleep(200);
  }
  if (isAlive(pid)) {
    console.log('[stop] SIGTERM did not stop process; sending SIGKILL');
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
  try { fs.unlinkSync(pidPath); } catch {}
  console.log('[stop] Done.');
})();
