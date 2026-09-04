#!/usr/bin/env node
/**
 * Repair — and, in `--check` mode, GATE — job titles corrupted by the
 * unbalanced-quote attribute read fixed in issue #6480.
 *
 * ## The signature this looks for
 *
 * The defect appended a truncated copy of the title to itself, because
 * `extractLinks()` read `title="…"` with `["']([^"']+)["']`, which stops at the
 * FIRST quote of either kind — so an Italian/French apostrophe cut the value
 * short and the fragment was concatenated onto the anchor text:
 *
 *     title="Collaboratrice-ore dell'economia domestica a ore"
 *   → "Collaboratrice-ore dell'economia domestica a ore Collaboratrice-ore dell"
 *                                                       └── A.slice(0,23) ──┘
 *                                                  and A[23] is the apostrophe
 *
 * So a title is corrupt iff it splits as `A + ' ' + B` where B is a proper
 * prefix of A **and the character of A right after that prefix is a quote**.
 *
 * That last clause is the whole point. Issue #6480 abandoned its own
 * measurement because a plain "repeated prefix" heuristic returned 367 hits
 * dominated by German double-gender titles — `Ernährungsberaterin /
 * Ernährungsberater`, whose tail genuinely IS a prefix of its head. Requiring a
 * quote at the cut point separates the two exactly: measured over all 30'804
 * stored vacancies it returns 2 hits and 0 false positives.
 *
 * ## Usage
 *
 *   node scripts/repair-quote-truncated-titles.mjs            # report only
 *   node scripts/repair-quote-truncated-titles.mjs --check    # exit 1 if any
 *   node scripts/repair-quote-truncated-titles.mjs --apply    # rewrite slices
 *
 * `--apply` repairs `title` and every `titleByLocale` slot. It deliberately does
 * NOT touch slugs: a published slug is a URL, and rewriting one is a rename that
 * belongs to the redirect machinery (`previousSlugsByLocale`), not to a title
 * repair.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { listSliceFileNames } from './lib/crawler-slice-files.mjs';

const JOB_SLICE_DIR = 'data/jobs/by-crawler';
/**
 * A quote at the cut point — as a raw character, or as an HTML entity that was
 * never decoded.
 *
 * The entity half is not theoretical: scanning the 30'758 stored titles finds
 * one that still carries `&#34;` (`Pflegepraktikant:in ... &#34;Häfelipraktikum&#34;`),
 * so entities do survive into the dataset from parsers that skip `decodeEntities`.
 * A truncation whose cut point landed on `&#39;` instead of `'` would otherwise
 * be invisible to this detector.
 */
const QUOTE_AT_CUT_RX =
  /^(?:["'‘’“”]|&(?:quot|apos|[lr]squo|[lr]dquo|#0*3[49]|#x0*2[27]|#0*(?:8216|8217|8220|8221)|#x0*201[89cCdD]);)/i;

/**
 * The corrupted-title detector.
 *
 * @param {string} raw
 * @returns {{ clean: string, echo: string }|null} null when the title is fine.
 */
export function detectQuoteTruncatedTitle(raw = '') {
  const s = String(raw || '');
  for (let i = 1; i < s.length; i++) {
    if (s[i] !== ' ') continue;
    const A = s.slice(0, i);
    const B = s.slice(i + 1);
    if (!B.length || B.length >= A.length) continue;
    if (A.slice(0, B.length) !== B) continue;
    if (!QUOTE_AT_CUT_RX.test(A.slice(B.length))) continue;
    return { clean: A, echo: B };
  }
  return null;
}

function main() {
  const apply = process.argv.includes('--apply');
  const check = process.argv.includes('--check');

  if (!existsSync(JOB_SLICE_DIR)) {
    console.error(`⚠️  ${JOB_SLICE_DIR} assente — worktree sparse? Niente da fare.`);
    return 0;
  }

  const files = listSliceFileNames(JOB_SLICE_DIR);
  let scanned = 0;
  const hits = [];

  for (const file of files) {
    const path = join(JOB_SLICE_DIR, file);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      console.error(`  parse-error: ${path}`);
      continue;
    }
    const jobs = Array.isArray(parsed) ? parsed : parsed.jobs || [];
    let touched = false;

    for (const job of jobs) {
      scanned++;
      const found = detectQuoteTruncatedTitle(job.title);
      const localeHits = Object.entries(job.titleByLocale || {})
        .map(([loc, t]) => [loc, detectQuoteTruncatedTitle(t)])
        .filter(([, d]) => d);
      if (!found && !localeHits.length) continue;

      hits.push({
        crawler: file.replace(/\.json$/, ''),
        id: job.id,
        before: job.title,
        after: found ? found.clean : job.title,
        locales: localeHits.map(([l]) => l),
      });

      if (apply) {
        // The corrupted title is also embedded in the synthesised description
        // (`<title> — <company>`), where it is not at end-of-string and so the
        // detector above cannot see it. Substitute it as a known literal: we
        // have the exact bad string and its exact replacement, so this cannot
        // over-match.
        const swaps = [];
        if (found) { swaps.push([job.title, found.clean]); job.title = found.clean; touched = true; }
        for (const [loc, d] of localeHits) {
          swaps.push([job.titleByLocale[loc], d.clean]);
          job.titleByLocale[loc] = d.clean;
          touched = true;
        }
        for (const [bad, good] of swaps) {
          if (!bad || bad === good) continue;
          if (typeof job.description === 'string' && job.description.includes(bad)) {
            job.description = job.description.split(bad).join(good);
            touched = true;
          }
          for (const [loc, text] of Object.entries(job.descriptionByLocale || {})) {
            if (typeof text === 'string' && text.includes(bad)) {
              job.descriptionByLocale[loc] = text.split(bad).join(good);
              touched = true;
            }
          }
        }
      }
    }

    if (apply && touched) {
      writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`);
      console.log(`  riscritto ${path}`);
    }
  }

  console.log(`\nScansionati ${scanned} annunci in ${files.length} slice.`);
  console.log(`Titoli con la firma #6480: ${hits.length}`);
  for (const h of hits) {
    console.log(`  ${h.crawler} ${h.id}`);
    console.log(`    prima: ${JSON.stringify(h.before)}`);
    console.log(`    dopo : ${JSON.stringify(h.after)}   locali: ${h.locales.join(',') || '-'}`);
  }

  if (check && hits.length) {
    console.error(`\n❌ --check: ${hits.length} titolo/i concatenato/i (#6480). Rilancia con --apply.`);
    return 1;
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
