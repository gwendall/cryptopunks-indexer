import 'dotenv/config';
import { Interface, JsonRpcProvider, id, type Log } from 'ethers';
import pc from 'picocolors';
import { CONTRACT_ADDRESS, PUNKS_ABI, DEFAULTS, DEFAULT_DEPLOY_BLOCK } from './constants.js';
import { openDb, getMeta, setMeta } from './db.js';

const iface = new Interface(PUNKS_ABI);
const TOPICS0 = [
  id('Assign(address,uint256)'),
  id('PunkTransfer(address,address,uint256)'),
  id('PunkOffered(uint256,uint256,address)'),
  id('PunkNoLongerForSale(uint256)'),
  id('PunkBidEntered(uint256,uint256,address)'),
  id('PunkBidWithdrawn(uint256,uint256,address)'),
  id('PunkBought(uint256,uint256,address,address)'),
];
const TOPIC_NAME = new Map([
  [id('Assign(address,uint256)'), 'Assign'],
  [id('PunkTransfer(address,address,uint256)'), 'PunkTransfer'],
  [id('PunkOffered(uint256,uint256,address)'), 'PunkOffered'],
  [id('PunkNoLongerForSale(uint256)'), 'PunkNoLongerForSale'],
  [id('PunkBidEntered(uint256,uint256,address)'), 'PunkBidEntered'],
  [id('PunkBidWithdrawn(uint256,uint256,address)'), 'PunkBidWithdrawn'],
  [id('PunkBought(uint256,uint256,address,address)'), 'PunkBought'],
]);

function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

function providerRangeHint(error: unknown): number | null {
  const err: any = error as any;
  const msg = (err?.message || err?.error?.message || '').toString().toLowerCase();
  // Alchemy Free: "under the free tier ... up to a 10 block range"
  if (msg.includes('10 block range')) return 10;
  // Infura often uses -32005 with too many results; reduce range
  if (msg.includes('too many') || msg.includes('more than') || msg.includes('response size')) return null; // no exact number
  return null;
}

function getConfig() {
  const rpcUrl = process.env.ETH_RPC_URL;
  if (!rpcUrl) {
    throw new Error('ETH_RPC_URL is required (set it in .env)');
  }
  const startBlock = process.env.START_BLOCK ? Number(process.env.START_BLOCK) : null;
  const stopBlock = process.env.STOP_BLOCK ? Number(process.env.STOP_BLOCK) : null;
  const chunkSize = process.env.CHUNK_SIZE ? Number(process.env.CHUNK_SIZE) : DEFAULTS.CHUNK_SIZE;
  const deployBlockEnv = process.env.DEPLOY_BLOCK ? Number(process.env.DEPLOY_BLOCK) : (DEFAULT_DEPLOY_BLOCK ?? null);
  return { rpcUrl, startBlock, stopBlock, chunkSize, deployBlockEnv };
}

async function discoverDeployBlock(provider: JsonRpcProvider) {
  // Binary search the first block where code exists at CONTRACT_ADDRESS
  const latest = await provider.getBlockNumber();
  let lo = 0, hi = latest; // inclusive search for first code-present
  // Quick check: if no code even at latest, bail
  const codeLatest = await provider.getCode(CONTRACT_ADDRESS, latest);
  if (!codeLatest || codeLatest === '0x') return 0;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    let code = '0x';
    try {
      code = await provider.getCode(CONTRACT_ADDRESS, mid);
    } catch {
      // Some providers may not support historical getCode well; fall back by moving hi down a bit
    }
    if (code && code !== '0x') hi = mid; else lo = mid + 1;
  }
  return lo;
}

export async function runSync(): Promise<void> {
  const { rpcUrl, startBlock, stopBlock, chunkSize, deployBlockEnv } = getConfig();
  const provider = new JsonRpcProvider(rpcUrl);
  const db = openDb();

  const chainLatest = await provider.getBlockNumber();
  const latestTarget = stopBlock ?? chainLatest;

  // Determine deploy block (meta -> env -> discover -> fallback 0)
  let deployBlock = getMeta(db, 'deploy_block', null);
  if (deployBlock != null) deployBlock = Number(deployBlock);
  if (deployBlock == null) {
    if (deployBlockEnv != null) {
      deployBlock = Number(deployBlockEnv);
      setMeta(db, 'deploy_block', deployBlock);
    } else {
      console.log('Discovering contract deploy block...');
      deployBlock = await discoverDeployBlock(provider);
      setMeta(db, 'deploy_block', deployBlock);
      console.log(`Detected deploy block: ${deployBlock}`);
    }
  }

  const lastSynced = Number(getMeta(db, 'last_synced_block', deployBlock - 1));
  let fromBlock = Math.max((startBlock ?? deployBlock), lastSynced + 1);

  if (fromBlock > latestTarget) {
    console.log(`Up to date. last_synced_block=${lastSynced}, latest=${latestTarget}`);
    return;
  }

  const tty = process.stdout.isTTY;
  const startFromBlock = fromBlock;
  const totalBlocks = (latestTarget - startFromBlock + 1);
  const t0 = Date.now();
  let processedBlocks = 0;
  let processedLogs = 0;
  let windowSize = chunkSize;
  // Smoothed speed (EMA)
  let emaSpeedBlkPerSec: number | null = null;
  let lastTickMs = Date.now();
  const EMA_ALPHA = 0.2; // 20% new sample, 80% history
  const skipTimestamps = process.env.SKIP_TIMESTAMPS === '1';
  const counters: { parsed: number; byType: Record<string, number> } = { parsed: 0, byType: Object.create(null) };

  function fmtNum(n: number | null) {
    if (n == null || isNaN(n)) return '-';
    if (n < 1000) return String(n);
    if (n < 1e6) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
    if (n < 1e9) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  }
  function fmtDuration(sec: number) {
    if (!isFinite(sec) || sec < 0) return '—';
    const s = Math.floor(sec % 60);
    const m = Math.floor((sec / 60) % 60);
    const h = Math.floor((sec / 3600) % 24);
    const d = Math.floor(sec / 86400);
    if (d > 0) return `${d}d${h}h`;
    if (h > 0) return `${h}h${m}m`;
    if (m > 0) return `${m}m${s}s`;
    return `${s}s`;
  }
  function renderProgress() {
    const nowMs = Date.now();
    const elapsed = (nowMs - t0) / 1000;
    const pct = totalBlocks > 0 ? (processedBlocks / totalBlocks) : 0;
    const instAvg = elapsed > 0 ? processedBlocks / elapsed : 0;
    const speed = (emaSpeedBlkPerSec ?? instAvg);
    const remaining = Math.max(0, totalBlocks - processedBlocks);
    const etaSec = speed > 0 ? remaining / speed : Infinity;
    const line = [
      pc.bold(pc.cyan('Sync')),
      `${fmtNum(startFromBlock)}${pc.dim('→')}${fmtNum(latestTarget)}`,
      pc.bold(pc.green(`${(pct * 100).toFixed(2)}%`)),
      pc.dim('|'), `${fmtNum(processedBlocks)}/${fmtNum(totalBlocks)} blks`,
      pc.dim('|'), `${fmtNum(processedLogs)} logs`,
      pc.dim('|'), `win ${fmtNum(windowSize)}`,
      pc.dim('|'), `${Math.max(0, speed).toFixed(0)} blk/s`,
      pc.dim('|'), `ETA ${fmtDuration(etaSec)}`
    ].filter(Boolean).join(' ');
    if (tty) {
      process.stdout.write(`\x1b[2K\r${line}`);
    } else {
      console.log(line);
    }
  }
  if (!tty) {
    console.log(`Syncing from block ${fromBlock} to ${latestTarget} (chunk=${chunkSize})`);
  }

  // Prepared statements for performance
  const insertRaw = db.prepare(`
    INSERT OR IGNORE INTO raw_logs(
      block_number, block_timestamp, tx_hash, log_index, address,
      topic0, topic1, topic2, topic3, data
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAssign = db.prepare(`
    INSERT OR IGNORE INTO assigns(
      punk_index, to_address, block_number, block_timestamp, tx_hash, log_index
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertTransfer = db.prepare(`
    INSERT OR IGNORE INTO transfers(
      punk_index, from_address, to_address, block_number, block_timestamp, tx_hash, log_index
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertOffer = db.prepare(`
    INSERT OR IGNORE INTO offers(
      punk_index, min_value_wei, to_address, block_number, block_timestamp, tx_hash, log_index, active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
  `);
  const insertOfferCancel = db.prepare(`
    INSERT OR IGNORE INTO offer_cancellations(
      punk_index, block_number, block_timestamp, tx_hash, log_index
    ) VALUES (?, ?, ?, ?, ?)
  `);
  const insertBid = db.prepare(`
    INSERT OR IGNORE INTO bids(
      punk_index, value_wei, from_address, block_number, block_timestamp, tx_hash, log_index, active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
  `);
  const insertBidWithdrawn = db.prepare(`
    INSERT OR IGNORE INTO bid_withdrawals(
      punk_index, value_wei, from_address, block_number, block_timestamp, tx_hash, log_index
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertBuy = db.prepare(`
    INSERT OR IGNORE INTO buys(
      punk_index, value_wei, from_address, to_address, block_number, block_timestamp, tx_hash, log_index
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const upsertOwner = db.prepare(`
    INSERT INTO owners(punk_index, owner) VALUES (?, ?) ON CONFLICT(punk_index) DO UPDATE SET owner = excluded.owner
  `);

  let currentStep = chunkSize;
  while (fromBlock <= latestTarget) {
    // Adaptively choose a workable toBlock for the provider; persist last good step
    let step = Math.min(currentStep, latestTarget - fromBlock + 1);
    let toBlock;
    let logs: Log[];
    for (;;) {
      try {
        toBlock = Math.min(fromBlock + step - 1, latestTarget);
        const filter: any = { address: CONTRACT_ADDRESS, fromBlock, toBlock };
        // We intentionally skip topics filtering by default to avoid signature mismatches across providers.
        // If you want to enable topic filtering, set FILTER_TOPICS=1.
        if (process.env.FILTER_TOPICS === '1') {
          filter.topics = [TOPICS0];
        }
        logs = await provider.getLogs(filter);
        break; // success
      } catch (e) {
        const hinted = providerRangeHint(e);
        if (hinted) step = Math.min(step, Math.max(1, hinted));
        else step = Math.max(1, Math.floor(step / 2));
        if (step <= 0) step = 1;
        // Small backoff to be kind on providers
        await sleep(500);
        if (tty) { windowSize = step; renderProgress(); }
        continue;
      }
    }
    windowSize = step;
    currentStep = step;

    // Batch fetch timestamps for unique blocks
    const uniqueBlocks = skipTimestamps ? [] : [...new Set(logs.map(l => l.blockNumber))];
    const blockTs = new Map<number, number>();
    if (!skipTimestamps && uniqueBlocks.length) {
      await Promise.all(uniqueBlocks.map(async (bn) => {
        const b = await provider.getBlock(bn);
        blockTs.set(bn, Number(b?.timestamp ?? 0));
      }));
    }

    // Sort by blockNumber asc then index asc for deterministic processing (ethers v6 uses `index`)
    logs.sort((a, b) => (a.blockNumber - b.blockNumber) || (a.index - b.index));

    const tx = db.transaction(() => {
      let printed = 0;
      const verbose = (process.env.VERBOSE === '1' || process.env.VERBOSE === 'true');
      for (const log of logs) {
        const ts = skipTimestamps ? null : (blockTs.get(log.blockNumber) ?? null);
        insertRaw.run(
          log.blockNumber,
          ts,
          log.transactionHash,
          log.index,
          log.address,
          log.topics[0] ?? null,
          log.topics[1] ?? null,
          log.topics[2] ?? null,
          log.topics[3] ?? null,
          log.data
        );
        let parsed: any;
        try {
          parsed = iface.parseLog({ topics: log.topics, data: log.data });
        } catch (e) {
          // If topic0 is known but parse failed, warn once per chunk
          const t0 = log.topics?.[0];
          const name = t0 ? (TOPIC_NAME.get(t0) || 'UnknownTopic') : 'NoTopic0';
          if (name) {
            console.warn(`Warning: failed to parse ${name} @${log.blockNumber}:${log.index} tx=${log.transactionHash}`);
          }
          continue; // skip unknown or unparsable
        }
        const name: string = parsed.name;
        const args: any = parsed.args;

        if (name === 'Assign') {
          const punkIndex = Number(args.punkIndex);
          const to = String(args.to);
          insertAssign.run(punkIndex, to, log.blockNumber, ts, log.transactionHash, log.index);
          upsertOwner.run(punkIndex, to);
          if (verbose && printed < 5) { console.log(`Assign punk=${punkIndex} to=${to} @${log.blockNumber}:${log.index}`); printed++; }
        } else if (name === 'PunkTransfer') {
          const punkIndex = Number(args.punkIndex);
          const from = String(args.from);
          const to = String(args.to);
          insertTransfer.run(punkIndex, from, to, log.blockNumber, ts, log.transactionHash, log.index);
          upsertOwner.run(punkIndex, to);
          if (verbose && printed < 5) { console.log(`Transfer punk=${punkIndex} ${from}→${to} @${log.blockNumber}:${log.index}`); printed++; }
        } else if (name === 'PunkOffered') {
          const punkIndex = Number(args.punkIndex);
          const minValue = BigInt(args.minValue).toString();
          const toAddr = args.toAddress ? String(args.toAddress) : null;
          insertOffer.run(punkIndex, minValue, toAddr, log.blockNumber, ts, log.transactionHash, log.index);
          // Deactivate previous active offers for this punk, keep only latest as active
          db.prepare(`UPDATE offers SET active = 0 WHERE punk_index = ? AND active = 1 AND (block_number < ? OR (block_number = ? AND log_index < ?))`).run(punkIndex, log.blockNumber, log.blockNumber, log.index);
          if (verbose && printed < 5) { console.log(`List punk=${punkIndex} min=${minValue} to=${toAddr ?? 'any'} @${log.blockNumber}:${log.index}`); printed++; }
        } else if (name === 'PunkNoLongerForSale') {
          const punkIndex = Number(args.punkIndex);
          insertOfferCancel.run(punkIndex, log.blockNumber, ts, log.transactionHash, log.index);
          // Mark all active offers for this punk as inactive up to this block
          db.prepare(`UPDATE offers SET active = 0 WHERE punk_index = ? AND active = 1`).run(punkIndex);
          if (verbose && printed < 5) { console.log(`List cancel punk=${punkIndex} @${log.blockNumber}:${log.index}`); printed++; }
        } else if (name === 'PunkBidEntered') {
          const punkIndex = Number(args.punkIndex);
          const value = BigInt(args.value).toString();
          const fromAddr = String(args.fromAddress);
          insertBid.run(punkIndex, value, fromAddr, log.blockNumber, ts, log.transactionHash, log.index);
          // Deactivate previous active bids by same address on this punk
          db.prepare(`UPDATE bids SET active = 0 WHERE punk_index = ? AND from_address = ? AND active = 1 AND (block_number < ? OR (block_number = ? AND log_index < ?))`).run(punkIndex, fromAddr, log.blockNumber, log.blockNumber, log.index);
          if (verbose && printed < 5) { console.log(`Bid punk=${punkIndex} value=${value} from=${fromAddr} @${log.blockNumber}:${log.index}`); printed++; }
        } else if (name === 'PunkBidWithdrawn') {
          const punkIndex = Number(args.punkIndex);
          const value = BigInt(args.value).toString();
          const fromAddr = String(args.fromAddress);
          insertBidWithdrawn.run(punkIndex, value, fromAddr, log.blockNumber, ts, log.transactionHash, log.index);
          // Mark active bids from this address on this punk as inactive
          db.prepare(`UPDATE bids SET active = 0 WHERE punk_index = ? AND from_address = ? AND active = 1`).run(punkIndex, fromAddr);
          if (verbose && printed < 5) { console.log(`Bid cancel punk=${punkIndex} from=${fromAddr} @${log.blockNumber}:${log.index}`); printed++; }
        } else if (name === 'PunkBought') {
          const punkIndex = Number(args.punkIndex);
          const value = BigInt(args.value).toString();
          const fromAddr = String(args.fromAddress);
          const toAddr = String(args.toAddress);
          insertBuy.run(punkIndex, value, fromAddr, toAddr, log.blockNumber, ts, log.transactionHash, log.index);
          upsertOwner.run(punkIndex, toAddr);
          // Resolve offers on purchase
          db.prepare(`UPDATE offers SET active = 0 WHERE punk_index = ? AND active = 1`).run(punkIndex);
          // Resolve bids from buyer or seller possibly; keep history but deactivate all active bids on this punk
          db.prepare(`UPDATE bids SET active = 0 WHERE punk_index = ? AND active = 1`).run(punkIndex);
          if (verbose && printed < 5) { console.log(`Sale punk=${punkIndex} value=${value} ${fromAddr}→${toAddr} @${log.blockNumber}:${log.index}`); printed++; }
        }
        counters.parsed += 1;
        counters.byType[name] = (counters.byType[name] || 0) + 1;
      }
      setMeta(db, 'last_synced_block', toBlock);
    });
    tx();
    const nowMs = Date.now();
    const blkThisStep = (toBlock - fromBlock + 1);
    const dtSec = (nowMs - lastTickMs) / 1000;
    processedBlocks += blkThisStep;
    processedLogs += logs.length;
    if (dtSec > 0.05) {
      const sample = blkThisStep / dtSec;
      emaSpeedBlkPerSec = (emaSpeedBlkPerSec == null)
        ? sample
        : (EMA_ALPHA * sample + (1 - EMA_ALPHA) * emaSpeedBlkPerSec);
      lastTickMs = nowMs;
    }
    if (tty) renderProgress();
    else console.log(`Indexed blocks ${fromBlock}-${toBlock} | logs=${logs.length} | parsed=${counters.parsed}`);
    fromBlock = toBlock + 1;
  }
  if (tty) process.stdout.write('\n');
  // Summary
  const totalParsed = counters.parsed;
  const types = Object.entries(counters.byType).map(([k, v]) => `${k}:${v}`).join(', ');
  console.log(`Parsed events: ${totalParsed}${types ? ' [' + types + ']' : ''}`);
}

export function exportOwners() {
  const db = openDb();
  const rows = db.prepare(`SELECT punk_index, owner FROM owners ORDER BY punk_index`).all();
  const out = Object.fromEntries(rows.map(r => [r.punk_index, r.owner]));
  return out;
}

export function exportOperationsGrouped(punkIndex = null) {
  const db = openDb();
  const where = punkIndex == null ? '' : 'WHERE punk_index = ?';
  const assigns = db.prepare(`
    SELECT punk_index AS punkIndex, to_address AS toAddress, block_number AS blockNumber, block_timestamp AS blockTimestamp, tx_hash AS txHash, log_index AS logIndex
    FROM assigns ${where} ORDER BY block_number, log_index
  `).all(punkIndex == null ? [] : [punkIndex]);
  const transfers = db.prepare(`
    SELECT punk_index AS punkIndex, from_address AS fromAddress, to_address AS toAddress, block_number AS blockNumber, block_timestamp AS blockTimestamp, tx_hash AS txHash, log_index AS logIndex
    FROM transfers ${where} ORDER BY block_number, log_index
  `).all(punkIndex == null ? [] : [punkIndex]);
  const offers = db.prepare(`
    SELECT punk_index AS punkIndex, min_value_wei AS minValueWei, to_address AS toAddress, active, block_number AS blockNumber, block_timestamp AS blockTimestamp, tx_hash AS txHash, log_index AS logIndex
    FROM offers ${where} ORDER BY block_number, log_index
  `).all(punkIndex == null ? [] : [punkIndex]);
  const offerCancellations = db.prepare(`
    SELECT punk_index AS punkIndex, block_number AS blockNumber, block_timestamp AS blockTimestamp, tx_hash AS txHash, log_index AS logIndex
    FROM offer_cancellations ${where} ORDER BY block_number, log_index
  `).all(punkIndex == null ? [] : [punkIndex]);
  const bids = db.prepare(`
    SELECT punk_index AS punkIndex, value_wei AS valueWei, from_address AS fromAddress, active, block_number AS blockNumber, block_timestamp AS blockTimestamp, tx_hash AS txHash, log_index AS logIndex
    FROM bids ${where} ORDER BY block_number, log_index
  `).all(punkIndex == null ? [] : [punkIndex]);
  const bidWithdrawals = db.prepare(`
    SELECT punk_index AS punkIndex, value_wei AS valueWei, from_address AS fromAddress, block_number AS blockNumber, block_timestamp AS blockTimestamp, tx_hash AS txHash, log_index AS logIndex
    FROM bid_withdrawals ${where} ORDER BY block_number, log_index
  `).all(punkIndex == null ? [] : [punkIndex]);
  const buys = db.prepare(`
    SELECT punk_index AS punkIndex, value_wei AS valueWei, from_address AS fromAddress, to_address AS toAddress, block_number AS blockNumber, block_timestamp AS blockTimestamp, tx_hash AS txHash, log_index AS logIndex
    FROM buys ${where} ORDER BY block_number, log_index
  `).all(punkIndex == null ? [] : [punkIndex]);

  return { assigns, transfers, offers, offerCancellations, bids, bidWithdrawals, buys };
}

export function exportEventsUnified(punkIndex = null) {
  const db = openDb();
  const where = punkIndex == null ? '' : ' WHERE punk_index = ?';
  const params = punkIndex == null ? [] : [punkIndex];
  const queries = [
    { type: 'Assign', sql: `SELECT 'Assign' as type, punk_index AS punkIndex, NULL AS fromAddress, to_address AS toAddress, NULL AS valueWei, NULL AS minValueWei, block_number AS blockNumber, block_timestamp AS blockTimestamp, tx_hash AS txHash, log_index AS logIndex FROM assigns${where}` },
    { type: 'PunkTransfer', sql: `SELECT 'PunkTransfer' as type, punk_index AS punkIndex, from_address AS fromAddress, to_address AS toAddress, NULL AS valueWei, NULL AS minValueWei, block_number AS blockNumber, block_timestamp AS blockTimestamp, tx_hash AS txHash, log_index AS logIndex FROM transfers${where}` },
    { type: 'PunkOffered', sql: `SELECT 'PunkOffered' as type, punk_index AS punkIndex, NULL AS fromAddress, to_address AS toAddress, NULL AS valueWei, min_value_wei AS minValueWei, block_number AS blockNumber, block_timestamp AS blockTimestamp, tx_hash AS txHash, log_index AS logIndex FROM offers${where}` },
    { type: 'PunkNoLongerForSale', sql: `SELECT 'PunkNoLongerForSale' as type, punk_index AS punkIndex, NULL AS fromAddress, NULL AS toAddress, NULL AS valueWei, NULL AS minValueWei, block_number AS blockNumber, block_timestamp AS blockTimestamp, tx_hash AS txHash, log_index AS logIndex FROM offer_cancellations${where}` },
    { type: 'PunkBidEntered', sql: `SELECT 'PunkBidEntered' as type, punk_index AS punkIndex, from_address AS fromAddress, NULL AS toAddress, value_wei AS valueWei, NULL AS minValueWei, block_number AS blockNumber, block_timestamp AS blockTimestamp, tx_hash AS txHash, log_index AS logIndex FROM bids${where}` },
    { type: 'PunkBidWithdrawn', sql: `SELECT 'PunkBidWithdrawn' as type, punk_index AS punkIndex, from_address AS fromAddress, NULL AS toAddress, value_wei AS valueWei, NULL AS minValueWei, block_number AS blockNumber, block_timestamp AS blockTimestamp, tx_hash AS txHash, log_index AS logIndex FROM bid_withdrawals${where}` },
    { type: 'PunkBought', sql: `SELECT 'PunkBought' as type, punk_index AS punkIndex, from_address AS fromAddress, to_address AS toAddress, value_wei AS valueWei, NULL AS minValueWei, block_number AS blockNumber, block_timestamp AS blockTimestamp, tx_hash AS txHash, log_index AS logIndex FROM buys${where}` },
  ];
  const rows = queries.flatMap(q => db.prepare(q.sql).all(...(params.length ? [params[0]] : [])));
  rows.sort((a, b) => (a.blockNumber - b.blockNumber) || (a.logIndex - b.logIndex));
  return rows;
}

export function exportEventsNormalized(punkIndex = null) {
  const unified = exportEventsUnified(punkIndex);
  // Map to normalized types and snake_case fields
  const out = unified.map((e) => {
    let type;
    switch (e.type) {
      case 'Assign': type = 'claim'; break;
      case 'PunkTransfer': type = 'transfer'; break;
      case 'PunkOffered': type = 'list'; break;
      case 'PunkNoLongerForSale': type = 'list_cancel'; break;
      case 'PunkBidEntered': type = 'bid'; break;
      case 'PunkBidWithdrawn': type = 'bid_cancel'; break;
      case 'PunkBought': type = 'sale'; break;
      default: type = e.type; break;
    }
    const valueWei = e.valueWei ?? e.minValueWei ?? null;
    return {
      type,
      punk_id: e.punkIndex,
      from_address: e.fromAddress ?? null,
      to_address: e.toAddress ?? null,
      value_wei: valueWei != null ? String(valueWei) : null,
      block_number: e.blockNumber,
      block_timestamp: e.blockTimestamp ?? null,
      tx_hash: e.txHash,
      log_index: e.logIndex,
    };
  });
  return out;
}

export function exportActiveOffers(limit = null) {
  const db = openDb();
  const sql = `SELECT punk_index AS punkIndex, min_value_wei AS minValueWei, to_address AS toAddress, block_number AS blockNumber, block_timestamp AS blockTimestamp, tx_hash AS txHash, log_index AS logIndex FROM offers WHERE active = 1 ORDER BY CAST(min_value_wei AS INTEGER) ASC, block_number ASC ${limit ? 'LIMIT ?' : ''}`;
  return db.prepare(sql).all(...(limit ? [limit] : []));
}

export function exportActiveBids(limit = null) {
  const db = openDb();
  const sql = `SELECT punk_index AS punkIndex, value_wei AS valueWei, from_address AS fromAddress, block_number AS blockNumber, block_timestamp AS blockTimestamp, tx_hash AS txHash, log_index AS logIndex FROM bids WHERE active = 1 ORDER BY CAST(value_wei AS INTEGER) DESC, block_number DESC ${limit ? 'LIMIT ?' : ''}`;
  return db.prepare(sql).all(...(limit ? [limit] : []));
}

export function exportFloor() {
  const db = openDb();
  const row = db.prepare(`SELECT MIN(CAST(min_value_wei AS INTEGER)) AS floorWei FROM offers WHERE active = 1`).get();
  const floorWei = row?.floorWei != null ? String(row.floorWei) : null;
  return { floorWei };
}
