import 'dotenv/config';
import http from 'node:http';
import url from 'node:url';
import { WebSocketServer } from 'ws';
import { JsonRpcProvider } from 'ethers';
import { exportOwners, exportActiveOffers, exportActiveBids, exportFloor, exportEventsSinceCursor, formatCursor, parseCursor, getLastSyncedBlock } from './indexer.js';
import { runSync } from './indexer.js';

type Progress = {
  deployBlock: number | null;
  lastSynced: number | null;
  latest: number | null;
  behind: number | null;
  lastRunStartedAt: number | null;
  lastRunCompletedAt: number | null;
  lastRunProcessed: number | null;
};

const PORT = Number(process.env.PORT || 8080);
const ETH_RPC_URL = process.env.ETH_RPC_URL;
if (!ETH_RPC_URL) {
  console.error('ETH_RPC_URL is required');
  process.exit(2);
}
const provider = new JsonRpcProvider(ETH_RPC_URL);

// Simple state for progress and broadcasts
let progress: Progress = {
  deployBlock: null,
  lastSynced: getLastSyncedBlock(),
  latest: null,
  behind: null,
  lastRunStartedAt: null,
  lastRunCompletedAt: null,
  lastRunProcessed: null,
};

let lastBroadcastCursor = formatCursor(progress.lastSynced || 0, -1);

async function updateLatest() {
  try { progress.latest = await provider.getBlockNumber(); }
  catch { progress.latest = null; }
  if (progress.latest != null && progress.lastSynced != null) {
    progress.behind = Math.max(0, progress.latest - progress.lastSynced);
  } else {
    progress.behind = null;
  }
}

// Web server
const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

  const parsed = url.parse(req.url || '', true);
  const path = parsed.pathname || '/';
  const query = parsed.query || {} as Record<string, string>;

  const send = (code: number, body: any) => {
    const data = JSON.stringify(body);
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
    res.end(data);
  };
  const notFound = () => send(404, { error: 'not_found' });

  try {
    if (path === '/' || path === '/v1/health') {
      await updateLatest();
      send(200, { ok: true, latest: progress.latest, lastSynced: progress.lastSynced, behind: progress.behind });
      return;
    }
    if (path === '/v1/progress') {
      await updateLatest();
      send(200, progress);
      return;
    }
    if (path === '/v1/owners') {
      send(200, exportOwners());
      return;
    }
    if (path === '/v1/market') {
      const offers = exportActiveOffers();
      const bids = exportActiveBids();
      const floor = exportFloor();
      send(200, { offers, bids, floor });
      return;
    }
    if (path === '/v1/events') {
      const limit = Math.max(1, Math.min(5000, Number(query.limit || 1000)));
      const { events, nextCursor } = exportEventsSinceCursor(query.fromCursor as string | undefined, limit, false);
      send(200, { events: events.map((e: any) => ({ ...e, cursor: formatCursor(e.blockNumber, e.logIndex) })), nextCursor });
      return;
    }
    if (path === '/v1/events/normalized') {
      const limit = Math.max(1, Math.min(5000, Number(query.limit || 1000)));
      const { events, nextCursor } = exportEventsSinceCursor(query.fromCursor as string | undefined, limit, true);
      send(200, { events, nextCursor });
      return;
    }
  } catch (e: any) {
    console.error('HTTP error:', e);
    send(500, { error: 'internal_error', message: e?.message || String(e) });
    return;
  }
  notFound();
});

// WebSocket broadcast for new events
const wss = new WebSocketServer({ server, path: '/ws' });
type Client = import('ws').WebSocket & { isAlive?: boolean };
const clients = new Set<Client>();
wss.on('connection', (ws: Client) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'hello', lastCursor: lastBroadcastCursor }));
  ws.on('close', () => { clients.delete(ws); });
});

setInterval(() => {
  for (const ws of clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} clients.delete(ws); continue; }
    ws.isAlive = false; try { ws.ping(); } catch {}
  }
}, 30000);

function broadcast(payload: any) {
  const data = JSON.stringify(payload);
  for (const ws of clients) {
    try { ws.send(data); } catch {}
  }
}

// Tailing loop: initial sync + keep-up
let syncing = false;
let pending = false;
async function syncOnce() {
  if (syncing) { pending = true; return; }
  syncing = true;
  const before = getLastSyncedBlock() ?? -1;
  progress.lastRunStartedAt = Date.now();
  try {
    await runSync();
  } catch (e) {
    console.error('sync error:', e);
  } finally {
    progress.lastRunCompletedAt = Date.now();
    progress.lastSynced = getLastSyncedBlock();
    await updateLatest();
    const after = progress.lastSynced ?? before;
    progress.lastRunProcessed = after - before;
    // broadcast new events since lastBroadcastCursor
    try {
      const { events, nextCursor } = exportEventsSinceCursor(lastBroadcastCursor, 5000, false);
      if (events.length) {
        broadcast({ type: 'events', events: events.map((e: any) => ({ ...e, cursor: formatCursor(e.blockNumber, e.logIndex) })) });
        lastBroadcastCursor = nextCursor;
      }
    } catch (e) {
      console.warn('broadcast error:', e);
    }
    syncing = false;
    if (pending) { pending = false; queueMicrotask(syncOnce); }
  }
}

// periodic poller + optional WS-trigger on new blocks
const intervalMs = Number(process.env.POLL_INTERVAL_MS || 15000);
const timer = setInterval(syncOnce, intervalMs);
syncOnce(); // initial catch-up

// If an ETH_WS_URL is provided, trigger syncs on new blocks
if (process.env.ETH_WS_URL) {
  try {
    const wsProvider = new (require('ethers').WebSocketProvider)(process.env.ETH_WS_URL);
    wsProvider.on('block', () => { syncOnce(); });
    (wsProvider as any)._websocket?.addEventListener?.('close', () => {});
  } catch (e) {
    console.warn('ETH_WS_URL provided but WebSocket connect failed; using polling only');
  }
}

server.listen(PORT, () => {
  console.log(`API listening on :${PORT}`);
});

