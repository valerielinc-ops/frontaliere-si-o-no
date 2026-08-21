#!/usr/bin/env node
/**
 * prune-cdn-assets.mjs — CDN assets/ GC janitor (zero-Claude, deterministico).
 *
 * Pota i file JS/CSS dal repo frontaliere-cdn/assets/ che la build corrente non
 * referenzia più, superata la grace-window. Previene il breach del soft-limit
 * ~1 GB di GitHub Pages causato dall'accumulo additivo (cp -n in deploy.yml).
 *
 * Modello (lastActive — vedi cdn-prune-plan.mjs → planJanitor):
 *   - "Attivo" (AUTORITATIVO) = presente in `dist/assets/`, l'output appena
 *     buildato. Copre TUTTI i file del build corrente: entry, modulepreload E
 *     dynamic-import (lazy) chunks (firebase/charts/maps/pdf) — questi ultimi NON
 *     compaiono nel live HTML. Path overridabile via DIST_ASSETS_DIR; se assente
 *     → FAIL-CLOSED, non pota nulla (mai pruning alla cieca).
 *   - "Attivo" (belt) = anche referenziato nel live HTML (entry + preload).
 *     Check secondario; un fetch fallito non blocca il prune.
 *   - Ogni run aggiorna `lastActive=now` per i file nel set attivo. Un file è
 *     ORFANO quando è rimasto ASSENTE dal set attivo per l'INTERA grace-window.
 *     Con i nomi STABILI (#1933) la build emette nomi FISSI: "assente da
 *     dist/assets" significa in modo affidabile "non più referenziato", e il
 *     max-age=600s dell'HTML (public/_headers) garantisce che nessuna pagina
 *     live lo punti da più di 10 min dopo che è uscito dal build.
 *   - Sostituisce la vecchia euristica "superseded sibling" per chunk-name, che
 *     NON riusciva a GC-are i chunk hashed legacy post-cutover: i nomi stabili
 *     locale-qualified (`slug.it.js`) vivono in un chunk-name group DIVERSO dai
 *     legacy `slug-<hash>.js`/`slug2-<hash>.js`, che quindi non guadagnavano mai
 *     un sibling più recente e restavano per sempre (16k file / 1.7 GB).
 *   - Prune solo se: NON in dist/assets && NON in live HTML && lastActive >
 *     GRACE_DAYS fa. Cap MAX_PRUNE_PER_RUN, oldest-inactive first (il backlog
 *     one-time post-cutover drena su più deploy, non un unico force-push gigante).
 *
 * Tracking età: assets/.hash-age.json nel repo CDN (preserved deploy→deploy
 * tramite `cp -n` in deploy.yml). Schema `{ [file]: { f: firstSeen, a: lastActive } }`
 * (entry legacy stringa firstSeen-only migrate al volo).
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
 *   GRACE_DAYS         grace-window giorni di inattività prima del prune (default: 7)
 *   MAX_PRUNE_PER_RUN  cap file potati per run (default: 6000)
 *   DRY_RUN            "1" → stampa piano senza modificare nulla
 *   DIST_ASSETS_DIR override del path active-set (default: <repo>/dist/assets,
 *                   il path inline di deploy.yml). Assente → FAIL-CLOSED, no prune.
 */

import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, writeFileSync, readFileSync, rmSync,
  readdirSync, existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { planJanitor } from './cdn-prune-plan.mjs';

// Shared Vite content-hash matcher (base64url alphabet `[A-Za-z0-9_-]`).
// Imported — NOT copy-pasted — so the char class can't drift from the canonical
// legacy-hash fallback in build-plugins/shared/chunkFiles.ts (AGENTS.md #6). A
// quote-strict `[a-zA-Z0-9]` would silently miss the ~1-in-5 hashes containing
// `_`/`-`, leaving those orphans ungrouped → never pruned → CDN keeps growing.
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const { VITE_ASSET_RX } = await import(
  join(__dirname, '..', '..', 'build-plugins', 'shared', 'viteAssetHashRx.mjs')
);

const DRY_RUN = process.env.DRY_RUN === '1';
// Defensive numeric env parse: `?? 7` only catches `undefined`, so GRACE_DAYS=''
// or a non-numeric value would yield NaN/0 → graceCutoffMs becomes NaN/now →
// grace bypassed → every superseded hash pruned at zero grace (mass in-flight
// 404). Require a finite positive number, else fall back to the 7-day default.
const __graceRaw = Number(process.env.GRACE_DAYS);
const GRACE_DAYS = Number.isFinite(__graceRaw) && __graceRaw > 0 ? __graceRaw : 7;
// Max files pruned per run — bounds blast radius and spreads the one-time
// post-cutover backlog (~16 k legacy hashed files, #1933) over a few deploys.
// Same defensive numeric parse as GRACE_DAYS (empty/NaN → default).
const __maxPruneRaw = Number(process.env.MAX_PRUNE_PER_RUN);
const MAX_PRUNE_PER_RUN = Number.isFinite(__maxPruneRaw) && __maxPruneRaw > 0 ? __maxPruneRaw : 6000;
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

/** Node twin of _SHARD_CRED_HELPER in scripts/lib/shard-git-helpers.sh — the
 * token is read from the environment inside the helper, so it never reaches
 * argv, the remote URL or git's error output. */
const CRED_HELPER =
  '!f() { test "$1" = get && printf "username=x-access-token\\npassword=%s\\n" "$SHARD_PUSH_TOKEN"; }; f';

/**
 * Force-push `main` to the CDN repo. The deploy key is a single point of
 * failure — read-only, revoked or (for shard repos) a secret shadowed by the
 * `shard-secrets-overflow` environment all look the same to git — so a refused
 * push is retried over HTTPS with a PAT, exactly like shard_pat_push does for
 * the section/locale/article shards (incident 2026-07-30, uri-it stale 3 days).
 * Throws the ORIGINAL error when no token is available or the fallback fails
 * too: this must never look like a successful prune.
 */
function pushCdnMain(repoDir, sshEnv) {
  try {
    execFileSync('git', ['-C', repoDir, 'push', '-f', CDN_REPO_SSH, 'main'],
      { env: { ...process.env, ...sshEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    return;
  } catch (err) {
    const token = process.env.SHARD_PUSH_PAT || process.env.GITHUB_PAT;
    if (!token) {
      console.warn('[janitor] deploy-key push failed and no SHARD_PUSH_PAT/GITHUB_PAT to fall back to');
      throw err;
    }
    const httpsUrl = CDN_REPO_SSH.replace(/^git@github\.com:/, 'https://github.com/');
    console.log(`::add-mask::${token}`);
    console.warn('[janitor] deploy-key push refused — retrying over HTTPS with a PAT');
    try {
      execFileSync('git', [
        '-C', repoDir,
        '-c', 'credential.helper=',
        '-c', `credential.helper=${CRED_HELPER}`,
        'push', '-f', httpsUrl, 'main',
      ], {
        env: { ...process.env, SHARD_PUSH_TOKEN: token },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      console.warn(
        '[janitor] ⚠️  pushed via the PAT fallback — CDN_DEPLOY_KEY is broken (read-only or revoked). Fix the key.',
      );
    } catch {
      throw err;
    }
  }
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
  // EVERY file in dist/assets/ is active — stable names (App.js, index.css,
  // seo-static.css, … — vite.config.ts stable-name policy) as much as any
  // legacy hashed name. The set is a PROTECT list, so broader is safer.
  const set = new Set(readdirSync(DIST_ASSETS_DIR));
  console.log(`[janitor] dist/assets/ active filenames: ${set.size} (from ${DIST_ASSETS_DIR})`);
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

    // Every JS/CSS bundle file in CDN assets/ is a prune CANDIDATE — stable-named
    // (`name.js`, the vite.config.ts stable-name policy) and any legacy
    // content-hashed leftover (`name-<hash8>.js`, from before the stable-name
    // cutover #1933). Sibling `.js.map`/`.css.map` files (vite.config.ts
    // `build.sourcemap: true`, #5607) are candidates too — same lastActive
    // tracking, same grace window — otherwise every renamed/removed chunk's
    // sourcemap is invisible to this filter and accumulates forever (never
    // enters `allAssets`, so `isActive`/registry never see it and
    // deploy.yml's additive `cp -rn` carries it forward on every deploy).
    // `.hash-age.json`, images, fonts and `logo.svg` are not JS/CSS(.map) and
    // are never touched here.
    const allDirFiles = readdirSync(assetsDir);
    const allAssets = allDirFiles.filter(f => /\.(js|css)(\.map)?$/.test(f));
    const hashedCount = allAssets.filter(f => VITE_ASSET_RX.test(f.replace(/\.map$/, ''))).length;
    console.log(`[janitor] ${allAssets.length} JS/CSS(.map) file(s) in CDN assets/ (${hashedCount} legacy-hashed, ${allAssets.length - hashedCount} stable)`);
    if (allAssets.length === 0) {
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

    // AUTHORITATIVE active set: the just-built dist/assets/ (covers lazy/dynamic
    // chunks invisible to the HTML scrape — firebase/charts/maps/pdf). A file
    // present here is referenced by the current build and is NEVER pruned.
    // Absent → FAIL-CLOSED: never prune blind against an incomplete active set.
    const distHashes = readDistAssetHashes();
    const canPrune = distHashes !== null;
    // Live-HTML scrape: SECONDARY belt — the boot bundles the homepage references
    // (entry + modulepreload). A failed fetch is non-blocking.
    const activeHashes = canPrune ? await fetchActiveHashes() : null;
    const isActive = (f) => (distHashes != null && distHashes.has(f)) || (activeHashes != null && activeHashes.has(f));

    // Pure planner does registry update + prune selection (see planJanitor).
    const { toPrune: plannedPrune, eligible, newCount, refreshed, registryPruned } = planJanitor({
      allAssets, registry, isActive, canPrune, now, graceCutoffMs, maxPrune: MAX_PRUNE_PER_RUN,
    });
    const registryDirty = newCount > 0 || refreshed > 0 || registryPruned > 0;
    if (newCount || refreshed || registryPruned) {
      console.log(`[janitor] registry: +${newCount} new, ${refreshed} refreshed lastActive, -${registryPruned} gone`);
    }

    const persistRegistryOnly = (reason) => {
      if (!(registryDirty && !DRY_RUN)) return;
      writeFileSync(hashAgePath, JSON.stringify(registry, null, 2));
      git(repoDir, ['add', `assets/${HASH_AGE_FILENAME}`]);
      git(repoDir, [
        '-c', 'user.email=cdn-janitor@frontaliereticino.ch',
        '-c', 'user.name=cdn-janitor',
        'commit', '-m', `chore(cdn-janitor): update age registry (no prune, ${reason})`,
      ]);
      assertFreshRemote(clonedTip, sshEnv);
      pushCdnMain(repoDir, sshEnv);
      console.log(`[janitor] persisted age registry update (no prune, ${reason})`);
    };

    if (!canPrune) {
      console.warn(
        '[janitor] ⚠️  dist/assets/ absent (no fresh build alongside this run) — ' +
        'FAIL-CLOSED: registering ages but pruning nothing this run',
      );
      persistRegistryOnly('dist/assets absent');
      return;
    }

    // planJanitor already selected + capped the prune set (oldest-inactive
    // first, bounded by MAX_PRUNE_PER_RUN so the one-time post-cutover backlog
    // drains over several deploys instead of one giant force-push).
    const toPrune = plannedPrune;
    if (eligible > toPrune.length) {
      console.log(`[janitor] ⚠️  ${eligible} orphan(s) eligible — capped at ${MAX_PRUNE_PER_RUN} this run (backlog drains over subsequent deploys)`);
    }
    console.log(`[janitor] ${toPrune.length} orphan asset(s) to prune this run (${eligible} eligible total)`);

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

    // Apply deletions in batches (one `git rm` per ~1000 paths — avoids spawning
    // a subprocess per file when draining the large post-cutover backlog, while
    // staying well under the OS arg-length limit).
    for (let i = 0; i < toPrune.length; i += 1000) {
      const batch = toPrune.slice(i, i + 1000);
      git(repoDir, ['rm', '--force', '--quiet', ...batch.map(f => `assets/${f}`)]);
      for (const f of batch) delete registry[f]; // keep registry in sync
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
    pushCdnMain(repoDir, sshEnv);

    console.log(`[janitor] ✅ CDN updated — pruned ${toPrune.length} file(s), registered ${newCount} new`);
    if (toPrune.length > 0) {
      console.log('Pruned hashes:');
      for (const f of toPrune) console.log(`  - ${f}`);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Run only when invoked directly (`node scripts/ci/prune-cdn-assets.mjs`), not
// when imported by tests for the pure planJanitor helper.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error('[janitor] fatal:', err.message);
    process.exit(1);
  });
}
