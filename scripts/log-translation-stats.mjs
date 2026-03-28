#!/usr/bin/env node
/**
 * Append a translation stats snapshot to data/translation-stats-history.json.
 * Called by translate-pending.yml after each run to build a monitoring history.
 *
 * Usage: node scripts/log-translation-stats.mjs [label]
 */

import fs from 'node:fs';
import path from 'node:path';

const CRAWLERS_DIR = 'data/jobs/by-crawler';
const STATS_FILE = 'data/translation-stats-history.json';
const LOCALES = ['it', 'en', 'de', 'fr'];
const MIN_DESC = 120;
const MIN_TITLE = 3;

const label = process.argv[2] || 'translate-pending';

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

function isIncomplete(job) {
  const tbl = job.titleByLocale || {};
  const dbl = job.descriptionByLocale || {};
  const sourceTitle = (job.title || '').trim().toLowerCase();
  const sourceDesc = (job.description || '').trim().toLowerCase();
  const sourceLang = job.sourceLang || 'it';
  for (const locale of LOCALES) {
    const title = (tbl[locale] || '').trim();
    const desc = (dbl[locale] || '').trim();
    if (title.length < MIN_TITLE || desc.length < MIN_DESC) return true;
    if (title.toLowerCase() === sourceTitle && locale !== sourceLang) {
      const othersDiffer = LOCALES.some(
        l => l !== locale && l !== sourceLang &&
             (tbl[l] || '').trim().toLowerCase() !== sourceTitle
      );
      if (!othersDiffer) return true;
    }
    if (desc.length > 0 && desc.toLowerCase() === sourceDesc && locale !== sourceLang) return true;
  }
  return false;
}

const files = fs.existsSync(CRAWLERS_DIR)
  ? fs.readdirSync(CRAWLERS_DIR).filter(f => f.endsWith('.json'))
  : [];

let total = 0;
let needsRetranslation = 0;
let incomplete = 0;
const byLocale = { it: 0, en: 0, de: 0, fr: 0 };
const topCompanies = [];

for (const file of files) {
  const content = readJson(path.join(CRAWLERS_DIR, file));
  if (!content) continue;
  const jobs = Array.isArray(content) ? content : (content.jobs || []);
  let companyPending = 0;

  for (const job of jobs) {
    total++;
    const flagged = !!job.needsRetranslation;
    const inc = isIncomplete(job);
    if (flagged) needsRetranslation++;
    if (inc) {
      incomplete++;
      companyPending++;
      // Count which locales are missing/untranslated
      for (const loc of LOCALES) {
        const title = (job.titleByLocale?.[loc] || '').trim();
        const desc = (job.descriptionByLocale?.[loc] || '').trim();
        const sourceDesc = (job.description || '').trim().toLowerCase();
        const sourceLang = job.sourceLang || 'it';
        if (title.length < MIN_TITLE || desc.length < MIN_DESC ||
            (desc.toLowerCase() === sourceDesc && loc !== sourceLang)) {
          byLocale[loc]++;
        }
      }
    }
  }

  if (companyPending > 0) {
    const content2 = readJson(path.join(CRAWLERS_DIR, file));
    const company = (Array.isArray(content2) ? content2[0] : content2?.jobs?.[0])?.company || file.replace('.json','');
    topCompanies.push({ company, pending: companyPending });
  }
}

topCompanies.sort((a, b) => b.pending - a.pending);

const entry = {
  timestamp: new Date().toISOString(),
  label,
  total,
  needsRetranslation,
  incomplete,
  complete: total - incomplete,
  missingByLocale: byLocale,
  topPending: topCompanies.slice(0, 10),
};

console.log(`\n📊 Translation stats [${label}]`);
console.log(`   Total jobs:          ${total}`);
console.log(`   Complete:            ${entry.complete} (${Math.round(entry.complete/total*100)}%)`);
console.log(`   Incomplete:          ${incomplete}`);
console.log(`     needsRetranslation:  ${needsRetranslation}`);
console.log(`     Missing by locale:   IT=${byLocale.it} EN=${byLocale.en} DE=${byLocale.de} FR=${byLocale.fr}`);
if (topCompanies.length > 0) {
  console.log(`   Top pending companies:`);
  for (const { company, pending } of topCompanies.slice(0, 5)) {
    console.log(`     ${String(pending).padStart(4)} — ${company}`);
  }
}

const history = readJson(STATS_FILE) || [];
history.push(entry);
// Keep last 200 entries
if (history.length > 200) history.splice(0, history.length - 200);
fs.writeFileSync(STATS_FILE, JSON.stringify(history, null, 2) + '\n', 'utf-8');
console.log(`   Saved to ${STATS_FILE} (${history.length} entries total)\n`);
