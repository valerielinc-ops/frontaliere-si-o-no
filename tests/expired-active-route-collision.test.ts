// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { repairExpiredRoutesAgainstActive } from '../scripts/lib/expired-jobs-archive.mjs';

const COLLIDING_ROUTE = 'same-title-company-lugano';
const ACTIVE_URL = 'https://jobs.example.test/active-1';
const EXPIRED_URL = 'https://jobs.example.test/expired-2';

function activeJob() {
  return {
    id: 'active-1',
    url: ACTIVE_URL,
    slug: COLLIDING_ROUTE,
    slugByLocale: { it: COLLIDING_ROUTE, de: COLLIDING_ROUTE, en: 'active-en' },
    previousSlugs: ['active-old'],
  };
}

function expiredJob(sourceIdentity = `url:${EXPIRED_URL}`) {
  return {
    slug: COLLIDING_ROUTE,
    slugByLocale: { it: COLLIDING_ROUTE, de: COLLIDING_ROUTE, en: 'expired-en' },
    previousSlugs: [COLLIDING_ROUTE, 'expired-old'],
    previousSlugsByLocale: { it: [COLLIDING_ROUTE], de: [COLLIDING_ROUTE] },
    sourceIdentity,
  };
}

describe('repairExpiredRoutesAgainstActive', () => {
  it('disambiguates a distinct archive posting across current and historical routes', () => {
    const active = activeJob();
    const expired = expiredJob();

    const result = repairExpiredRoutesAgainstActive([expired], [active]);

    expect(result.changed).toBe(1);
    expect(result.repairedRoutes).toBe(1);
    expect(expired.slug).toMatch(/^same-title-company-lugano-[0-9a-f]{8}$/);
    expect(expired.slugByLocale.it).toBe(expired.slug);
    expect(expired.slugByLocale.de).toBe(expired.slug);
    expect(expired.previousSlugs).toEqual([expired.slug, 'expired-old']);
    expect(expired.previousSlugsByLocale).toEqual({ it: [expired.slug], de: [expired.slug] });
    expect(active.slug).toBe(COLLIDING_ROUTE);
    expect(active.slugByLocale.de).toBe(COLLIDING_ROUTE);
  });

  it('is deterministic and idempotent for the same source identity', () => {
    const first = expiredJob();
    const second = expiredJob();

    repairExpiredRoutesAgainstActive([first], [activeJob()]);
    const secondResult = repairExpiredRoutesAgainstActive([second], [activeJob()]);
    const thirdResult = repairExpiredRoutesAgainstActive([second], [activeJob()]);

    expect(second.slug).toBe(first.slug);
    expect(second.slugByLocale).toEqual(first.slugByLocale);
    expect(second.previousSlugs).toEqual(first.previousSlugs);
    expect(secondResult.changed).toBe(1);
    expect(thirdResult.changed).toBe(0);
  });

  it('fails closed for same-posting or identity-less archive evidence', () => {
    const samePosting = expiredJob(`url:${ACTIVE_URL}`);
    const unknownPosting = expiredJob(null);

    expect(repairExpiredRoutesAgainstActive([samePosting], [activeJob()]).changed).toBe(0);
    expect(repairExpiredRoutesAgainstActive([unknownPosting], [activeJob()]).changed).toBe(0);
    expect(samePosting.slug).toBe(COLLIDING_ROUTE);
    expect(unknownPosting.slug).toBe(COLLIDING_ROUTE);
  });
});
