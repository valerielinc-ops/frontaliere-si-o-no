import { describe, it, expect } from 'vitest';
import { isJobBoardLandingPath } from '../../build-plugins/jobBoardSeo';

describe('isJobBoardLandingPath canton-aware (Phase 7.3)', () => {
  it.each([
    // Legacy TI landings — invariance preserved.
    ['/cerca-lavoro-ticino/', true],
    ['/cerca-lavoro-ticino', true], // trailing-slash-optional
    ['/en/find-jobs-ticino/', true],
    ['/de/jobs-im-tessin/', true],
    ['/fr/trouver-emploi-tessin/', true],

    // Non-TI cantons — IT.
    ['/cerca-lavoro-zurigo/', true],
    ['/cerca-lavoro-vallese/', true],
    ['/cerca-lavoro-argovia/', true],

    // Aggregator (Switzerland-wide).
    ['/cerca-lavoro-svizzera/', true],
    ['/en/find-jobs-switzerland/', true],
    ['/fr/trouver-emploi-suisse/', true],

    // Non-TI cantons — EN.
    ['/en/find-jobs-zurich/', true],
    ['/en/find-jobs-bern/', true],

    // Non-TI cantons — DE. Includes the "im" / "in" / "in der" prefix variants.
    ['/de/jobs-in-zurich/', true],
    ['/de/jobs-in-der-waadt/', true],
    ['/de/jobs-im-aargau/', true],
    ['/de/jobs-im-thurgau/', true],
    ['/de/jobs-im-jura/', true],
    ['/de/jobs-im-wallis/', true],

    // Non-TI cantons — FR.
    ['/fr/trouver-emploi-zurich/', true],
    ['/fr/trouver-emploi-geneve/', true],
    ['/fr/trouver-emploi-vaud/', true],

    // Sub-pages — must NOT match (they are NOT landings).
    ['/cerca-lavoro-ticino/lugano/', false],
    ['/cerca-lavoro-ticino/job-foo-bar/', false],
    ['/cerca-lavoro-ticino/azienda-bps/', false],
    ['/cerca-lavoro-zurigo/zurich/', false],
    ['/de/jobs-in-der-waadt/lausanne/', false],

    // Unrelated pages.
    ['/', false],
    ['/calcola-stipendio/', false],
    ['/en/calculate-salary/', false],
    ['/articoli-frontaliere/', false],

    // Edge: empty / nonsense.
    ['', false],
    ['/cerca-lavoro/', false], // missing canton/aggregator suffix
    ['/jobs-in-/', false],
  ])('isJobBoardLandingPath(%s) === %s', (path, expected) => {
    expect(isJobBoardLandingPath(path)).toBe(expected);
  });
});
