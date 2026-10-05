import { describe, expect, it } from 'vitest';
import {
  BORDER_WAIT_LEGACY_REDIRECTS,
  BORDER_WAIT_PRIMARY_LEGACY_BASES,
  canonicalizeBorderWaitLinks,
} from '@/build-plugins/shared/borderWaitLegacyRedirects';
import { BORDER_WAIT_CROSSINGS, buildOggiPath, buildRootHubPath } from '@/build-plugins/borderWaitData';

describe('border-wait canonical route migration', () => {
  it('bridges every sitemap-backed guide route to the current live vertical', () => {
    for (const [locale, base] of Object.entries(BORDER_WAIT_PRIMARY_LEGACY_BASES)) {
      expect(BORDER_WAIT_LEGACY_REDIRECTS.get(`${base}/`)).toBe(buildRootHubPath(locale as 'it' | 'en' | 'de' | 'fr'));
      for (const crossing of BORDER_WAIT_CROSSINGS) {
        const from = `${base}/${crossing}/`;
        expect(BORDER_WAIT_LEGACY_REDIRECTS.get(from), from).toBe(buildOggiPath(locale as 'it' | 'en' | 'de' | 'fr', crossing));
      }
    }
  });

  it('normalizes the hand-authored crossing aliases without creating redirect chains', () => {
    const aliases = new Map([
      ['/guida-frontaliere/tempi-attesa-dogana/brogeda-chiasso/', '/traffico-dogane/chiasso-brogeda/oggi/'],
      ['/guida-frontaliere/tempi-attesa-dogana/chiasso-centro-ponte-chiasso/', '/traffico-dogane/chiasso-centro/oggi/'],
      ['/guida-frontaliere/tempi-attesa-dogana/gaggiolo-cantello-stabio/', '/traffico-dogane/gaggiolo/oggi/'],
      ['/guida-frontaliere/tempi-attesa-dogana/ponte-chiasso/', '/traffico-dogane/chiasso-centro/oggi/'],
      ['/guida-frontaliere/tempi-attesa-dogana/novazzano/', '/traffico-dogane/bizzarone-novazzano/oggi/'],
      ['/guida-frontaliere/tempi-attesa-dogana/stabio/', '/traffico-dogane/gaggiolo/oggi/'],
      ['/tempi-attesa-confine/chiasso-brogeda/', '/traffico-dogane/chiasso-brogeda/oggi/'],
    ]);

    for (const [from, to] of aliases) {
      expect(BORDER_WAIT_LEGACY_REDIRECTS.get(from), from).toBe(to);
      expect(BORDER_WAIT_LEGACY_REDIRECTS.get(to)).toBeUndefined();
    }
  });

  it('rewrites embedded legacy links to direct canonical targets', () => {
    const html = '<a href="/guida-frontaliere/tempi-attesa-dogana/chiasso-brogeda/">Brogeda</a>'
      + ' <a href="/en/cross-border-guide/border-waiting-times/">Border waits</a>';
    const rewritten = canonicalizeBorderWaitLinks(html);
    expect(rewritten).toContain('href="/traffico-dogane/chiasso-brogeda/oggi/"');
    expect(rewritten).toContain('href="/en/border-wait/"');
    expect(rewritten).not.toContain('border-waiting-times');
  });
});
