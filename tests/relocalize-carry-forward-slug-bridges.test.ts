/**
 * previousSlugs writer regression — sibling of the class fixed in
 * scatter-jobs-to-slices.mjs (see tests/scatter-jobs-carry-forward-bridges.test.ts
 * and issues #4165/#4161/#4134/#4112/#4102/#4088/#4076/#3885/#3734/#4208), but
 * in relocalize-pending-jobs.mjs's syncTranslationsToCrawlerFile.
 *
 * Root cause (traced from production commit ad6d49549f, KSA jobs
 * ksa-efaa616bf2a8 / ksa-2819d31aa5ae / ksa-a83440f6b2be — the same
 * "Dipl. Pflegefachfrau/Pflegefachmann" family already involved in the
 * cross-job identity bug fixed in tests/relocalize-sync-job-identity.test.ts):
 *
 * An assembler-side legitimate rename (for example trackSlugHistoryDrift)
 * can capture a displaced value into the ASSEMBLED job's
 * previousSlugsByLocale. But syncTranslationsToCrawlerFile — the function
 * that writes assembled-dataset changes back onto the committed per-crawler
 * slice — only ever unioned the flat legacy `previousSlugs` array here, never
 * `previousSlugsByLocale`. So the captured bridge never reached the committed
 * slice: the active slug changed, but its history did not, producing a silent
 * loss with no redirect bridge for the old URL.
 *
 * The fix reuses scatter-jobs-to-slices.mjs's own (already tested, cap- and
 * headroom-aware) collectMissingAssembledBridges helper via the new
 * carryForwardMissingSlugBridges wrapper, instead of a second hand-rolled
 * flat-only implementation.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stableSlugHash } from '../scripts/lib/dedicated-crawler-common.mjs';
import {
  carryForwardMissingSlugBridges,
  repairPreviousSlugOwnership,
} from '../scripts/relocalize-pending-jobs.mjs';

describe('carryForwardMissingSlugBridges (relocalize sibling of the scatter carry-forward fix)', () => {
  it('carries forward a legitimate per-locale bridge captured on the assembled side but missing from the slice', () => {
    // Shape mirrors a source rename: the assembled job already knows the old
    // DE route, but the slice's own crawlerJob has no record of it yet.
    const crawlerJob = {
      id: 'ksa-efaa616bf2a8',
      slug: 'dipl-pflegefachfrau-pflegefachmann-ksa-ch-5',
      sourceLang: 'de',
      slugByLocale: {
        it: 'dipl-pflegefachfrau-pflegefachmann-ksa-ch-5',
        en: 'registered-nurse-nursing-professional-kantonsspital-aarau-ksa-aarau',
        de: 'dipl-pflegefachfrau-pflegefachmann-kantonsspital-aarau-ksa-aarau',
        fr: 'dipl-pflegefachfrau-pflegefachmann-ksa-ch-2',
      },
      previousSlugs: [],
      previousSlugsByLocale: {},
    };

    const assembled = {
      ...crawlerJob,
      // Collision guard already demoted DE on the assembled side and
      // captured the displaced value.
      slugByLocale: {
        ...crawlerJob.slugByLocale,
        de: 'dipl-pflegefachfrau-pflegefachmann-ksa-ch',
      },
      previousSlugs: ['dipl-pflegefachfrau-pflegefachmann-kantonsspital-aarau-ksa-aarau'],
      previousSlugsByLocale: {
        de: ['dipl-pflegefachfrau-pflegefachmann-kantonsspital-aarau-ksa-aarau'],
      },
    };

    const added = carryForwardMissingSlugBridges(crawlerJob, assembled);

    expect(added).toBe(true);
    // The bridge for the displaced DE slug must now exist on the slice job —
    // before the fix this was silently dropped.
    expect(crawlerJob.previousSlugsByLocale.de).toContain(
      'dipl-pflegefachfrau-pflegefachmann-kantonsspital-aarau-ksa-aarau',
    );
    expect(crawlerJob.previousSlugs).toContain(
      'dipl-pflegefachfrau-pflegefachmann-kantonsspital-aarau-ksa-aarau',
    );
  });

  it('is a no-op when the slice already holds every assembled bridge', () => {
    const crawlerJob = {
      id: 'company-abc',
      slug: 's-it',
      slugByLocale: { it: 's-it', en: 's-en' },
      previousSlugs: ['bridge-old'],
      previousSlugsByLocale: { en: ['bridge-old'] },
    };
    const assembled = {
      ...crawlerJob,
      previousSlugs: ['bridge-old'],
      previousSlugsByLocale: { en: ['bridge-old'] },
    };

    expect(carryForwardMissingSlugBridges(crawlerJob, assembled)).toBe(false);
  });

  it('mutates crawlerJob in place and returns true only when a bridge was actually added', () => {
    const crawlerJob = {
      id: 'company-xyz',
      slug: 's-it',
      slugByLocale: { it: 's-it', fr: 's-fr' },
      previousSlugs: [],
      previousSlugsByLocale: {},
    };
    const assembled = {
      ...crawlerJob,
      previousSlugs: ['legacy-fr-bridge'],
      previousSlugsByLocale: { fr: ['legacy-fr-bridge'] },
    };

    const added = carryForwardMissingSlugBridges(crawlerJob, assembled);
    expect(added).toBe(true);
    expect(crawlerJob.previousSlugsByLocale.fr).toContain('legacy-fr-bridge');

    // Calling it again with the now-updated crawlerJob is idempotent.
    const addedAgain = carryForwardMissingSlugBridges(crawlerJob, assembled);
    expect(addedAgain).toBe(false);
  });

  it('repairs cross-file previous-slug ownership and proves the second pass is a no-op', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relocalize-ownership-'));
    try {
      const owner = {
        id: 'owner-job',
        url: 'https://jobs.example.test/owner-job',
        slug: 'owner-current',
        slugByLocale: { it: 'owner-current' },
        previousSlugs: [],
        previousSlugsByLocale: {},
      };
      const claimant = {
        id: 'claimant-job',
        url: 'https://jobs.example.test/claimant-job',
        slug: 'claimant-current',
        slugByLocale: { it: 'claimant-current' },
        previousSlugs: [`owner-old-${stableSlugHash(owner)}`],
        previousSlugsByLocale: {
          en: [`owner-old-${stableSlugHash(owner)}`],
        },
      };
      fs.writeFileSync(path.join(directory, 'owner.json'), JSON.stringify({ jobs: [owner] }));
      fs.writeFileSync(path.join(directory, 'claimant.json'), JSON.stringify({ jobs: [claimant] }));

      const first = repairPreviousSlugOwnership(directory);
      expect(first.applied.moved).toBe(2);
      expect(first.residual.moved).toBe(0);
      expect(JSON.parse(fs.readFileSync(path.join(directory, 'owner.json'), 'utf8')).jobs[0].previousSlugs)
        .toContain(`owner-old-${stableSlugHash(owner)}`);
      expect(JSON.parse(fs.readFileSync(path.join(directory, 'claimant.json'), 'utf8')).jobs[0].previousSlugs)
        .not.toContain(`owner-old-${stableSlugHash(owner)}`);

      const second = repairPreviousSlugOwnership(directory);
      expect(second.applied.moved).toBe(0);
      expect(second.applied.emptyLocaleBucketsPruned).toBe(0);
      expect(second.residual.moved).toBe(0);
      expect(second.residual.emptyLocaleBucketsPruned).toBe(0);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
