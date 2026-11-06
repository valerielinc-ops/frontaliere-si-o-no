// scripts/lib/alerts/summaryWriter.mjs
//
// Renders the Markdown summary for the GitHub Actions job page. Falls
// back to stdout when GITHUB_STEP_SUMMARY is not set (local runs).

import { appendFileSync } from 'node:fs';

const SEVERITY_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };

function bySeverity(a, b) {
  const av = SEVERITY_ORDER[a.severity] ?? 9;
  const bv = SEVERITY_ORDER[b.severity] ?? 9;
  if (av !== bv) return av - bv;
  return String(a.id).localeCompare(String(b.id));
}

function rowFor(alert) {
  const id = alert.id || '';
  const severity = alert.severity || 'P3';
  const message = (alert.message || '').replace(/\|/g, '\\|');
  const mitigation = (alert.mitigation || '').replace(/\|/g, '\\|');
  return `| ${severity} | ${id} | ${message} | ${mitigation} |`;
}

export function buildSummary(activeAlerts, snoozedAlerts, { now = Date.now() } = {}) {
  const sortedActive = activeAlerts.slice().sort(bySeverity);
  const sortedSnoozed = snoozedAlerts.slice().sort(bySeverity);

  const lines = [];
  lines.push(`# Quality alerts — ${new Date(now).toISOString().slice(0, 10)}`);
  lines.push('');
  const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const a of sortedActive) counts[a.severity] = (counts[a.severity] || 0) + 1;
  lines.push(`**Active:** P0=${counts.P0} • P1=${counts.P1} • P2=${counts.P2} • P3=${counts.P3} — Snoozed=${sortedSnoozed.length}`);
  lines.push('');

  if (sortedActive.length === 0) {
    lines.push('No active alerts. System healthy.');
  } else {
    lines.push('## Active alerts');
    lines.push('');
    lines.push('| Severity | ID | Message | Mitigation |');
    lines.push('| --- | --- | --- | --- |');
    for (const a of sortedActive) lines.push(rowFor(a));
  }
  lines.push('');

  if (sortedSnoozed.length > 0) {
    lines.push('## Snoozed (still firing)');
    lines.push('');
    lines.push('| Severity | ID | Until | Message |');
    lines.push('| --- | --- | --- | --- |');
    for (const a of sortedSnoozed) {
      const until = a._snoozedUntil || '—';
      const message = (a.message || '').replace(/\|/g, '\\|');
      lines.push(`| ${a.severity} | ${a.id} | ${until} | ${message} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function writeJobSummary(activeAlerts, snoozedAlerts, opts = {}) {
  const summary = buildSummary(activeAlerts, snoozedAlerts, opts);
  const target = opts.targetPath || process.env.GITHUB_STEP_SUMMARY;
  if (target) {
    try {
      appendFileSync(target, `${summary}\n`, 'utf-8');
      return summary;
    } catch (err) {
      console.warn(`[summary] could not write to ${target}: ${err?.message || err}`);
    }
  }
  process.stdout.write(`${summary}\n`);
  return summary;
}
