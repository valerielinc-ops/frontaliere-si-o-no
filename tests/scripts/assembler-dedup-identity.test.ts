import { describe, expect, it } from 'vitest';
import { createAssemblerDedupIdentity } from '../../scripts/lib/assembler-dedup-identity.mjs';
import {
  dedupeByIdentityPreservingMarks,
  mergeBaselinePublicationEvidence,
} from '../../scripts/lib/job-mark-persistence.mjs';

describe('assembler dedup identity', () => {
  it('keeps ambiguous id-less same-slug records through both pre-route merge passes', () => {
    const identityOf = createAssemblerDedupIdentity();
    const first = {
      slug: 'retail-assistant',
      title: 'Retail assistant',
      company: 'Example Co',
      addressLocality: 'Lugano',
    };
    const second = { ...first, addressLocality: 'Mendrisio' };

    const collapsed = dedupeByIdentityPreservingMarks(
      [{ job: first, assembledAt: '' }, { job: second, assembledAt: '' }],
      identityOf,
    );
    const merged = mergeBaselinePublicationEvidence([], collapsed.winners, identityOf);

    expect(collapsed.collapsed).toBe(0);
    expect(collapsed.winners).toHaveLength(2);
    expect(merged).toHaveLength(2);
  });

  it('uses URL-first or stable-ID identities when source evidence exists', () => {
    const identityOf = createAssemblerDedupIdentity();

    expect(identityOf({ id: 'row-a', url: 'https://example.ch/job/1' }))
      .toBe(identityOf({ id: 'row-b', url: 'https://example.ch/job/1' }));
    expect(identityOf({ id: 'stable-1' })).toBe(identityOf({ id: 'stable-1' }));
    expect(identityOf({ id: 'stable-1', url: 'https://example.ch/job/1' }))
      .not.toBe(identityOf({ id: 'stable-1', url: 'https://example.ch/job/2' }));
  });
});
