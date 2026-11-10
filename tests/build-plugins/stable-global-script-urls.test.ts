import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

type ScriptContentVariant = {
  adRecovery: string;
  adsense: string;
  gtag: string;
};

const hash12 = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 12);

async function renderRepresentativePages(variant: ScriptContentVariant): Promise<string[]> {
  vi.resetModules();
  vi.doMock('../../build-plugins/constants', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../build-plugins/constants')>();
    return {
      ...actual,
      AD_RECOVERY_CONTENT: variant.adRecovery,
      AD_RECOVERY_VERSIONED_FILENAME: `site-support-${hash12(variant.adRecovery)}.js`,
      ADSENSE_LOADER_CONTENT: variant.adsense,
      ADSENSE_LOADER_VERSIONED_FILENAME: `adsense-loader-${hash12(variant.adsense)}.js`,
      GTAG_INIT_CONTENT: variant.gtag,
      GTAG_INIT_CONTENT_HASH: hash12(variant.gtag),
      GTAG_INIT_VERSIONED_FILENAME: `gtag-init-${hash12(variant.gtag)}.js`,
      GTAG_INIT_URL: '/assets/gtag-init.js',
      STATIC_PAGE_BUILD_ID: 'stable-global-script-test-build',
      STATIC_BUILD_ID_META_TAG: '<meta name="ft-build-id" content="stable-global-script-test-build">',
    };
  });

  try {
    const { buildSeoPageHtml } = await import('../../build-plugins/shared/seoPageShell');
    const pages = [
      {
        locale: 'it',
        title: 'Offerte di lavoro in Ticino',
        description: 'Hub cantonale delle offerte di lavoro.',
        canonicalUrl: 'https://frontaliereticino.ch/lavoro-ticino/',
        bodyHtml: '<main><h1>Offerte di lavoro</h1><p>Annunci recenti.</p></main>',
      },
      {
        locale: 'it',
        title: 'Tecnico di laboratorio',
        description: 'Annuncio di lavoro in Ticino.',
        canonicalUrl: 'https://frontaliereticino.ch/jobs/tecnico-laboratorio/',
        bodyHtml: '<main><h1>Tecnico di laboratorio</h1><p>Contratto a tempo pieno.</p></main>',
        jsonLdScripts: [JSON.stringify({ '@type': 'JobPosting', title: 'Tecnico di laboratorio' })],
      },
      {
        locale: 'it',
        title: 'Annuncio scaduto',
        description: 'L’annuncio non è più attivo.',
        canonicalUrl: 'https://frontaliereticino.ch/jobs/annuncio-scaduto/',
        robots: 'noindex,follow',
        bodyHtml: '<main><h1>Annuncio scaduto</h1><p>Consulta le posizioni simili.</p></main>',
      },
      {
        locale: 'it',
        title: 'Ricerche correlate: lavoro in Ticino',
        description: 'Ricerche correlate agli annunci in Ticino.',
        canonicalUrl: 'https://frontaliereticino.ch/cerca-lavoro-ticino/ricerche-correlate/',
        seoMainClass: 'cluster-seo-prose',
        bodyHtml: '<main><h1>Ricerche correlate</h1><p>Esplora le ricerche vicine.</p></main>',
      },
    ] as const;

    return pages.map((page) => buildSeoPageHtml(page));
  } finally {
    vi.doUnmock('../../build-plugins/constants');
    vi.resetModules();
  }
}

describe('static global script URLs', () => {
  it('keeps representative shell HTML byte-identical when only producer bytes and hashes change', async () => {
    const before = await renderRepresentativePages({
      adRecovery: 'window.adRecoveryRevision = 1;',
      adsense: 'window.adsenseRevision = 1;',
      gtag: 'window.gtagRevision = 1;',
    });
    const after = await renderRepresentativePages({
      adRecovery: 'window.adRecoveryRevision = 2;',
      adsense: 'window.adsenseRevision = 2;',
      gtag: 'window.gtagRevision = 2;',
    });

    expect(after).toEqual(before);
    for (const html of after) {
      expect(html).toContain('/assets/site-support.js');
      expect(html).toContain('/assets/adsense-loader.js');
      expect(html).toContain('/assets/gtag-init.js');
      expect(html).toContain('/assets/meta-pixel-base-code.js');
      expect(html).toContain('/assets/partnerize-tag.js');
      expect(html).not.toMatch(/(?:site-support|adsense-loader|gtag-init|meta-pixel-base-code|partnerize-tag)-[a-f0-9]{12}\.js/);
    }
  });
});
