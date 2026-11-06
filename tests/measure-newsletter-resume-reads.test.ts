import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const MEASUREMENT = path.resolve(__dirname, '..', 'scripts', 'measurements', 'newsletter-resume-reads-2026-10-08.json');

describe('misura del 2026-10-08: letture della ripresa newsletter, baseline contro HEAD', () => {
  const report = JSON.parse(fs.readFileSync(MEASUREMENT, 'utf8'));

  it('contiene solo aggregati e un riferimento baseline valido', () => {
    expect(JSON.stringify(report)).not.toMatch(/@/);
    expect(report.baseline_sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('job alert: la ripresa interroga ogni destinatario senza collection group', () => {
    const { baseline, head } = report.job_alerts;
    expect(baseline.firestore_calls).toBe(1);
    expect(baseline.docs_read).toBeGreaterThan(10_000);
    expect(head.collection_group_queries).toBe(0);
    expect(head.recipients).toBe(report.selected_recipients);
    expect(head.subscriber_queries).toBe(head.recipients);
    expect(head.firestore_calls).toBe(head.recipients);
    expect(head.docs_read).toBeLessThanOrEqual(head.recipients * 5);
  });

  it('personalizzazione: le letture seguono userId e profili privati validi', () => {
    const { baseline, head } = report.application_intent;
    expect(baseline.docs_read).toBeGreaterThan(10_000);
    expect(head.with_user_id).toBeLessThanOrEqual(report.selected_recipients);
    expect(head.private_reads).toBe(head.with_user_id);
    expect(head.profile_reads).toBe(head.private_found);
  });

  it('totali A/B: il primo passaggio calcola e il secondo usa la cache', () => {
    const { baseline, head } = report.ab_totals;
    expect(head.first_pass.docs_read).toBe(baseline.docs_read + 1);
    expect(head.first_pass.cache_reads).toBe(1);
    expect(head.first_pass.source).toBe('calculation');
    expect(head.first_pass.firestore_writes).toBe(1);
    expect(head.second_pass.docs_read).toBe(1);
    expect(head.second_pass.source).toBe('cache');
    expect(head.second_pass.campaign_calculations).toBe(0);
    expect(head.second_pass.firestore_writes).toBe(0);
  });

  it('complessivo: una ripresa resta sotto l’uno per cento della baseline', () => {
    const headReads = report.job_alerts.head.docs_read
      + report.application_intent.head.docs_read
      + report.ab_totals.head.second_pass.docs_read;
    const baselineReads = report.job_alerts.baseline.docs_read
      + report.application_intent.baseline.docs_read
      + report.ab_totals.baseline.docs_read;

    expect(headReads).toBeLessThan(baselineReads * 0.01);
  });
});
