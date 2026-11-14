import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { EmittedEmployerProfile } from '../build-plugins/shared/buildSignals';

describe('employer profile pages links completion barrier', () => {
  it('waits for profile and static-page signals before checking dist and injecting links', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'employer-pages-links-barrier-'));
    const previousBuildLocale = process.env.BUILD_LOCALE;
    const previousSkip = process.env.SKIP_EMPLOYER_PROFILE_PAGES;
    let buildSignals: typeof import('../build-plugins/shared/buildSignals') | undefined;
    let pluginRun: Promise<void> | undefined;
    let finished = false;

    process.env.BUILD_LOCALE = 'it';
    delete process.env.SKIP_EMPLOYER_PROFILE_PAGES;
    vi.resetModules();

    try {
      const { employerProfilePagesLinksPlugin } = await import(
        '../build-plugins/employerProfilePagesLinksPlugin'
      );
      buildSignals = await import('../build-plugins/shared/buildSignals');
      const plugin = employerProfilePagesLinksPlugin(root) as {
        closeBundle: () => Promise<void>;
      };
      const distDir = path.join(root, 'dist');
      const profile: EmittedEmployerProfile = {
        locale: 'it',
        path: '/aziende/acme/',
        label: 'Acme',
        indexable: true,
        companyKey: 'acme',
      };

      pluginRun = plugin.closeBundle().then(() => { finished = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(finished).toBe(false);
      expect(fs.existsSync(distDir)).toBe(false);

      const sitemapPath = path.join(distDir, 'mappa-del-sito', 'index.html');
      fs.mkdirSync(path.dirname(sitemapPath), { recursive: true });
      fs.writeFileSync(sitemapPath, '<main></main>', 'utf8');

      buildSignals.resolveEmployerProfilesFlushed([profile]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(finished).toBe(false);

      buildSignals.resolveStaticPagesFlushed();
      await pluginRun;
      pluginRun = undefined;

      const injected = fs.readFileSync(sitemapPath, 'utf8');
      expect(injected).toContain('data-employer-profiles-links');
      expect(injected).toContain('/aziende/acme/');
    } finally {
      buildSignals?.resolveEmployerProfilesFlushed([]);
      buildSignals?.resolveStaticPagesFlushed();
      if (pluginRun) await pluginRun.catch(() => undefined);
      fs.rmSync(root, { recursive: true, force: true });
      if (previousBuildLocale === undefined) delete process.env.BUILD_LOCALE;
      else process.env.BUILD_LOCALE = previousBuildLocale;
      if (previousSkip === undefined) delete process.env.SKIP_EMPLOYER_PROFILE_PAGES;
      else process.env.SKIP_EMPLOYER_PROFILE_PAGES = previousSkip;
      vi.resetModules();
    }
  });
});
