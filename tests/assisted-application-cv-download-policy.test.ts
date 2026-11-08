import { describe, expect, it } from 'vitest';
import { shouldDownloadOriginalCv } from '../scripts/assisted-application/lib/cv-download-policy.mjs';

describe('assisted application CV download', () => {
  it('downloads the original for drafting or when the candidate selected it', () => {
    const draft = { tailoredCv: { status: 'ready', pdfKey: 'tailored/cv.pdf' } };
    const order = { cvStorageKey: 'original/cv.pdf' };
    expect(shouldDownloadOriginalCv({ mode: 'draft', draft, order })).toBe(true);
    expect(shouldDownloadOriginalCv({ mode: 'submit', draft, flow: { cvChoice: 'original' }, order })).toBe(true);
  });

  it('skips the original when submit sends an existing tailored CV', () => {
    expect(shouldDownloadOriginalCv({
      mode: 'submit',
      draft: { tailoredCv: { status: 'ready', pdfKey: 'tailored/cv.pdf' } },
      flow: { cvChoice: 'tailored' },
      order: { cvStorageKey: 'original/cv.pdf' },
    })).toBe(false);
  });
});
