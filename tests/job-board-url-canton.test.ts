import { describe, expect, it } from 'vitest';
import { deriveCantonFromJobBoardUrl } from '../functions/src/lib/jobBoardUrlCanton.js';

describe('deriveCantonFromJobBoardUrl', () => {
  it('resolves an Italian (default locale, no prefix segment) job-board URL', () => {
    expect(deriveCantonFromJobBoardUrl('https://frontaliereticino.ch/cerca-lavoro-ticino/some-job/')).toBe('ti');
  });

  it('resolves an English locale-prefixed job-board URL', () => {
    expect(deriveCantonFromJobBoardUrl('https://frontaliereticino.ch/en/find-jobs-geneva/some-job/')).toBe('ge');
  });

  it('resolves a French locale-prefixed job-board URL', () => {
    expect(deriveCantonFromJobBoardUrl('https://frontaliereticino.ch/fr/trouver-emploi-vaud/some-job/')).toBe('vd');
  });

  it('resolves the legacy German jobs-im-tessin URL (TI frozen exception)', () => {
    expect(deriveCantonFromJobBoardUrl('https://frontaliereticino.ch/de/jobs-im-tessin/some-job/')).toBe('ti');
  });

  it('resolves a German dePrefix canton (Aargau: im Aargau)', () => {
    expect(deriveCantonFromJobBoardUrl('https://frontaliereticino.ch/de/jobs-im-aargau/some-job/')).toBe('ag');
  });

  it('resolves a German dePrefix canton with a different preposition (Waadt: in der Waadt)', () => {
    expect(deriveCantonFromJobBoardUrl('https://frontaliereticino.ch/de/jobs-in-der-waadt/some-job/')).toBe('vd');
  });

  it('resolves a plain German job-board URL without dePrefix (Zurich)', () => {
    expect(deriveCantonFromJobBoardUrl('https://frontaliereticino.ch/de/jobs-in-zurich/some-job/')).toBe('zh');
  });

  it('accepts a relative path with no origin', () => {
    expect(deriveCantonFromJobBoardUrl('/cerca-lavoro-ticino/some-job/')).toBe('ti');
  });

  it('returns null for the Switzerland-wide aggregator', () => {
    expect(deriveCantonFromJobBoardUrl('https://frontaliereticino.ch/cerca-lavoro-svizzera/')).toBeNull();
  });

  it('returns null for the ambiguous APPENZELLO group URL', () => {
    expect(deriveCantonFromJobBoardUrl('https://frontaliereticino.ch/cerca-lavoro-appenzello/')).toBeNull();
  });

  it('returns null for the ambiguous BASILEA group URL', () => {
    expect(deriveCantonFromJobBoardUrl('https://frontaliereticino.ch/cerca-lavoro-basilea/')).toBeNull();
  });

  it('returns null for a non-job-board page', () => {
    expect(deriveCantonFromJobBoardUrl('https://frontaliereticino.ch/blog/some-article/')).toBeNull();
  });

  it('returns null for the bare job-board prefix with no canton tail', () => {
    expect(deriveCantonFromJobBoardUrl('https://frontaliereticino.ch/cerca-lavoro-/')).toBeNull();
  });

  it('returns null for a malformed URL', () => {
    expect(deriveCantonFromJobBoardUrl('not a url at all: ///')).toBeNull();
  });

  it('returns null for null/undefined/empty input', () => {
    expect(deriveCantonFromJobBoardUrl(null)).toBeNull();
    expect(deriveCantonFromJobBoardUrl(undefined)).toBeNull();
    expect(deriveCantonFromJobBoardUrl('')).toBeNull();
  });

  it('returns null for a root path with no segments', () => {
    expect(deriveCantonFromJobBoardUrl('https://frontaliereticino.ch/')).toBeNull();
  });
});
