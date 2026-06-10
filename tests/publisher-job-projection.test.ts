import { describe, it, expect } from 'vitest';
import {
  publisherJobToRecords,
  publisherJobsToSlice,
  slugifyPublisher,
  truncatePublisherSlug,
  PUBLISHER_SOURCE_KEY,
  // @ts-expect-error mjs module, no type declarations
} from '../scripts/lib/publisherJobProjection.mjs';

const NOW = '2026-06-10T10:00:00.000Z';

function paidJob(over: Record<string, unknown> = {}) {
  return {
    id: 'job1',
    publisherUid: 'pub1',
    status: 'paid',
    title: 'Fisioterapista diplomato/a',
    description: 'x '.repeat(60),
    sourceLang: 'it',
    company: { name: 'R&C PhysioMedical Group', domain: 'physiomedicalgroup.ch' },
    locations: [{ label: 'Lugano' }, { label: 'Locarno' }],
    employmentType: 'FULL_TIME',
    apply: { mode: 'external_url', url: 'https://physiomedicalgroup.ch/careers' },
    paidAt: NOW,
    createdAt: NOW,
    ...over,
  };
}

describe('publisherJobToRecords', () => {
  it('emits one record per distinct location', () => {
    const recs = publisherJobToRecords(paidJob(), { nowIso: NOW });
    expect(recs).toHaveLength(2);
    expect(recs.map((r: any) => r.location).sort()).toEqual(['Locarno', 'Lugano']);
  });

  it('only projects paid jobs', () => {
    expect(publisherJobToRecords(paidJob({ status: 'pending_payment' }), { nowIso: NOW })).toEqual([]);
    expect(publisherJobToRecords(paidJob({ status: 'draft' }), { nowIso: NOW })).toEqual([]);
    expect(publisherJobToRecords(null, { nowIso: NOW })).toEqual([]);
  });

  it('tags provenance + source key', () => {
    const [r] = publisherJobToRecords(paidJob(), { nowIso: NOW });
    expect(r.source).toBe(PUBLISHER_SOURCE_KEY);
    expect(r.publisherUid).toBe('pub1');
    expect(r.publisherJobId).toBe('job1');
  });

  it('produces stable deterministic ids per (job, location)', () => {
    const a = publisherJobToRecords(paidJob(), { nowIso: NOW });
    const b = publisherJobToRecords(paidJob(), { nowIso: NOW });
    expect(a.map((r: any) => r.id)).toEqual(b.map((r: any) => r.id));
    expect(a.map((r: any) => r.id)).toContain('pub-job1-lugano');
    expect(a.map((r: any) => r.id)).toContain('pub-job1-locarno');
  });

  it('uses the external apply URL when mode is external_url', () => {
    const [r] = publisherJobToRecords(paidJob(), { nowIso: NOW });
    expect(r.applyUrl).toBe('https://physiomedicalgroup.ch/careers');
  });

  it('falls back to the site canonical apply URL for non-external modes', () => {
    const [r] = publisherJobToRecords(
      paidJob({ apply: { mode: 'forward_email', email: 'hr@x.ch' } }),
      { nowIso: NOW },
    );
    expect(r.applyUrl).toBe(r.url);
    expect(r.url).toMatch(/^https:\/\/frontaliereticino\.ch\/lavoro\//);
  });

  it('carries structured-data fields with safe defaults', () => {
    const [r] = publisherJobToRecords(paidJob(), { nowIso: NOW });
    expect(r.canton).toBe('TI');
    expect(r.country).toBe('CH');
    expect(r.currency).toBe('CHF');
    expect(r.postedDate).toBe(NOW);
    expect(r.validThrough).toBe('2026-07-10T10:00:00.000Z'); // +30 days
    expect(r.addressLocality).toBe('Lugano');
  });

  it('honors explicit location address + canton', () => {
    const recs = publisherJobToRecords(
      paidJob({
        locations: [
          { label: 'Lugano', canton: 'TI', address: { postalCode: '6900', streetAddress: 'Via Emilio Bossi 6' } },
        ],
      }),
      { nowIso: NOW },
    );
    expect(recs[0].postalCode).toBe('6900');
    expect(recs[0].streetAddress).toBe('Via Emilio Bossi 6');
  });

  it('propagates the featured flag', () => {
    const [r] = publisherJobToRecords(paidJob({ featured: true }), { nowIso: NOW });
    expect(r.featured).toBe(true);
    const [r2] = publisherJobToRecords(paidJob(), { nowIso: NOW });
    expect(r2.featured).toBe(false);
  });

  it('dedupes case/whitespace-variant locations', () => {
    const recs = publisherJobToRecords(
      paidJob({ locations: [{ label: 'Lugano' }, { label: 'lugano ' }, { label: '' }] }),
      { nowIso: NOW },
    );
    expect(recs).toHaveLength(1);
  });
});

describe('publisherJobsToSlice', () => {
  it('flattens many jobs and skips non-paid', () => {
    const slice = publisherJobsToSlice(
      [paidJob(), paidJob({ id: 'job2', status: 'draft' })],
      { nowIso: NOW },
    );
    expect(slice).toHaveLength(2); // only job1's 2 locations
  });
});

describe('slug helpers', () => {
  it('slugifies with diacritic stripping', () => {
    expect(slugifyPublisher('Zürich Genève')).toBe('zurich-geneve');
    expect(slugifyPublisher('  Fisioterapista, diplomato/a  ')).toBe('fisioterapista-diplomato-a');
  });
  it('truncates at a hyphen boundary', () => {
    const long = 'a'.repeat(60) + '-' + 'b'.repeat(80);
    expect(truncatePublisherSlug(long, 120).endsWith('-')).toBe(false);
    expect(truncatePublisherSlug(long, 120).length).toBeLessThanOrEqual(120);
  });
});
