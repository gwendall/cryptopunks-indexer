import 'dotenv/config';
import http from 'node:http';
import url from 'node:url';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { JsonRpcProvider } from 'ethers';
import { exportOwners, exportPunksByOwner, exportActiveOffers, exportActiveBids, exportFloor, exportEventsSinceCursor, exportEventsFiltered, formatCursor, parseCursor, getLastSyncedBlock, getRuntimeProgress, getDeployBlock } from './indexer.js';
import { buildOpenApiSpec } from './openapi.js';
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
const MAX_LIMIT = Math.max(100, Math.min(5000, Number(process.env.MAX_LIMIT || 5000)));
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

// Initialize deploy block if available
try { progress.deployBlock = getDeployBlock(); } catch { }

let lastBroadcastCursor = formatCursor(progress.lastSynced || 0, -1);
const sseClients = new Set<{ write: (event: string, payload: any) => void }>();
const progressSseClients = new Set<{ write: (event: string, payload: any) => void }>();
let lastProgressUpdateAt: number | null = null;

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
// Write a PID file for easy stop via pnpm stop (and clean up on errors)
const dataDir = path.join(process.cwd(), 'data');
try { if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true }); } catch { }
const pidFile = path.join(dataDir, '.server.pid');
try { fs.writeFileSync(pidFile, JSON.stringify({ pid: process.pid, port: PORT, startedAt: Date.now() })); } catch { }
const cleanupPid = () => { try { fs.unlinkSync(pidFile); } catch { } };
process.on('exit', cleanupPid);
process.on('SIGINT', () => { cleanupPid(); process.exit(0); });
process.on('SIGTERM', () => { cleanupPid(); process.exit(0); });
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
    if (path === '/' || path === '/docs') {
      // Swagger UI via CDN
      const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CryptoPunks Indexer API</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
    <style> body { margin: 0; } #swagger-ui { max-width: 100%; } </style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: '/openapi.json',
        dom_id: '#swagger-ui',
        presets: [SwaggerUIBundle.presets.apis],
        layout: 'BaseLayout'
      });
    </script>
  </body>
</html>`;
      const buf = Buffer.from(html);
      const ae = String(req.headers['accept-encoding'] || '');
      const useBr = !DISABLE_COMPRESSION && ae.includes('br') && typeof zlib.brotliCompress === 'function';
      const useGz = !DISABLE_COMPRESSION && !useBr && ae.includes('gzip');
      if (useBr) {
        zlib.brotliCompress(buf, (err, out) => {
          if (err) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(buf); return; }
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'br', 'vary': 'Accept-Encoding', 'content-length': out.length });
          res.end(out);
        });
      } else if (useGz) {
        zlib.gzip(buf, (err, out) => {
          if (err) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(buf); return; }
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip', 'vary': 'Accept-Encoding', 'content-length': out.length });
          res.end(out);
        });
      } else {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': buf.length, 'vary': 'Accept-Encoding' });
        res.end(buf);
      }
      return;
    }
    if (path === '/progress' || path === '/progress/') {
      // Lightweight HTML dashboard for runtime progress
      const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Indexer Progress</title>
    <style>
      body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif;margin:20px;color:#222}
      .row{display:flex;gap:8px;align-items:center;margin:6px 0}
      .bar{height:14px;background:#eee;border-radius:7px;overflow:hidden}
      .bar>i{display:block;height:100%;background:#0aa35c}
      code{background:#f6f8fa;padding:2px 4px;border-radius:4px}
      small{color:#666}
      .grid{display:grid;grid-template-columns:160px 1fr;gap:8px 16px;align-items:center}
    </style>
  </head>
  <body>
    <h1>CryptoPunks Indexer — Progress</h1>
    <div class="row"><button id="refresh">Refresh once</button><small id="status">—</small></div>
    <div class="row bar" style="width: min(720px, 95vw);"><i id="fill" style="width:0%"></i></div>
    <div class="grid" style="max-width: 780px;">
      <div>Syncing</div><div id="isSyncing">—</div>
      <div>Blocks</div><div id="blocks">—</div>
      <div>Logs</div><div id="logs">—</div>
      <div>Window</div><div id="win">—</div>
      <div>Speed</div><div id="speed">—</div>
      <div>ETA</div><div id="eta">—</div>
      <div>Deploy</div><div id="deploy">—</div>
      <div>Started</div><div id="started">—</div>
      <div>Updated</div><div id="updated">—</div>
    </div>
    <script>
      function fmtTime(ms){ if(!ms) return '—'; const d=new Date(ms); return d.toLocaleString(); }
      function fmt(n){ if(n==null) return '—'; return String(n); }
      async function once(){ const r=await fetch('/v1/progress'); const j=await r.json(); render(j); }
      function render(j){
        const rt=j.runtime||{};
        const pct = rt.totalBlocks>0 ? (rt.processedBlocks/rt.totalBlocks)*100 : (rt.isSyncing?0:100);
        document.getElementById('fill').style.width = Math.max(0,Math.min(100,pct)).toFixed(2)+'%';
        document.getElementById('status').textContent = rt.statusLine || '—';
        document.getElementById('isSyncing').textContent = rt.isSyncing ? 'yes' : 'no';
        document.getElementById('blocks').textContent = fmt(rt.processedBlocks) + ' / ' + fmt(rt.totalBlocks) + ' (' + ((pct||0).toFixed(2)) + '%)';
        document.getElementById('logs').textContent = fmt(rt.processedLogs);
        document.getElementById('win').textContent = fmt(rt.windowSize);
        document.getElementById('speed').textContent = (rt.speedBlocksPerSec||0).toFixed(0) + ' blk/s';
        document.getElementById('eta').textContent = rt.etaSeconds!=null && isFinite(rt.etaSeconds) ? Math.round(rt.etaSeconds)+'s' : '—';
        document.getElementById('deploy').textContent = fmt(rt.deployBlock);
        document.getElementById('started').textContent = fmtTime(rt.startedAt);
        document.getElementById('updated').textContent = fmtTime(rt.updatedAt);
      }
      once();
      const es = new EventSource('/v1/stream/progress');
      es.addEventListener('progress', ev => { try { render({ runtime: JSON.parse(ev.data) }); } catch (e) {} });
      document.getElementById('refresh').onclick = once;
    </script>
  </body>
  </html>`;
  const buf = Buffer.from(html);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': buf.length, 'vary': 'Accept-Encoding' });
  res.end(buf);
  return;
}
    if (path === '/openapi.json') {
  const spec = buildOpenApiSpec('');
  send(200, spec);
  return;
}
if (path === '/' || path === '/v1/health') {
  await updateLatest();
  send(200, { ok: true, latest: progress.latest, lastSynced: progress.lastSynced, behind: progress.behind });
  return;
}
if (path === '/v1/progress') {
  await updateLatest();
  const rt = getRuntimeProgress();
  // Derive percent if possible
  const percent = (rt.totalBlocks && rt.totalBlocks > 0) ? (rt.processedBlocks / rt.totalBlocks) : null;
  send(200, {
    ...progress,
    runtime: {
      isSyncing: rt.isSyncing,
      deployBlock: rt.deployBlock,
      startFromBlock: rt.startFromBlock,
      latestTarget: rt.latestTarget,
      totalBlocks: rt.totalBlocks,
      processedBlocks: rt.processedBlocks,
      processedLogs: rt.processedLogs,
      windowSize: rt.windowSize,
      speedBlocksPerSec: rt.speedBlocksPerSec,
      etaSeconds: rt.etaSeconds,
      startedAt: rt.startedAt,
      updatedAt: rt.updatedAt,
      completedAt: rt.completedAt,
      skipTimestamps: rt.skipTimestamps,
      percent,
      statusLine: rt.statusLine,
    },
  });
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
    } catch { }
  };
  // initial backlog
  try {
    const { events, nextCursor } = exportEventsSinceCursor(fromCursor, limit, normalized);
    if (events.length) write('events', { events, nextCursor });
  } catch { }
  // register client
  const client = { write };
  sseClients.add(client);
  const ka = setInterval(() => { try { res.write(`:ka\n\n`); } catch { } }, 15000);
  req.on('close', () => { clearInterval(ka); sseClients.delete(client); try { res.end(); } catch { } });
  return;
}
if (path === '/v1/market') {
  const offers = exportActiveOffers();
  const bids = exportActiveBids();
  const floor = exportFloor();
  send(200, { offers, bids, floor });
  return;
}
if (path === '/v1/stream/progress') {
  const headers: Record<string, string> = {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no',
  };
  res.writeHead(200, headers);
  const write = (event: string, payload: any) => {
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch { }
  };
  // Send initial snapshot
  try {
    const rt = getRuntimeProgress();
    write('progress', rt);
  } catch { }
  const client = { write };
  progressSseClients.add(client);
  const ka = setInterval(() => { try { res.write(`:ka\n\n`); } catch { } }, 15000);
  req.on('close', () => { clearInterval(ka); progressSseClients.delete(client); try { res.end(); } catch { } });
  return;
}
if (path === '/v1/events' || path === '/v1/events/normalized') {
  const rawLimit = Number(query.limit || 1000);
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(rawLimit) ? rawLimit : 1000));
  const rawOffset = Number(query.offset || 0);
  const offset = Math.max(0, Number.isFinite(rawOffset) ? rawOffset : 0);
  const normalized = path.endsWith('/normalized') || query.normalized === '1' || query.normalized === 'true';
  const fromCursor = (query.fromCursor as string) || (query.cursor as string) || undefined;
  const fromBlock = query.fromBlock != null ? Number(query.fromBlock) : undefined;
  const toBlock = query.toBlock != null ? Number(query.toBlock) : undefined;
  const types = (query.types as string | undefined)?.split(',').map(s => s.trim()).filter(Boolean);
  const punkIndices = (query.punk as string | undefined)?.split(',').map(s => Number(s)).filter(n => Number.isFinite(n));
  const address = (query.address as string | undefined) || undefined;
  // Date/time filters (seconds or ISO)
  function parseTime(x: any): number | undefined {
    if (x == null) return undefined;
    const s = String(x);
    if (!s) return undefined;
    if (/^\d+$/.test(s)) return Number(s);
    const ms = Date.parse(s);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
  }
  const fromTimestamp = parseTime((query.fromTs as string) || (query.fromTime as string) || (query.fromDate as string));
  const toTimestamp = parseTime((query.toTs as string) || (query.toTime as string) || (query.toDate as string));
  const { events, nextCursor, hasMore } = exportEventsFiltered({ cursor: fromCursor, fromBlock, toBlock, fromTimestamp, toTimestamp, types: types?.length ? types : undefined, punkIndices: punkIndices?.length ? punkIndices : undefined, address, limit, offset, normalized });
  res.setHeader('X-Next-Cursor', nextCursor);
  res.setHeader('X-Has-More', hasMore ? '1' : '0');
  res.setHeader('X-Limit', String(limit));
  res.setHeader('X-Offset', String(offset));
  res.setHeader('X-Max-Limit', String(MAX_LIMIT));
  send(200, { events, nextCursor, hasMore, limit, offset, maxLimit: MAX_LIMIT });
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
    const rawLimit = Number(query.limit || 1000);
    const limit = Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(rawLimit) ? rawLimit : 1000));
    const rawOffset = Number(query.offset || 0);
    const offset = Math.max(0, Number.isFinite(rawOffset) ? rawOffset : 0);
    const normalized = query.normalized === '1' || query.normalized === 'true';
    const fromCursor = (query.fromCursor as string) || (query.cursor as string) || undefined;
    const fromBlock = query.fromBlock != null ? Number(query.fromBlock) : undefined;
    const toBlock = query.toBlock != null ? Number(query.toBlock) : undefined;
    const types = (query.types as string | undefined)?.split(',').map(s => s.trim()).filter(Boolean);
    function parseTime(x: any): number | undefined {
      if (x == null) return undefined; const s = String(x); if (!s) return undefined; if (/^\d+$/.test(s)) return Number(s); const ms = Date.parse(s); return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
    }
    const fromTimestamp = parseTime((query.fromTs as string) || (query.fromTime as string) || (query.fromDate as string));
    const toTimestamp = parseTime((query.toTs as string) || (query.toTime as string) || (query.toDate as string));
    const { events, nextCursor, hasMore } = exportEventsFiltered({ cursor: fromCursor, fromBlock, toBlock, fromTimestamp, toTimestamp, types: types?.length ? types : undefined, punkIndices: [id], limit, offset, normalized });
    res.setHeader('X-Next-Cursor', nextCursor);
    res.setHeader('X-Has-More', hasMore ? '1' : '0');
    res.setHeader('X-Limit', String(limit));
    res.setHeader('X-Offset', String(offset));
    res.setHeader('X-Max-Limit', String(MAX_LIMIT));
    send(200, { events, nextCursor, hasMore, limit, offset, maxLimit: MAX_LIMIT });
    return;
  }
  send(404, { error: 'not_found' });
  return;
}
if (path?.startsWith('/v1/owners/')) {
  const addr = (path.split('/')[3] || '').toLowerCase();
  if (!addr || !addr.startsWith('0x') || addr.length !== 42) { send(400, { error: 'bad_address' }); return; }
  const punks = exportPunksByOwner(addr);
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
wss.on('connection', (ws: Client, req: http.IncomingMessage) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  clients.add(ws);
  try {
    const u = new URL(req.url || '/ws', 'http://localhost');
    const fromCursor = u.searchParams.get('fromCursor') || u.searchParams.get('cursor');
    const normalized = (u.searchParams.get('normalized') || '0') === '1';
    const rawLimit = Number(u.searchParams.get('limit') || 1000);
    const limit = Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(rawLimit) ? rawLimit : 1000));
    if (fromCursor) {
      try {
        const { events, nextCursor } = exportEventsSinceCursor(fromCursor, limit, normalized);
        const payload = normalized ? { type: 'events', events, nextCursor } : { type: 'events', events: events.map((e: any) => ({ ...e, cursor: formatCursor(e.blockNumber, e.logIndex) })), nextCursor };
        ws.send(JSON.stringify(payload));
      } catch { }
    }
  } catch { }
  ws.send(JSON.stringify({ type: 'hello', lastCursor: lastBroadcastCursor }));
  ws.on('close', () => { clients.delete(ws); });
});

setInterval(() => {
  for (const ws of clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch { } clients.delete(ws); continue; }
    ws.isAlive = false; try { ws.ping(); } catch { }
  }
}, 30000);

function broadcast(payload: any) {
  const data = JSON.stringify(payload);
  for (const ws of clients) {
    try { ws.send(data); } catch { }
  }
  for (const c of sseClients) {
    try { c.write('events', payload); } catch { }
  }
}

// Periodically broadcast progress updates via SSE when it changes
setInterval(() => {
  try {
    if (progressSseClients.size === 0) return;
    const rt = getRuntimeProgress();
    const ts = Number(rt.updatedAt || 0);
    if (!Number.isFinite(ts)) return;
    if (lastProgressUpdateAt != null && ts <= lastProgressUpdateAt) return;
    lastProgressUpdateAt = ts;
    for (const c of progressSseClients) {
      try { c.write('progress', rt); } catch { }
    }
  } catch { }
}, 1000);

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
    (wsProvider as any)._websocket?.addEventListener?.('close', () => { });
  } catch (e) {
    console.warn('ETH_WS_URL provided but WebSocket connect failed; using polling only');
  }
}

server.on('error', (err) => {
  // remove pidfile if failed to bind
  cleanupPid();
});
server.listen(PORT, () => {
  console.log(`API listening on :${PORT}`);
});
