import { describe, expect, it } from 'vitest';
import {
  classifyJobPhoto,
  selectJobOgPhoto,
} from '../../build-plugins/shared/jobPhotoClassification';
import {
  JOB_OG_IMAGE_VERSION,
  versionedJobOgImageUrl,
} from '../../build-plugins/shared/jobOgImageVersion.mjs';

describe('classifyJobPhoto', () => {
  it('uses the occupation in Italian title before the employer sector', () => {
    const job = {
      category: 'Sanità / Ospedali',
      sector: 'Sanità / Ospedali',
      titleByLocale: {
        it: 'Responsabile di progetto nel settore edile',
      },
      title: 'Projektleiterin / Projektleiter Bau',
    };

    expect(classifyJobPhoto(job)).toBe('trades');
    expect(selectJobOgPhoto(job, 'puk-project-manager')).toEqual({
      photoKey: 'trades',
      urlPhotoKey: 'trades',
    });
  });

  it('keeps an explicitly clinical occupation in the healthcare category', () => {
    expect(classifyJobPhoto({
      category: 'Sanità / Ospedali',
      titleByLocale: { it: 'Infermiere / infermiera in cure generali' },
      title: 'Pflegefachfrau / Pflegefachmann',
    })).toBe('healthcare');
  });

  it('does not let a conflicting source-language title override the Italian role', () => {
    expect(classifyJobPhoto({
      category: 'Sanità / Ospedali',
      titleByLocale: { it: 'Venditore / venditrice' },
      title: 'Pflegefachfrau / Pflegefachmann',
    })).toBe('office');
  });

  it('falls back to sector metadata when the title has no occupational clue', () => {
    const job = {
      category: 'Sanità / Ospedali',
      titleByLocale: { it: 'Collaboratore / collaboratrice' },
    };

    expect(classifyJobPhoto(job)).toBe('healthcare');
    expect(selectJobOgPhoto(job, 'generic-healthcare-role').urlPhotoKey).toBeUndefined();
  });

  it('includes the selected fallback photo in the image URL cache key', () => {
    expect(versionedJobOgImageUrl('https://frontaliereticino.ch', 'job-slug', 'trades'))
      .toBe(`https://frontaliereticino.ch/og/jobs/job-slug.webp?v=${JOB_OG_IMAGE_VERSION}&photo=trades`);
  });

  it('keeps the catalog photo key and its cache URL for a top-viewed offer', () => {
    const selection = selectJobOgPhoto(
      { titleByLocale: { it: 'Infermiere / infermiera' } },
      'infermiere-a-in-cure-generali-eoc-ente-ospedaliero-cantonale-novaggio',
    );

    expect(selection).toEqual({ photoKey: 'top-003', urlPhotoKey: 'top-003' });
    expect(versionedJobOgImageUrl(
      'https://frontaliereticino.ch',
      'infermiere-a-in-cure-generali-eoc-ente-ospedaliero-cantonale-novaggio',
      selection.urlPhotoKey,
    )).toBe(`https://frontaliereticino.ch/og/jobs/infermiere-a-in-cure-generali-eoc-ente-ospedaliero-cantonale-novaggio.webp?v=${JOB_OG_IMAGE_VERSION}&photo=top-003`);
  });
});
