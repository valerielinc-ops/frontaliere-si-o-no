import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { exportL8Ga4Attribution } from '../scripts/ci/export-l8-affiliate-outcomes.mjs';
import { reconcileAffiliateTransactions } from '../scripts/lib/affiliateRevenue.mjs';
import { normalizeAuthorizedAffiliateExport } from '../scripts/ci/fetch-authorized-affiliate-export.mjs';
import { buildAffiliateLinkHref } from '../services/affiliateService';

function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'affiliate-ga4-')); }
const daysAgo = (days: number) => new Date(Date.now() - days * 86400000).toISOString();

describe('live affiliate attribution source and money', () => {
 it('loads the live exporter from only the workflow sparse checkout without node_modules', () => {
  const dir = scratch();
  try {
   const root = path.resolve(__dirname, '..');
   const yaml = fs.readFileSync(path.join(root, '.github/workflows/loop-l8-revenue-attribution.yml'), 'utf8');
   const listed = yaml.split('sparse-checkout: |')[1].split('sparse-checkout-cone-mode:')[0]
    .trim().split('\n').map(line => line.trim().replace(/^\//, ''));
   for (const source of listed) {
    const original = path.join(root, source);
    if (!fs.existsSync(original)) continue;
    const dest = path.join(dir, source);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(original, dest);
   }
   const result = spawnSync(process.execPath, ['scripts/ci/export-l8-affiliate-outcomes.mjs', '--unavailable', '--out', path.join(dir, 'out.json')], { cwd: dir, encoding: 'utf8' });
   expect(result.status, result.stderr).toBe(0);
   expect(JSON.parse(fs.readFileSync(path.join(dir, 'out.json'), 'utf8')).attribution.source).toBe('ga4');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
 });

 it('reads unsampled GA4 event totals and never invents email exposure or approved money', async () => {
  const dir = scratch();
  try {
   const ga4Runner = vi.fn(async (_args: any) => ({ rowCount: 2, rows: [
    { dimensionValues: [{ value: 'affiliate_impression' }, { value: 'wise-control-web-exchange-test' }], metricValues: [{ value: '12' }] },
    { dimensionValues: [{ value: 'affiliate_click' }, { value: 'wise-control-web-exchange-test' }], metricValues: [{ value: '2' }] },
   ] }));
   const output = await exportL8Ga4Attribution({ outputPath: path.join(dir, 'out.json'), tokenProvider: async () => 'test', ga4Runner });
   expect(ga4Runner.mock.calls[0][0].body.dimensions).toEqual([{ name: 'eventName' }, { name: 'customEvent:attribution_id' }]);
   expect(output.exposures).toMatchObject({ web: 12, email: null, byAttribution: { 'wise-control-web-exchange-test': 12 } });
   expect(output.attribution.byPlacement).toEqual([{ attributionId: 'wise-control-web-exchange-test', impressions: 12, clicks: 2 }]);
   expect(output.clicks).toEqual({ web: 2, email: null, total: null, relevant: null });
   expect(output.transactions).toBeNull();
   expect(output.independent).toBe(false);
   expect(output.evidence.commercialLedger).toBe('not_configured');
   expect(output.attribution.source).toBe('ga4');
   expect(output.evidence.sourceRefs).not.toContain('posthog.affiliate_click');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
 });

 it('fails closed on a truncated analytics result', async () => {
  const dir = scratch();
  try {
   await expect(exportL8Ga4Attribution({ outputPath: path.join(dir, 'out.json'), tokenProvider: async () => 'test', ga4Runner: async () => ({ rowCount: 4, rows: [] }) })).rejects.toThrow('truncated');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
 });

 it('preserves the rendered pos through authorised import and separates estimated, pending and approved commissions', () => {
  const href = buildAffiliateLinkHref({ id: 'wise' }, { surface: 'web', position: 'exchange-best-offer', campaign: 'g4-contextual', variant: 'control' });
  const id = new URL(href).searchParams.get('pos');
  const base = { partner_id: 'wise', network: 'partnerize', pubref: id, currency: 'CHF', transaction_date: daysAgo(2) };
  const exported = normalizeAuthorizedAffiliateExport({ generatedAt: daysAgo(1), exposures: { web: 100, email: null }, transactions: [
   { ...base, transaction_id: 'a', status: 'pending', amount: 2, updated_at: daysAgo(2) },
   { ...base, transaction_id: 'a', status: 'approved', amount: 2, updated_at: daysAgo(1) },
   { ...base, transaction_id: 'b', status: 'pending', amount: 3 },
   { ...base, transaction_id: 'c', status: 'estimated', amount: 40 },
  ] }, { sourceLabel: 'authorised-test-fixture' });
  const report = reconcileAffiliateTransactions({ rows: exported.transactions, exposures: { ...exported.exposures, byAttribution: { [id!]: 100 } } });
  expect(report.byCurrency.CHF).toMatchObject({ approved: 2, pending: 3, estimated: 40, approvedConversions: 1 });
  expect(report.byAttribution).toHaveLength(1);
  expect(report.byAttribution[0]).toMatchObject({ partnerId: 'wise', attributionId: id, byCurrency: { CHF: { approved: 2, pending: 3, estimated: 40 } } });
  expect(report.byAttribution[0].byCurrency.CHF.approvedPer1000Impressions).toBe(20);
  expect(report.exposures.email).toBeNull();
  expect(report.byCurrency.CHF.approvedPer1000Exposures.email).toBeNull();
 });
});
