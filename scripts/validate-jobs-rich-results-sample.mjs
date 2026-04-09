#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DIST = path.join(ROOT, 'dist');
const JOBS_PATH = path.join(ROOT, 'data', 'jobs.json');
const BASE_URL = 'https://frontaliereticino.ch';

const LOCALES = [
  { code: 'it', prefix: '', segment: 'cerca-lavoro-ticino' },
  { code: 'en', prefix: 'en', segment: 'find-jobs-ticino' },
  { code: 'de', prefix: 'de', segment: 'jobs-im-tessin' },
  { code: 'fr', prefix: 'fr', segment: 'trouver-emploi-tessin' },
];

const RAW_ARG = process.argv[2];
const SAMPLE_SIZE = RAW_ARG ? Number(RAW_ARG) : null;
const SCRIPT_RE = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
const LINK_RE = /<link\b[^>]*>/gi;

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function pickSample(jobs, size) {
  const sorted = [...jobs].sort((a, b) => {
    const ad = new Date(a.crawledAt || a.postedDate || 0).getTime();
    const bd = new Date(b.crawledAt || b.postedDate || 0).getTime();
    return bd - ad;
  });
  return sorted.slice(0, Math.max(1, Math.min(size, sorted.length)));
}

function resolveSlugForLocale(job, localeCode) {
  const localized = String(job?.slugByLocale?.[localeCode] || '').trim();
  return localized || String(job?.slug || '').trim();
}

function buildDistFile(localeCode, slug) {
  const locale = LOCALES.find((l) => l.code === localeCode);
  if (!locale) return null;
  const parts = [DIST];
  if (locale.prefix) parts.push(locale.prefix);
  parts.push(locale.segment, slug, 'index.html');
  return path.join(...parts);
}

function parseHtmlAttributes(tag = '') {
  const attrs = {};
  const attrRe = /([^\s=]+)\s*=\s*["']([^"']*)["']/g;
  let m;
  while ((m = attrRe.exec(tag)) !== null) {
    attrs[String(m[1] || '').toLowerCase()] = String(m[2] || '');
  }
  return attrs;
}

function extractAlternateHrefLangs(html = '') {
  const byLocale = {};
  let m;
  while ((m = LINK_RE.exec(html)) !== null) {
    const tag = m[0] || '';
    const attrs = parseHtmlAttributes(tag);
    if (String(attrs.rel || '').toLowerCase() !== 'alternate') continue;
    const hreflang = String(attrs.hreflang || '').toLowerCase().trim();
    const href = String(attrs.href || '').trim();
    if (!hreflang || !href) continue;
    byLocale[hreflang] = href;
  }
  return byLocale;
}

function hrefToDistFile(href = '') {
  if (typeof href !== 'string' || href.length === 0) return null;
  if (!href.startsWith(BASE_URL)) return null;
  const relative = href.slice(BASE_URL.length).replace(/^\/+/, '').replace(/\/+$/, '');
  if (!relative) return path.join(DIST, 'index.html');
  return path.join(DIST, ...relative.split('/'), 'index.html');
}

function extractJsonLdBlocks(html) {
  const out = [];
  let m;
  while ((m = SCRIPT_RE.exec(html)) !== null) {
    const raw = (m[1] || '').trim();
    if (!raw) continue;
    try {
      out.push(JSON.parse(raw));
    } catch {
      out.push({ __parseError: true, raw: raw.slice(0, 240) });
    }
  }
  return out;
}

function getJobPosting(ldBlocks) {
  for (const block of ldBlocks) {
    if (block?.__parseError) continue;
    if (block?.['@type'] === 'JobPosting') return block;
    if (Array.isArray(block?.['@graph'])) {
      const found = block['@graph'].find((x) => x?.['@type'] === 'JobPosting');
      if (found) return found;
    }
  }
  return null;
}

function isIsoDate(x) {
  if (typeof x !== 'string' || x.length < 10) return false;
  const d = new Date(x);
  return !Number.isNaN(d.getTime());
}

function hasValidBaseSalary(baseSalary) {
  if (!baseSalary || typeof baseSalary !== 'object') return false;
  if (!baseSalary.currency || String(baseSalary.currency).trim().length === 0) return false;
  const value = baseSalary.value;
  if (!value || typeof value !== 'object') return false;
  const min = Number(value.minValue);
  const max = value.maxValue !== undefined ? Number(value.maxValue) : null;
  if (!Number.isFinite(min) || min <= 0) return false;
  // FRO-maxValue: maxValue is now MANDATORY — GSC flags missing maxValue as quality issue.
  if (max === null) return false;
  if (!Number.isFinite(max) || max < min) return false;
  if (!value.unitText || String(value.unitText).trim().length === 0) return false;
  return true;
}

function validateJobPosting(jobPosting, html, job, localeCode) {
  const errors = [];
  const warnings = [];

  const required = [
    ['title', jobPosting?.title],
    ['description', jobPosting?.description],
    ['datePosted', jobPosting?.datePosted],
    ['hiringOrganization.name', jobPosting?.hiringOrganization?.name],
  ];
  for (const [field, value] of required) {
    if (!value || String(value).trim().length === 0) errors.push(`missing:${field}`);
  }

  if (jobPosting?.datePosted && !isIsoDate(jobPosting.datePosted)) {
    errors.push('invalid:datePosted');
  }
  if (jobPosting?.validThrough && !isIsoDate(jobPosting.validThrough)) {
    warnings.push('invalid:validThrough');
  }

  const descLen = String(jobPosting?.description || '').trim().length;
  if (descLen < 140) warnings.push(`thin_description:${descLen}`);

  const hasRemote = jobPosting?.jobLocationType === 'TELECOMMUTE';
  const hasLocation =
    !!jobPosting?.jobLocation?.address?.addressLocality ||
    !!jobPosting?.jobLocation?.address?.addressRegion;
  if (!hasRemote && !hasLocation) {
    errors.push('missing:jobLocation');
  }
  if (!hasValidBaseSalary(jobPosting?.baseSalary)) {
    errors.push('missing_or_invalid:baseSalary');
  }
  if (!hasRemote) {
    const address = jobPosting?.jobLocation?.address || {};
    if (!address.postalCode || String(address.postalCode).trim().length === 0) {
      errors.push('missing:jobLocation.address.postalCode');
    }
    if (!address.streetAddress || String(address.streetAddress).trim().length === 0) {
      errors.push('missing:jobLocation.address.streetAddress');
    }
  }

  if (!jobPosting?.url || !String(jobPosting.url).startsWith(BASE_URL)) {
    warnings.push('url:not_internal_canonical');
  }
  if (!jobPosting?.identifier?.value) warnings.push('missing:identifier.value');
  if (!jobPosting?.employmentType) errors.push('missing:employmentType');
  if (!jobPosting?.hiringOrganization?.logo) warnings.push('missing:hiringOrganization.logo');
  if (!jobPosting?.inLanguage) warnings.push('missing:inLanguage');
  if (jobPosting?.inLanguage && String(jobPosting.inLanguage).toLowerCase() !== localeCode) {
    warnings.push(`invalid:inLanguage:${String(jobPosting.inLanguage)}`);
  }

  const expectedSlug = resolveSlugForLocale(job, localeCode);
  const canonicalNeedle = `/` + (localeCode === 'it' ? '' : `${localeCode}/`) + `${LOCALES.find((l) => l.code === localeCode).segment}/${expectedSlug}/`;
  if (!html.includes(`<link rel="canonical" href="${BASE_URL}${canonicalNeedle}">`)) {
    warnings.push('canonical:mismatch_or_missing');
  }

  const alternates = extractAlternateHrefLangs(html);
  for (const l of LOCALES) {
    const href = alternates[l.code];
    if (!href) {
      warnings.push(`hreflang:missing_or_invalid:${l.code}`);
      continue;
    }
    const expectedPrefix = `${BASE_URL}/${l.prefix ? `${l.prefix}/` : ''}${l.segment}/`;
    if (!href.startsWith(expectedPrefix)) {
      warnings.push(`hreflang:missing_or_invalid:${l.code}`);
      continue;
    }
    const targetFile = hrefToDistFile(href);
    if (!targetFile || !existsSync(targetFile)) {
      warnings.push(`hreflang:missing_or_invalid:${l.code}`);
    }
  }

  const hasBreadcrumb = html.includes('"@type":"BreadcrumbList"');
  if (!hasBreadcrumb) warnings.push('missing:BreadcrumbList');

  return { errors, warnings };
}

function main() {
  if (!existsSync(JOBS_PATH)) {
    console.error(`❌ jobs.json non trovato: ${JOBS_PATH}`);
    process.exit(1);
  }
  const jobs = readJson(JOBS_PATH);
  if (!Array.isArray(jobs) || jobs.length === 0) {
    console.error('❌ data/jobs.json è vuoto o non valido');
    process.exit(1);
  }

  const sample = Number.isFinite(SAMPLE_SIZE) && SAMPLE_SIZE > 0 ? pickSample(jobs, SAMPLE_SIZE) : jobs;
  const report = {
    sampleSize: sample.length,
    fullRun: !(Number.isFinite(SAMPLE_SIZE) && SAMPLE_SIZE > 0),
    localeChecks: 0,
    filesMissing: 0,
    jobPostingMissing: 0,
    parseErrors: 0,
    errors: 0,
    warnings: 0,
    details: [],
  };

  for (const job of sample) {
    for (const loc of LOCALES) {
      report.localeChecks += 1;
      const f = buildDistFile(loc.code, resolveSlugForLocale(job, loc.code));
      if (!f || !existsSync(f)) {
        report.filesMissing += 1;
        report.errors += 1;
        report.details.push({ slug: job.slug, locale: loc.code, level: 'error', issue: 'file_missing' });
        continue;
      }
      const html = readFileSync(f, 'utf8');
      // FRO-347: Bridge/redirect pages for non-IT locales redirect to the canonical slug.
      // They may have an incomplete JobPosting (no baseSalary/streetAddress by design).
      // Always treat bridge pages as warnings, not errors, regardless of JobPosting presence.
      const isBridgePage = html.includes('__BRIDGE_TARGET_SLUG__') || html.includes('URL legacy') || html.includes('window.location.replace');
      if (isBridgePage && loc.code !== 'it') {
        report.warnings += 1;
        report.details.push({ slug: job.slug, locale: loc.code, level: 'warning', issue: 'bridge_page_skipped' });
        continue;
      }
      const blocks = extractJsonLdBlocks(html);
      if (blocks.some((b) => b.__parseError)) {
        report.parseErrors += 1;
        report.errors += 1;
        report.details.push({ slug: job.slug, locale: loc.code, level: 'error', issue: 'jsonld_parse_error' });
        continue;
      }
      const jobPosting = getJobPosting(blocks);
      if (!jobPosting) {
        report.jobPostingMissing += 1;
        report.errors += 1;
        report.details.push({ slug: job.slug, locale: loc.code, level: 'error', issue: 'jobposting_missing' });
        continue;
      }

      const { errors, warnings } = validateJobPosting(jobPosting, html, job, loc.code);
      for (const e of errors) {
        report.errors += 1;
        report.details.push({ slug: job.slug, locale: loc.code, level: 'error', issue: e });
      }
      for (const w of warnings) {
        report.warnings += 1;
        report.details.push({ slug: job.slug, locale: loc.code, level: 'warning', issue: w });
      }
    }
  }

  const grouped = {};
  for (const d of report.details) {
    const key = `${d.level}:${d.issue}`;
    grouped[key] = (grouped[key] || 0) + 1;
  }

  console.log('=== Job Rich Results Audit ===');
  console.log(`Jobs checked: ${report.sampleSize}${report.fullRun ? ' (full)' : ' (sample)'}`);
  console.log(`Locale checks: ${report.localeChecks} (it/en/de/fr)`);
  console.log(`Errors: ${report.errors} | Warnings: ${report.warnings}`);
  console.log(`Missing files: ${report.filesMissing}`);
  console.log(`Missing JobPosting: ${report.jobPostingMissing}`);
  console.log(`JSON-LD parse errors: ${report.parseErrors}`);

  const topIssues = Object.entries(grouped)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12);

  if (topIssues.length > 0) {
    console.log('\nTop issues:');
    for (const [k, v] of topIssues) console.log(`- ${k}: ${v}`);
  } else {
    console.log('\nNo issues detected in sampled URLs.');
  }

  // Stampa dettagliata degli errori per ogni job/locale
  if (report.details.length > 0) {
    console.log('\nErrori dettagliati per job/locale:');
    for (const d of report.details) {
      if (d.level === 'error') {
        console.log(`slug: ${d.slug} | locale: ${d.locale} | issue: ${d.issue}`);
      }
    }
  }

  if (report.errors > 0) process.exit(1);
}

main();
