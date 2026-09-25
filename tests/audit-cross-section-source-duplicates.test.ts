// tests/audit-cross-section-source-duplicates.test.ts — bucketing per lo
// script di misurazione one-time del follow-up #5849 item 1 ("bonifica
// duplicati cross-sezione già pubblicati").
//
// Non ogni candidato di `listCrossSectionDuplicates` è un vero duplicato di
// contenuto: `discovery://` è un marker di entità (riuso by design), le
// chiavi relative sono riferimenti interni, non fonti news esterne. Solo
// `external` (http/https) è il segnale di "stesso documento di fonte riusato
// in due sezioni" che la issue chiede di misurare.
import { describe, expect, it } from 'vitest';
import { bucketCrossSectionDuplicates } from '../scripts/audit-cross-section-source-duplicates.mjs';

describe('bucketCrossSectionDuplicates', () => {
  it('smista per schema URL: empty / discovery / relative / external', () => {
    const dups = [
      { url: '', sections: [{ section: 'frontaliere', articleId: 'frontaliere' }, { section: 'svizzera', articleId: 'frontalieri-svizzera' }] },
      { url: 'discovery://orphan/pemsa%20lugano', sections: [{ section: 'frontaliere', articleId: 'a' }, { section: 'svizzera', articleId: 'b' }] },
      { url: '/guida-frontaliere/tempi-attesa-dogana/chiasso-centro', sections: [{ section: 'frontaliere', articleId: 'a' }, { section: 'svizzera', articleId: 'b' }] },
      { url: 'https://www.rsi.ch/s/3806396', sections: [{ section: 'frontaliere', articleId: 'a' }, { section: 'svizzera', articleId: 'b' }] },
      { url: 'http://example.org/x', sections: [{ section: 'frontaliere', articleId: 'a' }, { section: 'svizzera', articleId: 'b' }] },
    ];
    const buckets = bucketCrossSectionDuplicates(dups);
    expect(buckets.empty.map((d) => d.url)).toEqual(['']);
    expect(buckets.discovery.map((d) => d.url)).toEqual(['discovery://orphan/pemsa%20lugano']);
    expect(buckets.relative.map((d) => d.url)).toEqual(['/guida-frontaliere/tempi-attesa-dogana/chiasso-centro']);
    expect(buckets.external.map((d) => d.url)).toEqual(['https://www.rsi.ch/s/3806396', 'http://example.org/x']);
  });

  it('input vuoto produce bucket tutti vuoti', () => {
    const buckets = bucketCrossSectionDuplicates([]);
    expect(buckets).toEqual({ empty: [], discovery: [], relative: [], external: [] });
  });
});
