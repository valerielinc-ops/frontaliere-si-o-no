/**
 * Materialize one coherent corpus-main `content/` tree before an article
 * rerender. The site never decides from the published API or from a copied
 * tree: CI clones the corpus sparsely, checks out refs/remotes/origin/main,
 * validates the minimum shape, then mirrors only that tree into the site.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { isCantonCorpusPath, mirrorTree } from './corpus-canton-exclusion.mjs';
import { destinationOnlyPaths, isPreservedTreePath } from './corpus-local-preserve.mjs';

const CORPUS_REMOTE = 'https://github.com/nanakokyobashi-rgb/frontaliere-articles.git';
const REQUIRED_FILES = [
  'blog-articles-data.ts',
  'swiss-articles-data.ts',
  'blog-meta-it.ts',
  'blog-meta-en.ts',
  'blog-meta-de.ts',
  'blog-meta-fr.ts',
  'blog-meta-ch-it.ts',
  'blog-meta-ch-en.ts',
  'blog-meta-ch-de.ts',
  'blog-meta-ch-fr.ts',
];
const BODY_DIRS = [
  ...['it', 'en', 'de', 'fr'].map((locale) => `blog-body/${locale}`),
  ...['it', 'en', 'de', 'fr'].map((locale) => `blog-body-ch/${locale}`),
];

export function decideCorpusOverlayMode({ isCi = false, dryRun = false, explicit = false } = {}) {
  if (isCi === true || explicit === true) {
    return { mode: 'overlay', reason: isCi === true ? 'GitHub Actions' : 'flag esplicito' };
  }
  if (dryRun === true) {
    return { mode: 'local', reason: 'dry-run locale: si usa la copia locale senza modificare il tree' };
  }
  return {
    mode: 'refuse',
    reason: 'fuori da CI il corpus overlay richiede --allow-content-overlay oppure --dry-run',
  };
}
export function validateCorpusContentShape(contentRoot) {
  const missing = [];
  for (const rel of REQUIRED_FILES) {
    if (!fs.existsSync(path.join(contentRoot, rel))) missing.push(rel);
  }
  for (const rel of BODY_DIRS) {
    const dir = path.join(contentRoot, rel);
    const files = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((name) => name.endsWith('.ts'))
      : [];
    if (files.length === 0) missing.push(`${rel}/*.ts`);
  }
  return { ok: missing.length === 0, missing };
}

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || 'nessun dettaglio').trim();
    throw new Error(`git ${args.join(' ')} fallito: ${detail}`);
  }
  return String(result.stdout || '').trim();
}

export function mirrorCorpusContent({ source, destination }) {
  const destinationOnly = destinationOnlyPaths({ src: source, dest: destination });
  mirrorTree(source, destination, {
    exclude: isCantonCorpusPath,
    preserve: (rel) => isPreservedTreePath(rel, destinationOnly),
  });
}

export function corpusRevisionFromCheckout(checkoutDir) {
  const commit = git(checkoutDir, ['rev-parse', 'refs/remotes/origin/main']);
  const epoch = git(checkoutDir, ['show', '-s', '--format=%ct', commit]);
  const short = git(checkoutDir, ['rev-parse', '--short=12', commit]);
  return { commit, contentRevision: `${epoch}.${short}` };
}

export function prepareCorpusContentOverlay({
  rootDir,
  remote = process.env.ARTICLES_CORPUS_REMOTE || CORPUS_REMOTE,
} = {}) {
  const destination = path.join(rootDir, 'packages', 'articles', 'content');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'frontaliere-corpus-overlay-'));
  try {
    const clone = spawnSync(
      'git',
      ['clone', '--quiet', '--filter=blob:none', '--no-checkout', remote, temporary],
      { encoding: 'utf8' },
    );
    if (clone.status !== 0) {
      throw new Error(`clone corpus fallito: ${String(clone.stderr || clone.stdout || 'nessun dettaglio').trim()}`);
    }
    git(temporary, ['sparse-checkout', 'set', '--no-cone', 'content']);
    git(temporary, ['checkout', '--quiet', '--detach', 'refs/remotes/origin/main']);

    const source = path.join(temporary, 'content');
    const shape = validateCorpusContentShape(source);
    if (!shape.ok) throw new Error(`tree corpus main monco: mancano ${shape.missing.join(', ')}`);
    mirrorCorpusContent({ source, destination });

    const revision = corpusRevisionFromCheckout(temporary);
    console.log(`[rerender-article-corpus] corpus content pinned to ${revision.commit} (${revision.contentRevision})`);
    return revision;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
