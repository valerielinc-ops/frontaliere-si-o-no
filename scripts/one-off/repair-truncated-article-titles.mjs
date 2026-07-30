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

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SEO_DIR = path.join(ROOT, 'packages', 'articles', 'content', 'seo');
const META_FILE = path.join(ROOT, 'packages', 'articles', 'content', 'blog-meta-it.ts');
const META_CH_FILE = path.join(ROOT, 'packages', 'articles', 'content', 'blog-meta-ch-it.ts');
const APPLY = process.argv.includes('--apply');

const BRAND = ' | Frontaliere Ticino';
const TITLE_MAX_CHARS = 66;

/** Mirrors create-article.mjs's truncateAtWordBoundary exactly. */
function truncateAtWordBoundary(text, maxLen) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= maxLen) return s;
  const cut = s.slice(0, maxLen + 1);
  return cut
    .slice(0, Math.max(cut.lastIndexOf(' '), maxLen - 12))
    .trim()
    .replace(/[,:;.\-–—\s]+$/, '');
}

/**
 * Titles cut mid-sentence end on a connective immediately before the brand.
 * Kept deliberately conservative: "…paga di più | …" and "…nell'era AI | …" are
 * complete sentences that merely end on a short word, so `piu`/`ai` and friends
 * are excluded to avoid rewriting titles that are already fine.
 */
const CONNECTIVES =
  'per|con|di|da|in|su|tra|fra|e|ed|a|ad|il|la|lo|i|gli|le|un|una|uno|del|della|dei|degli|delle|al|alla|agli|alle|dal|dalla|nel|nella|sul|sulla|che|come|dove|non|ma|se|si|ha|hanno';
const TRUNCATED_RX = new RegExp(`\\b(${CONNECTIVES})\\s*\\|\\s*Frontaliere Ticino\\s*$`, 'i');

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
      if (!map.has(m[1])) map.set(m[1], m[2].replace(/\\'/g, "'").replace(/\\\\/g, '\\'));
    }
  }
  return map;
}

const escapeSingle = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const unescapeSingle = (s) => s.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
const unescapeDouble = (s) => s.replace(/\\"/g, '"').replace(/\\\\/g, '\\');

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
    if (!TRUNCATED_RX.test(currentTitle)) continue;

    // The entry key is `blog-<id>`; the meta chunk is keyed by the bare id.
    const full = metaTitles.get(starts[k].id);
    if (!full) {
      skipped++;
      continue;
    }

    // Only act when the editorial title actually carries more than the title tag.
    const currentCore = currentTitle.replace(/\s*\|\s*Frontaliere Ticino\s*$/i, '').trim();
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
    if (TRUNCATED_RX.test(newTitle) || newTitle.length <= currentCore.length) {
      skipped++;
      continue;
    }

    let newBlock = block.replace(titleM[0], `title: '${escapeSingle(newTitle)}'`);

    // ogTitle carries the same cut when it was synthesized from the same string.
    const ogM = newBlock.match(/ogTitle:\s*'((?:[^'\\]|\\.)*)'/);
    if (ogM) {
      const og = unescapeSingle(ogM[1]);
      if (full.startsWith(og) && full.length > og.length) {
        const newOg = dropDanglingConnective(truncateAtWordBoundary(full, 60));
        if (newOg.length > og.length) {
          newBlock = newBlock.replace(ogM[0], `ogTitle: '${escapeSingle(newOg)}'`);
        }
      }
    }

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
