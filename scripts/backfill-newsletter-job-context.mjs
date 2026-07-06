#!/usr/bin/env node
/**
 * Backfill missing job context fields on newsletter_subscribers/{email}.
 *
 * Default is dry-run. Use --apply to write only missing fields.
 *
 * Usage:
 *   node scripts/backfill-newsletter-job-context.mjs
 *   node scripts/backfill-newsletter-job-context.mjs --target-email soniacasara22@gmail.com
 *   node scripts/backfill-newsletter-job-context.mjs --limit 100 --apply
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JOB_BOARD_SEGMENT_RX } from './lib/jobBoardSections.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const JOB_CONTEXT_FIELDS = [
  'job_slug',
  'job_company',
  'job_location',
  'job_category',
  'job_search_query',
  'location_interest',
  'sector_interest',
];

const NON_JOB_SLUG_PREFIXES = [
  'azienda-',
  'company-',
  'unternehmen-',
  'entreprise-',
  'localita-',
  'location-',
  'standort-',
  'localite-',
  'ricerca-',
  'search-',
  'suche-',
  'recherche-',
];

const CATEGORY_HINTS = [
  ['Sanita / Ospedali', /\b(infermier|pflege|medic|sanitar|ospedal|clinic|arzt|soins|infirm)/i],
  ['Trasporti / Logistica', /\b(tren|zug|transport|logistic|fahrer|autista|rail|ferrovia|preparazione-treni)/i],
  ['Finanza / Banca', /\b(bank|banca|finance|financial|contabil|account|treuhand|audit)/i],
  ['IT / Tecnologia', /\b(software|developer|informatica|informatico|data|cloud|system|cyber|devops)\b/i],
  ['Vendita / Retail', /\b(vendit|sales|retail|shop|store|commercio|verkauf)/i],
  ['Amministrazione', /\b(admin|assistente|segreter|back-office|office|hr|risorse-umane)/i],
  ['Produzione / Tecnica', /\b(tecnic|produzione|polymechan|automat|elettric|engineer|meccan)/i],
  ['Ristorazione / Hotel', /\b(hotel|restaurant|cucina|chef|service|bar|reception)/i],
];

function readJsonSafe(relativePath, fallback) {
  const p = path.resolve(ROOT, relativePath);
  if (!fs.existsSync(p)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function titleFromSlug(slug) {
  return String(slug || '')
    .replace(/-[a-z0-9]{6,}$/i, '')
    .replace(/-\d{2,3}$/i, '')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .slice(0, 120);
}

export function extractSlugFromSourcePage(sourcePage) {
  if (!sourcePage) return '';
  let pathname = String(sourcePage || '').trim();
  try {
    pathname = new URL(pathname, 'https://frontaliereticino.ch').pathname;
  } catch {
    pathname = pathname.split('?')[0].split('#')[0];
  }
  const parts = pathname.split('/').map((p) => decodeURIComponent(p).trim()).filter(Boolean);
  if (parts.length === 0) return '';
  if (!parts.some((part) => JOB_BOARD_SEGMENT_RX.test(part))) return '';
  const last = parts[parts.length - 1];
  if (!last || JOB_BOARD_SEGMENT_RX.test(last)) return '';
  const slug = slugify(last);
  if (NON_JOB_SLUG_PREFIXES.some((prefix) => slug.startsWith(prefix))) return '';
  return slug;
}

function addSlug(index, slug, record) {
  const key = slugify(slug);
  if (key && !index.has(key)) index.set(key, record);
}

function buildKnownCompanyIndex(records) {
  const companies = [];
  const seen = new Set();
  for (const record of records) {
    const company = record.company || '';
    const keys = [
      record.companyKey,
      slugify(company),
      slugify(company.replace(/\([^)]*\)/g, '')),
    ].filter(Boolean);
    for (const key of keys) {
      if (key.length < 3 || seen.has(key)) continue;
      seen.add(key);
      companies.push({ key, company });
    }
  }
  return companies.sort((a, b) => b.key.length - a.key.length);
}

function buildKnownLocations(records) {
  const locations = [];
  const seen = new Set();
  for (const record of records) {
    for (const raw of [record.location, record.addressLocality, record.canton]) {
      const value = String(raw || '').trim();
      const key = slugify(value);
      if (key.length < 3 || seen.has(key) || /^\d+$/.test(key)) continue;
      seen.add(key);
      locations.push({ key, value });
    }
  }
  return locations.sort((a, b) => b.key.length - a.key.length);
}

function inferCategoryFromText(text) {
  for (const [category, re] of CATEGORY_HINTS) {
    if (re.test(text)) return category;
  }
  return '';
}

function humanizeSlugFragment(fragment) {
  return String(fragment || '')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function contextFromJob(job, source, slugOverride = '') {
  const title = job.titleByLocale?.it || job.title || job.topQuery || '';
  const category = job.category || job.sector || inferCategoryFromText(`${title} ${job.slug || ''}`);
  return {
    job_slug: slugOverride || job.slug || '',
    job_company: job.company || '',
    job_location: job.location || job.addressLocality || '',
    job_category: category || '',
    job_search_query: title || titleFromSlug(slugOverride || job.slug),
    location_interest: job.location || job.addressLocality || '',
    sector_interest: category || '',
    _source: source,
  };
}

function contextFromSlugHeuristic(slug, companyIndex, locationIndex) {
  if (!slug) return null;
  const companyHit = companyIndex.find((entry) => slug.includes(entry.key));
  const locationHit = locationIndex.find((entry) => slug.endsWith(`-${entry.key}`) || slug.includes(`-${entry.key}-`));
  let inferredLocation = locationHit?.value || '';
  if (!inferredLocation && companyHit) {
    const companyPos = slug.lastIndexOf(companyHit.key);
    const suffix = companyPos >= 0 ? slug.slice(companyPos + companyHit.key.length).replace(/^-+/, '') : '';
    const suffixTokens = suffix.split('-').filter(Boolean);
    const looksTruncatedLocation = locationIndex.some((entry) => entry.key.startsWith(suffix) && entry.key !== suffix);
    if (suffix.length >= 5 && suffix.length <= 40 && suffixTokens.length <= 3 && !/\d/.test(suffix) && !looksTruncatedLocation) {
      inferredLocation = humanizeSlugFragment(suffix);
    }
  }
  const searchQuery = titleFromSlug(slug);
  const category = inferCategoryFromText(slug);
  if (!companyHit && !locationHit && !searchQuery) return null;
  return {
    job_slug: slug,
    job_company: companyHit?.company || '',
    job_location: inferredLocation,
    job_category: category,
    job_search_query: searchQuery,
    location_interest: inferredLocation,
    sector_interest: category,
    _source: 'source_page_slug_heuristic',
  };
}

function mergeContextFallback(primary, fallback) {
  if (!primary || !fallback) return primary || fallback;
  const merged = { ...primary };
  let usedFallback = false;
  for (const field of JOB_CONTEXT_FIELDS) {
    if (!merged[field] && fallback[field]) {
      merged[field] = fallback[field];
      usedFallback = true;
    }
  }
  if (usedFallback && primary._source !== fallback._source) merged._source = `${primary._source}+${fallback._source}`;
  return merged;
}

function buildJobContextResolver() {
  const activeJobs = readJsonSafe('data/jobs.json', []);
  const orphanJobs = readJsonSafe('data/orphan-enriched-data.json', []);
  const slugRegistry = readJsonSafe('data/slug-registry.json', {});
  const preCathedralRegistry = readJsonSafe('data/slug-registry.pre-cathedral.snapshot.json', {});

  const activeBySlug = new Map();
  const orphanBySlug = new Map();
  for (const job of activeJobs) {
    addSlug(activeBySlug, job.slug, job);
    for (const slug of Object.values(job.slugByLocale || {})) addSlug(activeBySlug, slug, job);
  }
  for (const job of orphanJobs) {
    addSlug(orphanBySlug, job.slug, job);
    addSlug(orphanBySlug, extractSlugFromSourcePage(job.path), job);
    for (const slug of Object.values(job.slugByLocale || {})) addSlug(orphanBySlug, slug, job);
  }

  const aliasToCanonical = new Map();
  for (const registry of [slugRegistry, preCathedralRegistry]) {
    for (const entry of Object.values(registry || {})) {
      const canonical = slugify(entry?.canonicalSlug);
      if (!canonical) continue;
      addSlug(aliasToCanonical, canonical, canonical);
      for (const slug of Object.values(entry?.slugByLocale || {})) addSlug(aliasToCanonical, slug, canonical);
    }
  }

  const allKnownRecords = [...activeJobs, ...orphanJobs];
  const companyIndex = buildKnownCompanyIndex(allKnownRecords);
  const locationIndex = buildKnownLocations(allKnownRecords);

  function resolve(rawSlug) {
    const slug = slugify(rawSlug);
    if (!slug) return null;
    const heuristic = () => contextFromSlugHeuristic(slug, companyIndex, locationIndex);

    const active = activeBySlug.get(slug);
    if (active) return mergeContextFallback(contextFromJob(active, 'active_job_exact', slug), heuristic());

    const canonical = aliasToCanonical.get(slug);
    if (canonical && activeBySlug.has(canonical)) {
      return mergeContextFallback(contextFromJob(activeBySlug.get(canonical), 'slug_registry_active', slug), heuristic());
    }

    const orphan = orphanBySlug.get(slug);
    if (orphan) return mergeContextFallback(contextFromJob(orphan, 'orphan_exact', slug), heuristic());

    const prefixOrphan = [...orphanBySlug.entries()]
      .find(([known]) => (slug.startsWith(known) || known.startsWith(slug)) && Math.min(slug.length, known.length) >= 24);
    if (prefixOrphan) return mergeContextFallback(contextFromJob(prefixOrphan[1], 'orphan_prefix', slug), heuristic());

    return heuristic();
  }

  return { resolve, counts: { activeJobs: activeJobs.length, orphanJobs: orphanJobs.length, registryEntries: Object.keys(slugRegistry || {}).length } };
}

function missing(value) {
  return value === undefined || value === null || value === '';
}

export function buildSubscriberJobContextPatch(subscriber, resolver) {
  const slug = slugify(subscriber?.job_slug) || extractSlugFromSourcePage(subscriber?.source_page);
  if (!slug) return null;
  const context = resolver.resolve(slug);
  if (!context) return null;

  const patch = {};
  for (const field of JOB_CONTEXT_FIELDS) {
    if (missing(subscriber?.[field]) && context[field]) patch[field] = context[field];
  }
  if (Object.keys(patch).length === 0) return null;
  patch.job_context_backfill_source = context._source;
  patch.job_context_backfill_slug = slug;
  return patch;
}

function parseArgs(argv) {
  const args = { apply: false, limit: 0, targetEmail: '', sample: 10, showEmails: false };
  for (const raw of argv) {
    if (raw === '--apply') args.apply = true;
    else if (raw === '--show-emails') args.showEmails = true;
    else if (raw.startsWith('--limit=')) args.limit = Number(raw.slice('--limit='.length)) || 0;
    else if (raw === '--limit') args.limit = Number(argv[argv.indexOf(raw) + 1]) || 0;
    else if (raw.startsWith('--target-email=')) args.targetEmail = raw.slice('--target-email='.length).toLowerCase().trim();
    else if (raw === '--target-email') args.targetEmail = String(argv[argv.indexOf(raw) + 1] || '').toLowerCase().trim();
    else if (raw.startsWith('--sample=')) {
      const value = Number(raw.slice('--sample='.length));
      if (Number.isFinite(value) && value >= 0) args.sample = value;
    }
  }
  return args;
}

function maskEmail(email) {
  const [local, domain] = String(email || '').split('@');
  if (!domain) return String(email || '');
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${'*'.repeat(Math.max(3, local.length - visible.length))}@${domain}`;
}

async function getFirestoreAdmin() {
  const admin = await import('firebase-admin');
  if (!admin.default.apps?.length) {
    admin.default.initializeApp({
      credential: admin.default.credential.applicationDefault(),
      projectId: process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'frontaliere-ticino',
    });
  }
  return {
    db: admin.default.firestore(),
    FieldValue: admin.default.firestore.FieldValue,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(args.apply ? 'APPLY mode: will write missing newsletter job context' : 'DRY RUN: no writes (pass --apply to commit)');

  const resolver = buildJobContextResolver();
  console.log(`Loaded context data: ${resolver.counts.activeJobs} active jobs, ${resolver.counts.orphanJobs} orphan jobs, ${resolver.counts.registryEntries} registry entries`);

  const { db, FieldValue } = await getFirestoreAdmin();
  let docs = [];
  if (args.targetEmail) {
    const doc = await db.collection('newsletter_subscribers').doc(args.targetEmail).get();
    docs = doc.exists ? [doc] : [];
  } else {
    const snap = await db.collection('newsletter_subscribers').get();
    docs = snap.docs.filter((doc) => doc.id !== '_meta_');
  }

  let scanned = 0;
  let candidates = 0;
  let patchable = 0;
  let written = 0;
  const bySource = new Map();
  const previews = [];
  let batch = args.apply ? db.batch() : null;
  let batchCount = 0;

  for (const doc of docs) {
    if (args.limit && scanned >= args.limit) break;
    scanned++;
    const data = doc.data();
    const hasMissingJobField = JOB_CONTEXT_FIELDS.some((field) => missing(data?.[field]));
    if (!hasMissingJobField) continue;
    candidates++;

    const patch = buildSubscriberJobContextPatch(data, resolver);
    if (!patch) continue;
    patchable++;
    const source = patch.job_context_backfill_source || 'unknown';
    bySource.set(source, (bySource.get(source) || 0) + 1);

    const writePatch = {
      ...patch,
      job_context_backfilled_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
    };

    if (previews.length < args.sample) {
      previews.push({ id: doc.id, patch });
    }

    if (args.apply && batch) {
      batch.set(doc.ref, writePatch, { merge: true });
      batchCount++;
      if (batchCount >= 400) {
        await batch.commit();
        written += batchCount;
        batch = db.batch();
        batchCount = 0;
      }
    }
  }

  if (args.apply && batch && batchCount > 0) {
    await batch.commit();
    written += batchCount;
  }

  console.log('');
  console.log(`Scanned: ${scanned}`);
  console.log(`Missing some job context: ${candidates}`);
  console.log(`${args.apply ? 'Patched' : 'Patchable'}: ${args.apply ? written : patchable}`);
  if (bySource.size) {
    console.log('By source:');
    for (const [source, count] of [...bySource.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${source}: ${count}`);
    }
  }
  if (previews.length) {
    console.log('');
    console.log('Preview:');
    for (const item of previews) {
      console.log(`  ${args.showEmails ? item.id : maskEmail(item.id)}: ${JSON.stringify(item.patch)}`);
    }
  }
  if (!args.apply) console.log('\nRe-run with --apply to commit.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
