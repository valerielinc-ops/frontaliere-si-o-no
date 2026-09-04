// scripts/lib/informationGain.mjs
//
// Information-Gain metric engine (issue #5002).
//
// WHAT IT MEASURES
// -----------------------------------------------------------------------------
// Google's Information Gain patent (US8140449B1) asks one question about a
// page: given everything the user has ALREADY seen, how much does this page
// add? The operational restatement used here — and the only one that is
// computable from emitted HTML without an LLM — is:
//
//   among the pages built from the SAME template, what share of this page's
//   prose is not already on its siblings?
//
// A page that repeats its siblings word for word, changing only the place
// name and a couple of figures, adds nothing to the corpus: drop it from the
// index and the corpus is not less complete. That is exactly the "mail-merge"
// failure mode the issue calls out ("riscrivere le stesse informazioni con
// parole diverse", "usare template e strutture standardizzate").
//
// WHY MASKING IS THE WHOLE TRICK
// -----------------------------------------------------------------------------
// Comparing raw text does not work. Two fiscal-guide pages read:
//
//   "A Tradate  l'addizionale comunale IRPEF è 0,7%."
//   "A Bregnano l'addizionale comunale IRPEF è 0,55%."
//
// Character-wise those strings differ, so any hash/shingle comparison calls
// them distinct and the metric reports 100% unique — rewarding mail-merge,
// which is the opposite of the intent. So before comparing, every segment is
// masked twice:
//
//   1. NUMBERS → `#`. A slotted figure is data, not prose. Data still counts,
//      but it counts once, through `distinctDataValues` below, not by making
//      the sentence around it look new.
//   2. THIS PAGE'S OWN ENTITY TOKENS → `@`. Tokens taken from the page's
//      <title>, <h1> and URL slug (minus a stop list). "Tradate" on the
//      Tradate page and "Bregnano" on the Bregnano page both become `@`, so
//      the two sentences collapse to the same masked form and the template is
//      seen for what it is.
//
// Masking is deliberately asymmetric — each page is masked with ITS OWN entity
// tokens, never with the union. Masking with the union would erase legitimate
// mentions of other places (a comparison table naming its neighbours is real
// differentiation and must survive).
//
// COHORTS, NOT REGEX FAMILIES
// -----------------------------------------------------------------------------
// The comparison set is derived from the page itself: pages sharing the same
// masked heading skeleton (the ordered <h1>/<h2>/<h3> texts after masking) are
// the same template cohort. No per-family regex table to maintain and no drift
// when a plugin's URL shape changes — the same reason `relatedArticlesIndex.ts`
// ranks by content instead of by `category`. Cohorts of one are not scored:
// with no sibling there is nothing to be redundant with.
//
// SAMPLING SAFETY
// -----------------------------------------------------------------------------
// `audit-all.mjs` can walk a fraction of dist (AUDIT_SAMPLE_RATE). Every value
// here is a RATE over the pages actually seen, never an absolute count, so a
// sampled run and a full run are comparable — the failure mode called out in
// AGENTS.md rule #1's dist exception and the reason absolute ratchets flicker.
// The one sampling-sensitive knob is `minCohortPages`: below it a cohort is
// reported but never gated, because with 3 sampled siblings "shared by half
// the cohort" is noise.

/** Segments shorter than this are navigation chrome, not prose. */
const MIN_SEGMENT_CHARS = 25;

/**
 * A segment is template when it appears on at least this share of the cohort.
 * 0.5 is deliberately lenient: a sentence on half its siblings is already
 * boilerplate by any editorial standard, so a page scoring low here is not a
 * borderline case.
 */
const TEMPLATE_DF_SHARE = 0.5;

/**
 * Per-page segment cap. The dist walk can reach ~130k pages; keeping every
 * segment hash of every page would be the memory profile that forced
 * `post-deploy-validate-dist.yml` serial in the first place. 400 hashes/page
 * covers every page family this repo emits (the longest, the job-board hubs,
 * land around 300) and caps the engine at ~130k × 400 × 8 B ≈ 400 MB worst
 * case, ~40 MB at the observed average of ~40 segments.
 *
 * When a page DOES exceed the cap, which segments survive matters: keeping
 * only the first N in document order would bias the metric toward whichever
 * end of the page happens to be boilerplate. Some templates front-load nav
 * chrome before the page-specific content, others append a per-item list
 * after a shared intro — either way, cutting at a fixed offset can drop the
 * one part of the page that IS the payload and understate IGS exactly on the
 * richest pages. `segmentsFromText` below samples at an even stride across
 * the whole document instead, so a page over the cap still gets a spread of
 * segments from its beginning, middle and end.
 */
const MAX_SEGMENTS_PER_PAGE = 400;

/**
 * Tokens never treated as page identity. Masking them would erase the shared
 * vocabulary of the whole site ("frontaliere", "stipendio") and make every
 * page look unique. Kept small on purpose: the list only needs to cover words
 * that appear in MANY page titles, not every common word — a token that
 * appears in a single title masks a single page and cannot fake uniqueness.
 */
const ENTITY_STOP_TOKENS = new Set([
  // IT
  'come', 'come', 'guida', 'lavoro', 'lavorare', 'stipendio', 'salario', 'medio', 'netto', 'lordo',
  'svizzera', 'svizzero', 'ticino', 'frontaliere', 'frontalieri', 'frontaliera', 'tasse', 'imposte',
  'comune', 'comuni', 'vivere', 'residente', 'residenti', 'confronto', 'calcolo', 'calcola',
  'offerte', 'aziende', 'azienda', 'posti', 'posto', 'anni', 'anno', 'mese', 'mensile', 'annuo',
  // EN
  'work', 'jobs', 'job', 'salary', 'average', 'net', 'gross', 'switzerland', 'swiss', 'guide',
  'cross', 'border', 'commuter', 'commuters', 'tax', 'taxes', 'town', 'towns', 'living', 'compare',
  // DE
  'arbeit', 'arbeiten', 'stellen', 'lohn', 'durchschnittslohn', 'netto', 'brutto', 'schweiz',
  'grenzgaenger', 'grenzgänger', 'steuern', 'gemeinde', 'gemeinden', 'wohnen', 'vergleich',
  // FR
  'travail', 'emploi', 'emplois', 'salaire', 'moyen', 'suisse', 'frontalier', 'frontaliers',
  'impots', 'impôts', 'commune', 'communes', 'vivre', 'comparaison',
]);

const LOCALE_PREFIXES = new Set(['en', 'de', 'fr']);

/** FNV-1a, 32-bit. Stable across runs and processes — no crypto cost per segment. */
export function hashSegment(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Visible body text, one logical line per element boundary.
 *
 * Same stripping set as `audit-content-duplicates.mjs` (script/style/svg/
 * noscript/template/comments) so the two audits cannot disagree about what
 * "the text of a page" is. Tags collapse to newlines rather than spaces:
 * element boundaries are where prose actually breaks, and joining across them
 * would glue a heading onto the paragraph below it and make every masked
 * segment page-specific by accident.
 */
export function extractVisibleText(html) {
  const bodyStart = html.indexOf('<body');
  const body = bodyStart === -1 ? html : html.slice(bodyStart);
  return body
    .replace(/<script[\s\S]*?<\/script>/gi, '\n')
    .replace(/<style[\s\S]*?<\/style>/gi, '\n')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '\n')
    .replace(/<template[\s\S]*?<\/template>/gi, '\n')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '\n')
    .replace(/<!--[\s\S]*?-->/g, '\n')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;|&#38;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t\r ]+/g, ' ');
}

/** Prose segments: element lines, then sentence-split, then length-filtered. */
export function segmentsFromText(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length < MIN_SEGMENT_CHARS) continue;
    for (const sentence of trimmed.split(/(?<=[.!?])\s+/)) {
      const s = sentence.trim();
      if (s.length >= MIN_SEGMENT_CHARS) out.push(s);
    }
  }
  return sampleEvenlyOverCap(out, MAX_SEGMENTS_PER_PAGE);
}

/**
 * Above `limit`, keep an even stride across the WHOLE array instead of the
 * first `limit` entries. See `MAX_SEGMENTS_PER_PAGE` above for why: a
 * fixed-offset cut is biased by where a template happens to put its
 * boilerplate, an even stride is not — it still touches the tail of a long
 * page. Order-preserving (stride selection keeps ascending indices), so a
 * downstream de-dup pass sees the same relative order it always did.
 */
function sampleEvenlyOverCap(items, limit) {
  if (items.length <= limit) return items;
  if (limit <= 1) return items.slice(0, limit);
  // Endpoint-inclusive stride: (n-1)/(limit-1) puts sample 0 at index 0 and
  // sample (limit-1) at the LAST index, so the tail of the document is
  // always represented — not just "close to the end" but the end itself.
  const stride = (items.length - 1) / (limit - 1);
  const out = [];
  for (let i = 0; i < limit; i += 1) out.push(items[Math.round(i * stride)]);
  return out;
}

const tagText = (html, tag) => {
  const m = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
};

/** All heading texts in document order, `<h1>` through `<h3>`. */
export function headingTexts(html) {
  const out = [];
  const re = /<h([123])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (text) out.push(text);
  }
  return out;
}

/**
 * The tokens that identify THIS page: words from its title, h1 and slug.
 *
 * The slug is included because some families carry the discriminating token
 * only in the URL (`/lavoro-ticino-infermiere/` whose h1 is a full sentence),
 * and a page whose identity is invisible to the masker scores as unique for
 * free.
 */
export function entityTokensFrom({ title = '', h1 = '', slugPath = '' } = {}) {
  const raw = `${title} ${h1} ${slugPath.replace(/[/_-]+/g, ' ')}`
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ');
  const tokens = new Set();
  for (const token of raw.split(/\s+/)) {
    if (token.length < 3) continue;
    if (/^\d+$/.test(token)) continue; // numbers are masked by maskSegment anyway
    if (ENTITY_STOP_TOKENS.has(token)) continue;
    tokens.add(token);
  }
  return tokens;
}

/**
 * Canonical comparable form of one segment.
 *
 * Order matters: numbers first (so "0,55" cannot survive as an entity token),
 * then per-token entity substitution. Token splitting keeps the separators so
 * punctuation differences still register as different prose.
 */
export function maskSegment(segment, entityTokens) {
  const numbersMasked = segment
    .toLowerCase()
    .replace(/\d+(?:[.,’'  ]\d+)*/g, '#');
  if (!entityTokens || entityTokens.size === 0) {
    return numbersMasked.replace(/\s+/g, ' ').trim();
  }
  return numbersMasked
    .split(/(\P{L}+)/u)
    .map((part) => (entityTokens.has(part) ? '@' : part))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Locale of a dist-relative path — `it` is the unprefixed default. */
export function localeOfPath(relPath) {
  const first = relPath.replace(/\\/g, '/').replace(/^dist\//, '').split('/')[0] ?? '';
  return LOCALE_PREFIXES.has(first) ? first : 'it';
}

/** `dist/a/b/index.html` → `/a/b/` — the URL the page is served at. */
export function urlPathOf(relPath) {
  const posix = relPath.replace(/\\/g, '/').replace(/^dist\//, '');
  if (posix === 'index.html') return '/';
  if (posix.endsWith('/index.html')) return `/${posix.slice(0, -'index.html'.length)}`;
  if (posix.endsWith('.html')) return `/${posix.slice(0, -'.html'.length)}/`;
  return `/${posix}`;
}

/**
 * Everything the report stage needs from one page, and nothing else.
 *
 * Called once per file during the shared dist walk, so it must not retain the
 * HTML: only hashes, counts and short strings survive. `distinctDataValues` is
 * the count of distinct numeric literals on the page — the honest credit for a
 * page whose contribution IS its figures, kept separate from the prose rate so
 * neither can hide the other.
 */
export function fingerprintPage(relPath, html) {
  const urlPath = urlPathOf(relPath);
  const title = tagText(html, 'title');
  const h1 = tagText(html, 'h1');
  const entityTokens = entityTokensFrom({ title, h1, slugPath: urlPath });

  const headings = headingTexts(html);
  // Cohort seed is the masked <h1> ALONE, not the whole heading skeleton.
  // The skeleton was the first design and it fragmented the cohorts: an
  // optional section (a webcam block a comune has and its neighbour does not)
  // changes the skeleton, splits one template into three cohorts of four, and
  // every fragment falls under `minCohortPages` — a gate that measures nothing
  // precisely where the family is largest. The masked h1 is the template's
  // signature: it is emitted by one `copy.h1()` per family, so it is identical
  // across the family by construction and unaffected by optional sections.
  const skeleton = maskSegment(headings[0] ?? '', entityTokens);

  const segments = segmentsFromText(extractVisibleText(html));
  const segHashes = [];
  const seen = new Set();
  for (const segment of segments) {
    const hash = hashSegment(maskSegment(segment, entityTokens));
    if (seen.has(hash)) continue; // a page repeating itself is not two contributions
    seen.add(hash);
    segHashes.push(hash);
  }

  const numbers = new Set();
  for (const m of html.replace(/<[^>]*>/g, ' ').matchAll(/\d+(?:[.,]\d+)*/g)) numbers.add(m[0]);

  return {
    urlPath,
    locale: localeOfPath(relPath),
    skeletonHash: hashSegment(skeleton),
    headingCount: headings.length,
    segHashes,
    distinctDataValues: numbers.size,
  };
}

/**
 * Longest common path prefix — the cohort's human-readable name.
 *
 * Whole `/`-delimited segments first, then the common CHARACTER prefix of the
 * first segment where the paths diverge. The character step used to run only
 * when NO whole segment was common, which made the label locale-asymmetric on
 * exactly the families that need it most: `/lavoro-argovia-autista/` has no
 * common segment and gets the readable `it:/lavoro-`, while its own de/en/fr
 * translations (`/de/arbeit-bern-architekt/`, `/en/jobs-bern-fitter/`) always
 * share the locale segment, so the fallback never fired and every flat-slug
 * family in a prefixed locale collapsed to `/de/`, `/en/`, `/fr/`. Those
 * labels then collided with each other and got the `~skeletonHash` suffix from
 * `scoreCohorts`, so the same page family reads `it:/lavoro-` in one locale and
 * `en:/en/~896cea` in another (issue #6975: 37 offenders, several of them
 * unidentifiable from the report for this reason alone).
 *
 * It is not only cosmetic. `KNOWN_LOW_GAIN_COHORTS` in
 * `audit-information-gain.mjs` is keyed BY label, and a label that stops at
 * `/fr/` is a key shared with every other flat-slug family in French: one
 * inventoried value silently standing for several unrelated templates.
 *
 * Strictly more specific, never less — when the diverging segment has no
 * common character prefix (`/tasse-frontalieri-comune/<comune>/`) the label is
 * byte-identical to what it was before, which is what keeps the existing
 * inventory entries and the calibration table valid.
 */
export function commonPathPrefix(paths) {
  if (paths.length === 0) return '/';
  const split = paths.map((p) => p.split('/').filter(Boolean));
  const first = split[0];
  const out = [];
  for (let i = 0; i < first.length; i += 1) {
    const segment = first[i];
    if (!split.every((parts) => parts[i] === segment)) break;
    out.push(segment);
  }
  // Flat slug families (`/lavoro-ticino-<x>/`, `/en/jobs-<x>/`) share no whole
  // segment past this depth, so keep the common characters of the one where
  // they diverge: that is what makes `it:/lavoro-ticino-` a readable label.
  const diverging = split.map((parts) => parts[out.length] ?? '');
  let len = 0;
  while (diverging.every((s) => s.length > len && s[len] === diverging[0][len])) len += 1;
  const tail = diverging[0].slice(0, len);
  if (out.length === 0) return tail ? `/${tail}` : '/';
  return tail ? `/${out.join('/')}/${tail}` : `/${out.join('/')}/`;
}

const median = (values) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * Group fingerprints into template cohorts and score each page.
 *
 * @param {Array} fingerprints output of `fingerprintPage`
 * @param {{minCohortPages?: number}} [opts]
 * @returns {{cohorts: Array, pagesScored: number, pagesUncohorted: number}}
 */
export function scoreCohorts(fingerprints, opts = {}) {
  const minCohortPages = opts.minCohortPages ?? 12;

  const groups = new Map();
  for (const fp of fingerprints) {
    if (fp.segHashes.length === 0) continue; // empty shell, nothing to score
    const key = `${fp.locale}|${fp.skeletonHash}`;
    let bucket = groups.get(key);
    if (!bucket) groups.set(key, (bucket = []));
    bucket.push(fp);
  }

  const cohorts = [];
  let pagesScored = 0;
  let pagesUncohorted = 0;

  for (const [key, pages] of groups) {
    if (pages.length < 2) {
      pagesUncohorted += pages.length;
      continue;
    }
    const df = new Map();
    for (const page of pages) {
      for (const hash of page.segHashes) df.set(hash, (df.get(hash) ?? 0) + 1);
    }
    const templateCutoff = Math.max(2, Math.ceil(pages.length * TEMPLATE_DF_SHARE));

    const scored = pages
      .map((page) => {
        const pageSpecific = page.segHashes.reduce(
          (acc, hash) => acc + (df.get(hash) < templateCutoff ? 1 : 0),
          0,
        );
        return {
          urlPath: page.urlPath,
          segments: page.segHashes.length,
          pageSpecific,
          igs: (pageSpecific / page.segHashes.length) * 100,
          distinctDataValues: page.distinctDataValues,
        };
      })
      .sort((a, b) => a.igs - b.igs || (a.urlPath < b.urlPath ? -1 : 1));

    pagesScored += scored.length;
    const igsValues = scored.map((p) => p.igs);
    cohorts.push({
      key,
      label: `${pages[0].locale}:${commonPathPrefix(pages.map((p) => p.urlPath))}`,
      skeletonHash: pages[0].skeletonHash,
      locale: pages[0].locale,
      pages: scored.length,
      gated: scored.length >= minCohortPages,
      medianIgs: median(igsValues),
      meanIgs: igsValues.reduce((a, b) => a + b, 0) / igsValues.length,
      zeroGainPages: scored.filter((p) => p.pageSpecific === 0).length,
      worst: scored.slice(0, 5),
    });
  }

  // `commonPathPrefix` computes each cohort's label in isolation, with no
  // visibility into sibling cohorts. For flat-slug families it falls back to
  // a raw character prefix (`/lavoro-ticino-`), and two structurally distinct
  // families (different `skeletonHash`, i.e. different templates) can reduce
  // to that SAME string if their slugs happen to share a long enough prefix.
  // That collision is not cosmetic: `audit-information-gain.mjs` keys the
  // regression inventory (`KNOWN_LOW_GAIN_COHORTS`) BY label, so two
  // colliding cohorts would silently share one recorded baseline. Disambiguate
  // deterministically with the family's own skeleton fingerprint — stable
  // across sampling and independent of iteration order — leaving every
  // non-colliding label (the overwhelming majority) untouched.
  const labelCounts = new Map();
  for (const cohort of cohorts) labelCounts.set(cohort.label, (labelCounts.get(cohort.label) ?? 0) + 1);
  for (const cohort of cohorts) {
    if (labelCounts.get(cohort.label) > 1) cohort.label = `${cohort.label}~${cohort.skeletonHash.toString(16).slice(0, 6)}`;
  }

  cohorts.sort((a, b) => a.medianIgs - b.medianIgs || b.pages - a.pages);
  return { cohorts, pagesScored, pagesUncohorted };
}

export const INFORMATION_GAIN_TUNABLES = {
  MIN_SEGMENT_CHARS,
  TEMPLATE_DF_SHARE,
  MAX_SEGMENTS_PER_PAGE,
};
