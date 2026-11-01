import { describe, expect, it } from 'vitest';
import { ARTICLE_TRANSPARENCY } from '../packages/articles/engine/shared/aiDisclosure';
import { JOB_META_LABELS, jobMetaLocale } from '../services/jobMetaLabels';

describe('disclaimer nel box di trasparenza', () => {
  it.each(['it', 'en', 'de', 'fr'] as const)('%s ha il disclaimer visibile', locale => {
    expect(ARTICLE_TRANSPARENCY[locale].disclaimer.length).toBeGreaterThan(30);
  });
});

describe('etichette degli annunci', () => {
  it('non restano in italiano nelle altre lingue', () => {
    expect(JOB_META_LABELS[jobMetaLocale('en')].category).toBe('Category');
    expect(JOB_META_LABELS[jobMetaLocale('de')].salary).toBe('Gehalt');
    expect(JOB_META_LABELS[jobMetaLocale('fr')].contract).toBe('Contrat');
  });
});
