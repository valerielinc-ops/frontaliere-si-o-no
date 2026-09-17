import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { localizeJob } from '../scripts/localize-vf-existing-jobs.mjs';
import { resolveVfSwissLocation } from '../scripts/lib/vf-job-parser.mjs';

describe('VF localization flow', () => {
  it('runs fallback locale translation after the shared crawler', () => {
    const file = path.resolve(process.cwd(), 'scripts', 'update-vf-jobs.mjs');
    const source = fs.readFileSync(file, 'utf-8');

    expect(source).toContain('runDedicatedBaseCrawler');
    expect(source).toContain('translateMissingJobLocales');
    expect(source).toMatch(/await runBaseCrawler\(\);[\s\S]*await translateMissingJobLocales\(/);
  });

  it('clears a pre-existing short title and queues the job when replacement fails', async () => {
    const translate = vi.fn().mockResolvedValue('');
    const result = await localizeJob({
      title: 'Software Engineer',
      description: '',
      titleByLocale: {
        en: 'Software Engineer',
        it: 'AB',
        de: 'Ingenieur',
        fr: 'Ingénieur',
      },
      descriptionByLocale: {},
    }, { translate });

    expect(result.titleByLocale.it).toBe('');
    expect(result.needsRetranslation).toBe(true);
    expect(translate).toHaveBeenCalledWith(expect.objectContaining({
      targetLang: 'it',
      minChars: 3,
    }));
  });

  it('resolves the city from hierarchical Workday labels across Swiss cantons', () => {
    expect(resolveVfSwissLocation('EMEA · CHE · Stabio · VF Campus VF1'))
      .toEqual({ locality: 'Stabio', canton: 'TI' });
    expect(resolveVfSwissLocation('EMEA · CHE · Landquart · Outlet - NAP'))
      .toEqual({ locality: 'Landquart', canton: 'GR' });
    expect(resolveVfSwissLocation('EMEA · USA · New York')).toBeNull();
    expect(resolveVfSwissLocation('CHE')).toBeNull();
  });
});
