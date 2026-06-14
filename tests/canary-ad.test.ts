import { describe, expect, it } from 'vitest';
import { OWNER_EMAIL, isOwnerEmail, isCanaryJob } from '../scripts/lib/canaryAd.mjs';
import { publisherJobToRecords } from '../scripts/lib/publisherJobProjection.mjs';

const NOW = '2026-06-14T10:00:00.000Z';

function canaryPubJob(over: Record<string, unknown> = {}) {
  return {
    id: 'canary-owner-demo',
    publisherUid: 'owner-uid',
    status: 'paid',
    tier: 'sponsored',
    canary: true,
    featured: true,
    title: 'Specialista Marketing Digitale',
    description: 'parola '.repeat(60).trim(),
    sourceLang: 'it',
    company: { name: 'Frontaliere Ticino' },
    locations: [{ label: 'Lugano', canton: 'TI' }],
    apply: { mode: 'forward_email', email: OWNER_EMAIL },
    paidAt: NOW,
    createdAt: NOW,
    ...over,
  };
}

describe('canaryAd helpers', () => {
  it('OWNER_EMAIL defaults to the site owner, lowercased', () => {
    expect(OWNER_EMAIL).toBe('valerielinc@gmail.com');
  });

  it('isOwnerEmail is case/space-insensitive', () => {
    expect(isOwnerEmail('  ValerieLinc@Gmail.com ')).toBe(true);
    expect(isOwnerEmail('someone@else.com')).toBe(false);
    expect(isOwnerEmail('')).toBe(false);
    expect(isOwnerEmail(null)).toBe(false);
  });

  it('isCanaryJob is true only for canary===true', () => {
    expect(isCanaryJob({ canary: true })).toBe(true);
    expect(isCanaryJob({ canary: false })).toBe(false);
    expect(isCanaryJob({})).toBe(false);
    expect(isCanaryJob(null)).toBe(false);
  });
});

describe('publisher projection — canary passthrough', () => {
  it('emits canary:true on a sponsored canary ad', () => {
    const [rec] = publisherJobToRecords(canaryPubJob(), { nowIso: NOW });
    expect(rec.canary).toBe(true);
    expect(rec.featured).toBe(true);
    expect(rec.tier).toBe('sponsored');
  });

  it('omits the canary field on a normal sponsored ad (byte-identical)', () => {
    const [rec] = publisherJobToRecords(canaryPubJob({ canary: false }), { nowIso: NOW });
    expect('canary' in rec).toBe(false);
  });

  it('never marks a free ad canary (no broadcast perks on free)', () => {
    const [rec] = publisherJobToRecords(
      canaryPubJob({ tier: 'free', status: 'published', featured: false }),
      { nowIso: NOW },
    );
    expect('canary' in rec).toBe(false);
  });
});

// The three broadcast gates are thin inline filters over isCanaryJob/isOwnerEmail;
// this asserts the predicate semantics they all share (owner sees canary, others don't).
describe('canary broadcast gate semantics', () => {
  const jobs = [
    { id: 'real-1', canary: false },
    { id: 'canary-1', canary: true },
  ];
  const eligibleFor = (email: string) =>
    (isOwnerEmail(email) ? jobs : jobs.filter((j) => !isCanaryJob(j))).map((j) => j.id);

  it('owner sees real + canary jobs', () => {
    expect(eligibleFor(OWNER_EMAIL)).toEqual(['real-1', 'canary-1']);
  });

  it('a real subscriber never sees canary jobs', () => {
    expect(eligibleFor('user@example.com')).toEqual(['real-1']);
  });
});
