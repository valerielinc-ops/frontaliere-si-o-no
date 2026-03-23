#!/usr/bin/env node
/**
 * newsletter-qa.mjs — Pre-send rendering QA gate for the weekly newsletter.
 *
 * Generates the final newsletter HTML using the exact same template pipeline
 * as send-newsletter.mjs --send, runs structural validation checks, and
 * takes Chromium screenshots at desktop (1400px) and mobile (375px) widths
 * to simulate Gmail web / Gmail mobile rendering.
 *
 * Usage:
 *   node scripts/newsletter-qa.mjs           # Run QA, exit 0 if pass, 1 if fail
 *   node scripts/newsletter-qa.mjs --stress  # Include stress-test content
 *
 * send-newsletter.mjs --send checks for a valid QA artifact from today
 * (UTC) before allowing production sends.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { buildNewsletter, FEATURED_TOOLS, nlNormLocale } from '../services/newsletter-template.mjs';
import { matchJobsForSubscriber, getFallbackBriefing } from '../services/newsletter-content.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const QA_DIR = path.resolve(ROOT, 'docs', 'newsletter-qa');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');

const BASE_URL = 'https://frontaliereticino.ch';
const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)

const STRESS_MODE = process.argv.includes('--stress');

/* ── Build the newsletter HTML ──────────────────────────────── */

function loadJobs() {
  try {
    return JSON.parse(fs.readFileSync(DATA_JOBS, 'utf8'));
  } catch {
    return [];
  }
}

function buildQaHtml(opts = {}) {
  const { stress = false } = opts;
  const locale = 'it';
  const jobs = loadJobs();

  const exchangeRate = { rate: 0.9420, previousRate: 0.9385 };

  let matchedJobs = matchJobsForSubscriber(
    { locationInterest: null, sectorInterest: null },
    jobs,
    4,
  );

  if (stress) {
    // Inject edge-case content: long titles, long company names, long locations
    matchedJobs = matchedJobs.length > 0
      ? matchedJobs.map((job, i) => ({
          ...job,
          title: i === 0
            ? 'Responsabile Sviluppo Commerciale Internazionale e Coordinatore Progetti Strategici Senior (m/f/d)'
            : i === 1
            ? 'Front-End Developer / UI Engineer specializzato in React, TypeScript e architetture Micro-Frontend'
            : job.title,
          company: i === 2
            ? 'Azienda Multidisciplinare per la Consulenza Aziendale e la Formazione Professionale SA'
            : job.company,
          location: i === 3
            ? 'Mendrisio, Canton Ticino, Confederazione Svizzera'
            : job.location,
        }))
      : [
          {
            title: 'Responsabile Sviluppo Commerciale Internazionale (m/f/d)',
            company: 'Azienda Multidisciplinare SA',
            location: 'Mendrisio, Canton Ticino',
            canton: 'TI',
            slug: 'responsabile-sviluppo-commerciale-internazionale',
            url: `${BASE_URL}/cerca-lavoro-ticino/responsabile-sviluppo/`,
            category: 'tech',
          },
        ];
  }

  const toolIndex = Math.floor((Date.now() - new Date('2025-01-06').getTime()) / (7 * 24 * 60 * 60 * 1000)) % FEATURED_TOOLS.length;
  const featuredTool = FEATURED_TOOLS[toolIndex];
  const weeklyFact = {
    text: 'In Svizzera, il salario mediano è di circa 6.665 CHF al mese (2022).',
    source: 'UST',
  };

  const briefing = getFallbackBriefing(locale, exchangeRate);

  const defaultArticle = {
    title: 'Votazioni cantonali Ticino 2026: cosa cambia per i frontalieri',
    excerpt: 'SSR, imposizione individuale, fondo climatico: 4 temi su cui voti (o dovresti). Ecco cosa significa per il tuo portafoglio.',
    url: '/articoli-frontaliere/votazioni-imposizione-ticino-2026',
    badge: '🗳️ Voto 18 maggio',
  };

  return buildNewsletter({
    aiBriefing: briefing,
    exchangeRate,
    matchedJobs,
    totalJobs: jobs.length,
    article: defaultArticle,
    featuredTool,
    weeklyFact,
    locale,
    unsubscribeUrl: `${BASE_URL}/?action=unsubscribe&email=qa-preview@frontaliereticino.ch`,
    resubscribeUrl: `${BASE_URL}/?action=resubscribe&email=qa-preview@frontaliereticino.ch`,
  });
}

/* ── Structural checks ──────────────────────────────────────── */

const CHECKS = [
  {
    id: 'html-doctype',
    label: 'HTML document is well-formed',
    check: (html) => /<!DOCTYPE html/i.test(html) || /<html/i.test(html),
  },
  {
    id: 'no-scripts',
    label: 'No <script> tags (email client safety)',
    check: (html) => !/<script[\s>]/i.test(html),
  },
  {
    id: 'min-size',
    label: 'HTML is non-trivial (>8KB)',
    check: (html) => html.length > 8000,
  },
  {
    id: 'max-size',
    label: 'HTML is not bloated (<200KB)',
    check: (html) => html.length < 200000,
  },
  {
    id: 'mobile-media-query',
    label: 'Mobile @media query present',
    check: (html) => /@media only screen and/i.test(html) || /@media screen and/i.test(html),
  },
  {
    id: 'exchange-rate',
    label: 'Exchange rate value present',
    check: (html) => /0\.\d{3,}/.test(html),
  },
  {
    id: 'jobs-section',
    label: 'Job listings section present',
    check: (html) => /cerca-lavoro-ticino/i.test(html),
  },
  {
    id: 'unsubscribe-link',
    label: 'Unsubscribe link present',
    check: (html) => /action=unsubscribe/i.test(html) || /Cancellati|Unsubscribe|Abmelden/i.test(html),
  },
  {
    id: 'footer-present',
    label: 'Footer / legal section present',
    check: (html) => /frontaliereticino\.ch/i.test(html) && /newsletter/i.test(html),
  },
  {
    id: 'absolute-hrefs',
    label: 'All internal hrefs are absolute (https://)',
    check: (html) => {
      // Find any href that looks like a relative URL to frontaliereticino.ch (not mailto: tel: #)
      const broken = [...html.matchAll(/href="(\/[^"#?][^"]*frontaliereticino[^"]*)"/g)];
      return broken.length === 0;
    },
  },
  {
    id: 'no-empty-href',
    label: 'No empty href attributes',
    check: (html) => !(/href=""/).test(html),
  },
  {
    id: 'tools-section',
    label: 'Featured tool section present',
    check: (html) => /calcolator|cambio|calcolatrice|stipend|simulat/i.test(html),
  },
  {
    id: 'no-broken-template',
    label: 'No unrendered template placeholders',
    check: (html) => !/\{[a-z_]+\}/.test(html),
  },
  {
    id: 'table-based-layout',
    label: 'Table-based layout (email client compatibility)',
    check: (html) => /<table[^>]*>/i.test(html),
  },
];

function runStructuralChecks(html) {
  const results = CHECKS.map((spec) => {
    let passed = false;
    let error = null;
    try {
      passed = spec.check(html);
    } catch (e) {
      error = e.message;
    }
    return { id: spec.id, label: spec.label, passed, error };
  });
  return results;
}

function runStressChecks(html, stressHtml) {
  const results = [];

  // Stress: long title doesn't make HTML smaller (template didn't crash)
  results.push({
    id: 'stress-long-title',
    label: 'Long job title (150 chars) renders without crash',
    passed: stressHtml.length > 8000,
  });

  // Stress: both HTMLs contain the jobs section
  results.push({
    id: 'stress-jobs-present',
    label: 'Job section present with stress content',
    passed: /cerca-lavoro-ticino/i.test(stressHtml),
  });

  // Stress: no unclosed tags in stress HTML (simple heuristic)
  const openTags = (stressHtml.match(/<[a-z]+/g) || []).length;
  const closeTags = (stressHtml.match(/<\/[a-z]+>/g) || []).length;
  results.push({
    id: 'stress-balanced-tags',
    label: 'Stress HTML has reasonably balanced open/close tags',
    passed: Math.abs(openTags - closeTags) < 50,
  });

  return results;
}

/* ── Screenshots via Playwright ─────────────────────────────── */

async function takeScreenshots(html, prefix) {
  const browser = await chromium.launch({ headless: true });
  const screenshots = {};
  try {
    for (const { width, label } of [
      { width: 1400, label: 'desktop' },
      { width: 375, label: 'mobile' },
    ]) {
      const page = await browser.newPage();
      await page.setViewportSize({ width, height: 900 });
      await page.setContent(html, { waitUntil: 'networkidle' });
      const screenshotPath = path.join(QA_DIR, `${prefix}-${label}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      await page.close();
      screenshots[label] = screenshotPath;
      console.log(`  📸 Screenshot saved: ${path.relative(ROOT, screenshotPath)}`);
    }
  } finally {
    await browser.close();
  }
  return screenshots;
}

/* ── Write artifacts ────────────────────────────────────────── */

function writeArtifacts(report) {
  fs.mkdirSync(QA_DIR, { recursive: true });

  const prefix = `${today}${report.stress ? '-stress' : ''}`;

  // QA report JSON
  const reportPath = path.join(QA_DIR, `${prefix}-report.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');

  // Preview HTML
  const previewPath = path.join(QA_DIR, `${prefix}-preview.html`);
  fs.writeFileSync(previewPath, report.html, 'utf8');

  return { reportPath, previewPath };
}

/* ── Main ───────────────────────────────────────────────────── */

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Newsletter QA — Pre-Send Rendering Check');
  console.log(`  Date: ${today}${STRESS_MODE ? ' [stress mode]' : ''}`);
  console.log('═══════════════════════════════════════════════════════\n');

  // 1. Generate HTML
  console.log('📄 Generating newsletter HTML...');
  const html = buildQaHtml({ stress: false });
  const stressHtml = STRESS_MODE ? buildQaHtml({ stress: true }) : null;
  console.log(`   Base HTML: ${(html.length / 1024).toFixed(1)} KB`);
  if (stressHtml) console.log(`   Stress HTML: ${(stressHtml.length / 1024).toFixed(1)} KB`);

  // 2. Structural checks on base HTML
  console.log('\n🔍 Running structural checks...');
  const checks = runStructuralChecks(html);
  for (const r of checks) {
    const icon = r.passed ? '✅' : '❌';
    console.log(`  ${icon} ${r.label}${r.error ? ` [${r.error}]` : ''}`);
  }

  // 3. Stress checks
  let stressChecks = [];
  if (STRESS_MODE && stressHtml) {
    console.log('\n🔍 Running stress checks...');
    stressChecks = runStressChecks(html, stressHtml);
    for (const r of stressChecks) {
      const icon = r.passed ? '✅' : '❌';
      console.log(`  ${icon} ${r.label}`);
    }
  }

  // 4. Screenshots
  console.log('\n📸 Taking screenshots (Chromium)...');
  let screenshots = {};
  try {
    const prefix = `${today}${STRESS_MODE ? '-stress' : ''}`;
    fs.mkdirSync(QA_DIR, { recursive: true });
    screenshots = await takeScreenshots(html, prefix);
  } catch (err) {
    console.warn(`  ⚠️  Screenshot failed: ${err.message}`);
  }

  // 5. Summary
  const allChecks = [...checks, ...stressChecks];
  const failed = allChecks.filter((r) => !r.passed);
  const passed = allChecks.length - failed.length;
  const qaResult = failed.length === 0;

  console.log('\n' + '─'.repeat(56));
  console.log(`  Checks: ${passed}/${allChecks.length} passed | ${failed.length} failed`);
  if (failed.length > 0) {
    console.log('  Failed checks:');
    for (const r of failed) console.log(`    ❌ ${r.label}`);
  }

  // 6. Write artifacts
  const report = {
    date: today,
    generatedAt: new Date().toISOString(),
    stress: STRESS_MODE,
    passed: qaResult,
    checksTotal: allChecks.length,
    checksPassed: passed,
    checksFailed: failed.length,
    checks: allChecks,
    screenshots,
    htmlSizeBytes: html.length,
    html,
  };

  const { reportPath } = writeArtifacts(report);
  console.log(`\n  📋 Report: ${path.relative(ROOT, reportPath)}`);

  // 7. Final verdict
  if (qaResult) {
    console.log('\n✅ QA PASSED — newsletter is ready to send.');
    console.log('   Run: node scripts/send-newsletter.mjs --test');
    console.log('   Then: node scripts/send-newsletter.mjs --send\n');
  } else {
    console.log('\n❌ QA FAILED — fix the issues above before sending.');
    console.log('   Review the preview HTML and screenshots in docs/newsletter-qa/\n');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`❌ Newsletter QA failed: ${err.message || err}`);
  process.exit(1);
});
