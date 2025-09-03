import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketProvider } from 'ethers';
import { runSync, exportOwners, exportOperationsGrouped, exportEventsUnified } from './indexer.js';

async function main() {
  const cmd = process.argv[2] || 'sync';
  if (cmd === 'sync') {
    const tail = process.env.TAIL === '1';
    if (!tail) {
      await runSync();
    } else {
      const intervalMs = Number(process.env.POLL_INTERVAL_MS || 15000);
      const wsUrl = process.env.ETH_WS_URL || null;
      let syncing = false;
      let pending = false;
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));

      async function syncOnce() {
        if (syncing) { pending = true; return; }
        syncing = true;
        try {
          await runSync();
        } catch (e) {
          console.error('Sync error:', e);
        } finally {
          syncing = false;
          if (pending) { pending = false; queueMicrotask(syncOnce); }
        }
      }

      // periodic fallback poller
      const timer = setInterval(syncOnce, intervalMs);
      // initial catch-up
      await syncOnce();

      // optional WS-triggered near-realtime updates
      let ws;
      if (wsUrl) {
        try {
          ws = new WebSocketProvider(wsUrl);
          ws.on('block', () => { syncOnce(); });
          ws._websocket?.addEventListener?.('close', () => {
            // ignore; periodic timer still polls
          });
        } catch (e) {
          console.warn('ETH_WS_URL provided but WebSocket connection failed; continuing with polling only');
        }
      }

      // keep the process alive until killed
      const shutdown = () => {
        clearInterval(timer);
        try { ws?.destroy?.(); } catch {}
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      // sleep forever
      // eslint-disable-next-line no-constant-condition
      while (true) { await sleep(3600_000); }
    }
  } else if (cmd === 'export') {
    const owners = exportOwners();
    const outDir = path.join(process.cwd(), 'data');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, 'owners.json');
    fs.writeFileSync(outPath, JSON.stringify(owners, null, 2));
    console.log(`Exported owners to ${outPath}`);
  } else if (cmd === 'export-ops') {
    const grouped = exportOperationsGrouped();
    const outDir = path.join(process.cwd(), 'data');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, 'operations_by_type.json');
    fs.writeFileSync(outPath, JSON.stringify(grouped, null, 2));
    console.log(`Exported operations (grouped) to ${outPath}`);
  } else if (cmd === 'export-events') {
    const events = exportEventsUnified();
    const outDir = path.join(process.cwd(), 'data');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, 'events.json');
    fs.writeFileSync(outPath, JSON.stringify(events, null, 2));
    console.log(`Exported events (timeline) to ${outPath}`);
  } else {
    console.error('Unknown command. Use: sync | export');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
