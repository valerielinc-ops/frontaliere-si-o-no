/**
 * keepStoredSourceBodies — a fresh read under the shared word floor keeps the
 * source body stored from an earlier read, or the job is not published.
 */
import { describe, it, expect } from 'vitest';
import {
  buildSourceBodyFailureHousekeepingProof,
  buildThinSourceHousekeepingProof,
  collectThinSourceJobsForQuarantine,
  dropFailedSourceJobsWithoutValidBody,
  dropUnreadableSourceJobsWithoutValidBody,
  keepStoredSourceBodies,
  keepStoredSourceBodiesByKey,
  storedJobForFailedSource,
} from '@/scripts/lib/stored-source-body.mjs';
import { extractStableJobId } from '@/scripts/lib/job-match-key.mjs';

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

    const kept = keepStoredSourceBodiesByKey([thin, publishable], stored, jobKey);
    expect(kept).toEqual([publishable]);
    expect(collectThinSourceJobsForQuarantine([thin, publishable], kept, jobKey)).toEqual([thin]);

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

  it('reuses a stored body across a stable URL title rename', () => {
    const freshBody = Array(35).fill('fresh').join(' ');
    const storedBody = Array(60).fill('stored').join(' ');
    const fresh = [{
      url: 'https://source.example/jobs/new-title-123456',
      sourceLang: 'en',
      description: freshBody,
      descriptionByLocale: { en: freshBody },
      titleByLocale: { en: 'New title' },
      slugByLocale: { en: 'new-title' },
    }];
    const stored = [{
      url: 'https://source.example/jobs/old-title-123456',
      sourceLang: 'en',
      description: storedBody,
      descriptionByLocale: { en: storedBody },
    }];
    const keyOfJob = (job: { url: string }) => extractStableJobId(job.url);
    const kept = keepStoredSourceBodiesByKey(fresh, stored, keyOfJob);

    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({
      url: fresh[0].url,
      description: storedBody,
      descriptionByLocale: { en: storedBody },
    });
    expect(collectThinSourceJobsForQuarantine(fresh, kept, keyOfJob)).toEqual([]);
  });

  it('collects a thin discovery only when no merged record can publish it', () => {
    const thin = Array(35).fill('thin').join(' ');
    const oldThin = {
      url: 'https://source.example/jobs/old-title-123456',
      sourceLang: 'en',
      description: thin,
      descriptionByLocale: { en: thin },
    };
    const freshThin = {
      url: 'https://source.example/jobs/new-title-123456',
      sourceLang: 'en',
      description: thin,
      descriptionByLocale: { en: thin },
    };
    const keyOfJob = (job: { url: string }) => extractStableJobId(job.url);

    expect(collectThinSourceJobsForQuarantine([freshThin], [oldThin], keyOfJob)).toEqual([oldThin]);
    expect(collectThinSourceJobsForQuarantine([freshThin], [], keyOfJob)).toEqual([freshThin]);
  });

  it('keeps a valid stored body for a failed PDF and never classifies the failure as thin', () => {
    const failed = {
      url: 'https://source.example/jobs/pdf-failure',
      sourceLang: 'it',
      description: '',
      descriptionByLocale: { it: '' },
      sourceBodyFailureReason: 'pdf-extraction-failed',
      sourceBodyFailureMessage: 'no text extracted',
    };
    const stored = {
      ...failed,
      description: BODY,
      descriptionByLocale: { it: BODY },
      sourceBodyFailureReason: undefined,
      sourceBodyFailureMessage: undefined,
    };

    const kept = keepStoredSourceBodiesByKey([failed], [stored], jobKey);
    expect(kept).toEqual([expect.objectContaining({
      url: failed.url,
      sourceLang: 'it',
      description: BODY,
      descriptionByLocale: { it: BODY },
    })]);
    expect(kept[0]).not.toHaveProperty('sourceBodyFailureReason');
    expect(kept[0]).not.toHaveProperty('sourceBodyFailureMessage');
    expect(collectThinSourceJobsForQuarantine([failed], kept, jobKey)).toEqual([]);
    expect(buildSourceBodyFailureHousekeepingProof([stored], [failed], jobKey)).toEqual([{
      job: stored,
      reason: 'pdf-extraction-failed',
      definitive: true,
    }]);
  });

  it('drops a failed PDF without a valid stored body without thin quarantine evidence', () => {
    const failed = {
      url: 'https://source.example/jobs/pdf-failure-no-history',
      sourceLang: 'it',
      description: '',
      descriptionByLocale: { it: '' },
      sourceBodyFailureReason: 'pdf-extraction-failed',
    };
    expect(keepStoredSourceBodiesByKey([failed], [], jobKey)).toEqual([]);
    expect(collectThinSourceJobsForQuarantine([failed], [], jobKey)).toEqual([]);
  });

  it('removes a failed identity from the merge when its stored body is under the floor', () => {
    const failed = {
      url: 'https://source.example/jobs/pdf-failure-thin-history',
      sourceLang: 'it',
      description: '',
      descriptionByLocale: { it: '' },
      sourceBodyFailureReason: 'pdf-extraction-failed',
    };
    const stored = {
      ...failed,
      description: BODY_35,
      descriptionByLocale: { it: BODY_35 },
      sourceBodyFailureReason: undefined,
    };

    expect(dropFailedSourceJobsWithoutValidBody([stored], [failed], jobKey)).toEqual([]);
  });

  it('keeps a failed identity in the merge when its stored body clears the floor', () => {
    const failed = {
      url: 'https://source.example/jobs/pdf-failure-valid-history',
      sourceLang: 'it',
      description: '',
      descriptionByLocale: { it: '' },
      sourceBodyFailureReason: 'pdf-extraction-failed',
    };
    const stored = {
      ...failed,
      description: BODY,
      descriptionByLocale: { it: BODY },
      sourceBodyFailureReason: undefined,
    };

    expect(dropFailedSourceJobsWithoutValidBody([stored], [failed], jobKey)).toEqual([stored]);
  });
});

describe('dropUnreadableSourceJobsWithoutValidBody', () => {
  const url = 'https://jobs.example.ch/inserat.pdf';
  const thinFresh = { url, sourceLang: 'de', description: '', descriptionByLocale: { de: '' } };
  const emptyStored = { url, sourceLang: 'de', description: '', descriptionByLocale: { de: '' } };
  const validStored = { url, sourceLang: 'de', description: BODY, descriptionByLocale: { de: BODY } };

  it('drops a stored row under the floor for a thin fresh read, which the failure-only filter keeps', () => {
    expect(dropFailedSourceJobsWithoutValidBody([emptyStored], [thinFresh], jobKey)).toEqual([emptyStored]);
    expect(dropUnreadableSourceJobsWithoutValidBody([emptyStored], [thinFresh], jobKey)).toEqual([]);
  });

  it('drops it for a failed fresh read too', () => {
    const failed = { ...thinFresh, sourceBodyFailureReason: 'pdf-extraction-failed' };
    expect(dropUnreadableSourceJobsWithoutValidBody([emptyStored], [failed], jobKey)).toEqual([]);
  });

  it('keeps a stored row whose body clears the floor, and every row of a readable fresh posting', () => {
    expect(dropUnreadableSourceJobsWithoutValidBody([validStored], [thinFresh], jobKey)).toEqual([validStored]);
    const readable = { ...validStored };
    expect(dropUnreadableSourceJobsWithoutValidBody([emptyStored], [readable], jobKey)).toEqual([emptyStored]);
  });
});

describe('storedJobForFailedSource', () => {
  // A source whose title, slug and locality come from the PDF text (LWPHR,
  // Berit Klinik, ECAM): a failed read republishes the stored record whole.
  const stored = {
    url: 'https://jobs.example.ch/a.pdf',
    title: 'Pflegefachfrau HF 80%',
    slug: 'pflegefachfrau-hf-80-klinik',
    location: 'Bern',
    sourceLang: 'de',
    description: BODY,
    descriptionByLocale: { de: BODY, it: 'traduzione' },
    sourceBodyFailureReason: 'pdf-extraction-failed',
    sourceBodyFailureMessage: 'stale marker',
  };

  it('returns the stored record without failure markers when its body clears the floor', () => {
    const kept = storedJobForFailedSource(stored.url, [stored], jobKey);
    expect(kept).toEqual({
      url: stored.url,
      title: stored.title,
      slug: stored.slug,
      location: 'Bern',
      sourceLang: 'de',
      description: BODY,
      descriptionByLocale: { de: BODY, it: 'traduzione' },
    });
    expect(stored.sourceBodyFailureReason).toBe('pdf-extraction-failed');
  });

  it('returns null without a stored record, a source language or a body over the floor', () => {
    expect(storedJobForFailedSource('https://jobs.example.ch/other.pdf', [stored], jobKey)).toBeNull();
    expect(storedJobForFailedSource(stored.url, [{ ...stored, sourceLang: '' }], jobKey)).toBeNull();
    expect(storedJobForFailedSource(stored.url, [{ ...stored, description: BODY_35, descriptionByLocale: { de: BODY_35 } }], jobKey)).toBeNull();
    expect(storedJobForFailedSource('', [stored], jobKey)).toBeNull();
  });

  it('is what keepStoredSourceBodiesByKey republishes for a failed row that asks for the stored record', () => {
    const failed = {
      url: stored.url,
      title: 'Opportunità generica',
      slug: 'opportunita-generica',
      sourceLang: 'it',
      description: '',
      descriptionByLocale: {},
      sourceBodyFailureReason: 'pdf-extraction-failed',
      sourceBodyFailureMessage: 'HTTP 503 while fetching PDF',
      sourceBodyFailureKeepsStoredRecord: true,
    };
    expect(keepStoredSourceBodiesByKey([failed], [stored], jobKey))
      .toEqual([storedJobForFailedSource(stored.url, [stored], jobKey)]);
    // Without the flag only the body is restored under the fresh fields.
    const { sourceBodyFailureKeepsStoredRecord: _flag, ...plain } = failed;
    const [bodyOnly] = keepStoredSourceBodiesByKey([plain], [stored], jobKey);
    expect(bodyOnly.title).toBe('Opportunità generica');
    expect(bodyOnly.description).toBe(BODY);
  });
});
