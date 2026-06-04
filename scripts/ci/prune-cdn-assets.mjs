#!/usr/bin/env node
/**
 * prune-cdn-assets.mjs — CDN assets/ GC janitor (zero-Claude, deterministico).
 *
 * Pota gli hash content-based (JS/CSS) dal repo frontaliere-cdn/assets/
 * che sono stati sostituiti da versioni più recenti, superata la grace-window.
 * Previene il breach del soft-limit ~1 GB di GitHub Pages causato
 * dall'accumulo additivo introdotto da PR #1426.
 *
 * Algoritmo di sicurezza (senza accesso al vite manifest):
 *   - "Attivo" = referenziato direttamente nel live HTML (import statici + preload)
 *   - "Sostituito" = esiste un hash più recente per lo STESSO chunk-name prefix
 *     (es. "vendor-react" compare con 2+ hash → il più vecchio è sostituito)
 *   - Prune solo se: SOSTITUITO && firstSeen > GRACE_DAYS && NON ATTIVO nel HTML
 *   - Hash "unici" (un solo file per chunk-name prefix) NON vengono MAI potati
 *     → copre lazy vendor chunks invariati (firebase, charts, maps, pdf) che
 *     non appaiono nel HTML ma sono ancora attivi nel build corrente.
 *
 * Tracking età: assets/.hash-age.json nel repo CDN (preserved deploy→deploy
 * tramite `cp -n` in deploy.yml che copia dal CDN precedente).
 * Prima run: registra tutti gli hash con firstSeen=now, pota 0 file (bootstrap).
 * Run successive: pota hash sostituiti con firstSeen > GRACE_DAYS.
 *
 * Env:
 *   CDN_DEPLOY_KEY  SSH private key (write access su valerielinc-ops/frontaliere-cdn)
 *   GRACE_DAYS      grace-window giorni per hash sostituiti (default: 7)
 *   DRY_RUN         "1" → stampa piano senza modificare nulla
 */

import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, writeFileSync, readFileSync, rmSync,
  readdirSync, existsSync, unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DRY_RUN = process.env.DRY_RUN === '1';
const GRACE_DAYS = Number(process.env.GRACE_DAYS ?? 7);
const CDN_DEPLOY_KEY = process.env.CDN_DEPLOY_KEY ?? '';
const CDN_REPO_SSH = 'git@github.com:valerielinc-ops/frontaliere-cdn.git';
const LIVE_ENTRY_URL = 'https://frontaliereticino.ch/';
const CDN_ASSETS_HOST = 'cdn.frontaliereticino.ch/assets/';

// Vite content-hashed filename pattern: <chunk-name>-<8chars>.<js|css>
const VITE_ASSET_RX = /^(.+)-([a-zA-Z0-9]{8})\.(js|css)$/;
const HASH_AGE_FILENAME = '.hash-age.json';

function git(dir, args, extraEnv = {}) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function fetchActiveHashes() {
  try {
    const res = await fetch(LIVE_ENTRY_URL, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    // Extract all CDN asset filenames referenced in the entry HTML
    const escapedHost = CDN_ASSETS_HOST.replace(/\./g, '\\.');
    const rx = new RegExp(`${escapedHost}([a-zA-Z0-9._-]+)`, 'g');
    const active = new Set();
    for (const m of html.matchAll(rx)) active.add(m[1]);
    console.log(`[janitor] active hashes in live HTML: ${active.size}`);
    return active;
  } catch (err) {
    console.warn(`[janitor] ⚠️  live HTML fetch failed (${err.message}) — abort (conservative, no prune)`);
    return null;
  }
}

async function main() {
  if (!CDN_DEPLOY_KEY) {
    console.log('[janitor] CDN_DEPLOY_KEY not set — skip');
    process.exit(0);
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'cdn-janitor-'));
  const keyFile = join(tmpDir, 'key');
  writeFileSync(keyFile, `${CDN_DEPLOY_KEY}\n`, { mode: 0o600 });
  const sshCmd = `ssh -i ${keyFile} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
  const sshEnv = { GIT_SSH_COMMAND: sshCmd };

  try {
    // Sparse clone: only assets/ (skips og/, data/, images/ blobs)
    console.log('[janitor] cloning CDN repo (sparse, assets/ only)...');
    execFileSync('git', [
      'clone', '--depth', '1', '--filter=blob:none', '--sparse',
      CDN_REPO_SSH, join(tmpDir, 'cdn'),
    ], { env: { ...process.env, ...sshEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    const repoDir = join(tmpDir, 'cdn');
    git(repoDir, ['sparse-checkout', 'set', '--cone', 'assets'], sshEnv);

    const assetsDir = join(repoDir, 'assets');
    if (!existsSync(assetsDir)) {
      console.log('[janitor] no assets/ dir in CDN — nothing to prune');
      return;
    }

    // List Vite content-hashed asset files (excludes .hash-age.json and other non-Vite files)
    const allFiles = readdirSync(assetsDir).filter(f => VITE_ASSET_RX.test(f));
    console.log(`[janitor] ${allFiles.length} Vite asset file(s) in CDN assets/`);
    if (allFiles.length === 0) {
      console.log('[janitor] nothing to do');
      return;
    }

    // Read hash-age registry (or start fresh)
    const hashAgePath = join(assetsDir, HASH_AGE_FILENAME);
    let registry = {};
    if (existsSync(hashAgePath)) {
      try { registry = JSON.parse(readFileSync(hashAgePath, 'utf8')); } catch { /* start fresh */ }
    }

    const now = new Date().toISOString();
    const graceCutoffMs = Date.now() - GRACE_DAYS * 86_400_000;

    // Register new hashes (firstSeen = now)
    let newCount = 0;
    for (const f of allFiles) {
      if (!registry[f]) {
        registry[f] = now;
        newCount++;
      }
    }
    const registryDirty = newCount > 0;
    if (newCount > 0) console.log(`[janitor] registered ${newCount} new hash(es) in age registry`);

    // Fetch active hashes from live HTML (belt-and-suspenders check)
    const activeHashes = await fetchActiveHashes();
    if (!activeHashes) {
      // Still persist new registry entries even if we can't prune safely
      if (registryDirty && !DRY_RUN) {
        writeFileSync(hashAgePath, JSON.stringify(registry, null, 2));
        git(repoDir, ['add', `assets/${HASH_AGE_FILENAME}`]);
        git(repoDir, [
          '-c', 'user.email=cdn-janitor@frontaliereticino.ch',
          '-c', 'user.name=cdn-janitor',
          'commit', '-m', `chore(cdn-janitor): register ${newCount} new hash(es) (no prune, fetch failed)`,
        ]);
        execFileSync('git', ['-C', repoDir, 'push', '-f', CDN_REPO_SSH, 'main'],
          { env: { ...process.env, ...sshEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
        console.log('[janitor] persisted hash-age registry update (no prune)');
      }
      return;
    }

    // Group files by chunk-name prefix+ext to detect superseded hashes
    // Only prune the OLDER hash(es) when multiple hashes exist for the same chunk name.
    // Lone hashes (1 entry per chunk name) are never pruned — they may be active lazy chunks
    // (firebase, charts, maps, pdf) not referenced in the entry HTML.
    const groups = new Map(); // key: "chunkName.ext", value: [{file, firstSeen}]
    for (const f of allFiles) {
      const m = VITE_ASSET_RX.exec(f);
      if (!m) continue;
      const key = `${m[1]}.${m[3]}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ file: f, firstSeen: registry[f] ?? now });
    }

    // Build prune list: superseded (group size >1) + old enough + not in active HTML
    const toPrune = [];
    for (const [chunkKey, entries] of groups) {
      if (entries.length < 2) continue; // single hash → keep (might be active lazy chunk)
      // Oldest first by firstSeen timestamp
      entries.sort((a, b) => a.firstSeen.localeCompare(b.firstSeen));
      // All but the newest are superseded candidates
      for (const { file, firstSeen } of entries.slice(0, -1)) {
        if (activeHashes.has(file)) {
          // In live HTML → definitely still in use, never prune
          console.log(`[janitor] keep ${file} (active in live HTML despite supersession by newer ${chunkKey})`);
          continue;
        }
        if (new Date(firstSeen).getTime() > graceCutoffMs) {
          console.log(`[janitor] keep ${file} (superseded but within grace-window: firstSeen ${firstSeen})`);
          continue;
        }
        toPrune.push(file);
      }
    }

    console.log(`[janitor] ${toPrune.length} orphan asset(s) eligible for pruning`);

    if (DRY_RUN) {
      console.log('[janitor] DRY RUN — would prune:');
      for (const f of toPrune) console.log(`  - ${f}`);
      console.log(`[janitor] DRY RUN — hash-age registry: +${newCount} new entries`);
      return;
    }

    if (toPrune.length === 0 && !registryDirty) {
      console.log('[janitor] nothing to commit');
      return;
    }

    // Apply deletions
    for (const f of toPrune) {
      git(repoDir, ['rm', '--force', `assets/${f}`]);
      delete registry[f]; // keep registry in sync
    }

    // Persist updated hash-age registry
    writeFileSync(hashAgePath, JSON.stringify(registry, null, 2));
    git(repoDir, ['add', `assets/${HASH_AGE_FILENAME}`]);

    const commitMsg = toPrune.length > 0
      ? `chore(cdn-janitor): prune ${toPrune.length} orphan asset hash(es)${newCount > 0 ? `, register ${newCount} new` : ''}`
      : `chore(cdn-janitor): register ${newCount} new hash(es)`;

    git(repoDir, [
      '-c', 'user.email=cdn-janitor@frontaliereticino.ch',
      '-c', 'user.name=cdn-janitor',
      'commit', '-m', commitMsg,
    ]);

    execFileSync('git', ['-C', repoDir, 'push', '-f', CDN_REPO_SSH, 'main'],
      { env: { ...process.env, ...sshEnv }, stdio: ['ignore', 'pipe', 'pipe'] });

    console.log(`[janitor] ✅ CDN updated — pruned ${toPrune.length} file(s), registered ${newCount} new`);
    if (toPrune.length > 0) {
      console.log('Pruned hashes:');
      for (const f of toPrune) console.log(`  - ${f}`);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error('[janitor] fatal:', err.message);
  process.exit(1);
});
