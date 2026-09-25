#!/usr/bin/env node
/**
 * Repair article SEO titles that were cut mid-word.
 *
 * When the generation model omitted the `seo` block, create-article.mjs used to
 * synthesize it with a hard `.slice(0, 57)` on the Italian title. A character
 * cut lands wherever character 57 falls — usually mid-word, usually on the half
 * that carries the information:
 *
 *   "Incidente mortale a Porlezza: muore un | Frontaliere Ticino"
 *   "Educatori in Germania: stipendi fino a | Frontaliere Ticino"
 *   "Comuni di Confine: la distanza che | Frontaliere Ticino"
 *
 * The cause is fixed (that branch now uses `truncateAtWordBoundary`). This
 * repairs the ones already published, which stay broken otherwise — they are
 * indexed pages and the title tag is what earns the click.
 *
 * The untruncated text is still on disk, in the per-locale meta chunk: the
 * article's own `blog.article.<id>.title` is the full editorial headline. That
 * is the source used here.
 *
 * NOT the structured-data `headline` of the same entry, which was the obvious
 * candidate and is unusable: 159 of them carry a nested, truncated JSON blob
 * (`"headline": "{\"@context\":\"https://schema.org\",...`) left by a model
 * that emitted a whole document where a string belonged. Harmless today — the
 * renderer does not read it — but worthless as a repair source.
 *
 *   candidate = metaTitle + " | Frontaliere Ticino"
 *   title     = candidate.length <= 66 ? candidate : truncated(metaTitle, 60)
 *
 * Deliberately narrow. It only touches entries whose title matches the
 * mid-word-cut signature (ends on a connective word immediately before the
 * brand suffix), and only when the headline is genuinely longer than what the
 * title currently carries. An entry it cannot improve is left exactly as is.
 *
 * URLs, slugs, dates, bodies and structured data are NOT touched — only the two
 * title fields, so nothing about routing or canonicalisation can move.
 *
 * Usage:
 *   node scripts/one-off/repair-truncated-article-titles.mjs            # dry-run
 *   node scripts/one-off/repair-truncated-article-titles.mjs --apply    # write
 */
import fs from 'node:fs';
import path from 'node:path';
import { truncateToClause } from '../../build-plugins/shared/clauseTail.mjs';
import { unescapeTsString } from '../lib/unescape-ts-string.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SEO_DIR = path.join(ROOT, 'packages', 'articles', 'content', 'seo');
const META_FILE = path.join(ROOT, 'packages', 'articles', 'content', 'blog-meta-it.ts');
const META_CH_FILE = path.join(ROOT, 'packages', 'articles', 'content', 'blog-meta-ch-it.ts');
const APPLY = process.argv.includes('--apply');

const BRAND = ' | Frontaliere Ticino';
const TITLE_MAX_CHARS = 66;

/** Mirrors create-article.mjs's truncateAtWordBoundary exactly. */
// Delegates to the shared build-plugins/shared/clauseTail.mjs — the same
// implementation create-article.mjs and the SERP render layer use. The local
// copy this replaces carried the original defect it was written to repair:
// `Math.max(cut.lastIndexOf(' '), maxLen - 12)` falls back to a HARD mid-word
// cut when the last space sits before `maxLen - 12`, and stripping only
// punctuation leaves the preposition dangling ("…doganali per").
function truncateAtWordBoundary(text, maxLen) {
  return truncateToClause(text, maxLen);
}

/**
 * Titles cut mid-sentence end on a connective immediately before the brand.
 *
 * Deliberately over-inclusive rather than precise: `ai` IS in the list, so
 * "…nell'era AI | …" is flagged even though it is a complete sentence. That
 * costs nothing — such an entry is then rejected by the "is the editorial title
 * actually longer?" check below and left untouched — whereas leaving `ai` out
 * would miss the real "…comunale ai" cut. Flagging is cheap; rewriting a good
 * title is not, and the length check is what actually protects against it.
 */
const CONNECTIVES =
  'per|con|di|da|in|su|tra|fra|e|ed|a|ad|ai|il|la|lo|i|gli|le|un|una|uno|del|della|dei|degli|delle|al|alla|agli|alle|dal|dalla|nel|nella|sul|sulla|che|come|dove|non|ma|se|si|ha|hanno|' +
  // Second pass (review of the first): words that end a fragment just as badly
  // as a preposition but are none of the above — "…comunale ai", "…multe fino",
  // "…parco eolico: ecco", "…dibattito e 20". A bare number is the same case.
  'fino|verso|ecco|anche|nostro|nostra|nostri|nostre|suo|sua|suoi|sue|questo|questa|questi|queste';

// A bare trailing number is NOT a cut — "…si riprende nel 2026" is a complete
// title, and treating digits as a connective threw those away. What IS a cut is
// a connective followed by a number the phrase never finishes: "…dibattito e 20".
const CONNECTIVE_NUMBER_TAIL = /\b(?:e|ed|di|a|ad|con|per|da|in|su|tra|fra)\s+\d+\s*$/i;
const TRUNCATED_RX = new RegExp(`\\b(${CONNECTIVES})\\s*\\|\\s*Frontaliere Ticino\\s*$`, 'i');

/**
 * A second, distinct signature: the BRAND itself was cut, so the title ends in
 * "| Frontaliere" or a bare "|" instead of "| Frontaliere Ticino". Invisible to
 * TRUNCATED_RX, which requires the full brand before the connective — these
 * were missed entirely by the first pass (2 titles, ~40 ogTitle).
 */
const CUT_BRAND_RX = /\|\s*(?:Frontaliere)?\s*$/;

/** Any recognisable mid-phrase ending, whichever shape it takes. */
const isCut = (s) => {
  const core = String(s).replace(/\s*\|\s*Frontaliere(?:\s+Ticino)?\s*$/i, '');
  return TRUNCATED_RX.test(s) || CUT_BRAND_RX.test(s) || CONNECTIVE_NUMBER_TAIL.test(core);
};

/**
 * Trailing connectives left by a word-boundary cut ("… il campetto di Como tra")
 * are still a dangling phrase. Dropping them costs a word and reads as a title.
 */
function dropDanglingConnective(s) {
  let out = s.trim().replace(/[,:;.\-–—\s]+$/, '');
  const rx = new RegExp(`\\s+(${CONNECTIVES})$`, 'i');
  while (rx.test(out)) out = out.replace(rx, '').replace(/[,:;.\-–—\s]+$/, '');
  return out.trim();
}

/** id -> full editorial title, from the per-locale meta chunks. */
function readMetaTitles() {
  const map = new Map();
  for (const file of [META_FILE, META_CH_FILE]) {
    if (!fs.existsSync(file)) continue;
    const src = fs.readFileSync(file, 'utf-8');
    const rx = /'blog\.article\.([^']+)\.title':\s*'((?:[^'\\]|\\.)*)'/g;
    let m;
    while ((m = rx.exec(src)) !== null) {
      if (!map.has(m[1])) map.set(m[1], unescapeSingle(m[2]));
    }
  }
  return map;
}

const escapeSingle = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const unescapeSingle = (s) => unescapeTsString(s, { "'": "'", '\\': '\\' });
const unescapeDouble = (s) => unescapeTsString(s, { '"': '"', '\\': '\\' });

const metaTitles = readMetaTitles();
console.log(`meta title disponibili: ${metaTitles.size}`);

let scanned = 0;
let repaired = 0;
let skipped = 0;
const samples = [];

for (const file of fs.readdirSync(SEO_DIR).filter((f) => /^seo-blog.*\.ts$/.test(f))) {
  const full = path.join(SEO_DIR, file);
  let src = fs.readFileSync(full, 'utf-8');
  let changedInFile = 0;

  // Entry boundaries: each article block starts at 'blog-<id>': {
  const starts = [...src.matchAll(/'blog-([^']+)':\s*\{/g)].map((m) => ({ id: m[1], i: m.index }));

  // Walk backwards so earlier offsets stay valid as we splice.
  for (let k = starts.length - 1; k >= 0; k--) {
    const from = starts[k].i;
    const to = k + 1 < starts.length ? starts[k + 1].i : src.length;
    const block = src.slice(from, to);

    const titleM = block.match(/title:\s*'((?:[^'\\]|\\.)*)'/);
    if (!titleM) continue;
    scanned++;

    const currentTitle = unescapeSingle(titleM[1]);
    if (!isCut(currentTitle)) continue;

    // The entry key is `blog-<id>`; the meta chunk is keyed by the bare id.
    // Every article in the corpus has one — verified across all 8 seo-blog
    // files: zero blocks resolve to a missing meta title. An earlier version
    // carried an ogTitle fallback for supposed hub/landing entries without a
    // meta title; those turned out to have one too, so the branch was
    // unreachable by construction and is gone.
    const full = metaTitles.get(starts[k].id);
    if (!full) {
      skipped++;
      continue;
    }

    // Only act when the editorial title actually carries more than the title tag.
    // Strip the brand in whatever state it is in — including the cut forms
    // ("| Frontaliere", a bare "|"). Matching only the full brand left the
    // fragment inside `currentCore`, which then measured LONGER than the real
    // title and made the entry look unimprovable.
    const currentCore = currentTitle
      .replace(/\s*\|\s*Frontaliere(?:\s+Ticino)?\s*$/i, '')
      .replace(/\s*\|\s*$/, '')
      .trim();
    if (full.length <= currentCore.length) {
      skipped++;
      continue;
    }

    const candidate = `${full}${BRAND}`;
    const newTitle =
      candidate.length <= TITLE_MAX_CHARS
        ? candidate
        : dropDanglingConnective(truncateAtWordBoundary(full, 60));

    // A rebuild that is itself cut mid-phrase, or that recovers nothing, is not
    // an improvement — leave the entry alone rather than churn it.
    if (isCut(newTitle) || newTitle.length <= currentCore.length) {
      skipped++;
      continue;
    }

    let newBlock = block.replace(titleM[0], `title: '${escapeSingle(newTitle)}'`);

    // ogTitle is deliberately NOT touched here.
    //
    // It carries the same class of damage, but a DIFFERENT signature: the old
    // generator never appended the brand to it, so its cut is a bare `.slice()`
    // at an arbitrary character ("…carpooling aziendal") with none of the
    // markers this script detects — pipe, trailing connective, connective+number.
    // Every guard written against those markers therefore misjudges it: a loose
    // one lengthens ogTitle values that were already complete sentences, and a
    // strict one refuses to fix the ones that are plainly mutilated. Both were
    // tried on this branch; the second regressed 23 entries the first had fixed.
    //
    // A correct ogTitle repair needs its own detector (compare against the full
    // editorial title rather than look for a cut marker) and its own traversal —
    // this loop only opens a block when the TITLE is cut, so ~75 entries whose
    // title is fine and whose ogTitle is not are unreachable from here by
    // construction. That is a separate change, declared in the PR body.

    if (newBlock === block) {
      skipped++;
      continue;
    }

    src = src.slice(0, from) + newBlock + src.slice(to);
    repaired++;
    changedInFile++;
    if (samples.length < 8) samples.push({ id: starts[k].id, before: currentTitle, after: newTitle });
  }

  if (changedInFile > 0 && APPLY) fs.writeFileSync(full, src);
  if (changedInFile > 0) console.log(`${file}: ${changedInFile} title riparati`);
}

console.log(`\nscansionati: ${scanned}`);
console.log(`riparati:    ${repaired}`);
console.log(`saltati:     ${skipped} (headline assente o non più informativo del title)`);
console.log(APPLY ? '\n✅ scritto su disco' : '\nℹ️  dry-run — nessuna scrittura (usa --apply)');

if (samples.length) {
  console.log('\nesempi:');
  for (const s of samples) {
    console.log(`  [${s.id}]`);
    console.log(`    prima: ${s.before}`);
    console.log(`    dopo : ${s.after}`);
  }
}
