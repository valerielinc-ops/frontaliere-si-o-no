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
import { createGithubIssue } from '../lib/github-issue-creator.mjs';

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
//
// Two finding FAMILIES live here:
//   - TOPIC buckets (structured-data, cls, auto-ads, …): "agent shipped wrong
//     code about <domain>". Adding a NEW doc rule fixes these.
//   - PROCESS-failure-mode buckets (pr-body-contract, sibling-class-fix,
//     unvalidated-claim, stale-comment): "agent repeats a meta-mistake". These
//     are usually ALREADY documented, so they never surface as `novel`. They
//     matter via the EFFICACY signal instead: documented-but-still-recurring →
//     `recurringDespiteRule` → the prose rule isn't working → escalate to a
//     STRUCTURAL fix (template / CI gate / shared module), not another line.
//     (These 4 buckets were the harvester's blind spot until 2026-06-04.)
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
  // PROCESS-failure-mode buckets (see family note above):
  { key: 'pr-body-contract', re: /implementato|non implementato|completeness contract|sezioni? (obbligatori|mancant)|## fix\b|## verify\b/i, docKeys: ['completeness contract', 'non implementato'] },
  { key: 'sibling-class-fix', re: /stesso anti-?pattern|file gemello|stesso costrutto|sibling|non toccat|class-complete/i, docKeys: ['file gemello', 'stesso anti', 'class-complete'] },
  { key: 'unvalidated-claim', re: /claim.*(non validat|unvalidated|speculativ)|non validat.*pre-?merge|atteso\s+green|revert-?trigger|sufficienza speculativa/i, docKeys: ['non validat', 'revert-trigger', 'speculativ'] },
  { key: 'stale-comment', re: /stale (comment|doc)|comment(o|i)? stale|docblock stale|descrive ancora|title.*(contraddice|stale)|commento.*vecchio/i, docKeys: ['stale comment', 'docblock', 'descrive ancora'] },
];

// Catch-all fingerprint: when a finding matches NO taxonomy bucket, don't drop
// it silently (the old behaviour that hid the 4 process classes above). Derive a
// deterministic fingerprint from the first few CONTENT words (stopwords, emoji,
// severity labels, code spans, paths and digits stripped) so genuinely-NEW
// recurring phrasings still cluster and surface for human review. Coarse by
// design: it catches stable lead-phrases ("manca la sezione…", "claim non…"),
// not every paraphrase — a safety net, not a classifier.
const STOPWORDS = new Set(['the', 'a', 'an', 'di', 'la', 'il', 'le', 'lo', 'un', 'una',
  'e', 'ed', 'o', 'in', 'su', 'per', 'con', 'da', 'del', 'della', 'dei', 'delle', 'al',
  'non', 'che', 'è', 'this', 'is', 'to', 'of', 'and', 'or', 'no', 'nel', 'nella']);
function fingerprintFinding(text) {
  const words = text
    .toLowerCase()
    .replace(/[🔴🟡🟣❓]/g, ' ')
    .replace(/`[^`]*`/g, ' ')          // code spans (file paths, symbols, values)
    .replace(/\b(important|nit|q|pre-existing|process)\b/gi, ' ') // severity labels
    .replace(/[#/].*?(\s|$)/g, ' ')    // headings, paths
    .replace(/[^a-zàèéìòù\s-]+/gi, ' ') // punctuation, digits
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  const lead = words.slice(0, 4);
  return lead.length >= 3 ? `fp:${lead.join('-')}` : null; // too short → still drop
}
function bucketFinding(text) {
  for (const t of TAXONOMY) if (t.re.test(text)) return t.key;
  return fingerprintFinding(text); // unbucketed → fingerprint safety net (or null)
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
  // Dedup PER-ISSUE: una stessa issue ri-accodata dal followup-drainer (rescue
  // a 3 tentativi) può postare lo STESSO marker N volte. Contarli tutti gonfia
  // il bucket (3 run di UNA issue → conta 3) e fa scattare l'escalation su una
  // soglia di issue-distinte falsata — è esattamente ciò che ha prodotto #1478.
  // La lezione cercata è «N issue DISTINTE bloccate da questo esito», non «N
  // commenti» → conta ogni codice al più una volta per issue. (Il re-queue è
  // ora fermato alla sorgente in followup-drainer.mjs, ma il dedup rende il
  // conteggio robusto anche allo storico e a ri-tentativi manuali.)
  const seenThisIssue = new Set();
  for (const c of comments) {
    const m = String(c.body || '').match(/<!--\s*FIX_OUTCOME:\s*([a-z0-9-]+)\s*-->/i);
    if (!m) continue;
    const code = m[1].toLowerCase();
    if (code === 'pr-created') continue; // healthy
    // Backstop-emitted fallbacks (issue-fix.yml "post-step deterministico") tag
    // crashed/max_turns runs — expected catch-all, not a doc-rule violation.
    // Counting them inflates no-pr-unspecified → feedback loop: escalation keeps
    // re-firing even after the backstop fix (PR #1067) landed.
    if (String(c.body || '').includes('post-step deterministico')) continue;
    const k = `fix-outcome:${code}`;
    if (seenThisIssue.has(k)) continue;
    seenThisIssue.add(k);
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
// EFFICACY_FACTOR: a documented pattern that STILL recurs at ≥ THRESHOLD×factor
// is evidence the prose rule isn't preventing the mistake → escalate to a
// structural fix instead of writing another line nobody follows.
const EFFICACY_FACTOR = Number(process.env.EFFICACY_FACTOR || 2);
const clusters = [];
// `driver`: clusters that can drive a doc-rule proposal (an agent repeating a
// mistake or hitting a wall). issue-class counts are operational VOLUME handled
// by triage/monitors, not instruction signal → included as context, never a
// proposal driver (novel stays false for them).
function consider(source, counts, examples, { driver }) {
  for (const [key, count] of Object.entries(counts)) {
    if (count < THRESHOLD) continue;
    const documented = alreadyDocumented(key);
    // Documented + still recurring hard = the rule exists but isn't working.
    const recurringDespiteRule = driver && documented && count >= THRESHOLD * EFFICACY_FACTOR;
    clusters.push({ source, key, count, driver, novel: driver && !documented,
      recurringDespiteRule, alreadyDocumented: documented,
      examples: (examples[key] || []).slice(0, 5) });
  }
}
consider('reviewer-finding', findingCounts, findingExamples, { driver: true });
consider('fix-outcome', outcomeCounts, outcomeExamples, { driver: true });
consider('issue-class', issueCounts, issueExamples, { driver: false });

clusters.sort((a, b) => b.count - a.count);
const novel = clusters.filter((c) => c.novel);
const escalations = clusters.filter((c) => c.recurringDespiteRule);

const result = { generatedForWindowDays: WINDOW_DAYS, threshold: THRESHOLD,
  efficacyFactor: EFFICACY_FACTOR, since: sinceDay, totalClusters: clusters.length,
  novelClusters: novel.length, escalationClusters: escalations.length, clusters };
fs.writeFileSync(OUT, JSON.stringify(result, null, 2));

// ---- Human summary ----
console.log(`Lessons harvest — window ${WINDOW_DAYS}d (since ${sinceDay}), threshold ≥${THRESHOLD}`);
console.log(`Merged PRs scanned: ${mergedPrs.length} · issues scanned: ${allIssues.length} · fix-issues: ${fixIssues.length}`);
if (!clusters.length) console.log('No recurring clusters above threshold.');
for (const c of clusters) {
  const tag = c.novel ? 'NOVEL' : c.recurringDespiteRule ? 'ESCALATE' : 'documented';
  console.log(`  [${tag}] ${c.source}/${c.key} ×${c.count}` +
    (c.examples?.length ? `  e.g. ${c.examples.map((e) => '#' + (e.pr || e.issue)).join(',')}` : ''));
}
console.log(`\n→ novel recurring clusters: ${novel.length} · escalations (documented-but-recurring): ${escalations.length}`);

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT,
    `has_novel=${novel.length > 0}\nnovel_count=${novel.length}\n` +
    `has_escalation=${escalations.length > 0}\nescalation_count=${escalations.length}\n`);
}

// ---- Escalation issues: DETERMINISTIC + dedup-by-construction (zero Claude) ----
// Previously the Claude step was told to open one escalation issue per
// `recurringDespiteRule` cluster and dedup by re-searching the title. That
// soft, LLM-driven dedup drifted (same bucket filed under `source/key` AND
// `source:key`) and re-fired every run → duplicate escalations piled up
// (i18n-naming ×4, blocked-workflows-scope ×5, …). Emit them from code with a
// SINGLE canonical title + the hardened code-level dedup in
// github-issue-creator.mjs (comments on the open canonical instead of
// duplicating). The Claude step now handles ONLY novel doc-rule proposals.
function escalationTitle(c) {
  return `escalation(harvester): ${c.source}/${c.key} ricorre nonostante regola`;
}
// Recurrence bumps SEVERITY, not count: un'escalation è già "ricorre nonostante
// regola" (≥soglia×fattore) → baseline medium; se il count scala oltre 2× il
// fattore → high. Puro → testabile.
export function severityLabelForCount(count, threshold = THRESHOLD, factor = EFFICACY_FACTOR) {
  return count >= threshold * factor * 2 ? 'severity:high' : 'severity:medium';
}
// Estrae `<source>/<key>` dal titolo canonico, o null. Puro → testabile. Serve
// al self-heal: mappare un'escalation issue aperta al suo bucket.
export function parseEscalationKey(title) {
  const m = /^escalation\(harvester\):\s*(.+?)\s+ricorre nonostante regola\s*$/.exec(String(title || ''));
  return m ? m[1].trim() : null;
}
function escalationBody(c) {
  const examples = (c.examples || [])
    .map((e) => '#' + (e.pr || e.issue))
    .filter((s) => s !== '#undefined')
    .join(', ') || '—';
  return [
    '## Bucket',
    `\`${c.source}/${c.key}\` — count **${c.count}** su finestra ${WINDOW_DAYS}gg (dal ${sinceDay})`,
    '',
    '## Esempi PR/issue',
    examples,
    '',
    '## Perché escalare',
    `Pattern GIÀ documentato ma che ricorre ≥ soglia×fattore-efficacia ` +
      `(${THRESHOLD}×${EFFICACY_FACTOR}). La regola prosa NON previene l'errore ` +
      `→ serve un fix **STRUTTURALE** (gate CI deterministico, template, lint, ` +
      `modulo condiviso, refactor che lo renda impossibile by-construction), ` +
      `non un'altra riga di doc.`,
    '',
    '_Auto-filed dal lessons-harvester (dedup deterministico per bucket)._',
  ].join('\n');
}

// Gate: emit only when explicitly enabled (the workflow sets this). Keeps local
// dry-runs and tests from minting real GitHub issues.
if (process.env.HARVEST_EMIT_ESCALATIONS === 'true') {
  // 1. EMIT/UPDATE: una issue canonica per bucket attivo. createGithubIssue
  //    dedupa (commenta sul canonico se esiste). Poi bump SEVERITÀ in base al
  //    count (recidiva → severity sale, non si accumula un'altra issue).
  for (const c of escalations) {
    try {
      const res = await createGithubIssue({
        title: escalationTitle(c),
        description: escalationBody(c),
        priority: 2,
        labels: ['follow-up'],
        workflow: 'Lessons harvester',
      });
      const num = res?.number;
      if (num) {
        const sev = severityLabelForCount(c.count);
        const drop = sev === 'severity:high' ? 'severity:medium' : 'severity:high';
        try {
          gh(['label', 'create', sev, '--color', sev === 'severity:high' ? 'B60205' : 'D93F0B', '-f']);
        } catch { /* label esiste già */ }
        try {
          gh(['issue', 'edit', String(num), '--add-label', sev, '--remove-label', drop]);
        } catch (e) { process.stderr.write(`sev bump #${num} fallito: ${e.message}\n`); }
      }
    } catch (err) {
      process.stderr.write(`escalation emit failed for ${c.source}/${c.key}: ${err.message}\n`);
    }
  }

  // 2. SELF-HEAL CLOSE: un'escalation aperta il cui bucket NON è più tra quelli
  //    attivi (sceso sotto soglia per un'intera finestra) → il pattern si è
  //    fermato: chiudila (drena il ratchet; riapribile, riemerge se ricorre).
  //    Search via la frase senza parentesi (le `(` rompono gh search → era il
  //    blind-spot del monitoring) e filtro per titolo esatto.
  const liveKeys = new Set(escalations.map((c) => `${c.source}/${c.key}`));
  const openEsc = (ghJson([
    'issue', 'list', '--state', 'open', '--search', 'ricorre nonostante regola in:title',
    '--json', 'number,title', '--limit', '100',
  ]) || []).filter((i) => parseEscalationKey(i.title));
  for (const iss of openEsc) {
    const key = parseEscalationKey(iss.title);
    if (liveKeys.has(key)) continue; // ancora attivo → lascia aperta
    try {
      gh(['issue', 'comment', String(iss.number), '--body',
        `🌱 Self-heal: il bucket \`${key}\` non ricorre più sopra soglia nella finestra ${WINDOW_DAYS}gg (dal ${sinceDay}) → il pattern si è fermato. Chiusa dal lessons-harvester. Riemergerà in automatico se torna a ricorrere.`]);
      gh(['issue', 'close', String(iss.number), '--reason', 'completed']);
      console.log(`SELF-HEAL close #${iss.number} — bucket ${key} quiet`);
    } catch (e) {
      process.stderr.write(`self-heal close #${iss.number} fallito: ${e.message}\n`);
    }
  }
}
