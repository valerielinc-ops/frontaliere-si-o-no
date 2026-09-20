#!/usr/bin/env node
/**
 * Pubblica sulla PR il dettaglio dei test Vitest falliti.
 *
 * Il job mantiene il run Vitest nello stesso job di checkout/setup/npm ci. Il
 * log, però, è difficile da trovare nella vista della PR; il JSON prodotto dal
 * reporter è invece una sorgente strutturata e contiene file, nome del test e
 * messaggi d'errore.
 *
 * Best-effort: questo reporter non deve mai aggiungere un secondo rosso al
 * gate che sta già fallendo.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MAX_FAILURES = 20;
const MAX_MESSAGE_LENGTH = 1800;
const MAX_BODY_LENGTH = 60_000;
const MARKER = '<!-- vitest-failure-report -->';

function trustedGhBin() {
  const value = String(process.env.TRUSTED_GH_BIN || '').trim();
  if (!value || !value.startsWith('/') || value.includes('\0')) {
    throw new Error('TRUSTED_GH_BIN mancante o non assoluto');
  }
  return value;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function relativeTestFile(file) {
  const normalized = String(file || '').replaceAll('\\', '/');
  const match = normalized.match(/(?:^|\/)(tests\/[^/]+(?:\/[^/]+)*\.test\.[cm]?[jt]sx?)$/);
  return match?.[1] || path.basename(normalized) || '(file non disponibile)';
}

function trimMessage(message) {
  const text = String(message || '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').trim();
  if (text.length <= MAX_MESSAGE_LENGTH) return text;
  return `${text.slice(0, MAX_MESSAGE_LENGTH - 1)}…`;
}

export function reportFilesFromEnv(value = process.env.VITEST_REPORT_FILES) {
  return String(value || 'shard-timing-related.json')
    .split(/[\n,]/u)
    .map((file) => file.trim())
    .filter(Boolean);
}

export function collectFailures(files = reportFilesFromEnv()) {
  const groups = [];
  for (const file of files) {
    const report = readJson(file);
    if (!report) continue;
    const failures = [];
    for (const suite of report.testResults || []) {
      for (const assertion of suite.assertionResults || []) {
        if (assertion.status !== 'failed') continue;
        failures.push({
          file: relativeTestFile(suite.name),
          test: assertion.fullName || assertion.title || '(test senza nome)',
          error: trimMessage((assertion.failureMessages || []).join('\n') || 'errore senza messaggio nel report Vitest'),
        });
      }
    }
    if (report.success === false || report.numFailedTests > 0 || failures.length > 0) {
      groups.push({
        file,
        failedTests: Number(report.numFailedTests || failures.length),
        failedSuites: Number(report.numFailedTestSuites || 0),
        failures,
      });
    }
  }
  return groups;
}

export function buildComment(groups, {
  runUrl = '',
  runId = '',
  headSha = '',
} = {}) {
  const lines = [
    MARKER,
    '## ❌ Test Vitest falliti',
    '',
    'Il gate `tests` è fallito. Dettaglio estratto dal report JSON del run Vitest:',
    '',
  ];
  if (groups.length === 0) {
    lines.push('- Il passo Vitest è fallito, ma il reporter JSON non è disponibile; consultare il log del job.', '');
  }
  for (const group of groups) {
    lines.push(`### ${group.file}`);
    lines.push(`- Test falliti: **${group.failedTests}**${group.failedSuites ? ` — file suite falliti: **${group.failedSuites}**` : ''}`);
    for (const failure of group.failures.slice(0, MAX_FAILURES)) {
      lines.push('- **' + failure.file + '** — `' + failure.test + '`');
      lines.push('  ```text');
      lines.push(`  ${failure.error.replaceAll('\n', '\n  ')}`);
      lines.push('  ```');
    }
    if (group.failures.length > MAX_FAILURES) {
      lines.push(`- … e altri ${group.failures.length - MAX_FAILURES} test falliti nel report.`);
    }
    if (group.failures.length === 0) {
      lines.push('- Il report indica un failure, ma non contiene il dettaglio di un’asserzione; consultare il log del job.');
    }
    lines.push('');
  }
  if (runUrl) lines.push(`Run: ${runUrl}`);
  if (runId) lines.push('Run ID: `' + runId + '`');
  if (headSha) lines.push('HEAD verificata: `' + headSha.slice(0, 12) + '`');
  return lines.join('\n').slice(0, MAX_BODY_LENGTH);
}

function gh(args) {
  try {
    execFileSync(trustedGhBin(), args, {
      encoding: 'utf8',
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    return true;
  } catch {
    return false;
  }
}

function ghOutput(args) {
  try {
    return execFileSync(trustedGhBin(), args, {
      encoding: 'utf8',
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
  } catch {
    return '';
  }
}

function publishComment(repo, prNumber, body) {
  const raw = ghOutput(['api', `repos/${repo}/issues/${prNumber}/comments?per_page=100`]);
  let comments = [];
  try { comments = JSON.parse(raw); } catch { /* best-effort: fall back to a new comment */ }
  const previous = comments.find((comment) => String(comment.body || '').includes(MARKER));
  if (previous?.id) {
    return gh([
      'api',
      '--method', 'PATCH',
      `repos/${repo}/issues/comments/${previous.id}`,
      '-f', `body=${body}`,
    ]);
  }
  return gh(['pr', 'comment', prNumber, '--repo', repo, '--body', body]);
}

function main() {
  const groups = collectFailures();
  const prNumber = process.env.PR_NUMBER || '';
  const repo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
  if (!prNumber || !repo) {
    console.log('Vitest reports: failure rilevati, ma PR/repository non disponibili.');
    return;
  }
  const body = buildComment(groups, {
    runUrl: process.env.RUN_URL || '',
    runId: process.env.RUN_ID || '',
    headSha: process.env.HEAD_SHA || '',
  });
  const posted = publishComment(repo, prNumber, body);
  console.log(posted ? `Commento failure Vitest pubblicato/aggiornato sulla PR #${prNumber}.` : 'Impossibile pubblicare il commento failure Vitest (best-effort).');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) main();
