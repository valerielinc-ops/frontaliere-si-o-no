// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  buildJobSearchHref,
  isJobBoardPath,
} from '../components/shared/JobSearchFloatingButton';

describe('job-search floating button routing', () => {
  it.each([
    ['it', '/cerca-lavoro-svizzera/'],
    ['en', '/en/find-jobs-switzerland/'],
    ['de', '/de/jobs-in-schweiz/'],
    ['fr', '/fr/trouver-emploi-suisse/'],
  ] as const)('builds the canonical %s aggregator path', (locale, expected) => {
    expect(buildJobSearchHref(locale)).toBe(expected);
  });

  it.each([
    '/cerca-lavoro-svizzera/',
    '/cerca-lavoro-ticino/lugano/',
    '/en/find-jobs-switzerland/search-engineer/',
    '/de/jobs-in-schweiz/',
    '/de/jobs-im-tessin/',
    '/fr/trouver-emploi-suisse/recherche-infirmier/',
  ])('hides on job-board paths: %s', (pathname) => {
    expect(isJobBoardPath(pathname)).toBe(true);
  });

  it.each(['/', '/calcola-stipendio/', '/blog/', '/lavorare-in-svizzera/'])(
    'stays visible on non-job paths: %s',
    (pathname) => {
      expect(isJobBoardPath(pathname)).toBe(false);
    },
  );
});
