import { describe, expect, it } from 'vitest';
import { resolveSearchConsoleCompatTarget } from '@/build-plugins/searchConsoleCompat';

describe('Search Console compatibility for historical German canton sections', () => {
  it.each([
    ['appenzell', 'jobs-in-appenzell'],
    ['basel', 'jobs-in-basel'],
    ['waadt', 'jobs-in-der-waadt'],
  ])('canonicalizes /de/jobs-im-%s/* to /de/%s/', (legacySlug, canonicalSection) => {
    expect(resolveSearchConsoleCompatTarget(`/de/jobs-im-${legacySlug}/old-job-slug/`)).toEqual({
      canonicalPath: `/de/${canonicalSection}/`,
      kind: 'expired-job',
      locale: 'de',
    });
  });
});
