import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketProvider } from 'ethers';
import { runSync, exportOwners, exportOperationsGrouped, exportEventsUnified, exportEventsNormalized, exportActiveOffers, exportActiveBids, exportFloor } from './indexer.js';

async function main() {
  const cmd = process.argv[2] || 'sync';
  if (cmd === 'sync') {
    const tail = process.env.TAIL === '1';
    const argv = process.argv.slice(3);
    const reset = argv.includes('--reset');
    const verboseFlag = argv.includes('--verbose');
    if (verboseFlag) process.env.VERBOSE = '1';
    if (reset) {
      const dataDir = path.join(process.cwd(), 'data');
      const dbBase = path.join(dataDir, 'punks.sqlite');
      const wal = dbBase + '-wal';
      const shm = dbBase + '-shm';
      try {
        if (fs.existsSync(dbBase)) fs.rmSync(dbBase);
        if (fs.existsSync(wal)) fs.rmSync(wal);
        if (fs.existsSync(shm)) fs.rmSync(shm);
        console.log('Reset: removed SQLite database and WAL/SHM files.');
      } catch (e) {
        console.warn('Reset: failed to remove some files:', e.message);
      }
    }
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
      let ws: WebSocketProvider | undefined;
      if (wsUrl) {
        try {
          ws = new WebSocketProvider(wsUrl);
          ws.on('block', () => { syncOnce(); });
          (ws as any)._websocket?.addEventListener?.('close', () => {
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
    const argv = process.argv.slice(3);
    const onlyOwners = argv.includes('--owners');
    const onlyOps = argv.includes('--ops');
    const onlyEvents = argv.includes('--events');
    const includeNormalized = argv.includes('--normalized') || (!onlyOwners && !onlyOps && !onlyEvents);
    const onlyMarket = argv.includes('--market');
    const punkArg = argv.find(a => a.startsWith('--punk='));
    const punkIndex = punkArg ? Number(punkArg.split('=')[1]) : null;
    const selected = (onlyOwners || onlyOps || onlyEvents) ? { owners: onlyOwners, ops: onlyOps, events: onlyEvents } : { owners: true, ops: true, events: true };

    const outDir = path.join(process.cwd(), 'data');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    if (selected.owners) {
      const owners = exportOwners();
      const ownersPath = path.join(outDir, 'owners.json');
      fs.writeFileSync(ownersPath, JSON.stringify(owners, null, 2));
      console.log(`Exported owners to ${ownersPath}`);
    }
    if (selected.ops) {
      const grouped = exportOperationsGrouped(punkIndex);
      const opsPath = path.join(outDir, 'operations_by_type.json');
      fs.writeFileSync(opsPath, JSON.stringify(grouped, null, 2));
      console.log(`Exported operations (grouped) to ${opsPath}`);
    }
    if (selected.events) {
      const events = exportEventsUnified(punkIndex);
      const eventsPath = path.join(outDir, 'events.json');
      fs.writeFileSync(eventsPath, JSON.stringify(events, null, 2));
      console.log(`Exported events (timeline) to ${eventsPath}`);
    }
    if (includeNormalized) {
      const eventsN = exportEventsNormalized(punkIndex);
      const eventsNPath = path.join(outDir, 'events_normalized.json');
      fs.writeFileSync(eventsNPath, JSON.stringify(eventsN, null, 2));
      console.log(`Exported events (normalized) to ${eventsNPath}`);
    }
    if (onlyMarket || (!onlyOwners && !onlyOps && !onlyEvents)) {
      const offers = exportActiveOffers();
      const bids = exportActiveBids();
      const floor = exportFloor();
      const marketPath = path.join(outDir, 'market.json');
      fs.writeFileSync(marketPath, JSON.stringify({ offers, bids, floor }, null, 2));
      console.log(`Exported market state to ${marketPath}`);
    }
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
  } else if (cmd === 'verify') {
    const sqlite3 = await import('better-sqlite3');
    const pathDb = path.join(process.cwd(), 'data', 'punks.sqlite');
    if (!fs.existsSync(pathDb)) {
      console.error('No database found at data/punks.sqlite');
      process.exit(2);
    }
    const Database: any = (sqlite3 as any).default || (sqlite3 as any);
    const db = new Database(pathDb);
    const tables = ['raw_logs','assigns','transfers','offers','offer_cancellations','bids','bid_withdrawals','buys','owners'];
    const counts = Object.fromEntries(tables.map(t => [t, db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c]));
    const last = db.prepare(`SELECT value FROM meta WHERE key='last_synced_block'`).get()?.value ?? null;
    const deploy = db.prepare(`SELECT value FROM meta WHERE key='deploy_block'`).get()?.value ?? null;
    console.log(JSON.stringify({ counts, meta: { deploy_block: deploy, last_synced_block: last } }, null, 2));
  } else {
    console.error('Unknown command. Use: sync | export');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
