import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { newsletterPreferencesPagesPlugin } from '../build-plugins/newsletterPreferencesPagesPlugin';
import { SLUG_TABLES } from '../services/routeSlugs.data';

describe('newsletter preference cold-entry shells', () => {
  it('emits four noindex bootstraps without redirects or subscriber data', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newsletter-shells-'));
    try {
      const plugin = newsletterPreferencesPagesPlugin(root);
      await (plugin.closeBundle as () => void)();
      for (const locale of ['it', 'en', 'de', 'fr'] as const) {
        const route = `${locale === 'it' ? '' : `/${locale}`}/${SLUG_TABLES[locale].newsletterPreferences}/`;
        const html = fs.readFileSync(path.join(root, 'dist', route, 'index.html'), 'utf8');
        const document = new JSDOM(html).window.document;
        expect(document.documentElement.lang).toBe(locale);
        expect(document.querySelector('meta[name=robots]')?.getAttribute('content')).toBe('noindex,follow');
        expect(html).toContain(`https://frontaliereticino.ch${route}`);
        expect(html).toContain('/assets/index-entry.js');
        expect(html).not.toMatch(/http-equiv="refresh"|location\.(?:replace|assign)|location\.href\s*=/);
        expect(html).not.toContain('seo-static-content');
        expect(html).not.toContain('token=');
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
