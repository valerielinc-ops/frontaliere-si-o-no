#!/usr/bin/env node
// Zero-Claude check: every article id in BOTH section registries
// (frontaliere: data/blog-articles-data.ts, svizzera: data/swiss-articles-data.ts)
// must carry title + excerpt + imageAlt keys in that section's OWN IT meta
// file (services/locales/blog-meta-it.ts / blog-meta-ch-it.ts).
//
// Root cause this locks (2026-07 production incident): registry entries can
// be appended (create-article.mjs runs, manual edits, cross-branch merges)
// without their `blog.article.<id>.*` meta landing in the same change. The
// article PAGE recovers via build-plugins/articleSeoFallback.ts (derives
// title/description from services/seo/seo-blog*.ts when meta is missing) —
// but the LIST (components/community/BlogArticles.tsx and its svizzera
// mirror) calls `t()` directly with no fallback, so a registry id with no IT
// title renders the raw i18n key `blog.article.<id>.title` live on
// /articoli-frontaliere/ and /articoli-svizzera/. Confirmed orphans at the
// time this gate was added: permesso-g-pro-contro-2026,
// cantieri-traffico-a9-ticino, iniziativa-salari-ticino (all now repaired —
// see services/locales/blog-meta-{it,en,de,fr}.ts).
//
// Uses ARTICLE_SECTION_CORE_LIST (build-plugins/shared/articleSectionCore.mjs)
// as the single source of truth for the section → registryFile/metaPrefix
// tuple, instead of re-hardcoding those paths a 7th time (see that module's
// docstring for the six pre-existing copies it already collapsed).
//
// Usage: node scripts/ci/check-orphan-article-meta.mjs
// Exit 0 = every registry id has complete IT meta. Exit 1 = orphan(s) found.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ARTICLE_SECTION_CORE_LIST } from '../../build-plugins/shared/articleSectionCore.mjs';

// cwd-relative (not __dirname-relative) so a test fixture can point this at
// an isolated temp tree via `{ cwd }` — same convention as
// scripts/ci/validate-article-append-integrity.mjs. The ARTICLE_SECTION_CORE_LIST
// import itself always resolves against this script's own real location
// (module imports are never cwd-relative); that's fine, it's static config,
// not something a fixture needs to fake.
const root = process.cwd();

// Same three suffixes create-article.mjs writes for every article today —
// verified 1:1 across the live corpus (3027 frontaliere + 553 svizzera
// entries in blog-meta-it.ts / blog-meta-ch-it.ts, zero partial entries).
const REQUIRED_SUFFIXES = ['title', 'excerpt', 'imageAlt'];

function idsOf(registryFile) {
  const src = readFileSync(resolve(root, registryFile), 'utf-8');
  return [...src.matchAll(/^\s*id:\s*'([^']+)'/gm)].map((m) => m[1]);
}

let exitCode = 0;

// EVERY locale the list route is served on, not just IT. `services/router.ts`
// exposes the archive on four routes per section (/articoli-frontaliere/,
// /cross-border-articles/, /grenzgaenger-artikel/, /articles-frontalier/ and
// the svizzera equivalents), and BlogArticles.tsx calls t() with no fallback
// on all of them. An id with complete IT meta but missing EN/DE/FR still
// renders the raw `blog.article.<id>.title` key on three routes out of four —
// checking IT alone would let this PR's own incident survive on the locales
// nobody inspected.
const LOCALES = ['it', 'en', 'de', 'fr'];

for (const { section, registryFile, metaPrefix } of ARTICLE_SECTION_CORE_LIST) {
  const ids = idsOf(registryFile);
  const orphansByLocale = new Map();
  for (const locale of LOCALES) {
    const metaFile = `services/locales/${metaPrefix}-${locale}.ts`;
    const metaSrc = readFileSync(resolve(root, metaFile), 'utf-8');
    const orphans = [];
    for (const id of ids) {
      const missing = REQUIRED_SUFFIXES.filter(
        (suffix) => !metaSrc.includes(`'blog.article.${id}.${suffix}'`),
      );
      if (missing.length) orphans.push(`  ${id}: missing ${missing.join(', ')}`);
    }
    if (orphans.length) orphansByLocale.set(metaFile, orphans);
  }
  if (orphansByLocale.size) {
    for (const [metaFile, orphans] of orphansByLocale) {
      console.error(`\n❌ ${section} (${registryFile} ↔ ${metaFile}): ${orphans.length} orphan id(s):`);
      orphans.forEach((l) => console.error(l));
    }
    exitCode = 1;
  } else {
    console.log(`✅ ${section}: all ${ids.length} registry ids have complete meta in all ${LOCALES.length} locales`);
  }
}

if (exitCode === 0) {
  console.log('\n✅ no orphan article meta — every registry id renders a real title in the live list');
} else {
  console.error('\n❌ orphan article meta found — add title/excerpt/imageAlt to the locale meta file(s) named above (services/locales/*) before merging — every locale the archive route serves must resolve, not just IT; see scripts/manage-article.mjs list for the orphan finder and scripts/lib/free-translate.mjs for the translation cascade');
}
process.exit(exitCode);
