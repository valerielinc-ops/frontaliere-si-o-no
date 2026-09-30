/**
 * keepStoredSourceBodies — a fresh read under the shared word floor keeps the
 * source body stored from an earlier read, or the job is not published.
 */
import { describe, it, expect } from 'vitest';
import {
  buildThinSourceHousekeepingProof,
  findThinSourceJobsWithoutStoredBody,
  keepStoredSourceBodies,
  keepStoredSourceBodiesByKey,
} from '@/scripts/lib/stored-source-body.mjs';

const BODY = Array(60).fill('Aufgabe').join(' ');
const BODY_40 = Array(40).fill('Aufgabe').join(' ');
const BODY_35 = Array(35).fill('Kurztext').join(' ');
const key = (url: string) => url;
const jobKey = (job: { url: string }) => job.url;

describe('keepStoredSourceBodies', () => {
  it('keeps a fresh job whose body is over the word floor', () => {
    const fresh = [{ url: 'a', description: BODY, descriptionByLocale: { de: BODY }, sourceLang: 'de' }];
    expect(keepStoredSourceBodies(fresh, [], key)).toEqual(fresh);
  });

  it('reuses the stored source body, keyed by the stored source language', () => {
    const fresh = [{ url: 'a', description: '', descriptionByLocale: {}, sourceLang: 'en' }];
    const stored = [{ url: 'a', sourceLang: 'fr', description: BODY, descriptionByLocale: { fr: BODY, it: 'traduzione' } }];
    expect(keepStoredSourceBodies(fresh, stored, key)).toEqual([
      { url: 'a', description: BODY, descriptionByLocale: { fr: BODY }, sourceLang: 'fr' },
    ]);
  });

  it('moves a title and slug keyed by the fallback language to the stored source language', () => {
    const fresh = [{
      url: 'a', description: '', descriptionByLocale: {}, sourceLang: 'en',
      titleByLocale: { en: 'Polymecanic Team Leader' }, slugByLocale: { en: 'polymecanic-team-leader-mikron' },
    }];
    const stored = [{ url: 'a', sourceLang: 'fr', description: BODY, descriptionByLocale: { fr: BODY } }];
    const [kept] = keepStoredSourceBodies(fresh, stored, key);
    expect(kept.sourceLang).toBe('fr');
    expect(kept.titleByLocale).toEqual({ fr: 'Polymecanic Team Leader' });
    expect(kept.slugByLocale).toEqual({ fr: 'polymecanic-team-leader-mikron' });
  });

  it('leaves multi-locale title and slug maps alone', () => {
    const titleByLocale = { it: 'Addetto', en: 'Clerk', de: 'Sachbearbeiter', fr: 'Employé' };
    const fresh = [{ url: 'a', description: '', descriptionByLocale: {}, sourceLang: 'en', titleByLocale }];
    const stored = [{ url: 'a', sourceLang: 'de', description: BODY, descriptionByLocale: { de: BODY } }];
    expect(keepStoredSourceBodies(fresh, stored, key)[0].titleByLocale).toEqual(titleByLocale);
  });

  it('leaves out a job with neither a fresh nor a stored body over the floor', () => {
    const fresh = [{ url: 'a', description: 'Kurzer Text.', descriptionByLocale: {}, sourceLang: 'de' }];
    const stored = [{ url: 'a', sourceLang: 'de', description: 'Auch kurz.', descriptionByLocale: { de: 'Auch kurz.' } }];
    expect(keepStoredSourceBodies(fresh, stored, key)).toEqual([]);
    expect(keepStoredSourceBodies(fresh, [], key)).toEqual([]);
  });

  it('records a dropped thin read before keeping the publishable sibling', () => {
    const thin = {
      url: 'https://jobs.example.test/thin',
      sourceLang: 'de',
      description: BODY_35,
      descriptionByLocale: { de: BODY_35 },
    };
    const publishable = {
      url: 'https://jobs.example.test/publishable',
      sourceLang: 'de',
      description: BODY,
      descriptionByLocale: { de: BODY },
    };
    const stored = [{
      ...thin,
      description: BODY_40,
      descriptionByLocale: { de: BODY_40 },
    }];

    expect(findThinSourceJobsWithoutStoredBody([thin, publishable], stored, jobKey)).toEqual([thin]);
    expect(keepStoredSourceBodiesByKey([thin, publishable], stored, key)).toEqual([publishable]);

    const proof = buildThinSourceHousekeepingProof([thin], [thin], jobKey);
    expect(proof).toEqual([{
      job: thin,
      reason: 'thin-source-quarantine',
      definitive: true,
    }]);
    expect(keepStoredSourceBodiesByKey([thin, publishable], stored, key)).not.toContainEqual(thin);
  });

  it('uses a custom job identity and the declared source-locale slot', () => {
    const fresh = [{
      requisition: 'a',
      sourceLang: 'it',
      description: '',
      descriptionByLocale: { it: '' },
    }];
    const stored = [{
      requisition: 'a',
      sourceLang: 'fr',
      description: 'stale flat field',
      descriptionByLocale: { fr: BODY, en: 'translation' },
    }];
    expect(keepStoredSourceBodiesByKey(fresh, stored, (job) => job.requisition)).toEqual([
      {
        requisition: 'a',
        sourceLang: 'fr',
        description: BODY,
        descriptionByLocale: { fr: BODY },
      },
    ]);
  });
});
