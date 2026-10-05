import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { countingDb, summarizeLoader } from '../scripts/measure-job-email-ranking-reads.mjs';
import { AFFINITY_PROFILE_READ_CHUNK } from '../functions/src/lib/jobEmailAffinityStore.js';

const MEASUREMENT = path.resolve(__dirname, '..', 'scripts', 'measurements', 'job-email-ranking-reads-2026-10-05.json');

describe('countingDb', () => {
  it('conta query.get e getAll con i documenti restituiti, e lascia passare il resto', async () => {
    const fake = {
      collection: () => ({
        where() { return this; },
        doc: (id: string) => ({ id }),
        get: async () => ({ size: 3, docs: [1, 2, 3] }),
      }),
      getAll: async (...refs: unknown[]) => refs.map(() => ({ exists: false })),
    };
    const { db, counts } = countingDb(fake);
    await db.collection('x').where('a', '==', 1).get();
    await db.getAll(db.collection('x').doc('a'), db.collection('x').doc('b'));
    expect(counts).toEqual({ calls: 2, docs: 5 });
  });

  it('summarizeLoader riporta solo conteggi', () => {
    const summary = summarizeLoader(
      { profiles: new Map([['someone', null]]), stats: { recipients: 1, opted_out: 0, read: 1, found: 0, failed: 0, skipped_reason: null } },
      { calls: 1, docs: 1 },
      12,
    );
    expect(summary).toEqual({ firestore_calls: 1, docs_read: 1, recipients: 1, opted_out: 0, profiles_found: 0, failed: 0, elapsed_ms: 12 });
  });
});

describe('misura del 2026-10-05: letture degli input di ordinamento, baseline contro HEAD', () => {
  const report = JSON.parse(fs.readFileSync(MEASUREMENT, 'utf8'));

  it('contiene solo aggregati', () => {
    expect(JSON.stringify(report)).not.toMatch(/@/);
    expect(report.baseline_sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('newsletter: una query della baseline contro una lettura di profilo per destinatario a lotti', () => {
    const { baseline, head } = report.newsletter;
    expect(baseline.firestore_calls).toBe(1);
    expect(baseline.docs_read).toBeGreaterThan(0);
    expect(head.docs_read).toBe(head.recipients - head.opted_out);
    expect(head.firestore_calls).toBe(Math.ceil(head.docs_read / AFFINITY_PROFILE_READ_CHUNK));
    expect(head.failed).toBe(0);
  });

  it('job alert: nessuna chiamata nella baseline, una lettura per iscritto in HEAD', () => {
    const { baseline, head } = report.job_alert;
    expect(baseline.firestore_calls).toBe(0);
    expect(baseline.docs_read).toBe(0);
    expect(head.docs_read).toBe(head.recipients - head.opted_out);
    expect(head.firestore_calls).toBe(Math.ceil(head.docs_read / AFFINITY_PROFILE_READ_CHUNK));
    expect(head.failed).toBe(0);
  });
});
