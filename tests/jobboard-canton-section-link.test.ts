import { describe, it, expect } from 'vitest';
import { buildPath, parsePath, registerJobSlugMap, getJobMetaForSlug } from '@/services/router';
import { resolveJobCanton } from '@/build-plugins/shared/cantonSection';

/**
 * Regression: job-board links must use the job's OWN canton section, not the
 * legacy TI default. Bug report: on /cerca-lavoro-zurigo/ the per-job links
 * pointed to /cerca-lavoro-ticino/<slug>/. Root cause was the SPA building
 * job-board paths via buildPath() WITHOUT jobBoardCanton, collapsing every
 * non-TI link onto table.jobBoard ('cerca-lavoro-ticino').
 *
 * These tests lock the two ingredients the fix relies on:
 *  - buildPath() emits the canton-aware section when jobBoardCanton is set;
 *  - the canton can be recovered from the job (resolveJobCanton, used in the
 *    object branch of buildJobPath) and from the slug map (getJobMetaForSlug,
 *    used in the string branch + cross-component sibling fixes).
 */
describe('job-board canton section links', () => {
  const ZH_JOB = {
    canton: 'ZH',
    location: 'Zürich',
    slug: 'dipl-pflegefachperson-hf-fh-privatklinik-bethanien-zurich',
  };

  it('buildPath emits the job canton section for a non-TI job', () => {
    const path = buildPath(
      { activeTab: 'job-board', jobBoardCanton: 'ZH', jobSlug: ZH_JOB.slug },
      'it',
    );
    expect(path).toBe(`/cerca-lavoro-zurigo/${ZH_JOB.slug}/`);
    // …and round-trips back to the ZH canton (no collapse to TI).
    expect(parsePath(path).route.jobBoardCanton).toBe('ZH');
  });

  it('without jobBoardCanton it falls back to the legacy TI section (documents the old bug)', () => {
    const path = buildPath({ activeTab: 'job-board', jobSlug: ZH_JOB.slug }, 'it');
    expect(path).toBe(`/cerca-lavoro-ticino/${ZH_JOB.slug}/`);
  });

  it('resolveJobCanton drives the object branch of buildJobPath', () => {
    const canton = resolveJobCanton(ZH_JOB);
    expect(canton).toBe('ZH');
    const path = buildPath(
      { activeTab: 'job-board', jobBoardCanton: canton, jobSlug: ZH_JOB.slug },
      'it',
    );
    expect(path).toBe(`/cerca-lavoro-zurigo/${ZH_JOB.slug}/`);
  });

  it('TI jobs keep the legacy TI section unchanged', () => {
    const tiPath = buildPath(
      { activeTab: 'job-board', jobBoardCanton: resolveJobCanton({ canton: 'TI', location: 'Lugano' }), jobSlug: 'capo-progetto-lugano' },
      'it',
    );
    expect(tiPath).toBe('/cerca-lavoro-ticino/capo-progetto-lugano/');
  });

  it('getJobMetaForSlug exposes the canton for the slug-map (string) branch', () => {
    registerJobSlugMap([{ id: 'zh1', canton: 'ZH', slug: ZH_JOB.slug, slugByLocale: { it: ZH_JOB.slug } }]);
    expect(getJobMetaForSlug(ZH_JOB.slug)?.canton).toBe('ZH');
    const canton = getJobMetaForSlug(ZH_JOB.slug)?.canton;
    const path = buildPath(
      { activeTab: 'job-board', ...(canton ? { jobBoardCanton: canton } : {}), jobSlug: ZH_JOB.slug },
      'it',
    );
    expect(path).toBe(`/cerca-lavoro-zurigo/${ZH_JOB.slug}/`);
  });
});
