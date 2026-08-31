#!/usr/bin/env node
/**
 * Auto-generate company entries for the companies directory page
 * from crawler infrastructure.
 *
 * Sources, in the order the NAME is resolved:
 *   1. Runner/parser files — `COMPANY_NAME`/`companyLabel`, cioe' il datore che
 *      il crawler DICHIARA di seguire (`lib/crawler-company-identity.mjs`)
 *   2. Job slices (data/jobs/by-crawler/{slug}.json) — solo a maggioranza
 *      assoluta, perche' uno slice puo' coprire piu' marchi (`coop-ticino`)
 *   3. lo slug, imbellito
 * COMPANY_HQ (crawler-location-config.mjs) resta la fonte di citta'/cantone.
 *
 * Output: data/crawler-companies-auto.json
 *
 * Run after scaffolding new crawlers or during assemble step.
 * The TicinoCompanies component imports this file and merges it with
 * hardcoded + manual entries, so deduplication handles overlaps.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { listSliceFileNames } from './lib/crawler-slice-files.mjs';
import {
  extractDeclaredIdentity,
  isNonEmployerSlug,
  sliceDomainForName,
  summariseSliceCompanies,
} from './lib/crawler-company-identity.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SLICES_DIR = path.resolve(ROOT, 'data', 'jobs', 'by-crawler');
const RUNNERS_DIR = path.resolve(ROOT, 'scripts');
const PARSERS_DIR = path.resolve(ROOT, 'scripts', 'lib');
const OUTPUT = path.resolve(ROOT, 'data', 'crawler-companies-auto.json');

// ─── Import COMPANY_HQ ─────────────────────────────────────────────────────
const { COMPANY_HQ } = await import('./lib/crawler-location-config.mjs');
const { registrableDomain } = await import('./lib/prospector/registrable.mjs');

// ─── Discover all crawler slugs from runner files ───────────────────────────
function discoverCrawlerSlugs() {
  const files = fs.readdirSync(RUNNERS_DIR).filter(
    (f) => f.startsWith('update-') && f.endsWith('-jobs.mjs')
  );
  return files.map((f) => f.replace(/^update-/, '').replace(/-jobs\.mjs$/, ''));
}

// ─── Locate the slice a runner actually writes ──────────────────────────────
/**
 * The runner FILENAME gives `update-<slug>-jobs.mjs` -> `<slug>`, but the slice
 * is named after the runner's INTERNAL company key, and the two diverge freely:
 * `update-eoc-jobs.mjs` declares `EOC_KEY = 'eoc-ente-ospedaliero-cantonale'`
 * and writes `eoc-ente-ospedaliero-cantonale.json`. Measured on this repo, 87
 * of the runners have no same-named slice.
 *
 * Looking for `<slug>.json` alone therefore misses silently and falls back to
 * regex-scraping the runner source, which finds a name but rarely a domain —
 * that is how the `eoc` entry ended up with no `website` at all, and how the
 * prospector lost its only chance to recognise EOC by domain.
 *
 * Resolution order, deterministic and never a guess:
 *   1. `<slug>.json`
 *   2. exactly one slice named `<slug>-*.json`
 *   3. otherwise nothing — ambiguity (`migros` -> `migros-hq`, `migros-ticino`)
 *      falls back to the source scrape rather than picking a sibling at random.
 *
 * @param {string} slug
 * @returns {string|null} absolute path to the slice, or null
 */
function resolveSlicePath(slug) {
  const exact = path.join(SLICES_DIR, `${slug}.json`);
  if (fs.existsSync(exact)) return exact;

  const matches = listSliceFileNames(SLICES_DIR).filter(
    (f) => f.startsWith(`${slug}-`),
  );
  return matches.length === 1 ? path.join(SLICES_DIR, matches[0]) : null;
}

// ─── Read company metadata from job slice ───────────────────────────────────
/**
 * Lo slice parla per maggioranza assoluta, mai per primo record.
 *
 * `jobs[0]` e' l'ordine di crawl: su uno slice di gruppo — `coop-ticino` copre
 * Fust/Jumbo/Interdiscount per costruzione — il primo job appartiene a un
 * marchio qualsiasi, e quel nome finiva nella directory pubblica come nome
 * dell'azienda. La regola e la sua astensione stanno in
 * `lib/crawler-company-identity.mjs`, pure e testabili senza i 444 MB di slice.
 */
function readFromSlice(slug) {
  const slicePath = resolveSlicePath(slug);
  if (!slicePath) return null;
  try {
    const data = JSON.parse(fs.readFileSync(slicePath, 'utf8'));
    const jobs = Array.isArray(data) ? data : data?.jobs || [];
    if (!jobs.length) return null;
    // Il sommario intero, non solo il nome: il dominio va scelto DOPO, per il
    // nome che ha vinto (vedi `sliceDomainForName`).
    return summariseSliceCompanies(jobs);
  } catch {
    return null;
  }
}

// ─── Reject a VENDOR domain posing as the employer's own ────────────────────
/** Registrable domains of every hosted-ATS platform the prospector knows. */
const VENDOR_DOMAINS = (() => {
  const out = new Set();
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'prospector', 'platforms.json'), 'utf8'));
  } catch {
    // Registry absent (sparse checkout): the guard lets everything through
    // rather than pretending every domain is fine.
    console.warn('⚠️  platforms.json non leggibile — guardia vendor-domain inattiva.');
    return out;
  }
  // `platforms` is an OBJECT keyed by domain, not an array. Iterating it as an
  // array throws, and swallowing that in a catch left the guard silently empty
  // — the failure mode this whole file exists to stop.
  const platforms = raw?.platforms;
  const list = Array.isArray(platforms) ? platforms : Object.values(platforms || {});
  for (const p of list) {
    const d = registrableDomain(typeof p === 'string' ? p : p?.domain || '');
    if (d) out.add(d);
  }
  if (!out.size) console.warn('⚠️  nessun dominio vendor indicizzato da platforms.json — guardia inattiva.');
  return out;
})();

/**
 * `apply.workable.com` is where GUESS publishes, not who GUESS is. Recording it
 * as the company domain puts `workable.com` into the prospector's coverage index,
 * where — folded to the registrable domain — it marks every OTHER Workable
 * tenant as an employer we already crawl, and discovery dies silently. Three
 * entries were already in this state (`boggi`, `guess`, `vir-biotechnology`)
 * before the slice lookup above started finding many more domains.
 *
 * @param {string} domain
 * @returns {boolean}
 */
function isVendorDomain(domain) {
  const d = registrableDomain(domain || '');
  return Boolean(d) && VENDOR_DOMAINS.has(d);
}

// ─── Extract company metadata from runner or parser file ────────────────────
// La lettura del literal dichiarato vive in `lib/crawler-company-identity.mjs`:
// la usa anche il test che verifica l'invariante sul dato pubblicato, e una
// seconda copia dei prefissi qui avrebbe iniziato a derivare il giorno dopo.
const extractFromFile = extractDeclaredIdentity;

// ─── Prettify a slug into a human-readable name ─────────────────────────────
function slugToName(slug) {
  return slug
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ─── Main ───────────────────────────────────────────────────────────────────
const slugs = discoverCrawlerSlugs();
const companies = [];
const seen = new Set();
const skippedNonEmployer = [];

for (const slug of slugs) {
  // Skip aliases in COMPANY_HQ (they point to the same company)
  if (seen.has(slug)) continue;
  seen.add(slug);

  // Frammento di URL o id di tenant ATS: e' un crawler valido, non un'azienda.
  // Resta fuori dalla DIRECTORY, non dal crawling.
  if (isNonEmployerSlug(slug)) {
    skippedNonEmployer.push(slug);
    continue;
  }

  // Location from COMPANY_HQ
  const hq = COMPANY_HQ[slug];

  // Company metadata: il nome DICHIARATO batte lo slice (vedi sotto), ma
  // entrambi vanno letti — lo slice porta il dominio anche quando non porta il nome.
  const sliceData = readFromSlice(slug);
  const runnerData = extractFromFile(path.join(RUNNERS_DIR, `update-${slug}-jobs.mjs`));
  const parserData = extractFromFile(path.join(PARSERS_DIR, `${slug}-job-parser.mjs`));

  // Il nome DICHIARATO dal crawler viene prima dello slice.
  //
  // `COMPANY_NAME`/`companyLabel` e' l'affermazione del runner su quale datore
  // sta seguendo; lo slice e' cio' che ha trovato, e su un crawler di gruppo le
  // due cose divergono per costruzione. Con la precedenza vecchia (slice prima)
  // `fust` prendeva il nome dal marchio piu' prolifico dello slice e diventava
  // «Coop Genossenschaft» pur avendo `FUST_COMPANY_NAME = 'Fust'` due righe
  // sopra. Lo slice resta la fonte per i crawler che un nome dichiarato non ce
  // l'hanno (misurati 5 su 609), e li' parla solo a maggioranza assoluta.
  const companyName =
    runnerData?.company ||
    parserData?.company ||
    sliceData?.name ||
    slugToName(slug);

  // Il dominio segue il nome scelto, non la maggioranza dello slice: su `fust`
  // il nome finale e' quello dichiarato («Fust») mentre lo slice e' a
  // maggioranza «Coop Genossenschaft», e la coppia sbagliata darebbe la scheda
  // Fust con il dominio di Coop.
  const companyDomain =
    [sliceDomainForName(sliceData, companyName), runnerData?.companyDomain, parserData?.companyDomain]
      .find((d) => d && !isVendorDomain(d)) || '';

  const careersUrl = runnerData?.careersUrl || parserData?.careersUrl || '';
  const website = companyDomain
    ? `https://www.${companyDomain.replace(/^www\./, '')}`
    : '';

  const entry = {
    name: companyName,
    key: slug,
    website: website || undefined,
    careersUrl: careersUrl || undefined,
    city: hq?.city || 'Lugano',
    canton: hq?.canton || 'TI',
    country: 'CH',
    hasDedicatedCrawler: true,
    autoGenerated: true,
  };

  // Clean undefined values
  Object.keys(entry).forEach((k) => {
    if (entry[k] === undefined) delete entry[k];
  });

  companies.push(entry);
}

// Sort alphabetically by name
companies.sort((a, b) => a.name.localeCompare(b.name, 'it'));

// Scrittura ATOMICA, dal modulo condiviso — non una tmp+rename riscritta qui.
//
// `fs.writeFileSync` diretto sulla destinazione non e' una write sola: sono
// ~600 voci, ~150 KB, e un'interruzione a meta' — ENOSPC, kill del runner,
// timeout del job — lascia sul disco un JSON troncato al posto di quello buono.
// Questo file non e' un log: `TicinoCompanies` lo importa, quindi un
// troncamento non produce un dato sbagliato ma una BUILD ROTTA.
//
// Finche' il generatore girava solo a mano, il danno restava sul disco di chi
// lo lanciava. Da quando lo invoca `prospect-promote.mjs` (vedi li'), quel file
// a meta' finirebbe dentro il commit della PR di promozione, spedito da una
// pipeline che nessuno guarda — ed e' l'unico motivo per cui il `catch` di
// quello script puo' permettersi di non interrompere la promozione.
//
// `writeJsonAtomic` e' gia' la sorgente unica per i ~95 script di dati crawler
// (issue #2805) e produce byte identici a prima (`JSON.stringify(v, null, 2)`
// + newline). Riscrivere qui la stessa tmp+rename sarebbe la copia numero 96,
// cioe' il difetto che quel modulo esiste per rendere impossibile.
writeJsonAtomic(OUTPUT, companies);

console.log(`✅ Generated ${companies.length} crawler company entries → ${path.relative(ROOT, OUTPUT)}`);

if (skippedNonEmployer.length) {
  console.log(
    `ℹ️  ${skippedNonEmployer.length} slug non-datore esclusi dalla directory: ${skippedNonEmployer.join(', ')}`,
  );
}
