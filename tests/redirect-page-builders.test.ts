import { describe, expect, it } from 'vitest';
import { buildFlatRedirect } from '@/build-plugins/constants';

describe('SEO alias pages', () => {
  it('emits a canonical bridge page for flat aliases', () => {
    const html = buildFlatRedirect(
      'https://www.frontaliereticino.ch/de/statistiken/beste-grenzgemeinden/',
      '/de/statistiken/beste-grenzgemeinden/',
    );

    expect(html).not.toContain('http-equiv="refresh"');
    expect(html).not.toContain('location.replace(');
    expect(html).toContain('rel="canonical"');
    expect(html).toContain('href="https://www.frontaliereticino.ch/de/statistiken/beste-grenzgemeinden/"');
    expect(html).toContain('Apri la versione canonica');
  });
});
