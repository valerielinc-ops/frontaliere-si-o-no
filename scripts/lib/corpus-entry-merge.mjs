/**
 * corpus-entry-merge.mjs — keep locally-published articles alive across a
 * corpus pull that overwrites files nanako also owns.
 *
 * WHY THIS EXISTS
 * ───────────────
 * `pull-articles-corpus.mjs` no longer DELETES files (#5289), which protects a
 * site-published article's body: `blog-body/it/<id>.ts` exists only downstream,
 * so nothing removes it. That is the whole story for per-article files.
 *
 * It is not the story for the shared ones. An article also lives as an ENTRY
 * inside files nanako owns too — `routerBlogData.ts`, `blog-meta-it.ts`,
 * `seo-blog-ch.ts`, `blog-articles-data.ts`, … Those files exist on both sides,
 * so the mirror copies upstream's version over ours and the entry is gone. Not
 * deleted as a file: overwritten as a line. The unit of ownership is the entry,
 * not the file, and a file-level rule cannot see that.
 *
 * Measured on 2026-08-07: three articles answering HTTP 200 lost their slug,
 * i18n and SEO entries exactly this way — first through a corpus sync, then
 * again through a merge with main — while their bodies survived untouched. The
 * restore had to be done by hand twice.
 *
 * WHAT IT DOES
 * ────────────
 * After the mirror has written upstream's copy, re-introduce the entries for
 * ids that exist ONLY downstream.
 *
 *   Upstream wins on a shared id, always. If both sides carry an id, upstream's
 *   version stands and nothing here touches it — data flows corpus → site and
 *   this must not become a back channel. Preservation is only ever about ids
 *   upstream does not have at all.
 *
 * WHY IT FAILS LOUDLY
 * ───────────────────
 * A surface this cannot merge is worse than a crash: it reproduces the original
 * incident with nobody watching. So the caller does not trust the shape
 * detectors — it records, before the overwrite, every (file, id) pair that was
 * present, and afterwards asserts each one is present again. `missing` is that
 * answer. A shape we failed to recognise, or a future surface nobody added
 * here, surfaces as a refusal rather than as a silent half-restore.
 */

/** Ids declared in a slug registry (`BLOG_SLUGS` / `SWISS_SLUGS`). */
export function parseSlugIds(src) {
  const ids = new Set();
  // Same shape the CI gate parses: `'id': { it: '…', … }`, single- or
  // multi-line — \s spans newlines, so both registries' formatting works.
  const rx = /["']([^"']+)["']:\s*\{\s*it:\s*["']/g;
  let m;
  while ((m = rx.exec(src)) !== null) ids.add(m[1]);
  return ids;
}

/**
 * Article ids the site has and the corpus does not.
 *
 * Derived from the slug registries because those are the definition of a
 * published article: `create-article.mjs` writes there, and the routing,
 * sitemap and SEO surfaces all key off the same id.
 */
export function localOnlyIds({ localSources, upstreamSources }) {
  const local = new Set();
  for (const src of localSources) for (const id of parseSlugIds(src)) local.add(id);
  const upstream = new Set();
  for (const src of upstreamSources) for (const id of parseSlugIds(src)) upstream.add(id);
  return new Set([...local].filter((id) => !upstream.has(id)));
}

const isTopLevelDeclaration = (line) => /^(export\s+const|export\s+type|type|const)\s+\w+/.test(line);

/** How many times `id` occurs across all lines — the unit of a complete entry. */
function countMentions(lines, id) {
  const rx = new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  return lines.reduce((n, l) => n + (l.match(rx) ?? []).length, 0);
}

/**
 * Indices of every line mentioning `id`, by plain substring.
 *
 * Deliberately NOT a word-boundary match. The SEO chunks key their entries as
 * `'blog-<id>': {`, so the id is preceded by a hyphen — and a `[^\w-]`
 * boundary skips exactly that line while still matching the entry's inner
 * `canonicalPath` and image URLs. The unit detector then never saw a block to
 * open and spliced those three inner lines in on their own, nesting the entry
 * inside its neighbour. Three of four mentions "restored", valid syntax,
 * `seoBlogCh['blog-<id>']` undefined at runtime.
 */
function mentioningLines(lines, id) {
  return lines.map((l, i) => (l.includes(id) ? i : -1)).filter((i) => i !== -1);
}

/**
 * The smallest self-contained unit carrying `id`, as a [start, end] line range.
 *
 * Three shapes, tried in order — mutually exclusive across the surfaces this
 * repo has, so the ordering is a tiebreak that never fires rather than a guess:
 *   1. keyed block      `  'blog-<id>': {` … `  },`      (seo-blog*.ts)
 *   2. object in array  `  {` … `id: '<id>',` … `  },`   (blog-articles-data.ts)
 *   3. standalone line   one whole line                   (blog-meta-*.ts, BLOG_SLUGS)
 * Membership inside a top-level declaration line is handled separately.
 *
 * A line that OPENS a block is one that ends in `{`. That is the whole test,
 * and it is deliberately not brace counting: an earlier version balanced `{`
 * against `}` with quoted spans stripped, and it broke on the real
 * seo-blog-ch.ts, whose entries carry JSON-LD with template literals and braces
 * inside string values. It never found the close, fell through to shape 3, and
 * spliced the entry's INNER lines in on their own — an orphaned
 * `canonicalPath:` with no block around it. Corrupt output that still contained
 * the id, so a presence check called it a success. Shape detection here has to
 * be lexical and boring.
 */
function unitFor(lines, idx, id) {
  const line = lines[idx];

  // 1. keyed block — `  'key': {` on its own line.
  if (/^\s*['"][^'"]*['"]\s*:\s*\{\s*$/.test(line)) return closeBlock(lines, idx);

  // 2. object-in-array — `id: '<id>',` inside a `{ … }` sibling whose opener is
  //    a bare `{` on its own line just above.
  if (new RegExp(`^\\s*id\\s*:\\s*['"]${id}['"]\\s*,?\\s*$`).test(line)) {
    for (let k = idx - 1; k >= 0; k--) {
      if (lines[k].trim() === '{') return closeBlock(lines, k);
      if (lines[k].trim().endsWith('}') || lines[k].trim().endsWith('},')) break;
    }
    return null;
  }

  // 3. standalone line — anything that does not open a block.
  if (!line.trimEnd().endsWith('{') && !line.trimEnd().endsWith('[')) return [idx, idx];
  return null;
}

/**
 * Close a block on INDENTATION, not on brace arithmetic.
 *
 * These files are machine-generated with uniform formatting, so an entry opened
 * at indent N closes at the next line that is exactly `N}` or `N},`. That is
 * immune to whatever braces the entry's string values happen to contain.
 * Returning null when no such line exists is the honest answer — the caller
 * reports it and the run refuses.
 */
function closeBlock(lines, start) {
  const indent = lines[start].match(/^\s*/)[0];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === `${indent}},` || lines[i] === `${indent}}`) return [start, i];
  }
  return null;
}

/**
 * Where to put a unit back.
 *
 * Anchored on content, never on a line number: upstream's file has different
 * length and different neighbours, so an index from the local file means
 * nothing in it. The nearest preceding local line that is not itself being
 * preserved and appears EXACTLY once in the target is the anchor — uniqueness
 * is what makes "after this line" unambiguous. Falls back to the nearest
 * following line, then gives up and lets the caller report it missing.
 */
function anchorIndex(targetLines, localLines, start, end, preservedRx) {
  const isBlock = end > start;

  // A MULTI-LINE unit has to land between entries, never merely after some
  // unique line. Those are not the same thing, and the difference is not
  // cosmetic: the first version of this anchored an SEO entry after the
  // nearest unique line, which happened to be a `"mainEntityOfPage"` deep
  // inside the PREVIOUS entry. The result parsed, so every syntax check passed
  // — and the entry had become a property of its neighbour's structuredData
  // instead of a sibling. `seoBlogCh['blog-<id>']` was undefined at runtime
  // while the file looked restored. So for a block, anchor on the preceding
  // SIBLING entry and insert after that sibling's own close.
  if (isBlock) {
    const indent = localLines[start].match(/^\s*/)[0];
    const opensSibling = (l) =>
      l.match(/^\s*/)[0] === indent && (/^\s*['"][^'"]*['"]\s*:\s*\{\s*$/.test(l) || l.trim() === '{');

    for (let k = start - 1; k >= 0; k--) {
      if (!opensSibling(localLines[k])) continue;
      const sibling = closeBlock(localLines, k);
      if (!sibling) continue;
      // Identify the sibling in the target by a line of its own that is unique
      // there — its key line, or for a keyless `{` its `id:` line.
      const marker = localLines.slice(k, sibling[1] + 1)
        .find((l) => !preservedRx.test(l) && l.trim() && targetLines.filter((t) => t === l).length === 1);
      if (!marker) continue;
      const at = targetLines.indexOf(marker);
      // Walk out to that entry's opener in the TARGET, then to its close.
      let open = at;
      while (open >= 0 && !opensSibling(targetLines[open])) open--;
      if (open < 0) continue;
      const close = closeBlock(targetLines, open);
      if (!close) continue;
      return close[1] + 1;
    }
    return -1;
  }

  // Single lines sit at one structural level, so "after a unique sibling line"
  // is unambiguous for them.
  for (let k = start - 1; k >= 0; k--) {
    const c = localLines[k];
    if (!c.trim() || preservedRx.test(c)) continue;
    if (targetLines.filter((l) => l === c).length === 1) return targetLines.indexOf(c) + 1;
  }
  for (let k = end + 1; k < localLines.length; k++) {
    const c = localLines[k];
    if (!c.trim() || preservedRx.test(c)) continue;
    if (targetLines.filter((l) => l === c).length === 1) return targetLines.indexOf(c);
  }
  return -1;
}

/**
 * Splice `'id'` into the upstream copy of a single-line list or union.
 *
 * The separator is lifted from the local line rather than assumed, so an array
 * (`, 'id'`) and a union (` | 'id'`) both come out in their own syntax without
 * this function knowing which is which.
 */
function spliceMembership(targetLines, localLine, id) {
  const name = localLine.match(/^(?:export\s+)?(?:const|type)\s+(\w+)/)?.[1];
  if (!name) return false;
  const i = targetLines.findIndex((l) => new RegExp(`^(?:export\\s+)?(?:const|type)\\s+${name}\\b`).test(l));
  if (i === -1 || targetLines[i].includes(`'${id}'`)) return false;

  const token = localLine.match(new RegExp(`(\\s*(?:,|\\|)\\s*)'${id}'`))?.[0];
  if (!token) return false;

  const line = targetLines[i];
  const closer = line.lastIndexOf('];') !== -1 ? '];' : ';';
  const at = line.lastIndexOf(closer);
  if (at === -1) return false;
  targetLines[i] = line.slice(0, at) + token + line.slice(at);
  return true;
}

/**
 * Re-introduce `ids` from `localText` into `upstreamText`.
 *
 * Pure: text in, text out, no filesystem and no network — which is what lets
 * the incident be replayed in a unit test against fixtures.
 *
 * @returns {{text: string, preserved: string[], upstreamWins: string[], missing: string[]}}
 *   `missing` is the fail-loudly channel: an id that was in `localText` and is
 *   still absent from `text` afterwards.
 */
export function mergeEntries(upstreamText, localText, ids) {
  const localLines = localText.split('\n');
  let targetLines = upstreamText.split('\n');

  const preserved = [];
  const upstreamWins = [];
  const missing = [];
  const wanted = [...ids].filter((id) => localLines.some((l) => l.includes(id)));
  const preservedRx = wanted.length
    ? new RegExp(wanted.map((i) => i.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'))
    : /$^/;

  for (const id of wanted) {
    // Upstream wins on a shared id — the documented direction of the data.
    if (targetLines.some((l) => l.includes(id))) {
      upstreamWins.push(id);
      continue;
    }

    let placed = false;
    const idxs = mentioningLines(localLines, id);
    const done = new Set();

    for (const idx of idxs) {
      if (done.has(idx)) continue;

      if (isTopLevelDeclaration(localLines[idx])) {
        if (spliceMembership(targetLines, localLines[idx], id)) placed = true;
        done.add(idx);
        continue;
      }

      const unit = unitFor(localLines, idx, id);
      if (!unit) continue;
      const [start, end] = unit;
      for (let i = start; i <= end; i++) done.add(i);

      const block = localLines.slice(start, end + 1);
      if (block.every((l) => targetLines.includes(l)) && block.length > 1) continue;

      const at = anchorIndex(targetLines, localLines, start, end, preservedRx);
      if (at === -1) continue;
      targetLines.splice(at, 0, ...block);
      placed = true;
    }

    // Presence is NOT the check. Upstream had zero mentions of this id, so a
    // correct merge reproduces the local file's count exactly — every slug
    // line, every i18n key, every field inside an SEO block. Anything less is a
    // partial splice, which is how a corrupt seo-blog-ch.ts once passed as
    // restored: the id was "there", in three orphaned property lines with no
    // entry around them. Counting is what tells a whole entry from a fragment.
    const want = countMentions(localLines, id);
    const got = countMentions(targetLines, id);
    if (placed && got === want) preserved.push(id);
    else missing.push(`${id}${placed ? ` (${got}/${want} mentions restored)` : ''}`);
  }

  return { text: targetLines.join('\n'), preserved, upstreamWins, missing };
}
