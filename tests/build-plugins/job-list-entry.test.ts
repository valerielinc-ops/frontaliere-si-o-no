import { describe, it, expect } from 'vitest';
import { buildJobListEntry } from '../../build-plugins/shared/jobListEntry';

const opts = { locale: 'it', url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/infermiere-lugano/', baseUrl: 'https://frontaliereticino.ch' };
describe('job-list structured data', () => {
  it('links to the detail without declaring a second JobPosting', () => {
    expect(buildJobListEntry({ title: 'Nurse', titleByLocale: { it: 'Infermiere' }, description: 'a'.repeat(4000) }, opts))
      .toEqual({ '@type': 'WebPage', name: 'Infermiere', url: opts.url });
  });
  it('uses the display title in JSON-LD when a translation contains AI narrative', () => {
    const narrative = 'I need to see the current job data before translating: **Assistente vendite 80%** However, the translation breaks down because the context is missing.';
    expect(buildJobListEntry({ title: 'Sales assistant', titleByLocale: { it: narrative } }, opts))
      .toEqual({ '@type': 'WebPage', name: 'Assistente vendite 80%', url: opts.url });
  });
  it('does not invent a listing when the title or detail URL is absent', () => {
    expect(buildJobListEntry({}, opts)).toBeNull();
    expect(buildJobListEntry({ title: 'Infermiere' }, { ...opts, url: '' })).toBeNull();
  });
});
