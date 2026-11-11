import { describe, expect, it } from 'vitest';
import {
  buildMinimalJobInput,
  computeInputHash,
} from '../build-plugins/shared/incrementalManifest.mjs';

describe('jobs SEO reuse input hash', () => {
  it('ignores source identity hashes that do not reach rendered HTML', () => {
    const base = {
      id: 'job-123',
      slug: 'job-123',
      title: 'Bilingual service assistant',
      description: 'Support the customer team.',
      sourceHash: 'source-hash-before',
      sourceRecordHash: 'record-hash-before',
      updatedAt: '2026-11-10T10:00:00Z',
      lastUpdatedAt: '2026-11-10T10:00:00Z',
    };
    const refreshed = {
      ...base,
      sourceHash: 'source-hash-after',
      sourceRecordHash: 'record-hash-after',
      lastUpdatedAt: '2026-11-11T10:00:00Z',
    };
    const input = (job: typeof base) => buildMinimalJobInput(job, 'de', 'job-123');

    expect(computeInputHash(input(base), 'active-job')).toBe(
      computeInputHash(input(refreshed), 'active-job'),
    );
  });

  it('still invalidates when rendered job content changes', () => {
    const base = {
      id: 'job-123',
      slug: 'job-123',
      title: 'Bilingual service assistant',
      description: 'Support the customer team.',
      sourceHash: 'same-source-hash',
      sourceRecordHash: 'same-record-hash',
    };
    const changed = { ...base, description: 'Lead the customer team.' };
    const input = (job: typeof base) => buildMinimalJobInput(job, 'de', 'job-123');

    expect(computeInputHash(input(base), 'active-job')).not.toBe(
      computeInputHash(input(changed), 'active-job'),
    );
  });

  it('invalidates when qualityScore changes because active pages serialize it in the slim seed', () => {
    const base = {
      id: 'job-123',
      slug: 'job-123',
      title: 'Bilingual service assistant',
      description: 'Support the customer team.',
      qualityScore: 72,
    };
    const changed = { ...base, qualityScore: 91 };
    const input = (job: typeof base) => buildMinimalJobInput(job, 'de', 'job-123');

    expect(computeInputHash(input(base), 'active-job')).not.toBe(
      computeInputHash(input(changed), 'active-job'),
    );
  });

  it('invalidates expired pages when a related job eligibility flag changes', () => {
    const job = {
      id: 'expired-123',
      slug: 'expired-123',
      title: 'Archived service assistant',
      description: 'The archived vacancy description.',
    };
    const related = {
      id: 'active-456',
      slug: 'active-456',
      title: 'Bilingual service assistant',
      sourceLang: 'fr',
      needsRetranslation: false,
    };
    const changedRelated = { ...related, needsRetranslation: true };
    const input = (candidate: typeof related) => (
      buildMinimalJobInput(job, 'de', 'expired-123', [candidate])
    );

    expect(computeInputHash(input(related), 'expired-soft-landing')).not.toBe(
      computeInputHash(input(changedRelated), 'expired-soft-landing'),
    );
  });

  it('keeps updatedAt in the input hash because JobPosting date fallback can render it', () => {
    const base = {
      id: 'job-123',
      slug: 'job-123',
      title: 'Bilingual service assistant',
      description: 'Support the customer team.',
      updatedAt: '2026-11-10T10:00:00Z',
    };
    const changed = { ...base, updatedAt: '2026-11-11T10:00:00Z' };
    const input = (job: typeof base) => buildMinimalJobInput(job, 'de', 'job-123');

    expect(computeInputHash(input(base), 'active-job')).not.toBe(
      computeInputHash(input(changed), 'active-job'),
    );
  });

  it.each(['lastSeenAt', 'lastObservedAt'] as const)(
    'keeps %s in the input hash because the active deadline can use it',
    (field) => {
      const base = {
        id: 'job-123',
        slug: 'job-123',
        title: 'Bilingual service assistant',
        description: 'Support the customer team.',
        validThroughSource: 'last-observed-window',
        [field]: '2026-11-10T10:00:00Z',
      };
      const changed = { ...base, [field]: '2026-11-11T10:00:00Z' };
      const input = (job: typeof base) => buildMinimalJobInput(job, 'de', 'job-123');

      expect(computeInputHash(input(base), 'active-job')).not.toBe(
        computeInputHash(input(changed), 'active-job'),
      );
    },
  );
});
