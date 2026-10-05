/**
 * Which parts of the corpus `content/` tree the site must NOT pull in.
 *
 * The canton article sections (piano «sezioni articoli per cantone») live in
 * the corpus and are served from R2 by the Worker; the site has no view for
 * them and never compiles them. If `scripts/pull-articles-corpus.mjs` mirrored
 * them, every canton article would enter `packages/articles/content/`, the SPA
 * bundle and every sync PR — the exact cost the R2 design avoids.
 *
 * The excluded names are DERIVED from the generated section core (every
 * canton, active or not), not restated: the per-canton directory
 * `content/cantons/` (registry, slugs, …), each section's body directory and
 * each section's meta chunks (`<metaPrefix>-<locale>.ts`). Only top-level
 * entries of `content/` are matched — that is where the core places them —
 * so a same-named file deeper in an unrelated directory is untouched.
 *
 * The two tree helpers below are the ones the pull script used inline, now
 * taking the exclusion so the copy AND the file counts that gate it see the
 * same tree: counting canton files the mirror then skips would inflate the
 * upstream side and mask a real shrink of the site's own articles.
 */
import fs from 'node:fs';
import path from 'node:path';

import { CANTON_ARTICLE_SECTION_CORE } from '../../packages/articles/engine/shared/cantonArticleSectionCore.generated.mjs';

const CONTENT_PREFIX = 'packages/articles/content/';

function topLevelDirOf(repoRelFile) {
  if (!repoRelFile.startsWith(CONTENT_PREFIX)) {
    throw new Error(`canton registry outside ${CONTENT_PREFIX}: ${repoRelFile}`);
  }
  return repoRelFile.slice(CONTENT_PREFIX.length).split('/')[0];
}

const ENTRIES = Object.values(CANTON_ARTICLE_SECTION_CORE);

/** Top-level directory names under content/ that belong to canton sections. */
export const CANTON_CONTENT_DIRS = Object.freeze([
  ...new Set([
    ...ENTRIES.map((e) => topLevelDirOf(e.registryFile)),
    ...ENTRIES.map((e) => topLevelDirOf(e.slugDataFile)),
    ...ENTRIES.map((e) => e.bodyDir),
  ]),
]);

/** Top-level file-name prefixes (`<metaPrefix>-`) of the canton meta chunks. */
export const CANTON_META_PREFIXES = Object.freeze(ENTRIES.map((e) => `${e.metaPrefix}-`));

/**
 * True for a `content/`-relative path (POSIX separators) owned by a canton
 * section. `cantons`, `cantons/canton-ti/registry.ts`, `blog-body-canton-ti/it/x.ts`
 * and `blog-meta-canton-ti-it.ts` are; `blog-body/it/x.ts` and `blog-meta-it.ts`
 * are not.
 */
export function isCantonCorpusPath(relPath) {
  const top = String(relPath).split('/')[0];
  if (CANTON_CONTENT_DIRS.includes(top)) return true;
  return CANTON_META_PREFIXES.some((prefix) => top.startsWith(prefix));
}

/** Count files under `dir`, skipping `.git` and every path `exclude(rel)` claims. */
export function countFiles(dir, { exclude = () => false } = {}) {
  let n = 0;
  const walk = (d, relBase) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === '.git') continue;
      const rel = relBase ? `${relBase}/${e.name}` : e.name;
      if (exclude(rel)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, rel); else n++;
    }
  };
  walk(dir, '');
  return n;
}

/**
 * Recursive copy of `src` onto `dst`, deleting anything in `dst` that src lacks.
 * Paths `exclude(rel)` claims are neither copied nor kept: an excluded entry
 * already present in `dst` is removed, so the destination converges to the
 * filtered tree whatever state it started in.
 */
export function mirrorTree(src, dst, { exclude = () => false } = {}, relBase = '') {
  fs.mkdirSync(dst, { recursive: true });
  const relOf = (name) => (relBase ? `${relBase}/${name}` : name);
  const want = new Set(fs.readdirSync(src).filter((name) => !exclude(relOf(name))));
  for (const name of fs.readdirSync(dst)) {
    if (name === '.git') continue;
    if (!want.has(name)) fs.rmSync(path.join(dst, name), { recursive: true, force: true });
  }
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (!want.has(e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) {
      mirrorTree(s, d, { exclude }, relOf(e.name));
    } else {
      // Skip an identical file so the mtime (and any downstream cache keyed on
      // it) does not churn on every sync.
      let same = false;
      try {
        const a = fs.statSync(s), b = fs.statSync(d);
        same = a.size === b.size && fs.readFileSync(s).equals(fs.readFileSync(d));
      } catch { same = false; }
      if (!same) {
        if (fs.existsSync(d)) fs.rmSync(d, { force: true });
        fs.copyFileSync(s, d);
      }
    }
  }
}
