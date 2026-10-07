/**
 * Pin and overlay one coherent corpus snapshot before the full article
 * rerender.  The sync workflow exposes ARTICLES_SYNC_COMMIT only through the
 * Actions environment; it does not leave a durable source revision in the
 * site checkout.  Therefore the safe local proof is content equality: a
 * published manifest may be used only when its content tree is byte-identical
 * to the current site copy (apart from the existing generated/canton
 * exceptions).  A mismatch is deliberately a hard refusal, never a green
 * rerender with an unknown ordering between the two publishers.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { ARTICLES_API_BASE } from './articles-api-base.mjs';
import { normalizeCommit } from './articles-sync-pin.mjs';
import { isCantonCorpusPath, mirrorTree } from './corpus-canton-exclusion.mjs';
import {
  destinationOnlyPaths,
  isPreservedTreePath,
  listRelFiles,
} from './corpus-local-preserve.mjs';

const CORPUS_REMOTE = 'https://github.com/nanakokyobashi-rgb/frontaliere-articles.git';
const GENERATED_CHURN_PREFIX = 'image-credits/';

function comparableFiles(root) {
  return new Set(
    [...listRelFiles(root)].filter((rel) =>
      !isCantonCorpusPath(rel) && !rel.startsWith(GENERATED_CHURN_PREFIX)),
  );
}

/**
 * Compare the source-owned content projection, not directory mtimes.  The
 * destination-only image-credit records are the one existing sync exception;
 * arbitrary extra article files remain a mismatch and keep the rerender out.
 */
export function contentTreesMatch(sourceRoot, destinationRoot) {
  if (!fs.existsSync(sourceRoot) || !fs.existsSync(destinationRoot)) return false;
  const sourceFiles = comparableFiles(sourceRoot);
  const destinationFiles = comparableFiles(destinationRoot);
  if (sourceFiles.size === 0 || sourceFiles.size !== destinationFiles.size) return false;

  for (const rel of sourceFiles) {
    if (!destinationFiles.has(rel)) return false;
    try {
      if (!fs.readFileSync(path.join(sourceRoot, rel)).equals(fs.readFileSync(path.join(destinationRoot, rel)))) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Pure decision boundary used by the runner and by the fail-closed tests.
 * `contentMatchesSiteCopy` is intentionally a positive proof, not a guess
 * based on timestamps: the sync pin is transient and the site has no readable
 * aligned commit to compare in Git history.
 */
export function chooseCorpusOverlayCommit({
  manifest,
  corpusMainCommit,
  manifestIsAncestorOfMain,
  contentMatchesSiteCopy,
}) {
  const commit = normalizeCommit(manifest?.commit);
  if (!commit) {
    return {
      ok: false,
      reason: 'manifest.json non leggibile: manca un commit corpus SHA-1 completo',
    };
  }

  const main = normalizeCommit(corpusMainCommit);
  if (!main || manifestIsAncestorOfMain !== true) {
    return {
      ok: false,
      reason: `il commit ${commit} del manifest non è verificabile come antenato o uguale di main del corpus`,
    };
  }

  if (contentMatchesSiteCopy !== true) {
    return {
      ok: false,
      reason:
        `il commit ${commit} non è dimostrabilmente almeno equivalente alla copia ` +
        'del sito: l’albero content confrontato non coincide, quindi il rerender viene rifiutato',
    };
  }

  return { ok: true, commit };
}

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || 'nessun dettaglio').trim();
    throw new Error(`git ${args.join(' ')} fallito: ${detail}`);
  }
  return String(result.stdout || '').trim();
}

function gitStatus(cwd, args) {
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).status;
}

async function fetchPublishedManifest(apiBase, fetchImpl, attempts = 3) {
  const url = `${String(apiBase).replace(/\/+$/, '')}/manifest.json`;
  let lastError = 'risposta assente';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, { redirect: 'follow' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const manifest = await response.json();
      if (!manifest || typeof manifest !== 'object') throw new Error('JSON non-oggetto');
      return { manifest, url };
    } catch (error) {
      lastError = error?.message || String(error);
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
  return { manifest: null, url, error: lastError };
}

/**
 * Fetch the manifest, verify ancestry and content equality, then mirror the
 * pinned content tree into the site's existing content root.  The temporary
 * checkout is blobless and sparse; it is deleted only after the overlay copy
 * has completed.
 */
export async function prepareCorpusContentOverlay({
  rootDir,
  apiBase = ARTICLES_API_BASE,
  remote = process.env.ARTICLES_CORPUS_REMOTE || CORPUS_REMOTE,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('manifest API illeggibile: fetch non disponibile');

  const published = await fetchPublishedManifest(apiBase, fetchImpl);
  if (!published.manifest || !normalizeCommit(published.manifest.commit)) {
    const pure = chooseCorpusOverlayCommit({ manifest: published.manifest });
    throw new Error(`${pure.reason}; ${published.error || published.url}`);
  }
  const target = normalizeCommit(published.manifest.commit);
  const destination = path.join(rootDir, 'packages', 'articles', 'content');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'frontaliere-corpus-overlay-'));

  try {
    const clone = spawnSync(
      'git',
      ['clone', '--quiet', '--filter=blob:none', '--no-checkout', '--branch', 'main', remote, temporary],
      { encoding: 'utf8' },
    );
    if (clone.status !== 0) {
      throw new Error(`clone corpus fallito: ${String(clone.stderr || clone.stdout || 'nessun dettaglio').trim()}`);
    }
    git(temporary, ['sparse-checkout', 'set', '--no-cone', 'content']);

    const corpusMainCommit = git(temporary, ['rev-parse', 'refs/remotes/origin/main']);
    if (gitStatus(temporary, ['cat-file', '-e', `${target}^{commit}`]) !== 0) {
      git(temporary, ['fetch', '--quiet', 'origin', target]);
    }
    const ancestryStatus = gitStatus(temporary, ['merge-base', '--is-ancestor', target, corpusMainCommit]);
    const checkout = spawnSync('git', ['-C', temporary, 'checkout', '--quiet', '--detach', target], { encoding: 'utf8' });
    if (checkout.status !== 0) {
      throw new Error(`il corpus non serve il commit ${target}: ${String(checkout.stderr || checkout.stdout || '').trim()}`);
    }

    const matches = ancestryStatus === 0 && contentTreesMatch(path.join(temporary, 'content'), destination);
    const verdict = chooseCorpusOverlayCommit({
      manifest: published.manifest,
      corpusMainCommit,
      manifestIsAncestorOfMain: ancestryStatus === 0,
      contentMatchesSiteCopy: matches,
    });
    if (!verdict.ok) throw new Error(verdict.reason);

    const source = path.join(temporary, 'content');
    const destinationOnly = destinationOnlyPaths({ src: source, dest: destination });
    mirrorTree(source, destination, {
      exclude: isCantonCorpusPath,
      preserve: (rel) => isPreservedTreePath(rel, destinationOnly),
    });

    const epoch = git(temporary, ['show', '-s', '--format=%ct', target]);
    const short = git(temporary, ['rev-parse', '--short=12', target]);
    const contentRevision = `${epoch}.${short}`;
    console.log(`[rerender-article-corpus] corpus content pinned to ${target} (${contentRevision})`);
    return { commit: target, contentRevision, manifestUrl: published.url };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
