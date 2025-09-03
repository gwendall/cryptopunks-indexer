#!/usr/bin/env node
/*
  Ensures better-sqlite3 native binding is present across npm/pnpm/yarn.
  If missing, it suggests the right pnpm commands or triggers a rebuild.
*/
const { execSync } = require('node:child_process');

function hasBinding() {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    db.prepare('select 1').get();
    db.close();
    return true;
  } catch (e) {
    return false;
  }
}

if (hasBinding()) process.exit(0);

const ua = process.env.npm_config_user_agent || '';
const isPNPM = ua.includes('pnpm');

if (isPNPM) {
  console.warn('[postinstall] better-sqlite3 binding missing and pnpm detected.');
  console.warn('[postinstall] If you see "Ignored build scripts", run:');
  console.warn('  pnpm approve-builds better-sqlite3 && pnpm rebuild better-sqlite3\n');
}

let cmd = 'npm rebuild better-sqlite3';
if (ua.includes('pnpm')) cmd = 'pnpm rebuild better-sqlite3';
if (ua.includes('yarn')) cmd = 'yarn rebuild better-sqlite3';

try {
  console.log(`[postinstall] Attempting rebuild: ${cmd}`);
  execSync(cmd, { stdio: 'inherit' });
} catch (e) {
  console.warn('[postinstall] Rebuild failed. You may need to approve builds or install build tools (Xcode CLT on macOS).');
}

if (!hasBinding()) {
  console.warn('[postinstall] better-sqlite3 binding still missing.');
  if (isPNPM) {
    console.warn('Try: pnpm approve-builds better-sqlite3 && pnpm rebuild better-sqlite3');
  }
  console.warn('Alternatively, use Docker: docker compose up -d');
}

