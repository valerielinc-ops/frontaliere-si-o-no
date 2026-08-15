/**
 * corpus-local-preserve.mjs — snapshot shared files before pull-articles-corpus.mjs's
 * mirror step overwrites them, so locally-only article ids can be merged back in.
 *
 * Extracted out of pull-articles-corpus.mjs (2026-08-15) so the snapshot step can be
 * exercised in a test without running the rest of the script — the clone, the manifest
 * fetch, the registry gate. This is the exact logic that used two undefined variables
 * (`srcFiles`, `dstFiles`) at runtime from 2026-08-13 to 2026-08-15: `node --check`
 * cannot catch a ReferenceError that only fires when the branch actually runs, and the
 * branch only runs when `preserveIds.size > 0` — i.e. only when a locally-published
 * article's id is not yet upstream, not on every sync.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Every file under `dir`, as a Set of POSIX-style paths relative to `dir`
 * (e.g. `"blog-body/it/foo.ts"`).
 */
export function listRelFiles(dir) {
  const out = new Set();
  const walk = (d, rel) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === '.git') continue;
      const p = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r); else out.add(r);
    }
  };
  walk(dir, '');
  return out;
}

/**
 * Snapshot the local content of files that exist on BOTH sides of the mirror
 * (matched by relative path — those are the ones the mirror is about to
 * overwrite) and mention at least one locally-only article id.
 *
 * `preserveIds` is the Set of ids `localOnlyIds()` found: present downstream,
 * absent upstream. A shared file mentioning none of them needs no snapshot —
 * upstream's copy of it carries nothing that would be lost.
 */
export function collectPreserveSnapshots({ src, dest, preserveIds }) {
  const srcFiles = listRelFiles(src);
  const dstFiles = listRelFiles(dest);
  const snapshots = [];
  for (const rel of srcFiles) {
    if (!dstFiles.has(rel)) continue; // upstream-only: nothing of ours to lose
    const abs = path.join(dest, rel);
    let text;
    try { text = fs.readFileSync(abs, 'utf-8'); } catch { continue; }
    const ids = [...preserveIds].filter((id) => text.includes(id));
    if (ids.length > 0) snapshots.push({ rel, text, ids });
  }
  return snapshots;
}
