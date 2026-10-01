import { describe, it, expect } from 'vitest';
import { buildJobListEntry } from '../../build-plugins/shared/jobListEntry';

const opts = { locale: 'it', url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/infermiere-lugano/', baseUrl: 'https://frontaliereticino.ch' };
describe('job-list structured data', () => {
  it('links to the detail without declaring a second JobPosting', () => {
    expect(buildJobListEntry({ title: 'Nurse', titleByLocale: { it: 'Infermiere' }, description: 'a'.repeat(4000) }, opts))
      .toEqual({ '@type': 'WebPage', name: 'Infermiere', url: opts.url });
  });
  it('does not invent a listing when the title or detail URL is absent', () => {
    expect(buildJobListEntry({}, opts)).toBeNull();
    expect(buildJobListEntry({ title: 'Infermiere' }, { ...opts, url: '' })).toBeNull();
  });
});
