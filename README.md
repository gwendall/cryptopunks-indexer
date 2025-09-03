# CryptoPunks Standalone Indexer

Indexes on‑chain CryptoPunks activity into a local SQLite database and exports clean, ready‑to‑use JSON.

- Contract: `0xb47e3cd837ddf8e4c57f05d70ab865de6e193bbb` (mainnet)
- Events parsed: Assign, PunkTransfer, PunkOffered, PunkNoLongerForSale, PunkBidEntered, PunkBidWithdrawn, PunkBought
- Outputs: owners.json, operations_by_type.json, events.json

## Highlights

- Simple: one env var (`ETH_RPC_URL`) and go
- Portable: Docker image and docker-compose provided
- Persistent: uses SQLite file at `data/punks.sqlite`
- Idempotent: unique keys on `(tx_hash, log_index)`
- Continuous: set `TAIL=1` to keep indexing new blocks

## Prerequisites

- Node.js 18+ (or Docker)
- An Ethereum mainnet HTTP RPC URL (`ETH_RPC_URL`)

## Quick Start (Local)

1) Copy `.env.example` to `.env` and set `ETH_RPC_URL`.

2) Install and run:

```
npm install   # or: pnpm install | yarn install
npm run sync      # first run; for full accuracy, start from block 0
npm run export    # writes data/owners.json
```

Optional continuous mode (poll every 15s):

```
TAIL=1 npm run sync
```
During sync you’ll see a single-line progress with colors (percent, blocks, logs, speed, ETA). On non-TTY environments, progress prints per chunk.

Note for pnpm users:
- pnpm may show “Ignored build scripts: better-sqlite3”. This blocks the native binding.
- Fix with one command: `pnpm run fix:pnpm`
  - Equivalent to: `pnpm approve-builds better-sqlite3 && pnpm rebuild better-sqlite3`
  - Then rerun: `pnpm run sync`
Note for yarn users:
- If you see a binding error, run: `yarn rebuild better-sqlite3`. On macOS, ensure Xcode Command Line Tools: `xcode-select --install`.

## Quick Start (Docker)

Build and run (persist `./data` locally):

```
docker build -t cryptopunks-indexer .
docker run --rm -it --env-file .env -v "$PWD/data:/app/data" cryptopunks-indexer
```

Continuous indexing:

```
docker run --rm -it --env-file .env -e TAIL=1 -v "$PWD/data:/app/data" cryptopunks-indexer
```

## Quick Start (Docker Compose)

```
docker compose up -d
docker compose logs -f
```

Stops with `docker compose down`. Data persists in `./data`.

## Configuration

- `ETH_RPC_URL` (required): HTTP(s) RPC URL to Ethereum mainnet.
- `ETH_WS_URL` (optional): WebSocket RPC URL for near‑realtime wake‑ups in tail mode.
- `START_BLOCK` (optional): First block to scan. Default: `0`.
- `STOP_BLOCK` (optional): Last block to scan. Default: latest.
- `CHUNK_SIZE` (optional): Block range per request. Default: `5000`.
- `TAIL` (optional): `1` to keep polling for new blocks. Default: off.
- `POLL_INTERVAL_MS` (optional): Poll interval when tailing. Default: `15000`.
- `DEPLOY_BLOCK` (optional): CryptoPunks contract deploy block. If not set, the indexer auto-discovers it (via getCode binary search) and saves it to the DB meta table.
- `SKIP_TIMESTAMPS` (optional): `1` to skip fetching block timestamps for speed. Default: `0`.

Provider tips:
- The indexer auto-adapts the block range if your provider rejects large `eth_getLogs` windows (e.g., Alchemy Free limits to 10 blocks).
- If you see range errors, you can also set `CHUNK_SIZE=10` explicitly for free-tier RPCs.
- For fastest full sync: use a provider that allows larger log windows (e.g., Alchemy PAYG, QuickNode, Ankr, LlamaNodes) and set a larger `CHUNK_SIZE` (e.g., 2000–5000). Setting `SKIP_TIMESTAMPS=1` further reduces calls.

How to find the deploy block manually:
- Go to the contract on Etherscan: https://etherscan.io/address/0xb47e3cd837ddf8e4c57f05d70ab865de6e193bbb
- In the “Transactions” tab, open the “Contract Creation” transaction and note the Block number.
- Set it via env: `DEPLOY_BLOCK=<that number>` to skip auto-discovery.

Tip: For accurate owners and history, index from block `0`.

## Commands

- `npm run sync`: Index chain data into SQLite (incremental). Set `TAIL=1` to keep indexing new blocks. Optionally add `ETH_WS_URL` for near‑realtime triggers.
- `npm run export`: Export current owners to `data/owners.json`.
- `node src/index.js export-ops`: Export grouped operations to `data/operations_by_type.json`.
- `node src/index.js export-events`: Export unified timeline to `data/events.json`.

## Data Outputs

All outputs are deterministic, stable‑sorted by `blockNumber` then `logIndex` and include `txHash`.

1) `data/owners.json` — current owner by punk

```json
{
  "0": "0x...",
  "1": "0x..."
}
```

2) `data/operations_by_type.json` — grouped, typed operations

```json
{
  "assigns": [{ "punkIndex": 0, "toAddress": "0x...", "blockNumber": 0, "blockTimestamp": 0, "txHash": "0x...", "logIndex": 0 }],
  "transfers": [{ "punkIndex": 0, "fromAddress": "0x...", "toAddress": "0x...", "blockNumber": 0, "blockTimestamp": 0, "txHash": "0x...", "logIndex": 0 }],
  "offers": [{ "punkIndex": 0, "minValueWei": "10000000000000000", "toAddress": null, "active": 1, "blockNumber": 0, "blockTimestamp": 0, "txHash": "0x...", "logIndex": 0 }],
  "offerCancellations": [{ "punkIndex": 0, "blockNumber": 0, "blockTimestamp": 0, "txHash": "0x...", "logIndex": 0 }],
  "bids": [{ "punkIndex": 0, "valueWei": "10000000000000000", "fromAddress": "0x...", "active": 1, "blockNumber": 0, "blockTimestamp": 0, "txHash": "0x...", "logIndex": 0 }],
  "bidWithdrawals": [{ "punkIndex": 0, "valueWei": "10000000000000000", "fromAddress": "0x...", "blockNumber": 0, "blockTimestamp": 0, "txHash": "0x...", "logIndex": 0 }],
  "buys": [{ "punkIndex": 0, "valueWei": "10000000000000000", "fromAddress": "0x...", "toAddress": "0x...", "blockNumber": 0, "blockTimestamp": 0, "txHash": "0x...", "logIndex": 0 }]
}
```

3) `data/events.json` — unified, time‑ordered event timeline

```json
[
  { "type": "Assign", "punkIndex": 0, "toAddress": "0x...", "blockNumber": 0, "blockTimestamp": 0, "txHash": "0x...", "logIndex": 0 },
  { "type": "PunkTransfer", "punkIndex": 0, "fromAddress": "0x...", "toAddress": "0x...", "blockNumber": 1, "blockTimestamp": 0, "txHash": "0x...", "logIndex": 1 }
]
```

## Hosting Options (simple)

- Render (Worker + Persistent Disk)
  - Worker: command `node src/index.js sync`; env `ETH_RPC_URL`, `TAIL=1`
  - Add a persistent disk mounted at `/app/data`

- Railway (Service + Volume)
  - Deploy from repo or Dockerfile; add a Volume at `/app/data`
  - Env: `ETH_RPC_URL`, `TAIL=1`

- Fly.io (App + Volume)
  - `fly launch --no-deploy` → `fly volumes create data --size 1`
  - Mount volume at `/app/data`; set secrets `ETH_RPC_URL` and optional `TAIL=1`

Note: Heroku’s filesystem is ephemeral; prefer a disk‑backed host or switch to Postgres.

## Persistence & DB

- Default: SQLite at `data/punks.sqlite` (portable, zero‑config)
- Cloud persistence: mount a disk/volume to `/app/data`
- Optional next step: Add Postgres via `DB_URL=postgres://...` (open an issue if you want this; a small adapter can make the SQL cross‑DB)

## Development

- Node 18+; install deps with `npm i`
- Entry points:
  - `src/index.js`: CLI (sync, export, export-ops, export-events, tailing)
  - `src/indexer.js`: sync logic, event parsing, exports
  - `src/db.js`: SQLite schema and helpers
  - `src/constants.js`: ABI, contract address, defaults
- Useful envs while iterating:
  - `START_BLOCK=XXXXX` to limit scope
  - `STOP_BLOCK=YYYYY` for short runs
  - `CHUNK_SIZE=2000` if your RPC rate limits
  - `TAIL=1` to keep it running

Resetting state: delete `data/punks.sqlite` or set `START_BLOCK=0` and resync.

## Troubleshooting

- Empty outputs: ensure `ETH_RPC_URL` is set and reachable
- Slow syncs on public RPCs: lower `CHUNK_SIZE` (e.g., 1000–2000)
- Owners mismatch: ensure you started from `START_BLOCK=0`
- Continuous mode verbosity: tail logs with `docker compose logs -f`

---

CryptoPunks predates ERC‑721; this indexer parses its custom events and stores both raw logs and typed/derived tables in SQLite.
