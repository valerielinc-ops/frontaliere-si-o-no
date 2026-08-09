#!/usr/bin/env node
/**
 * audit-slug-prompt-leaks.mjs
 *
 * 0-tolerance gate: fails if any article slug that is already published — in
 * the routing registries or in the blog sitemaps — is (or contains) the prompt
 * instruction that was supposed to produce it.
 *
 * ── Relationship to the real fix (issue #5334) ───────────────────────────
 *
 * The fix is upstream, in `scripts/lib/slug-prompt-leak-guard.mjs`, called
 * before the first write in `scripts/create-article.mjs`. This audit is
 * deliberately the SECOND line and not the first: by the time a slug is
 * visible here it is already in `routerBlogData.ts`, and a slug in
 * `routerBlogData.ts` is one sitemap sync away from being crawled. An audit
 * cannot un-index a URL — it can only tell you that the pre-write gate was
 * bypassed, which is worth knowing precisely because the four slugs in
 * KNOWN_LEGACY_LEAKS reached production without a single component objecting.
 *
 * It shares the pattern list with the pre-write gate rather than restating it:
 * two lists would drift, and the drift would be invisible in exactly the
 * direction that matters (audit stricter than gate = noise; audit looser than
 * gate = the gate looks confirmed while it is not).
 *
 * Usage:
 *   node scripts/audit-slug-prompt-leaks.mjs
 *   node scripts/audit-slug-prompt-leaks.mjs --json
 *
 * Exit codes:
 *   0 — no leaked slug outside the documented legacy set
 *   1 — at least one NEW leaked slug found
 *   2 — no source could be read (fail-closed; see readSource)
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { findSlugPromptLeak } from './lib/slug-prompt-leak-guard.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Leaked slugs that were ALREADY published when this audit was written.
 *
 * They are named here rather than parked in a regenerable baseline file on
 * purpose: a baseline is a number that quietly absorbs the next regression,
 * whereas this list cannot absorb anything — a new leak is a new string and
 * fails. Removing an entry is how the remediation half of #5334 tightens the
 * gate; nothing here should ever be ADDED.
 *
 * Two distinct families, both from the same prompt:
 *
 * 1. The four `kebab-case-…` ids reported in the issue. These are the visible
 *    half: they are the IT slug, so they ARE the public URL
 *    (`/articoli-frontaliere/<id>/`), all four answer 200 and all four are in
 *    `sitemap-blog.xml`.
 *
 * 2. The `slug-<locale>` family, NOT in the issue and found while writing this
 *    audit. The schema's `slugs` line is
 *    `{ "it": "slug-it", "en": "slug-en", … }` and four articles echoed it into
 *    their en/de/fr slugs — including one that answered in Italian
 *    (`slug-inglese`/`slug-tedesco`/`slug-francese`). These are worse in one
 *    specific way and better in another: worse because they COLLIDE — three
 *    different articles all claim `/en/…/slug-en/`, so at most one can win and
 *    the others are unreachable in that locale; better because the Italian URL,
 *    which carries the traffic, is correct in all four cases.
 */
export const KNOWN_LEGACY_LEAKS = Object.freeze(new Set([
  // Family 1 — the IT slug is the instruction (issue #5334).
  'kebab-case-3-5-words-max-40-chars',
  'kebab-case-turismo-ticino',
  'kebab-case-ticino-nubifragio-grigioni',
  'kebab-case-rossi-bruxelles-ticino',
  // Family 2 — the per-locale slug is the schema's own placeholder.
  'slug-en', 'slug-de', 'slug-fr',
  'slug-inglese', 'slug-tedesco', 'slug-francese',
  // ── Family 3, added 2026-08-09 — the half-obeyed answer ───────────────
  //
  // "nothing here should ever be ADDED" is the rule above, and it is the right
  // rule while the DETECTOR is fixed. These seven are the other case: the
  // detector was widened (`schema-placeholder-prefix` in
  // `lib/slug-prompt-leak-guard.mjs`) and made visible slugs that were already
  // published and had been invisible to every earlier rule. Nothing regressed
  // — the gate got eyes. Leaving them out would have made this audit, and the
  // vitest sweep that shares its sources, red on `main` for every PR in the
  // repo.
  //
  // Twelve slug positions, seven distinct strings, four articles. All are
  // en/de/fr slugs: the Italian URL, which carries the traffic, is correct in
  // all four cases. They are NOT rewritten here — see the PR body; a published
  // article URL cannot be changed without a redirect, and article pages have
  // no `previousSlugs` bridge (that mechanism is job-board only, in
  // `build-plugins/jobsSeoPagesPlugin.ts`).
  //
  // These live in `packages/articles/content/`, which is a DOWNSTREAM MIRROR
  // of `nanakokyobashi-rgb/frontaliere-articles` (`scripts/pull-articles-corpus.mjs`).
  // Repairing them here would be overwritten by the next sync; the decision
  // belongs upstream.
  'slug-gaggiolo-traffic',
  'slug-gaggiolo-verkehr',
  'slug-traffico-da-record',
  'slug-terzo-pilastro-3a-switzerland',
  'slug-terzo-pilastro-3a-schweiz',
  'slug-terzo-pilastro-3a-suisse',
  'slug-terzo-pilastro-3a-vantaggi-2026-basilea',
]));

/**
 * Sources, in the order a slug travels: registry first (where a slug becomes
 * routable), sitemap second (where it becomes crawlable).
 *
 * `public/` is git-tracked but absent from a sparse worktree, so a missing
 * sitemap is reported as "not scanned" and never silently counted as clean —
 * the failure mode CLAUDE.md warns about, where an empty result reads as a
 * pass. The registries under `packages/articles/content/` are always present,
 * which is what makes the fail-closed check below satisfiable everywhere.
 */
const SOURCES = [
  { path: 'packages/articles/content/routerBlogData.ts', kind: 'registry' },
  { path: 'packages/articles/content/routerSwissData.ts', kind: 'registry' },
  { path: 'public/sitemap-blog.xml', kind: 'sitemap' },
  { path: 'public/sitemap-blog-ch.xml', kind: 'sitemap' },
];

/**
 * Sources this audit reads, exported so the vitest sweep in
 * `tests/article-slug-prompt-leak-guard.test.ts` scans the SAME files instead
 * of listing its own — the test is what actually runs in CI, so the two must
 * not be able to disagree about what "everything" means.
 */
export const AUDIT_SOURCES = Object.freeze(SOURCES.map((s) => Object.freeze({ ...s })));

/** Slug-shaped tokens from a registry file: every quoted `'a-b-c'` literal. */
export function extractRegistrySlugs(src) {
  return [...src.matchAll(/'([a-z0-9][a-z0-9-]*)'/g)].map((m) => m[1]);
}

/** Last non-empty path segment of every `<loc>` in a sitemap. */
export function extractSitemapSlugs(src) {
  const out = [];
  for (const m of src.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
    const segments = m[1].split('?')[0].split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    if (last && !last.includes('.')) out.push(last);
  }
  return out;
}

function main() {
  const asJson = process.argv.includes('--json');
  const scanned = [];
  const missing = [];
  /** @type {Map<string, Set<string>>} slug → sources it appeared in */
  const leaks = new Map();

  for (const { path: rel, kind } of SOURCES) {
    const abs = resolve(ROOT, rel);
    if (!existsSync(abs)) {
      missing.push(rel);
      continue;
    }
    const src = readFileSync(abs, 'utf8');
    const slugs = kind === 'registry' ? extractRegistrySlugs(src) : extractSitemapSlugs(src);
    scanned.push({ path: rel, slugs: slugs.length });
    for (const slug of slugs) {
      if (!findSlugPromptLeak(slug)) continue;
      if (!leaks.has(slug)) leaks.set(slug, new Set());
      leaks.get(slug).add(rel);
    }
  }

  // Fail-closed. Zero readable sources means the audit proved nothing, and an
  // audit that proves nothing must not report success — that is the shape of
  // the bug this whole issue is about.
  if (scanned.length === 0) {
    console.error('❌ audit-slug-prompt-leaks: nessuna sorgente leggibile — audit non eseguito.');
    console.error(`   attese: ${SOURCES.map((s) => s.path).join(', ')}`);
    process.exit(2);
  }

  const fresh = [...leaks.keys()].filter((s) => !KNOWN_LEGACY_LEAKS.has(s));
  const legacySeen = [...leaks.keys()].filter((s) => KNOWN_LEGACY_LEAKS.has(s));

  if (asJson) {
    console.log(JSON.stringify({
      scanned, missing,
      fresh: fresh.map((s) => ({ slug: s, ...findSlugPromptLeak(s), sources: [...leaks.get(s)] })),
      legacy: legacySeen,
      ok: fresh.length === 0,
    }, null, 2));
    process.exit(fresh.length === 0 ? 0 : 1);
  }

  const totalSlugs = scanned.reduce((n, s) => n + s.slugs, 0);
  console.log(`🔎 audit-slug-prompt-leaks: ${totalSlugs} slug da ${scanned.length} sorgenti`);
  for (const s of scanned) console.log(`   • ${s.path} (${s.slugs})`);
  if (missing.length) {
    console.log(`   ⓘ non presenti in questo checkout (worktree sparse?), NON scansionate: ${missing.join(', ')}`);
  }

  if (legacySeen.length) {
    console.log(`\n⚠️  ${legacySeen.length} leak storici noti, ancora live (issue #5334, meta' rimedio):`);
    for (const slug of legacySeen) console.log(`   – ${slug}`);
  }

  if (fresh.length === 0) {
    console.log('\n✅ Nessuno slug contaminato dal template del prompt oltre a quelli noti.');
    process.exit(0);
  }

  console.error(`\n❌ ${fresh.length} NUOVI slug contaminati dal template del prompt:`);
  for (const slug of fresh) {
    const leak = findSlugPromptLeak(slug);
    console.error(`   – "${slug}" (${leak.pattern}: "${leak.match}")`);
    console.error(`     in: ${[...leaks.get(slug)].join(', ')}`);
  }
  console.error(
    '\nIl gate pre-scrittura in scripts/lib/slug-prompt-leak-guard.mjs e\' stato aggirato: ' +
    'questi slug sono gia\' routabili e a un sync di distanza dall\'essere indicizzati. ' +
    'Non aggiungerli a KNOWN_LEGACY_LEAKS — vanno rinominati con redirect previousSlugs.',
  );
  process.exit(1);
}

// Run only when executed as a CLI. The vitest sweep imports KNOWN_LEGACY_LEAKS
// and the two extractors from this file so it cannot drift from the audit;
// importing must not also run the audit and call process.exit() inside the test
// worker.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
