import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { employerProfileJobLinksPlugin } from '../build-plugins/employerProfileJobLinksPlugin';
import {
  _resetJobsSeoPagesSignalForTests,
  registerJobsSeoPagesProducer,
  resolveEmployerProfilesFlushed,
  resolveJobsSeoPagesFlushed,
  setJobSitemapAllowlist,
  type EmittedEmployerProfile,
} from '../build-plugins/shared/buildSignals';

describe('employer profile job links completion barrier', () => {
  it('waits for jobs SEO before checking dist created during closeBundle', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'employer-profile-links-barrier-'));
    const previousFastBuild = process.env.FAST_BUILD;
    const previousSkip = process.env.SKIP_EMPLOYER_PROFILE_PAGES;
    const activePath = '/cerca-lavoro-ticino/active-job/';
    const stalePath = '/cerca-lavoro-ticino/stale-job/';
    const profile: EmittedEmployerProfile = {
      locale: 'it',
      path: 'aziende/acme/',
      label: 'Acme',
      indexable: true,
      companyKey: 'acme',
    };
    let pluginRun: Promise<void> | undefined;
    let finished = false;
    delete process.env.FAST_BUILD;
    delete process.env.SKIP_EMPLOYER_PROFILE_PAGES;
    _resetJobsSeoPagesSignalForTests();
    registerJobsSeoPagesProducer();

    try {
      const plugin = employerProfileJobLinksPlugin(root) as { closeBundle: () => Promise<void> };
      pluginRun = plugin.closeBundle().then(() => { finished = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(finished).toBe(false);
      expect(fs.existsSync(path.join(root, 'dist'))).toBe(false);

      const profilePath = path.join(root, 'dist', profile.path, 'index.html');
      fs.mkdirSync(path.dirname(profilePath), { recursive: true });
      fs.writeFileSync(profilePath, [
        '<ul>',
        `<li><article class="jc-card"><a href="${stalePath}">Stale</a></article></li>`,
        `<li><article class="jc-card"><a href="${activePath}">Active</a></article></li>`,
        '</ul>',
      ].join(''));
      setJobSitemapAllowlist(new Set([`https://frontaliereticino.ch${activePath}`]));
      resolveEmployerProfilesFlushed([profile]);
      resolveJobsSeoPagesFlushed();
      await pluginRun;
      pluginRun = undefined;

      const filtered = fs.readFileSync(profilePath, 'utf-8');
      expect(filtered).toContain(activePath);
      expect(filtered).not.toContain(stalePath);
    } finally {
      resolveEmployerProfilesFlushed([profile]);
      resolveJobsSeoPagesFlushed();
      if (pluginRun) await pluginRun.catch(() => undefined);
      fs.rmSync(root, { recursive: true, force: true });
      if (previousFastBuild === undefined) delete process.env.FAST_BUILD;
      else process.env.FAST_BUILD = previousFastBuild;
      if (previousSkip === undefined) delete process.env.SKIP_EMPLOYER_PROFILE_PAGES;
      else process.env.SKIP_EMPLOYER_PROFILE_PAGES = previousSkip;
      _resetJobsSeoPagesSignalForTests();
    }
  });

  it('returns in FAST_BUILD without waiting for an absent jobs producer', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'employer-profile-links-fast-build-'));
    const previousFastBuild = process.env.FAST_BUILD;
    delete process.env.FAST_BUILD;
    process.env.FAST_BUILD = '1';
    _resetJobsSeoPagesSignalForTests();
    try {
      const plugin = employerProfileJobLinksPlugin(root) as { closeBundle: () => Promise<void> };
      await plugin.closeBundle();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      if (previousFastBuild === undefined) delete process.env.FAST_BUILD;
      else process.env.FAST_BUILD = previousFastBuild;
      _resetJobsSeoPagesSignalForTests();
    }
  });
});
