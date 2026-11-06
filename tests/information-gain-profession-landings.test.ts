import { describe, expect, it } from 'vitest';
import { buildProfessionLandingCopy, buildProfessionLandingSections } from '../build-plugins/professionLandingsCopy';
import { buildProfessionLandingPath, type ProfessionId } from '../build-plugins/professionLandingsData';
import { fingerprintPage, scoreCohorts } from '../scripts/lib/informationGain.mjs';

// The same ten-role sample used by the recurring production cohort report.
const SAMPLE_PROFESSIONS = [
  'muratore',
  'fisioterapista',
  'educatore',
  'macellaio',
  'elettricista',
  'infermiere',
  'ingegnere',
  'autista',
  'cuoco',
  'cameriere',
] as const satisfies readonly ProfessionId[];

describe('profession landing copy information gain — #12409', () => {
  it('keeps the ten-page Italian copy cohort at or above the existing 40% target', () => {
    const fingerprints = SAMPLE_PROFESSIONS.map((id) => {
      const copy = buildProfessionLandingCopy('it', id, { liveCount: 3, fresh30Count: 1 });
      const sections = buildProfessionLandingSections('it', id);
      const html = `<!doctype html><html lang="it"><head><title>${copy.title}</title></head><body>
        <h1>${copy.h1}</h1><p>${copy.lede}</p>
        ${sections.map((section) => `<section><h2>${section.title}</h2>${section.paragraphs.map((p) => `<p>${p}</p>`).join('')}</section>`).join('')}
      </body></html>`;
      return fingerprintPage(`${buildProfessionLandingPath('it', id).slice(1)}index.html`, html);
    });

    const { cohorts } = scoreCohorts(fingerprints, {
      minCohortPages: SAMPLE_PROFESSIONS.length,
      includePageScores: true,
    });

    expect(cohorts).toHaveLength(1);
    expect(cohorts[0].label).toBe('it:/lavoro-ticino-');
    expect(cohorts[0].medianIgs).toBeGreaterThanOrEqual(40);
    expect(cohorts[0].zeroGainPages).toBe(0);
  });
});
