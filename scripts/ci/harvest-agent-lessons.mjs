#!/usr/bin/env node
// Lessons harvester — DETERMINISTIC aggregator (zero Claude).
//
// Scans recent reviewer findings, recurring issue classes and issue-fix
// outcomes, buckets them by a fixed taxonomy, drops anything already covered by
// the doc-contracts (AGENTS.md / ISSUES.md / REVIEW.md / FOLLOWUP.md), and
// emits the surviving "novel recurring" clusters. The weekly/daily workflow
// only spends a Claude turn when this script reports has_novel=true, so the
// common (nothing-new) day costs zero model tokens.
//
// Output:
//   - writes clusters JSON to $HARVEST_OUT (default: harvest-clusters.json)
//   - prints a human summary to stdout
//   - appends `has_novel=<bool>` and `novel_count=<n>` to $GITHUB_OUTPUT
//
// Env knobs: WINDOW_DAYS (14), THRESHOLD (3), MAX_PRS (40), MAX_ISSUES (120).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const WINDOW_DAYS = Number(process.env.WINDOW_DAYS || 14);
const THRESHOLD = Number(process.env.THRESHOLD || 3);
const MAX_PRS = Number(process.env.MAX_PRS || 40);
const MAX_ISSUES = Number(process.env.MAX_ISSUES || 120);
const OUT = process.env.HARVEST_OUT || 'harvest-clusters.json';

const sinceMs = Date.now() - WINDOW_DAYS * 86_400_000;
const sinceDay = new Date(sinceMs).toISOString().slice(0, 10);

function gh(args) {
  try {
    return execFileSync('gh', args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    process.stderr.write(`gh ${args.join(' ')} failed: ${err.message}\n`);
    return '';
  }
}
function ghJson(args) {
  const raw = gh(args).trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// ---- Reviewer-finding taxonomy: stable buckets via regex on finding text. ----
// Each finding (a 🔴/🟡/❓ line in a reviewer review body) maps to ONE bucket so
// recurrence is countable without fuzzy NLP. `docKeys` are substrings searched
// in the doc corpus to decide "already documented".
const TAXONOMY = [
  { key: 'structured-data', re: /structured data|json-?ld|basesalary|postalcode|hiringorganization|jobposting/i, docKeys: ['structured data', 'json-ld', 'basesalary'] },
  { key: 'missing-test-funnel', re: /missing test|test mancant|no test|senza test|test coverage/i, docKeys: ['test coverage', 'test mancant', 'senza test'] },
  { key: 'time-bomb-hardcoded', re: /hardcoded|time-?bomb|absolute date|aged? out|invecchia|date assolut/i, docKeys: ['date assolut', 'time-bomb', 'daysago'] },
  { key: 'cls-layout', re: /\bcls\b|layout shift|reflow|reserve space|min-h-|aspect-ratio/i, docKeys: ['cls', 'reserve space', 'layout shift'] },
  { key: 'auto-ads', re: /auto ?ads|adsense|anchor ad|vignette|in-page ad/i, docKeys: ['auto ads', 'adsense'] },
  { key: 'canonical-sitemap', re: /canonical|sitemap|noindex|cross-section/i, docKeys: ['canonical', 'sitemap', 'noindex'] },
  { key: 'workflow-scope-creds', re: /workflows? scope|github_pat|\bpat\b|credential|secret|branch protection|push.*workflow/i, docKeys: ['workflows`', 'capability-guard', 'github_pat'] },
  { key: 'i18n-naming', re: /locale|i18n|translat|canton-?aware|naming|brand/i, docKeys: ['locale', 'i18n', 'canton-aware'] },
  { key: 'router-nav', re: /router|parsepath|staticoverlay|window\.location/i, docKeys: ['router', 'staticoverlay', 'parsepath'] },
];
function bucketFinding(text) {
  for (const t of TAXONOMY) if (t.re.test(text)) return t.key;
  return null; // unbucketed findings are ignored for recurrence (too noisy)
}

// ---- 1. Reviewer findings on recently-merged PRs ----
const findingExamples = {}; // bucket -> [{pr, severity, snippet}]
const findingCounts = {};
const mergedPrs = ghJson(['pr', 'list', '--state', 'merged', '--search', `merged:>=${sinceDay}`,
  '--limit', String(MAX_PRS), '--json', 'number']) || [];
for (const { number } of mergedPrs) {
  const data = ghJson(['pr', 'view', String(number), '--json', 'reviews']);
  const reviews = data?.reviews || [];
  for (const r of reviews) {
    if (r.author?.login !== 'claude') continue;
    const lines = String(r.body || '').split('\n');
    for (const line of lines) {
      const sev = line.includes('🔴') ? '🔴' : line.includes('🟡') ? '🟡' : line.includes('❓') ? '❓' : null;
      if (!sev) continue;
      const bucket = bucketFinding(line);
      if (!bucket) continue;
      findingCounts[bucket] = (findingCounts[bucket] || 0) + 1;
      (findingExamples[bucket] ||= []).push({ pr: number, severity: sev, snippet: line.trim().slice(0, 160) });
    }
  }
}

// ---- 2. Recurring issue classes (created in window) ----
function issueClass(title, labels) {
  const t = title || '';
  if (/^Crawler Failure/i.test(t)) return 'issue:crawler-failure';
  if (/Validation Failure|Publish post-deploy/i.test(t)) return 'issue:validation-failure';
  if (/\[crawler-health\]/i.test(t)) return 'issue:crawler-health';
  if (/^follow-up\(/i.test(t)) return 'issue:follow-up';
  const names = (labels || []).map((l) => l.name);
  if (names.includes('revenue') || names.includes('rpm-canary')) return 'issue:revenue';
  return null;
}
const issueCounts = {};
const issueExamples = {};
const allIssues = ghJson(['issue', 'list', '--state', 'all', '--search', `created:>=${sinceDay}`,
  '--limit', String(MAX_ISSUES), '--json', 'number,title,labels']) || [];
for (const it of allIssues) {
  const cls = issueClass(it.title, it.labels);
  if (!cls) continue;
  issueCounts[cls] = (issueCounts[cls] || 0) + 1;
  (issueExamples[cls] ||= []).push({ issue: it.number, title: (it.title || '').slice(0, 80) });
}

// ---- 3. issue-fix outcomes via FIX_OUTCOME markers in issue comments ----
// Marker contract (issue-fix.yml prompt): the fixer's terminal comment starts
// with `<!-- FIX_OUTCOME: <code> -->`. We bucket the blocked/no-pr codes since
// those are the recurring-burn signal; `pr-created` is the healthy path.
const outcomeCounts = {};
const outcomeExamples = {};
const fixIssues = ghJson(['issue', 'list', '--search', `label:agent:triaged updated:>=${sinceDay}`,
  '--state', 'all', '--limit', String(MAX_ISSUES), '--json', 'number']) || [];
for (const { number } of fixIssues.slice(0, MAX_ISSUES)) {
  const data = ghJson(['issue', 'view', String(number), '--json', 'comments']);
  const comments = data?.comments || [];
  for (const c of comments) {
    const m = String(c.body || '').match(/<!--\s*FIX_OUTCOME:\s*([a-z0-9-]+)\s*-->/i);
    if (!m) continue;
    const code = m[1].toLowerCase();
    if (code === 'pr-created') continue; // healthy
    const k = `fix-outcome:${code}`;
    outcomeCounts[k] = (outcomeCounts[k] || 0) + 1;
    (outcomeExamples[k] ||= []).push({ issue: number });
  }
}

// ---- Dedup vs existing doc-contracts ----
const DOC_FILES = ['AGENTS.md', 'ISSUES.md', 'REVIEW.md', 'FOLLOWUP.md'];
let corpus = '';
for (const f of DOC_FILES) { try { corpus += '\n' + fs.readFileSync(f, 'utf-8').toLowerCase(); } catch { /* ignore */ } }
function alreadyDocumented(bucketKey) {
  const tax = TAXONOMY.find((t) => t.key === bucketKey);
  if (tax) return tax.docKeys.some((k) => corpus.includes(k.toLowerCase()));
  // Non-taxonomy keys (issue-class / fix-outcome codes): check hyphen, space
  // and nospace variants so "follow-up" matches a doc that writes "follow up".
  const base = bucketKey.replace(/^[a-z-]+:/, '').toLowerCase();
  const variants = [base, base.replace(/-/g, ' '), base.replace(/-/g, '')];
  return variants.some((v) => corpus.includes(v));
}

// ---- Assemble clusters above threshold + novel ----
const clusters = [];
// `driver`: clusters that can drive a doc-rule proposal (an agent repeating a
// mistake or hitting a wall). issue-class counts are operational VOLUME handled
// by triage/monitors, not instruction signal → included as context, never a
// proposal driver (novel stays false for them).
function consider(source, counts, examples, { driver }) {
  for (const [key, count] of Object.entries(counts)) {
    if (count < THRESHOLD) continue;
    const documented = alreadyDocumented(key);
    clusters.push({ source, key, count, driver, novel: driver && !documented,
      alreadyDocumented: documented, examples: (examples[key] || []).slice(0, 5) });
  }
}
consider('reviewer-finding', findingCounts, findingExamples, { driver: true });
consider('fix-outcome', outcomeCounts, outcomeExamples, { driver: true });
consider('issue-class', issueCounts, issueExamples, { driver: false });

clusters.sort((a, b) => b.count - a.count);
const novel = clusters.filter((c) => c.novel);

const result = { generatedForWindowDays: WINDOW_DAYS, threshold: THRESHOLD, since: sinceDay,
  totalClusters: clusters.length, novelClusters: novel.length, clusters };
fs.writeFileSync(OUT, JSON.stringify(result, null, 2));

// ---- Human summary ----
console.log(`Lessons harvest — window ${WINDOW_DAYS}d (since ${sinceDay}), threshold ≥${THRESHOLD}`);
console.log(`Merged PRs scanned: ${mergedPrs.length} · issues scanned: ${allIssues.length} · fix-issues: ${fixIssues.length}`);
if (!clusters.length) console.log('No recurring clusters above threshold.');
for (const c of clusters) {
  console.log(`  [${c.novel ? 'NOVEL' : 'documented'}] ${c.source}/${c.key} ×${c.count}` +
    (c.examples?.length ? `  e.g. ${c.examples.map((e) => '#' + (e.pr || e.issue)).join(',')}` : ''));
}
console.log(`\n→ novel recurring clusters: ${novel.length}`);

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `has_novel=${novel.length > 0}\nnovel_count=${novel.length}\n`);
}
