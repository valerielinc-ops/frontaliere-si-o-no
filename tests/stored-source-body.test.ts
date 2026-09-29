/**
 * keepStoredSourceBodies — a fresh read under the shared word floor keeps the
 * source body stored from an earlier read, or the job is not published.
 */
import { describe, it, expect } from 'vitest';
import {
  keepStoredSourceBodies,
  keepStoredSourceBodiesByKey,
} from '@/scripts/lib/stored-source-body.mjs';

const BODY = Array(60).fill('Aufgabe').join(' ');
const key = (url: string) => url;

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

  it('leaves out a job with neither a fresh nor a stored body over the floor', () => {
    const fresh = [{ url: 'a', description: 'Kurzer Text.', descriptionByLocale: {}, sourceLang: 'de' }];
    const stored = [{ url: 'a', sourceLang: 'de', description: 'Auch kurz.', descriptionByLocale: { de: 'Auch kurz.' } }];
    expect(keepStoredSourceBodies(fresh, stored, key)).toEqual([]);
    expect(keepStoredSourceBodies(fresh, [], key)).toEqual([]);
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
