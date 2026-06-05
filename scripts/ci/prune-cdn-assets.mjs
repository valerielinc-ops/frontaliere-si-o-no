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
 *   - "Attivo" (AUTORITATIVO) = presente in `dist/assets/`, l'output appena
 *     buildato. Copre TUTTI gli hash del build corrente: entry, modulepreload E
 *     dynamic-import (lazy) chunks (firebase/charts/maps/pdf) — questi ultimi NON
 *     compaiono nel live HTML. Path overridabile via DIST_ASSETS_DIR; se assente
 *     → FAIL-CLOSED, non pota nulla (mai pruning alla cieca).
 *   - "Attivo" (belt-and-suspenders) = anche referenziato nel live HTML (entry +
 *     preload). Check secondario, non blocca più il prune se il fetch fallisce.
 *   - "Sostituito" = esiste un sibling con firstSeen STRETTAMENTE più recente per
 *     lo STESSO chunk-name prefix. Al bootstrap tutti i firstSeen === now → nessun
 *     sibling strettamente-più-nuovo → niente prunabile (ordine readdirSync NON
 *     decide mai una delete fra i duplicati #1426 con timestamp identici).
 *   - Prune solo se: NON in dist/assets && NON in live HTML && SOSTITUITO
 *     (sibling strettamente più nuovo) && firstSeen > GRACE_DAYS.
 *   - Hash "unici" (un solo file per chunk-name prefix) NON vengono MAI potati.
 *
 * Tracking età: assets/.hash-age.json nel repo CDN (preserved deploy→deploy
 * tramite `cp -n` in deploy.yml che copia dal CDN precedente).
 * Prima run: registra tutti gli hash con firstSeen=now, pota 0 file (bootstrap).
 * Run successive: pota hash sostituiti con firstSeen > GRACE_DAYS.
 *
 * INVOCAZIONE (anti-clobber by sequencing):
 *   Eseguito come STEP INLINE in `.github/workflows/deploy.yml`, subito DOPO il
 *   force-push della CDN, nello STESSO job sequenziale. NON come cron standalone.
 *   Motivo: un cron standalone clona la CDN (stato A), poi un deploy concorrente
 *   force-pusha il commit B (nuovi bundle), poi il cron force-pusha A' (parent A)
 *   → B sparisce → l'HTML live punta a hash 404 → SPA morta (outage class
 *   2026-06-04). Inline nello stesso job = nessun writer concorrente tra il push
 *   del deploy e questo prune: il clone vede la tip appena pushata.
 *   Difesa in profondità: se mai eseguito fuori da quel contesto, prima di OGNI
 *   force-push ricontrolla che la tip remota combaci con il clone (assertFresh).
 *
 * Env:
 *   CDN_DEPLOY_KEY  SSH private key (write access su valerielinc-ops/frontaliere-cdn)
 *   GRACE_DAYS      grace-window giorni per hash sostituiti (default: 7)
 *   DRY_RUN         "1" → stampa piano senza modificare nulla
 *   DIST_ASSETS_DIR override del path active-set (default: <repo>/dist/assets,
 *                   il path inline di deploy.yml). Assente → FAIL-CLOSED, no prune.
 */

import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, writeFileSync, readFileSync, rmSync,
  readdirSync, existsSync, unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Shared Vite content-hash matcher (base64url alphabet `[A-Za-z0-9_-]`).
// Imported — NOT copy-pasted — so the char class can't drift from the canonical
// SPA extractor in build-plugins/shared/spaBundleRx.ts (AGENTS.md #6). A
// quote-strict `[a-zA-Z0-9]` would silently miss the ~1-in-5 hashes containing
// `_`/`-`, leaving those orphans ungrouped → never pruned → CDN keeps growing.
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const { VITE_ASSET_RX } = await import(
  join(__dirname, '..', '..', 'build-plugins', 'shared', 'viteAssetHashRx.mjs')
);

const DRY_RUN = process.env.DRY_RUN === '1';
const GRACE_DAYS = Number(process.env.GRACE_DAYS ?? 7);
const CDN_DEPLOY_KEY = process.env.CDN_DEPLOY_KEY ?? '';
const CDN_REPO_SSH = 'git@github.com:valerielinc-ops/frontaliere-cdn.git';
const LIVE_ENTRY_URL = 'https://frontaliereticino.ch/';
const CDN_ASSETS_HOST = 'cdn.frontaliereticino.ch/assets/';

// Authoritative set of CURRENTLY-active asset hashes: the just-built output on
// disk (dist/assets/). When the janitor runs inline in deploy.yml (post-CDN-push,
// before the "Drop dist/assets" step), this dir holds EVERY hash the live build
// references — entry, modulepreload AND dynamic-import (lazy) chunks. The live
// HTML scrape only sees entry+preload, so dist/assets/ is the only source that
// covers firebase/charts/maps/pdf lazy chunks. Overridable for standalone/test
// runs; if absent we FAIL-CLOSED on pruning (never prune blind).
const DIST_ASSETS_DIR = process.env.DIST_ASSETS_DIR
  ?? join(__dirname, '..', '..', 'dist', 'assets');

const HASH_AGE_FILENAME = '.hash-age.json';

function git(dir, args, extraEnv = {}) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Defense-in-depth anti-clobber guard. The CDN `main` is force-pushed by
 * deploy.yml as a PARENTLESS single commit (fresh `git init`), so we CANNOT rely
 * on parent ancestry to detect a concurrent deploy. Instead we snapshot the
 * remote tip SHA at clone time (clonedTip) and, right before each force-push,
 * re-query the live remote tip (`git ls-remote`). If it moved, a deploy ran
 * mid-flight and our clone is stale → aborting prevents our force-push from
 * clobbering the deploy's fresh build commit (which would 404 in-flight HTML).
 * In the normal inline-step invocation (post-push, same sequential job) nothing
 * writes concurrently, so the tips always match and this is a no-op.
 */
function assertFreshRemote(clonedTip, sshEnv) {
  const out = execFileSync('git', ['ls-remote', CDN_REPO_SSH, 'refs/heads/main'], {
    encoding: 'utf8',
    env: { ...process.env, ...sshEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const liveTip = (out.split(/\s+/)[0] || '').trim();
  if (liveTip && clonedTip && liveTip !== clonedTip) {
    throw new Error(
      `stale clone — CDN main moved ${clonedTip.slice(0, 8)} → ${liveTip.slice(0, 8)} ` +
      `(a deploy ran mid-run); aborting to avoid clobbering the fresh build commit`,
    );
  }
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

/**
 * Read the set of asset filenames present in the just-built `dist/assets/`.
 * This is the AUTHORITATIVE list of hashes the current build actually
 * references — including dynamic-import (lazy) chunks that never appear in the
 * entry HTML. Returns null when the dir is absent (e.g. standalone cron with no
 * fresh build) so the caller can FAIL-CLOSED and skip pruning rather than prune
 * blind against an incomplete active set.
 */
function readDistAssetHashes() {
  if (!existsSync(DIST_ASSETS_DIR)) return null;
  const set = new Set(readdirSync(DIST_ASSETS_DIR).filter(f => VITE_ASSET_RX.test(f)));
  console.log(`[janitor] dist/assets/ active hashes: ${set.size} (from ${DIST_ASSETS_DIR})`);
  return set;
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

    // Snapshot the remote tip we cloned — re-checked before each force-push to
    // detect a concurrent deploy (see assertFreshRemote).
    const clonedTip = git(repoDir, ['rev-parse', 'HEAD']).trim();

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

    // AUTHORITATIVE active set: the just-built dist/assets/ (covers lazy/dynamic
    // chunks invisible to the HTML scrape — firebase/charts/maps/pdf). This is
    // the PRIMARY protection: a hash present here is referenced by the current
    // build and must NEVER be pruned. Absent → FAIL-CLOSED: register ages but
    // prune nothing (never prune blind against an incomplete active set).
    const distHashes = readDistAssetHashes();
    const canPrune = distHashes !== null;

    // Live-HTML scrape: SECONDARY belt-and-suspenders (entry + modulepreload only).
    // No longer required to prune — dist/assets/ is authoritative — but when it
    // succeeds it adds an extra protect set. A failed fetch is non-blocking.
    const activeHashes = canPrune ? await fetchActiveHashes() : null;

    const persistRegistryOnly = (reason) => {
      if (!(registryDirty && !DRY_RUN)) return;
      writeFileSync(hashAgePath, JSON.stringify(registry, null, 2));
      git(repoDir, ['add', `assets/${HASH_AGE_FILENAME}`]);
      git(repoDir, [
        '-c', 'user.email=cdn-janitor@frontaliereticino.ch',
        '-c', 'user.name=cdn-janitor',
        'commit', '-m', `chore(cdn-janitor): register ${newCount} new hash(es) (no prune, ${reason})`,
      ]);
      assertFreshRemote(clonedTip, sshEnv);
      execFileSync('git', ['-C', repoDir, 'push', '-f', CDN_REPO_SSH, 'main'],
        { env: { ...process.env, ...sshEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
      console.log(`[janitor] persisted hash-age registry update (no prune, ${reason})`);
    };

    if (!canPrune) {
      console.warn(
        '[janitor] ⚠️  dist/assets/ absent (no fresh build alongside this run) — ' +
        'FAIL-CLOSED: registering ages but pruning nothing this run',
      );
      persistRegistryOnly('dist/assets absent');
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

    // Build prune list. A candidate is pruned ONLY when ALL hold:
    //   1. NOT in dist/assets/ (current build) — authoritative active set.
    //   2. NOT in live HTML (when the scrape succeeded) — belt-and-suspenders.
    //   3. A sibling with a STRICTLY-NEWER firstSeen exists (truly superseded).
    //      At bootstrap every firstSeen === now → no strictly-newer sibling →
    //      nothing prunable → safe even with identical #1426-backlog timestamps
    //      (where readdirSync order is arbitrary and must NOT decide deletion).
    //   4. firstSeen older than the grace-window.
    const toPrune = [];
    for (const [chunkKey, entries] of groups) {
      if (entries.length < 2) continue; // single hash → keep (might be active lazy chunk)
      // Newest firstSeen in the group; only hashes strictly older than this are
      // "superseded". Ties (equal firstSeen) are NOT superseded by each other.
      let newestSeen = entries[0].firstSeen;
      for (const e of entries) if (e.firstSeen.localeCompare(newestSeen) > 0) newestSeen = e.firstSeen;
      for (const { file, firstSeen } of entries) {
        if (distHashes.has(file)) {
          // Referenced by the current build (entry OR lazy/dynamic chunk) → never prune.
          console.log(`[janitor] keep ${file} (present in dist/assets — active in current build)`);
          continue;
        }
        if (activeHashes && activeHashes.has(file)) {
          // In live HTML → definitely still in use, never prune
          console.log(`[janitor] keep ${file} (active in live HTML despite supersession by newer ${chunkKey})`);
          continue;
        }
        if (firstSeen.localeCompare(newestSeen) >= 0) {
          // No strictly-newer sibling (it IS the newest, or tied with it) → not superseded.
          console.log(`[janitor] keep ${file} (no strictly-newer sibling — not superseded, ${chunkKey})`);
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

    assertFreshRemote(clonedTip, sshEnv);
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
