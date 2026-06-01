/**
 * Verifies the registry pin stays authoritative at the mergeAndDeduplicate
 * chokepoint after the source-copy rule was de-duplicated into the shared
 * registryPinnedLocaleSlug helper. A registered job whose fresh crawl carries a
 * re-translated (drifted) per-locale slug must be restored to the immutable
 * registry slug, with the drift demoted to previousSlugs.
 *
 * Uses SLUG_REGISTRY_PATH_OVERRIDE to inject a controlled registry instead of
 * the real 10k-entry file (also keeps the real registry untouched by the test).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const URL_3164 = 'https://recruitingapp-2908.umantis.com/Vacancies/3164/Description/1';
const LOCKED_EN = 'assistant-psychologist-or-specialist-psychologist-upd-bern';
const DRIFT_EN = 'psychology-assistant-specialized-psychologist-assistant-upd-bern';

const tmpFiles: string[] = [];
afterEach(() => {
  delete process.env.SLUG_REGISTRY_PATH_OVERRIDE;
  for (const f of tmpFiles.splice(0)) {
    try { fs.unlinkSync(f); } catch { /* gone */ }
  }
});

describe('mergeAndDeduplicate registry authority (post source-copy dedup)', () => {
  it('restores a registered locale slug when the fresh crawl brings a drifted one', async () => {
    const registry = {
      'id|umantis.com|3164': {
        canonicalSlug: 'psicologo-a-assistente-upd-bern',
        slugByLocale: {
          it: 'psicologo-a-assistente-upd-bern',
          en: LOCKED_EN,
          de: 'assistenzpsychologin-upd-bern',
          fr: 'psychologue-assistant-e-upd-bern',
        },
      },
    };
    const regPath = path.join(os.tmpdir(), `merge-auth-reg-${process.pid}.json`);
    fs.writeFileSync(regPath, JSON.stringify(registry), 'utf-8');
    tmpFiles.push(regPath);
    process.env.SLUG_REGISTRY_PATH_OVERRIDE = regPath;

    const { mergeAndDeduplicate } = await import('../scripts/lib/dedicated-crawler-common.mjs');

    const base = {
      id: 'umantis-3164',
      url: URL_3164,
      title: 'Assistenzpsychologin',
      company: 'UPD',
      location: 'Bern',
      sourceLang: 'de',
      description: 'x'.repeat(200),
      crawledAt: '2026-05-20T10:00:00Z',
      source: 'Company Careers Crawler',
      titleByLocale: { it: 'Psicologo', en: 'Psychology Assistant', de: 'Assistenzpsychologin', fr: 'Psychologue' },
    };
    // Fresh crawl carries a re-translated (drifted) EN slug as the ACTIVE slug
    // (no prior good slug to win over it), so the registry pin — not the
    // existing-wins merge rule — is what must correct it.
    const freshCrawl = { ...base, crawledAt: '2026-06-01T10:00:00Z', slug: 'psicologo-a-assistente-upd-bern', slugByLocale: { it: 'psicologo-a-assistente-upd-bern', en: DRIFT_EN, de: 'assistenzpsychologin-upd-bern', fr: 'psychologue-assistant-e-upd-bern' } };

    const result = mergeAndDeduplicate([], [freshCrawl], {});
    const merged = result.merged.find((j: { url: string }) => j.url === URL_3164);

    // Registry slug wins over the drifted crawl slug.
    expect(merged.slugByLocale.en).toBe(LOCKED_EN);

    // The drift is preserved as a bridge so the legacy URL keeps resolving.
    const enPrev = merged.previousSlugsByLocale?.en || [];
    const allPrev = [...enPrev, ...(merged.previousSlugs || [])];
    expect(allPrev).toContain(DRIFT_EN);
  });
});
