#!/usr/bin/env node
/**
 * Run cleanLisJobs() standalone to fix existing data without re-crawling.
 * Usage: node scripts/clean-lis-data.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');

// ── Import the actual functions from update-lis-jobs.mjs ──
// We can't import them directly since main() auto-runs, so we inline the essentials.

const LIS_KEY = 'lis-lugano-istituti-sociali';
const LOCALES = ['it', 'en', 'de', 'fr'];
const LIS_COMPANY_NAME = 'LIS – Lugano Istituti Sociali';

function normalizeKey(value = '') {
  return String(value || '').trim().toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function isLisJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  const host = (() => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } })();
  const company = String(job?.company || '').toLowerCase();
  return key === LIS_KEY || key.includes('lugano-istituti-sociali') || key.includes('lis-lugano')
    || host.includes('lugano-lis.ch') || host.includes('arca24.careers')
    || (company.includes('lis') && company.includes('istituti sociali'))
    || company.includes('lugano istituti sociali');
}

function extractCleanTitle(dirtyTitle) {
  let t = String(dirtyTitle || '').trim();
  t = t.replace(/^LIS\s*[–-]\s*Lugano\s+Istituti\s+Sociali\s*/i, '');
  t = t.replace(/\s+(Invia|Send)\s*$/i, '');
  return t.trim().length >= 3 ? t.trim() : dirtyTitle;
}

function extractLocation(desc, jobUrl) {
  const m1 = (desc || '').match(/(Luogo di lavoro|Work location):\s*(Svizzera|Switzerland)\s*,\s*Ticino\s*,\s*([A-ZÀ-Ú][a-zà-ú]+(?:\s+[A-ZÀ-Ú][a-zà-ú]+)*?)(?=\s+Via\b|\s+\d|\s*,|\s*$)/i);
  if (m1) return m1[3].trim();
  const m2 = (desc || '').match(/##\s*(Svizzera|Switzerland)\s*,\s*Ticino\s*,\s*([A-ZÀ-Ú][a-zà-ú]+(?:\s+[A-ZÀ-Ú][a-zà-ú]+)*?)(?=\s+Via\b|\s+\d|\s*,|\s*$)/i);
  if (m2) return m2[2].trim();
  try {
    const idParam = new URL(jobUrl).searchParams.get('id') || '';
    const parts = idParam.split('-');
    if (parts.length >= 2) {
      const city = parts[parts.length - 1];
      return city.charAt(0).toUpperCase() + city.slice(1);
    }
  } catch {}
  return 'Pregassona';
}

function cleanLisDescription(dirty) {
  if (!dirty || typeof dirty !== 'string') return '';
  // Idempotency: if already cleaned (starts with our metadata emoji), return as-is
  if (dirty.startsWith('📍 ')) return dirty;
  let desc = dirty;
  desc = desc.replace(/##\s*(Vedi dettagli|View details|See details)[\s\S]*$/i, '');
  const candidatiCut = desc.replace(/^[\s\S]*?\?\s*%\s*(Candidati|Apply)\s*/i, '');
  if (candidatiCut.length < desc.length * 0.9) {
    desc = candidatiCut;
  } else {
    const descAnCut = desc.replace(/^[\s\S]*?##\s*(Descrizione annuncio|Job description)\s*/i, '');
    if (descAnCut.length < desc.length * 0.9) {
      desc = descAnCut;
      desc = desc.replace(/^(Verifica la tua compatibilit[àa] con questo annuncio|Verify your compatibility with this job ad)[^.]*\s*/i, '');
    }
  }
  desc = desc.replace(/(Sei iscritto\/a a questo annuncio|You applied to this job)\s*/gi, '');
  desc = desc.replace(/(Stampa\s+Dillo a un amico\s+Segnalazione|Print\s+Tell a friend\s+Report)\s*/gi, '');
  desc = desc.replace(/(Verifica la tua compatibilit[àa] con questo annuncio|Verify your compatibility with this job ad)[^.]*\s*/gi, '');
  desc = desc.replace(/\?\s*%\s*(Candidati|Apply)\s*/gi, '');
  desc = desc.replace(/attivit[àa]\s+Stampa\b/gi, '');
  desc = desc.replace(/activities\s+Print\b/gi, '');
  desc = desc.replace(/(oppure\s+Condividi questo annuncio di lavoro|or\s+Share this job)\s*/gi, '');
  desc = desc.replace(/Powered by\s*/gi, '');
  desc = desc.replace(/\(function\s*\(d,\s*s,\s*id\)[\s\S]*?indeed-apply[\s\S]*?\)\s*;?\s*/gi, '');
  desc = desc.replace(/^#+\s+LIS\s*[–-]\s*Lugano\s+Istituti\s+Sociali[^\n]*/gm, '');
  desc = desc.replace(/&(sol|comma|ndash|NewLine|colo|times);/gi, (m, ent) => {
    const map = { sol: '/', comma: ',', ndash: '–', NewLine: '\n', colo: ':', times: '×' };
    return map[ent.toLowerCase()] || m;
  });
  const meta = [];
  const locM = dirty.match(/(Luogo di lavoro|Work location):\s*([^#]+?)(?=Sett(ore|or):|Ru?ole?:|Data\s|Expiry|$)/i);
  if (locM) meta.push(`📍 Luogo di lavoro: ${locM[2].replace(/\s+/g, ' ').trim()}`);
  const setM = dirty.match(/Sett(ore|or):\s*([^#]+?)(?=Ru?ole?:|Data\s|Luogo|Work loc|Expiry|$)/i);
  if (setM) meta.push(`🏢 Settore: ${setM[2].replace(/\s+/g, ' ').trim()}`);
  const ruoM = dirty.match(/Ru?ole?:\s*([^#]+?)(?=Data\s|Luogo|Work loc|Sett(ore|or):|Expiry|$)/i);
  if (ruoM) meta.push(`👤 Ruolo: ${ruoM[1].replace(/\s+/g, ' ').trim()}`);
  const scadM = dirty.match(/(Data di scadenza|Expiry date):\s*(\d[\d/]+)/i);
  if (scadM) meta.push(`📅 Scadenza: ${scadM[2].trim()}`);
  const parts = [];
  if (meta.length > 0) parts.push(meta.join('\n'));
  const body = desc.replace(/\n{3,}/g, '\n\n').trim();
  if (body.length >= 30) parts.push(body);
  return parts.join('\n\n') || dirty;
}

// ── Run cleaning ──
const allJobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
let cleaned = 0;

for (const job of allJobs) {
  if (!isLisJob(job)) continue;
  // Idempotency: skip if already cleaned
  const desc = String(job.description || '');
  if (desc.startsWith('📍 ') && job.company === LIS_COMPANY_NAME) continue;
  job.company = LIS_COMPANY_NAME;
  job.companyKey = LIS_KEY;
  job.companyDomain = 'lugano-lis.ch';
  const cleanTitle = extractCleanTitle(job.title);
  job.title = cleanTitle;
  const dirtyDesc = String(job.description || '');
  job.location = extractLocation(dirtyDesc, job.url);
  job.canton = 'TI';
  const cleanDesc = cleanLisDescription(dirtyDesc);
  if (cleanDesc.length >= 50) job.description = cleanDesc;
  const cleanSlug = normalizeKey(job.title);
  if (cleanSlug.length >= 3) job.slug = cleanSlug;
  if (!job.titleByLocale) job.titleByLocale = {};
  if (!job.slugByLocale) job.slugByLocale = {};
  if (!job.descriptionByLocale) job.descriptionByLocale = {};
  for (const locale of LOCALES) {
    job.titleByLocale[locale] = job.title;
    job.slugByLocale[locale] = job.slug;
    const localeDesc = String(job.descriptionByLocale[locale] || '');
    if (localeDesc.length < 50) {
      job.descriptionByLocale[locale] = job.description;
    } else {
      const cleanedLocale = cleanLisDescription(localeDesc);
      if (cleanedLocale.length >= 50) job.descriptionByLocale[locale] = cleanedLocale;
    }
  }
  cleaned++;
}

if (cleaned > 0) {
  fs.writeFileSync(DATA_JOBS, JSON.stringify(allJobs, null, 2) + '\n');
  console.log(`🧹 Cleaned ${cleaned} LIS jobs.`);
}

// Verify
const verifyJobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
const lisJobs = verifyJobs.filter(isLisJob);
console.log(`\n📊 Verification — ${lisJobs.length} LIS jobs after cleaning:`);
for (const j of lisJobs) {
  const descLen = (j.description || '').length;
  const locales = Object.keys(j.descriptionByLocale || {}).filter(k => (j.descriptionByLocale[k] || '').length >= 120);
  console.log(`  ✅ ${j.title} | ${j.location} | desc=${descLen} | locales=[${locales.join(',')}] | slug=${j.slug}`);
}
