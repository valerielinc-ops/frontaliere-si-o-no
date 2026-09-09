#!/usr/bin/env node
/**
 * Reconcile an authorised affiliate-network export.
 *
 * No network mutation, postback, order, or purchase simulation happens here.
 * Without an export this report says `unmeasurable`; it never turns missing
 * commercial data into zero revenue.
 *
 * Usage:
 *   node scripts/affiliate-revenue-report.mjs --input export.json --from 2026-09-01 --to 2026-09-07 --web-exposures 1000
 *   node scripts/affiliate-revenue-report.mjs --input export.csv --email-delivered 500 --markdown
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseAffiliateCsv,
  parseAffiliateExport,
  reconcileAffiliateTransactions,
} from './lib/affiliateRevenue.mjs';

const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] || null : null;
};
const inputPath = valueAfter('--input') || process.env.AFFILIATE_REVENUE_EXPORT_FILE || null;
const from = valueAfter('--from');
const to = valueAfter('--to');
const webExposures = valueAfter('--web-exposures');
const emailExposures = valueAfter('--email-delivered');
const markdown = args.includes('--markdown');

function renderMarkdown(report) {
  const lines = [
    '# Affiliate revenue reconciliation',
    '',
    `Status: **${report.status}**`,
    `Period: ${report.period.from || '—'} → ${report.period.to || '—'}`,
    `Deduplicated transactions: ${report.deduplicatedTransactions}`,
    `Invalid rows: ${report.invalidRows}`,
    `Web exposures: ${report.exposures.web ?? 'unmeasurable'}`,
    `Email delivered: ${report.exposures.email ?? 'unmeasurable'}`,
    '',
    '| Currency | Pending | Approved | Reversed | Approved / 1,000 web | Approved / 1,000 email |',
    '|---|---:|---:|---:|---:|---:|',
  ];
  for (const [currency, values] of Object.entries(report.byCurrency)) {
    lines.push(`| ${currency} | ${values.pending.toFixed(2)} | ${values.approved.toFixed(2)} | ${values.reversed.toFixed(2)} | ${values.approvedPer1000Exposures.web ?? '—'} | ${values.approvedPer1000Exposures.email ?? '—'} |`);
  }
  if (report.reason) lines.push('', `Reason: ${report.reason}`);
  if (report.invalidReasons?.length) lines.push('', `Invalid rows: ${report.invalidReasons.join('; ')}`);
  return lines.join('\n');
}

function numericOrNull(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function main() {
  const period = { from, to };
  if (!inputPath) {
    const report = {
      status: 'unmeasurable',
      reason: 'no authorised affiliate-network export configured',
      period,
      invalidRows: 0,
      deduplicatedTransactions: 0,
      exposures: { web: numericOrNull(webExposures), email: numericOrNull(emailExposures) },
      byCurrency: {},
    };
    process.stdout.write(markdown ? renderMarkdown(report) + '\n' : JSON.stringify(report, null, 2) + '\n');
    return;
  }

  const absolutePath = resolve(inputPath);
  const rawText = readFileSync(absolutePath, 'utf8');
  const raw = absolutePath.toLowerCase().endsWith('.csv')
    ? parseAffiliateCsv(rawText)
    : JSON.parse(rawText);
  const parsed = parseAffiliateExport(raw, {
    webExposures: numericOrNull(webExposures),
    emailExposures: numericOrNull(emailExposures),
  });
  const report = reconcileAffiliateTransactions({ rows: parsed.rows, from, to, exposures: parsed.exposures });
  process.stdout.write(markdown ? renderMarkdown(report) + '\n' : JSON.stringify(report, null, 2) + '\n');
}

main();
