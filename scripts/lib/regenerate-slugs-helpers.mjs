/**
 * Pure helpers for slugByLocale regeneration. Extracted from
 * scripts/regenerate-slugs-by-locale.mjs so the slug heuristics can be
 * unit-tested in isolation.
 *
 * The CLI lives in the parent file; this module owns only the slug math.
 */

import crypto from 'node:crypto';
import { truncateSlugAtWordBoundary } from './slug-truncate.mjs';

export const MAX_SLUG_LENGTH = 120;

// IT/EN/DE/FR connectives stripped from slug token sets so they don't pollute
// Jaccard comparisons. `und` (DE) lives here even though it's 3 chars.
export const SLUG_STOP_WORDS = new Set(
  'del,dei,della,delle,degli,nel,nella,per,con,una,uno,che,tra,fra,sur,les,des,une,pour,avec,dans,par,the,and,for,with,from,die,der,das,den,dem,des,und,fur,mit,von,bei,ein,eine,einer,einem,einen'.split(','),
);

export function slugify(text) {
  const base = String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return truncateSlugAtWordBoundary(base, MAX_SLUG_LENGTH);
}

export function shortJobHash(jobId) {
  return crypto.createHash('sha1').update(String(jobId ?? '')).digest('hex').slice(0, 6);
}

export function appendDisambiguatorTail(slug, tail) {
  const t = String(tail || '').trim();
  if (!t) return slug;
  const maxBase = Math.max(0, MAX_SLUG_LENGTH - t.length - 1);
  const trimmed = truncateSlugAtWordBoundary(String(slug || ''), maxBase).replace(/-+$/, '');
  return trimmed ? `${trimmed}-${t}` : t;
}

export function buildSlug(title, company, location, disambiguator = '') {
  const parts = [title, company, location].filter(Boolean);
  const base = slugify(parts.join(' '));
  const d = String(disambiguator || '').trim();
  if (!d || !base) return base;
  const maxBase = Math.max(0, MAX_SLUG_LENGTH - d.length - 1);
  const trimmed = truncateSlugAtWordBoundary(base, maxBase).replace(/-+$/, '');
  return trimmed ? `${trimmed}-${d}` : d;
}

export function slugTokenSet(slug) {
  return new Set(
    String(slug || '').split('-').filter((w) => w.length >= 3 && !SLUG_STOP_WORDS.has(w)),
  );
}

export function slugJaccard(a, b) {
  const setA = slugTokenSet(a);
  const setB = slugTokenSet(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  return intersection / (setA.size + setB.size - intersection);
}

export function isLikelyUntranslated(localeTitle, sourceTitle) {
  if (!localeTitle || !sourceTitle) return false;
  const a = slugify(localeTitle);
  const b = slugify(sourceTitle);
  if (a === b) return true;
  return slugJaccard(a, b) > 0.5;
}

// Tokens contributed by company / location / disambiguator. Used to subtract
// "structural noise" from slug comparisons so the Jaccard score reflects only
// the title portion of the slug.
function noiseTokens(company, location, disambiguator) {
  const out = new Set();
  for (const text of [company, location, disambiguator]) {
    for (const t of slugTokenSet(slugify(text))) out.add(t);
  }
  return out;
}

/**
 * Decide whether `slug` already encodes the supplied locale `title` + the
 * shared company/location context.
 *
 * Compares **only the title-derived tokens** of both slugs by subtracting
 * company + location + disambiguator tokens first. Pre-fix this used a
 * whole-slug Jaccard against `buildSlug(title, company, location)`, which
 * false-positived on multi-locale jobs whose company+location share a long
 * fingerprint (e.g. `ferrovia-retica-rhb-chur` contributes 4 shared tokens
 * before the title is even considered). That false positive blocked
 * regeneration of translated EN slugs, leaving `slugByLocale.en` stuck on
 * the source-language form and the translated URL 404-ing.
 *
 * Returns true when the title-only token overlap is ≥ 0.5 (same Jaccard
 * threshold as before — the change is *what* gets compared, not the bar).
 */
export function slugMatchesTitle(slug, title, company, location, disambiguator = '') {
  if (!slug || !title) return false;
  const noise = noiseTokens(company, location, disambiguator);

  const slugTokens = new Set();
  for (const t of slugTokenSet(slug)) if (!noise.has(t)) slugTokens.add(t);

  const titleTokens = new Set();
  for (const t of slugTokenSet(slugify(title))) if (!noise.has(t)) titleTokens.add(t);

  if (slugTokens.size === 0 && titleTokens.size === 0) return true;
  if (slugTokens.size === 0 || titleTokens.size === 0) return false;

  let intersection = 0;
  for (const t of slugTokens) if (titleTokens.has(t)) intersection++;
  const union = slugTokens.size + titleTokens.size - intersection;
  return intersection / union >= 0.5;
}

/**
 * Il locale SORGENTE deve rientrare nella rigenerazione?
 *
 * Normalmente no: lo slug source-lang lo conia il parser al crawl
 * (`slugify(title + <chiave crawler> + …)`) e rigenerarlo su ogni passaggio
 * sposterebbe URL indicizzati a ogni micro-drift del titolo. L'eccezione e' la
 * RIETICHETTATURA del datore: quando l'etichetta dichiarata dal parser cambia,
 * lo slug sorgente resta congelato sul brand vecchio per sempre — nessun altro
 * passaggio lo tocca — e la route indicizzata continua a nominare un datore che
 * il contenuto non dichiara piu' (#7722: 15/15 righe di `med-ipersonal` con
 * `-med-ipersonal-ch` nello slug `de` e `company: iPersonal AG` nel record).
 *
 * Il discriminante NON e' un'euristica sul «token di brand»: il tail dello slug
 * sorgente e' la CHIAVE del crawler per convenzione su tutti i parser dedicati,
 * quindi «tail != company» e' la normalita' (`accor` → `Ibis Budget`) e usarlo
 * come trigger sposterebbe migliaia di URL sani. Il trigger e' l'appartenenza
 * alla lista chiusa `BRAND_RELABELLED_CRAWLER_KEYS`
 * (`scripts/lib/crawler-brand-relabel.mjs`), cioe' le sole chiavi mono-datore la
 * cui etichetta e' stata corretta: li' — e solo li' — lo slug sorgente si
 * riallinea alla forma canonica `title + company + location` come ogni altro
 * locale. Idempotente: una volta canonico, `canonical === currentSlug` e il
 * passaggio successivo non tocca piu' nulla.
 *
 * @param {object} params
 * @param {boolean} params.isBrandRelabelledKey chiave crawler nella lista chiusa
 * @param {string} params.currentSlug slug sorgente attuale
 * @param {string} params.title titolo nel locale sorgente
 * @param {string} params.company etichetta RICONCILIATA (non quella su disco)
 * @param {string} [params.location]
 * @param {string} [params.disambiguator]
 * @returns {boolean}
 */
export function sourceLocaleNeedsBrandRefresh({
  isBrandRelabelledKey,
  currentSlug,
  title,
  company,
  location = '',
  disambiguator = '',
}) {
  if (!isBrandRelabelledKey) return false;
  if (!String(title || '').trim() || !String(company || '').trim()) return false;
  const canonical = buildSlug(title, company, location, disambiguator);
  if (!canonical) return false;
  return canonical !== String(currentSlug || '').trim();
}
