import 'dotenv/config';
import http from 'node:http';
import url from 'node:url';
import zlib from 'node:zlib';
import { WebSocketServer } from 'ws';
import { JsonRpcProvider } from 'ethers';
import { exportOwners, exportActiveOffers, exportActiveBids, exportFloor, exportEventsSinceCursor, exportEventsFiltered, formatCursor, parseCursor, getLastSyncedBlock } from './indexer.js';
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
const sseClients = new Set<{ write: (event: string, payload: any) => void }>();

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
const DISABLE_COMPRESSION = process.env.DISABLE_COMPRESSION === '1';
const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
  if (req.method === 'HEAD') {
    // Fast path: acknowledge endpoint without generating body
    res.writeHead(200, { 'content-type': 'application/json', 'vary': 'Accept-Encoding' });
    res.end();
    return;
  }

  const parsed = url.parse(req.url || '', true);
  const path = parsed.pathname || '/';
  const query = parsed.query || {} as Record<string, string>;

  const send = (code: number, body: any) => {
    const data = Buffer.from(JSON.stringify(body));
    const ae = String(req.headers['accept-encoding'] || '');
    const useBr = ae.includes('br') && typeof zlib.brotliCompress === 'function';
    const useGz = !useBr && ae.includes('gzip');
    if (!DISABLE_COMPRESSION && useBr) {
      zlib.brotliCompress(data, (err, out) => {
        if (err) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(data); return; }
        res.writeHead(code, { 'content-type': 'application/json', 'content-encoding': 'br', 'vary': 'Accept-Encoding', 'content-length': out.length });
        res.end(out);
      });
      return;
    }
    if (!DISABLE_COMPRESSION && useGz) {
      zlib.gzip(data, (err, out) => {
        if (err) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(data); return; }
        res.writeHead(code, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'vary': 'Accept-Encoding', 'content-length': out.length });
        res.end(out);
      });
      return;
    }
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': data.length, 'vary': 'Accept-Encoding' });
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

    if (path === '/v1/stream/events') {
      // Server-Sent Events stream (global timeline)
      const headers: Record<string, string> = {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no',
      };
      res.writeHead(200, headers);
      const q = parsed.query as any;
      const fromCursor = (q.fromCursor as string) || (q.cursor as string) || lastBroadcastCursor;
      const limit = Math.max(1, Math.min(5000, Number(q.limit || 1000)));
      const normalized = q.normalized === '1' || q.normalized === 'true';
      const write = (event: string, payload: any) => {
        try {
          res.write(`event: ${event}\n`);
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        } catch {}
      };
      // initial backlog
      try {
        const { events, nextCursor } = exportEventsSinceCursor(fromCursor, limit, normalized);
        if (events.length) write('events', { events, nextCursor });
      } catch {}
      // register client
      const client = { write };
      sseClients.add(client);
      const ka = setInterval(() => { try { res.write(`:ka\n\n`); } catch {} }, 15000);
      req.on('close', () => { clearInterval(ka); sseClients.delete(client); try { res.end(); } catch {} });
      return;
    }
    if (path === '/v1/market') {
      const offers = exportActiveOffers();
      const bids = exportActiveBids();
      const floor = exportFloor();
      send(200, { offers, bids, floor });
      return;
    }
    if (path === '/v1/events' || path === '/v1/events/normalized') {
      const limit = Math.max(1, Math.min(5000, Number(query.limit || 1000)));
      const normalized = path.endsWith('/normalized') || query.normalized === '1' || query.normalized === 'true';
      const fromCursor = (query.fromCursor as string) || (query.cursor as string) || undefined;
      const fromBlock = query.fromBlock != null ? Number(query.fromBlock) : undefined;
      const toBlock = query.toBlock != null ? Number(query.toBlock) : undefined;
      const types = (query.types as string | undefined)?.split(',').map(s => s.trim()).filter(Boolean);
      const punkIndices = (query.punk as string | undefined)?.split(',').map(s => Number(s)).filter(n => Number.isFinite(n));
      const address = (query.address as string | undefined) || undefined;
      const { events, nextCursor } = exportEventsFiltered({ cursor: fromCursor, fromBlock, toBlock, types: types?.length ? types : undefined, punkIndices: punkIndices?.length ? punkIndices : undefined, address, limit, normalized });
      send(200, { events, nextCursor });
      return;
    }
    if (path?.startsWith('/v1/punks/')) {
      const parts = path.split('/');
      const id = Number(parts[3]);
      if (!Number.isFinite(id)) { send(400, { error: 'bad_punk' }); return; }
      if (parts.length === 4 || parts[4] === '') {
        // summary: owner + active market
        const owners = exportOwners();
        const owner = owners[String(id) as keyof typeof owners] || null;
        // active offer
        const offer = exportActiveOffers().find((o: any) => o.punkIndex === id) || null;
        // active bids sorted by value desc
        const bids = exportActiveBids().filter((b: any) => b.punkIndex === id);
        send(200, { punkIndex: id, owner, offer, bids });
        return;
      }
      if (parts[4] === 'events') {
        const limit = Math.max(1, Math.min(5000, Number(query.limit || 1000)));
        const normalized = query.normalized === '1' || query.normalized === 'true';
        const fromCursor = (query.fromCursor as string) || (query.cursor as string) || undefined;
        const fromBlock = query.fromBlock != null ? Number(query.fromBlock) : undefined;
        const toBlock = query.toBlock != null ? Number(query.toBlock) : undefined;
        const types = (query.types as string | undefined)?.split(',').map(s => s.trim()).filter(Boolean);
        const { events, nextCursor } = exportEventsFiltered({ cursor: fromCursor, fromBlock, toBlock, types: types?.length ? types : undefined, punkIndices: [id], limit, normalized });
        send(200, { events, nextCursor });
        return;
      }
      send(404, { error: 'not_found' });
      return;
    }
    if (path?.startsWith('/v1/owners/')) {
      const addr = (path.split('/')[3] || '').toLowerCase();
      if (!addr || !addr.startsWith('0x') || addr.length !== 42) { send(400, { error: 'bad_address' }); return; }
      const owners = exportOwners();
      const punks = Object.entries(owners).filter(([_, v]) => String(v).toLowerCase() === addr).map(([k]) => Number(k)).sort((a,b)=>a-b);
      send(200, { owner: addr, punkIndices: punks });
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
wss.shouldHandle = async (req) => {
  // Allow all origins; tighten if needed
  return true;
};
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
  for (const c of sseClients) {
    try { c.write('events', payload); } catch {}
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
