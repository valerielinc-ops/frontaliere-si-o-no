/**
 * The engine module behind the Wikimedia Commons cover credits (P14 S1):
 * packages/articles/engine/shared/imageCredits.mjs.
 *
 * Every surface that shows a cover — static article page, RSS, SPA, corpus
 * generator — goes through this one module, so its rules are pinned here once:
 * the schema-1 validator, the reader, the ImageObject projection that replaces
 * the site's false «© Frontaliere Ticino» claim, and the visible line at the end
 * of the article in the four locales — which public domain and CC0 covers do
 * not get (owner decision 2026-10-05), while their ImageObject stays whole.
 *
 * The reference record is the design's worked example (kuhne-nagel-tagli-posti-
 * ticino-2026 → Commons «Locarno 1.jpg», CC BY-SA 3.0, by Riessdo), built from the
 * real Commons API answer.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  IMAGE_CREDIT_COPY,
  IMAGE_CREDIT_LICENCE_FAMILIES,
  UNKNOWN_AUTHOR_NAME,
  coverKey,
  createImageCreditReader,
  hasVisibleImageCredit,
  imageCreditParts,
  imageObjectCreditFields,
  isAllowedAuthorUrl,
  mediaRssCreditXml,
  normaliseLicenceUrl,
  renderImageCreditHtml,
  validateImageCreditRecord,
  type ImageCreditRecord,
} from '../../packages/articles/engine/shared/imageCredits.mjs';

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object | null ? DeepPartial<T[K]> | null : T[K] };

function locarno(): ImageCreditRecord {
  return {
    schema: 1,
    cover: '/images/blog/kuhne-nagel-tagli-posti-ticino-2026.webp',
    source: 'wikimedia-commons',
    commons: {
      title: 'Locarno 1.jpg',
      pageUrl: 'https://commons.wikimedia.org/wiki/File:Locarno_1.jpg',
      pageId: 15180899,
      width: 2560,
      height: 1920,
      revision: '2011-05-12T01:11:59Z',
    },
    author: {
      text: 'Riessdo at de.wikipedia',
      name: 'Riessdo',
      url: 'https://de.wikipedia.org/wiki/User:Riessdo',
      type: 'Person',
    },
    attribution: null,
    licence: {
      name: 'CC BY-SA 3.0',
      url: 'https://creativecommons.org/licenses/by-sa/3.0/',
      family: 'cc-by-sa',
      attributionRequired: true,
    },
    restrictions: [],
    modified: 'resized',
    fetchedAt: '2026-10-04',
    status: 'ok',
    curation: null,
  };
}

/** The reference record with some fields replaced (one level deep per object). */
function record(overrides: DeepPartial<ImageCreditRecord> = {}): ImageCreditRecord {
  const base = locarno() as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    const current = base[key];
    out[key] = value && typeof value === 'object' && !Array.isArray(value) && current && typeof current === 'object'
      ? { ...(current as object), ...(value as object) }
      : value;
  }
  return out as unknown as ImageCreditRecord;
}

const PD = record({
  commons: { title: 'Lugano prokudin.jpg', pageUrl: 'https://commons.wikimedia.org/wiki/File:Lugano_prokudin.jpg' },
  author: { text: 'Sergei Mikhailovich Prokudin-Gorskii', name: 'Sergei Mikhailovich Prokudin-Gorskii', url: null, type: 'Person' },
  licence: { name: 'Public domain', url: null, family: 'pd', attributionRequired: false },
  modified: 'cropped',
});

const UNKNOWN_PD = record({
  commons: { title: 'Swiss vote.png', pageUrl: 'https://commons.wikimedia.org/wiki/File:Swiss_vote.png' },
  author: { text: null, name: null, url: null, type: 'Person' },
  licence: { name: 'Public domain', url: null, family: 'pd', attributionRequired: false },
});

/** One record per family, from real probe files of that licence. */
const FAMILY_RECORDS: Record<string, ImageCreditRecord> = {
  'cc-by-sa': locarno(),
  'cc-by': record({
    commons: { title: 'Economic growth of Germany.jpg', pageUrl: 'https://commons.wikimedia.org/wiki/File:Economic_growth_of_Germany.jpg' },
    author: { text: 'Max Roser', name: 'Max Roser', url: null, type: 'Person' },
    licence: { name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/', family: 'cc-by', attributionRequired: true },
  }),
  cc0: record({
    commons: { title: 'AI Classroom at Universal Ai University.jpg', pageUrl: 'https://commons.wikimedia.org/wiki/File:AI_Classroom_at_Universal_Ai_University.jpg' },
    author: { text: 'ManoBV16', name: 'ManoBV16', url: null, type: 'Person' },
    licence: { name: 'CC0', url: 'https://creativecommons.org/publicdomain/zero/1.0/', family: 'cc0', attributionRequired: false },
  }),
  pd: PD,
  'no-known-restrictions': record({
    commons: {
      title: 'Classroom problems in the education of gifted children (1917) (14591177510).jpg',
      pageUrl: 'https://commons.wikimedia.org/wiki/File:Classroom_problems_in_the_education_of_gifted_children_(1917)_(14591177510).jpg',
    },
    author: { text: 'Internet Archive Book Images', name: 'Internet Archive Book Images', url: 'https://www.flickr.com/people/126377022@N07', type: 'Organization' },
    licence: { name: 'No restrictions', url: 'https://www.flickr.com/commons/usage/', family: 'no-known-restrictions', attributionRequired: false },
  }),
  fal: record({
    licence: { name: 'FAL', url: 'https://artlibre.org/licence/lal/en', family: 'fal', attributionRequired: true },
  }),
  'other-attribution': record({
    commons: { title: 'General Map of Switzerland.jpg', pageUrl: 'https://commons.wikimedia.org/wiki/File:General_Map_of_Switzerland.jpg' },
    author: { text: 'Federal Office of Topography', name: 'Federal Office of Topography', url: 'https://en.wikipedia.org/wiki/en:Swisstopo', type: 'Organization' },
    licence: { name: 'Attribution-Swisstopo', url: null, family: 'other-attribution', attributionRequired: true },
  }),
};

const LOCALES = ['it', 'en', 'de', 'fr'] as const;

describe('the design worked example (Locarno 1.jpg, CC BY-SA 3.0)', () => {
  it('is a valid schema-1 record', () => {
    expect(validateImageCreditRecord(locarno())).toEqual({ valid: true, errors: [] });
  });

  it('projects exactly the ImageObject fields of the design, §4.2', () => {
    expect(JSON.stringify(imageObjectCreditFields(locarno()))).toBe(
      '{"creator":{"@type":"Person","@id":"https://de.wikipedia.org/wiki/User:Riessdo","name":"Riessdo","url":"https://de.wikipedia.org/wiki/User:Riessdo"},'
      + '"creditText":"Riessdo / Wikimedia Commons","copyrightNotice":"© Riessdo",'
      + '"license":"https://creativecommons.org/licenses/by-sa/3.0/",'
      + '"acquireLicensePage":"https://commons.wikimedia.org/wiki/File:Locarno_1.jpg",'
      + '"isBasedOn":"https://commons.wikimedia.org/wiki/File:Locarno_1.jpg"}',
    );
  });

  it('renders exactly the footer markup of the design, §5.1', () => {
    expect(renderImageCreditHtml(locarno(), 'it')).toBe(
      '<footer class="ft-image-credit mt-8 text-sm text-subtle" data-image-credit="wikimedia-commons"><small>'
      + 'Immagine di copertina: <a href="https://commons.wikimedia.org/wiki/File:Locarno_1.jpg" target="_blank" rel="noopener" class="underline underline-offset-2">«<bdi>Locarno 1</bdi>»</a>'
      + ' di <a href="https://de.wikipedia.org/wiki/User:Riessdo" target="_blank" rel="noopener" class="underline underline-offset-2"><bdi>Riessdo</bdi></a>'
      + ', <a href="https://creativecommons.org/licenses/by-sa/3.0/" target="_blank" rel="noopener" class="underline underline-offset-2">CC BY-SA 3.0</a>'
      + ', tramite Wikimedia Commons (ridimensionata).</small></footer>',
    );
  });

  it('words the line in the four locales of the design, §3', () => {
    const lines = Object.fromEntries(LOCALES.map((l) => [l, imageCreditParts(locarno(), l)!.text]));
    expect(lines).toEqual({
      it: 'Immagine di copertina: «Locarno 1» di Riessdo, CC BY-SA 3.0, tramite Wikimedia Commons (ridimensionata).',
      en: 'Cover image: “Locarno 1” by Riessdo, CC BY-SA 3.0, via Wikimedia Commons (resized).',
      de: 'Titelbild: „Locarno 1“ von Riessdo, CC BY-SA 3.0, via Wikimedia Commons (skaliert).',
      fr: 'Image de couverture : « Locarno 1 » par Riessdo, CC BY-SA 3.0, via Wikimedia Commons (redimensionnée).',
    });
  });
});

describe('every licence family', () => {
  it('has a fixture for each family the schema allows', () => {
    expect(Object.keys(FAMILY_RECORDS).sort()).toEqual([...IMAGE_CREDIT_LICENCE_FAMILIES].sort());
  });

  it.each(Object.entries(FAMILY_RECORDS))('%s: valid, five fields with http(s) URLs, never the site', (family, rec) => {
    expect(validateImageCreditRecord(rec).errors).toEqual([]);
    const ld = imageObjectCreditFields(rec);
    for (const field of ['creator', 'creditText', 'copyrightNotice', 'license', 'acquireLicensePage'] as const) {
      expect(ld[field], `${family}: ${field}`).toBeTruthy();
    }
    expect(new URL(ld.license).protocol).toBe('https:');
    expect(ld.acquireLicensePage).toBe(rec.commons.pageUrl);
    expect(ld.isBasedOn).toBe(rec.commons.pageUrl);
    expect(ld.creator.name).toBe(rec.author.name);
    expect(JSON.stringify(ld)).not.toMatch(/Frontaliere Ticino|Tutti i diritti riservati/);
    // Commons hosts the file; it is never the creator.
    expect(ld.creator.name).not.toMatch(/Wikimedia/);
  });

  it('copyright notice per family: © author for attribution licences, a status for the rest', () => {
    const notices = Object.fromEntries(
      Object.entries(FAMILY_RECORDS).map(([family, rec]) => [family, imageObjectCreditFields(rec).copyrightNotice]),
    );
    expect(notices).toEqual({
      'cc-by-sa': '© Riessdo',
      'cc-by': '© Max Roser',
      cc0: 'CC0',
      pd: 'Public domain',
      'no-known-restrictions': 'No known copyright restrictions',
      fal: '© Riessdo',
      'other-attribution': '© Federal Office of Topography',
    });
  });

  it('licence link: its own URL, the canonical one of the family, else the file page', () => {
    expect(imageObjectCreditFields(FAMILY_RECORDS['cc-by']).license).toBe('https://creativecommons.org/licenses/by/4.0/');
    expect(imageObjectCreditFields(FAMILY_RECORDS.cc0).license).toBe('https://creativecommons.org/publicdomain/zero/1.0/');
    const cc0WithoutUrl = record({ ...FAMILY_RECORDS.cc0, licence: { ...FAMILY_RECORDS.cc0.licence, url: null } });
    expect(imageObjectCreditFields(cc0WithoutUrl).license).toBe('https://creativecommons.org/publicdomain/zero/1.0/');
    expect(imageObjectCreditFields(FAMILY_RECORDS['no-known-restrictions']).license).toBe('https://www.flickr.com/commons/usage/');
    expect(imageObjectCreditFields(FAMILY_RECORDS['other-attribution']).license)
      .toBe('https://commons.wikimedia.org/wiki/File:General_Map_of_Switzerland.jpg');
  });

  it('public domain without a licence URL links the file page and is named in the locale', () => {
    expect(imageObjectCreditFields(PD).license).toBe('https://commons.wikimedia.org/wiki/File:Lugano_prokudin.jpg');
    // No visible line (owner decision 2026-10-05): the localised name lives on
    // in the Media RSS licence.
    expect(LOCALES.map((l) => mediaRssCreditXml(PD, l).match(/>([^<]+)<\/media:license>$/)![1]))
      .toEqual(['pubblico dominio', 'public domain', 'gemeinfrei', 'domaine public']);
  });

  it('Flickr Commons is described, not named, in every locale', () => {
    expect(LOCALES.map((l) => imageCreditParts(FAMILY_RECORDS['no-known-restrictions'], l)!
      .segments.find((s) => s.kind === 'licence')!.text)).toEqual([
      'nessuna restrizione di copyright nota',
      'no known copyright restrictions',
      'keine bekannten urheberrechtlichen Beschränkungen',
      'aucune restriction de droit d’auteur connue',
    ]);
  });

  it('other licence names stay as published', () => {
    expect(imageCreditParts(FAMILY_RECORDS['cc-by'], 'de')!.text).toContain(', CC BY 4.0, via Wikimedia Commons');
    expect(imageCreditParts(FAMILY_RECORDS['other-attribution'], 'fr')!.text).toContain(', Attribution-Swisstopo, via');
  });
});

describe('attribution requested by the licensor', () => {
  const FORTEPAN = record({
    attribution: 'FOTO:FORTEPAN / Angyalföldi Helytörténeti Gyűjtemény',
    author: { text: 'Fortepan', name: 'Fortepan', url: null, type: 'Organization' },
  });

  it('replaces « di {author}» with «, {attribution}» in the visible line', () => {
    expect(imageCreditParts(FORTEPAN, 'it')!.text).toBe(
      'Immagine di copertina: «Locarno 1», FOTO:FORTEPAN / Angyalföldi Helytörténeti Gyűjtemény, CC BY-SA 3.0, tramite Wikimedia Commons (ridimensionata).',
    );
    expect(imageCreditParts(FORTEPAN, 'en')!.text).not.toContain(' by ');
  });

  it('is the credit text; the creator stays the author; the notice is © author', () => {
    const ld = imageObjectCreditFields(FORTEPAN);
    expect(ld.creditText).toBe('FOTO:FORTEPAN / Angyalföldi Helytörténeti Gyűjtemény / Wikimedia Commons');
    expect(ld.creator).toEqual({ '@type': 'Organization', name: 'Fortepan' });
    expect(ld.copyrightNotice).toBe('© Fortepan');
  });

  it('gives a credited Person a stable Schema.org identity', () => {
    const credited = imageObjectCreditFields(locarno()).creator;
    expect(credited).toMatchObject({
      '@type': 'Person',
      '@id': 'https://de.wikipedia.org/wiki/User:Riessdo',
      name: 'Riessdo',
      url: 'https://de.wikipedia.org/wiki/User:Riessdo',
    });
  });

  it('a ©-prefixed attribution is the copyright notice verbatim', () => {
    const eu = record({
      attribution: '© European Union, 2026',
      author: { text: 'European Commission', name: 'European Commission', url: null, type: 'Organization' },
      licence: { name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/', family: 'cc-by', attributionRequired: true },
    });
    expect(imageObjectCreditFields(eu).copyrightNotice).toBe('© European Union, 2026');
    expect(imageObjectCreditFields(eu).creditText).toBe('© European Union, 2026 / Wikimedia Commons');
  });

  it('does not suffix «/ Wikimedia Commons» twice', () => {
    const yann = record({ attribution: '© Yann Forget / Wikimedia Commons' });
    expect(imageObjectCreditFields(yann).creditText).toBe('© Yann Forget / Wikimedia Commons');
  });

  it('does not name Commons twice in the line either: the attribution verbatim, no «via Wikimedia Commons»', () => {
    // The licensor's requested credit line already names Commons, so the line
    // shows it as written and drops its own «tramite/via Wikimedia Commons».
    const yann = record({ attribution: '© Yann Forget / Wikimedia Commons' });
    const nbsp = ' ';
    expect(['it', 'en', 'de', 'fr'].map((locale) => imageCreditParts(yann, locale)!.text)).toEqual([
      'Immagine di copertina: «Locarno 1», © Yann Forget / Wikimedia Commons, CC BY-SA 3.0 (ridimensionata).',
      'Cover image: “Locarno 1”, © Yann Forget / Wikimedia Commons, CC BY-SA 3.0 (resized).',
      'Titelbild: „Locarno 1“, © Yann Forget / Wikimedia Commons, CC BY-SA 3.0 (skaliert).',
      `Image de couverture${nbsp}: «${nbsp}Locarno 1${nbsp}», © Yann Forget / Wikimedia Commons, CC BY-SA 3.0 (redimensionnée).`,
    ]);
    const html = renderImageCreditHtml(yann, 'it');
    expect(html).toContain('<bdi>© Yann Forget / Wikimedia Commons</bdi>');
    expect(html.match(/Wikimedia Commons/g)).toHaveLength(1);
    // An attribution that does not name Commons keeps the phrase (FORTEPAN above).
    expect(imageCreditParts(FORTEPAN, 'de')!.text).toContain(', via Wikimedia Commons (skaliert).');
  });

  it('is linked to the author profile when one is known', () => {
    const linked = record({ attribution: 'Riessdo / de.wikipedia' });
    expect(renderImageCreditHtml(linked, 'it')).toContain(
      ', <a href="https://de.wikipedia.org/wiki/User:Riessdo" target="_blank" rel="noopener" class="underline underline-offset-2"><bdi>Riessdo / de.wikipedia</bdi></a>,',
    );
  });
});

describe('unknown author (courtesy credit only)', () => {
  it('is valid for public domain, CC0 and Flickr Commons', () => {
    for (const family of ['pd', 'cc0', 'no-known-restrictions'] as const) {
      const rec = record({ ...UNKNOWN_PD, licence: { ...UNKNOWN_PD.licence, family } });
      expect(validateImageCreditRecord(rec).errors, family).toEqual([]);
    }
  });

  it('says so in every locale where a line is shown (Flickr Commons; public domain and CC0 have none)', () => {
    const unknownFlickr = record({ ...UNKNOWN_PD, licence: FAMILY_RECORDS['no-known-restrictions'].licence });
    const nbsp = '\u00a0';
    expect(LOCALES.map((l) => imageCreditParts(unknownFlickr, l)!.text)).toEqual([
      'Immagine di copertina: «Swiss vote», autore sconosciuto, nessuna restrizione di copyright nota, tramite Wikimedia Commons (ridimensionata).',
      'Cover image: “Swiss vote”, author unknown, no known copyright restrictions, via Wikimedia Commons (resized).',
      'Titelbild: „Swiss vote“, Urheber unbekannt, keine bekannten urheberrechtlichen Beschränkungen, via Wikimedia Commons (skaliert).',
      `Image de couverture${nbsp}: «${nbsp}Swiss vote${nbsp}», auteur inconnu, aucune restriction de droit d’auteur connue, via Wikimedia Commons (redimensionnée).`,
    ]);
    for (const l of LOCALES) expect(imageCreditParts(UNKNOWN_PD, l), l).toBeNull();
  });

  it('never falls back to the site, Commons or the uploader as creator', () => {
    const ld = imageObjectCreditFields(UNKNOWN_PD);
    expect(ld.creator).toEqual({ '@type': 'Person', name: UNKNOWN_AUTHOR_NAME });
    expect(ld.creditText).toBe(`${UNKNOWN_AUTHOR_NAME} / Wikimedia Commons`);
    expect(ld.copyrightNotice).toBe('Public domain');
  });

  it('omits <media:credit> but keeps the licence in RSS', () => {
    expect(mediaRssCreditXml(UNKNOWN_PD, 'it')).toBe(
      '<media:license type="text/html" href="https://commons.wikimedia.org/wiki/File:Swiss_vote.png">pubblico dominio</media:license>',
    );
  });

  it('is rejected where the licence requires attribution', () => {
    const ccBy = record({ ...UNKNOWN_PD, licence: FAMILY_RECORDS['cc-by'].licence });
    expect(validateImageCreditRecord(ccBy).errors).toContain('author.name is required when the licence requires attribution');
  });
});

/**
 * Owner decision, 2026-10-05: «Credito per le immagini in pubblico dominio o
 * CC0 (la licenza non lo richiede): cosa facciamo?» → «Togliere il credito».
 * No visible line for those two families, on any surface (they all render
 * `imageCreditParts`); the structured data does not change.
 */
describe('public domain and CC0: no visible credit, same structured data (owner decision 2026-10-05)', () => {
  const CC0_WITHOUT_URL = record({ ...FAMILY_RECORDS.cc0, licence: { ...FAMILY_RECORDS.cc0.licence, url: null } });
  const HIDDEN: Array<[string, ImageCreditRecord]> = [
    ['public domain', PD],
    ['public domain, unknown author', UNKNOWN_PD],
    ['CC0', FAMILY_RECORDS.cc0],
    ['CC0 without a licence URL', CC0_WITHOUT_URL],
  ];

  it.each(HIDDEN)('%s: no line and no footer, in every locale', (_label, rec) => {
    expect(validateImageCreditRecord(rec).errors).toEqual([]);
    expect(hasVisibleImageCredit(rec)).toBe(false);
    for (const locale of [...LOCALES, 'xx']) {
      expect(imageCreditParts(rec, locale), locale).toBeNull();
      expect(renderImageCreditHtml(rec, locale), locale).toBe('');
    }
  });

  it('public domain keeps exactly the ImageObject fields it had', () => {
    expect(imageObjectCreditFields(PD)).toEqual({
      creator: { '@type': 'Person', name: 'Sergei Mikhailovich Prokudin-Gorskii' },
      creditText: 'Sergei Mikhailovich Prokudin-Gorskii / Wikimedia Commons',
      copyrightNotice: 'Public domain',
      license: 'https://commons.wikimedia.org/wiki/File:Lugano_prokudin.jpg',
      acquireLicensePage: 'https://commons.wikimedia.org/wiki/File:Lugano_prokudin.jpg',
      isBasedOn: 'https://commons.wikimedia.org/wiki/File:Lugano_prokudin.jpg',
    });
    expect(imageObjectCreditFields(UNKNOWN_PD)).toEqual({
      creator: { '@type': 'Person', name: UNKNOWN_AUTHOR_NAME },
      creditText: `${UNKNOWN_AUTHOR_NAME} / Wikimedia Commons`,
      copyrightNotice: 'Public domain',
      license: 'https://commons.wikimedia.org/wiki/File:Swiss_vote.png',
      acquireLicensePage: 'https://commons.wikimedia.org/wiki/File:Swiss_vote.png',
      isBasedOn: 'https://commons.wikimedia.org/wiki/File:Swiss_vote.png',
    });
  });

  it('CC0 keeps exactly the ImageObject fields it had', () => {
    const page = 'https://commons.wikimedia.org/wiki/File:AI_Classroom_at_Universal_Ai_University.jpg';
    const expected = {
      creator: { '@type': 'Person', name: 'ManoBV16' },
      creditText: 'ManoBV16 / Wikimedia Commons',
      copyrightNotice: 'CC0',
      license: 'https://creativecommons.org/publicdomain/zero/1.0/',
      acquireLicensePage: page,
      isBasedOn: page,
    };
    expect(imageObjectCreditFields(FAMILY_RECORDS.cc0)).toEqual(expected);
    expect(imageObjectCreditFields(CC0_WITHOUT_URL)).toEqual(expected);
  });

  it('keeps the Media RSS credit and licence (metadata, not the visible line)', () => {
    expect(mediaRssCreditXml(PD, 'it')).toBe(
      '<media:credit role="author" scheme="urn:ebu">Sergei Mikhailovich Prokudin-Gorskii</media:credit>'
      + '<media:license type="text/html" href="https://commons.wikimedia.org/wiki/File:Lugano_prokudin.jpg">pubblico dominio</media:license>',
    );
    expect(mediaRssCreditXml(FAMILY_RECORDS.cc0, 'en')).toBe(
      '<media:credit role="author" scheme="urn:ebu">ManoBV16</media:credit>'
      + '<media:license type="text/html" href="https://creativecommons.org/publicdomain/zero/1.0/">CC0</media:license>',
    );
  });

  it('still shows the line when a public domain or CC0 record says attribution is required', () => {
    for (const rec of [PD, FAMILY_RECORDS.cc0]) {
      const required = record({ ...rec, licence: { ...rec.licence, attributionRequired: true } });
      expect(hasVisibleImageCredit(required)).toBe(true);
      expect(renderImageCreditHtml(required, 'it')).toMatch(/^<footer class="ft-image-credit/);
    }
  });

  it('CC BY and CC BY-SA keep the visible line unchanged', () => {
    expect(hasVisibleImageCredit(FAMILY_RECORDS['cc-by'])).toBe(true);
    expect(hasVisibleImageCredit(FAMILY_RECORDS['cc-by-sa'])).toBe(true);
    expect(imageCreditParts(FAMILY_RECORDS['cc-by'], 'it')!.text).toBe(
      'Immagine di copertina: «Economic growth of Germany» di Max Roser, CC BY 4.0, tramite Wikimedia Commons (ridimensionata).',
    );
    expect(imageCreditParts(FAMILY_RECORDS['cc-by-sa'], 'it')!.text).toBe(
      'Immagine di copertina: «Locarno 1» di Riessdo, CC BY-SA 3.0, tramite Wikimedia Commons (ridimensionata).',
    );
  });

  it('every other family keeps its line', () => {
    const shown = Object.entries(FAMILY_RECORDS).filter(([family]) => family !== 'pd' && family !== 'cc0');
    expect(shown.map(([family]) => family).sort()).toEqual(['cc-by', 'cc-by-sa', 'fal', 'no-known-restrictions', 'other-attribution']);
    for (const [family, rec] of shown) {
      expect(hasVisibleImageCredit(rec), family).toBe(true);
      for (const locale of LOCALES) expect(renderImageCreditHtml(rec, locale), `${family} ${locale}`).toMatch(/^<footer class="ft-image-credit/);
    }
  });
});

describe('markup safety', () => {
  const HOSTILE = record({
    commons: {
      title: 'Tom & Jerry <script>alert("x")</script> l\'été.jpg',
      pageUrl: 'https://commons.wikimedia.org/wiki/File:Tom_%26_Jerry_%3Cscript%3Ealert(%22x%22)%3C/script%3E_l%27%C3%A9t%C3%A9.jpg',
    },
    author: { text: 'A <b>"bold"</b> & \'quoted\' name', name: 'A <b>"bold"</b> & \'quoted\' name', url: null, type: 'Person' },
  });

  it('escapes <&"\' in every value, in HTML and in RSS', () => {
    expect(validateImageCreditRecord(HOSTILE).errors).toEqual([]);
    const html = renderImageCreditHtml(HOSTILE, 'it');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>');
    expect(html).toContain('Tom &amp; Jerry &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; l&#39;été');
    expect(html).toContain('<bdi>A &lt;b&gt;&quot;bold&quot;&lt;/b&gt; &amp; &#39;quoted&#39; name</bdi>');
    expect(mediaRssCreditXml(HOSTILE, 'it')).toContain(
      '<media:credit role="author" scheme="urn:ebu">A &lt;b&gt;&quot;bold&quot;&lt;/b&gt; &amp; &#39;quoted&#39; name</media:credit>',
    );
  });

  it('isolates the title and every name in <bdi> (RTL names render in place)', () => {
    const rtl = record({ author: { text: 'الهام خزائی', name: 'الهام خزائی', url: null, type: 'Person' } });
    const html = renderImageCreditHtml(rtl, 'en');
    expect(html).toContain('“<bdi>Locarno 1</bdi>”');
    expect(html).toContain(' by <bdi>الهام خزائی</bdi>,');
  });

  it('links with target=_blank rel=noopener only: no nofollow, license or author rel', () => {
    for (const rec of Object.values(FAMILY_RECORDS).filter(hasVisibleImageCredit)) {
      const html = renderImageCreditHtml(rec, 'de');
      const anchors = html.match(/<a\b[^>]*>/g) ?? [];
      expect(anchors.length).toBeGreaterThanOrEqual(2);
      for (const a of anchors) {
        expect(a).toMatch(/^<a href="https:\/\/[^"]+" target="_blank" rel="noopener" class="underline underline-offset-2">$/);
      }
      expect(html).not.toMatch(/rel="(?:license|author|nofollow)/);
    }
  });

  it('a footer of semantic tokens, never a <p> (speakable reads `article p`)', () => {
    const html = renderImageCreditHtml(locarno(), 'fr');
    expect(html.startsWith('<footer class="ft-image-credit mt-8 text-sm text-subtle" data-image-credit="wikimedia-commons"><small>')).toBe(true);
    expect(html.endsWith('</small></footer>')).toBe(true);
    expect(html).not.toMatch(/<p[\s>]|<section|dark:|#[0-9a-f]{3,6}\b/i);
  });

  it('uses French no-break spaces before the colon and inside the guillemets', () => {
    const html = renderImageCreditHtml(locarno(), 'fr');
    expect(html).toContain('Image de couverture : <a ');
    expect(html).toContain('>« <bdi>Locarno 1</bdi> »</a>');
    // The character, not the entity: the same copy lands in RSS XML.
    expect(html).not.toContain('&nbsp;');
  });

  it('renders nothing for a record that cannot make a line', () => {
    const broken = record({ commons: { title: '', pageUrl: 'javascript:alert(1)' } });
    expect(imageCreditParts(broken, 'it')).toBeNull();
    expect(renderImageCreditHtml(broken, 'it')).toBe('');
  });

  it('falls back to Italian for an unknown locale', () => {
    expect(imageCreditParts(locarno(), 'xx')!.locale).toBe('it');
  });
});

describe('copy', () => {
  it('has the same keys in it/en/de/fr', () => {
    const shape = (o: object): string[] => Object.entries(o).flatMap(([k, v]) =>
      v && typeof v === 'object' ? shape(v).map((s) => `${k}.${s}`) : [k]).sort();
    for (const locale of LOCALES) expect(shape(IMAGE_CREDIT_COPY[locale])).toEqual(shape(IMAGE_CREDIT_COPY.it));
  });

  it('German uses no ß', () => {
    expect(JSON.stringify(IMAGE_CREDIT_COPY.de)).not.toContain('ß');
  });

  it('change note: cropped and resized vs resized', () => {
    const cropped = record({ modified: 'cropped' });
    expect(LOCALES.map((l) => imageCreditParts(cropped, l)!.text.match(/\(([^)]+)\)\.$/)![1])).toEqual([
      'ritagliata e ridimensionata', 'cropped and resized', 'zugeschnitten und skaliert', 'recadrée et redimensionnée',
    ]);
  });
});

describe('Media RSS', () => {
  it('credits the author and links the licence', () => {
    expect(mediaRssCreditXml(locarno(), 'it')).toBe(
      '<media:credit role="author" scheme="urn:ebu">Riessdo</media:credit>'
      + '<media:license type="text/html" href="https://creativecommons.org/licenses/by-sa/3.0/">CC BY-SA 3.0</media:license>',
    );
  });

  it('credits the requested attribution instead of the author', () => {
    const rec = record({ attribution: 'Contains modified Copernicus Sentinel data 2023' });
    expect(mediaRssCreditXml(rec, 'en')).toContain('>Contains modified Copernicus Sentinel data 2023</media:credit>');
  });
});

describe('validateImageCreditRecord rejects', () => {
  const rejects = (rec: unknown, fragment: string) => {
    const { valid, errors } = validateImageCreditRecord(rec);
    expect(valid).toBe(false);
    expect(errors.join(' | ')).toContain(fragment);
  };

  it('a non-object and an unknown schema version', () => {
    rejects(null, 'record must be an object');
    rejects(record({ schema: 2 as 1 }), 'schema must be 1');
  });

  it('a licence family outside the allowlist (GFDL, no licence)', () => {
    rejects(record({ licence: { family: 'gfdl' as 'cc-by' } }), 'licence.family must be one of');
  });

  it('a cover that is not a /images/blog/ file', () => {
    rejects(record({ cover: '/images/places/lugano.webp' }), 'cover must be a site path');
    rejects(record({ cover: 'https://cdn.frontaliereticino.ch/images/blog/x.webp' }), 'cover must be a site path');
    rejects(record({ cover: '/images/blog/a..b.webp' }), 'cover must be a site path');
  });

  it('a file page that is not https Commons, or not the page of the title', () => {
    rejects(record({ commons: { pageUrl: 'http://commons.wikimedia.org/wiki/File:Locarno_1.jpg' } }), 'commons.pageUrl must start with');
    rejects(record({ commons: { pageUrl: 'https://commons.wikimedia.org/wiki/File:Locarno_2.jpg' } }), 'not the file page of commons.title');
    rejects(record({ commons: { title: 'File:Locarno 1.jpg' } }), 'must not carry the "File:" prefix');
  });

  it('an author link outside the allowlist (redlink, e-mail form, other sites, http)', () => {
    for (const url of [
      'https://commons.wikimedia.org/w/index.php?title=User:X&action=edit&redlink=1',
      'https://commons.wikimedia.org/wiki/Special:EmailUser/Sevela.p',
      'https://web.archive.org/web/2016/http://www.panoramio.com/user/5250256',
      'http://commons.wikimedia.org/wiki/User:Riessdo',
      'javascript:alert(1)',
    ]) {
      rejects(record({ author: { url } }), 'author.url must be null or an https');
    }
  });

  it('a licence URL that is not normalised, and a missing one where the licence must be linked', () => {
    rejects(record({ licence: { url: 'https://creativecommons.org/licenses/by-sa/3.0/deed.it' } }), 'licence.url must be normalised');
    rejects(record({ licence: { url: null } }), 'licence.url is required for cc-by-sa');
    rejects(record({ licence: { url: 'https://example.org/licence/' } }), 'must be a creativecommons.org licence');
  });

  it('an e-mail address in any text written by people', () => {
    rejects(record({ author: { text: 'Mail me: someone@example.org', name: 'Riessdo' } }), 'author.text contains an e-mail address');
    rejects(record({ attribution: 'roland_zh(at)hispeed(dot)ch' }), 'attribution contains an e-mail address');
    // ...but a file title or a Flickr profile id with «@» is not an address.
    const retina = record({ commons: { title: 'Logo@2x.png', pageUrl: 'https://commons.wikimedia.org/wiki/File:Logo@2x.png' } });
    expect(validateImageCreditRecord(retina).errors).toEqual([]);
    expect(validateImageCreditRecord(FAMILY_RECORDS['no-known-restrictions']).errors).toEqual([]);
  });

  it('a value containing /images/ (the engine would read it as the hero)', () => {
    rejects(record({ attribution: 'see /images/blog/other.webp' }), 'attribution contains "/images/"');
  });

  it('control and bidi-override characters', () => {
    rejects(record({ author: { name: 'Ries‮sdo' } }), 'author.name contains a control or bidi-override character');
    rejects(record({ attribution: 'two\nlines' }), 'attribution contains a control or bidi-override character');
  });

  it('a description instead of a name', () => {
    rejects(record({ author: { name: 'x'.repeat(151) } }), 'author.name is longer than 150 characters');
  });

  it('unknown fields, wrong enums and malformed dates', () => {
    rejects({ ...locarno(), license: {} }, 'record: unknown field "license"');
    rejects(record({ modified: 'edited' as 'cropped' }), 'modified must be');
    rejects(record({ status: 'live' as 'ok' }), 'status must be');
    rejects(record({ fetchedAt: '04/10/2026' }), 'fetchedAt must be a YYYY-MM-DD date');
    rejects(record({ author: { type: 'Bot' as 'Person' } }), 'author.type must be');
    rejects(record({ curation: { by: '', at: '2026-10-04', note: 'x' } }), 'curation.by must be a non-empty string');
  });
});

describe('isAllowedAuthorUrl', () => {
  it('links only profiles on the allowlisted hosts', () => {
    expect([
      'https://commons.wikimedia.org/wiki/User:Ank_gsx',
      'https://de.wikipedia.org/wiki/User:Riessdo',
      'https://en.wikipedia.org/wiki/en:Russell_Lee_(photographer)',
      'https://www.wikidata.org/wiki/Q116216083',
      'https://www.flickr.com/people/126377022@N07',
    ].every(isAllowedAuthorUrl)).toBe(true);
    expect([
      'https://commons.wikimedia.org/wiki/Sergei_Mikhailovich_Prokudin-Gorskii',
      'https://www.geograph.org.uk/profile/13090',
      'https://de.wikipedia.org/wiki/Spezial:E-Mail_senden/Riessdo',
      'https://www.flickr.com/photos/someone/12345/',
      'https://de.wikipedia.org/wiki/User:Riessdo?uselang=it',
    ].some(isAllowedAuthorUrl)).toBe(false);
  });
});

describe('normaliseLicenceUrl', () => {
  it.each([
    ['http://creativecommons.org/publicdomain/zero/1.0/deed.en', 'https://creativecommons.org/publicdomain/zero/1.0/'],
    ['https://creativecommons.org/licenses/by-sa/4.0', 'https://creativecommons.org/licenses/by-sa/4.0/'],
    ['https://creativecommons.org/licenses/by-sa/3.0/at/deed.en', 'https://creativecommons.org/licenses/by-sa/3.0/at/'],
    ['//www.creativecommons.org/licenses/by/2.0/legalcode', 'https://creativecommons.org/licenses/by/2.0/'],
    ['http://artlibre.org/licence/lal/en', 'https://artlibre.org/licence/lal/en'],
    ['https://www.flickr.com/commons/usage/', 'https://www.flickr.com/commons/usage/'],
  ])('%s → %s', (input, expected) => {
    expect(normaliseLicenceUrl(input)).toBe(expected);
    expect(normaliseLicenceUrl(expected)).toBe(expected);
  });

  it('is null for anything that is not an http(s) URL', () => {
    expect([null, undefined, '', 'not a url', 'javascript:alert(1)', 'ftp://x/y'].map(normaliseLicenceUrl))
      .toEqual([null, null, null, null, null, null]);
  });
});

describe('coverKey', () => {
  it('keys site paths and the registry CDN/raw URLs of a blog cover by basename', () => {
    expect(coverKey('/images/blog/kuhne-nagel-tagli-posti-ticino-2026.webp')).toBe('kuhne-nagel-tagli-posti-ticino-2026');
    expect(coverKey('https://cdn.frontaliereticino.ch/images/blog/x.webp')).toBe('x');
    expect(coverKey('https://raw.githubusercontent.com/o/r/main/public/images/blog/x-1.png?v=2')).toBe('x-1');
  });

  it('has no key for anything that is not a blog cover', () => {
    expect([
      '/og-image.png', '/images/places/lugano.webp', '/images/blog/thumbnails/x.webp',
      '/images/blog/../x.webp', '/images/blog/x.svg', '', null, undefined,
    ].map(coverKey)).toEqual([null, null, null, null, null, null, null, null]);
  });
});

describe('createImageCreditReader', () => {
  /** In-memory fs exposing only what the reader may use. */
  function memFs(files: Record<string, string>) {
    const reads: string[] = [];
    return {
      reads,
      fs: {
        existsSync: (p: string) => Object.prototype.hasOwnProperty.call(files, p),
        readFileSync: (p: string) => {
          reads.push(p);
          if (!Object.prototype.hasOwnProperty.call(files, p)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
          return files[p];
        },
      },
    };
  }
  const KEY = 'kuhne-nagel-tagli-posti-ticino-2026';
  const SITE = '/site/packages/articles/content/image-credits';
  const CORPUS = '/site/content/image-credits';

  it('reads a cover by its resolved path, from either layout, first candidate first', () => {
    const corpusOnly = memFs({ [`${CORPUS}/blog/${KEY}.json`]: JSON.stringify(locarno()) });
    const reader = createImageCreditReader(corpusOnly.fs, [SITE, CORPUS]);
    expect(reader.get(`/images/blog/${KEY}.webp`)).toEqual(locarno());

    const both = memFs({
      [`${SITE}/blog/${KEY}.json`]: JSON.stringify(record({ author: { name: 'Site Copy' } })),
      [`${CORPUS}/blog/${KEY}.json`]: JSON.stringify(locarno()),
    });
    expect(createImageCreditReader(both.fs, [SITE, CORPUS]).get(`https://cdn.frontaliereticino.ch/images/blog/${KEY}.webp`)!
      .author.name).toBe('Site Copy');
  });

  it('returns null without reading anything for covers that cannot have a record', () => {
    const { fs, reads } = memFs({});
    const reader = createImageCreditReader(fs, [SITE, CORPUS]);
    expect(['/og-image.png', '/images/places/x.webp', undefined, null].map((c) => reader.get(c))).toEqual([null, null, null, null]);
    expect(reader.get(`/images/blog/${KEY}.webp`)).toBeNull();
    expect(reads).toEqual([]);
  });

  it('caches per cover: one read however many pages share it', () => {
    const { fs, reads } = memFs({ [`${CORPUS}/blog/${KEY}.json`]: JSON.stringify(locarno()) });
    const reader = createImageCreditReader(fs, CORPUS);
    for (let i = 0; i < 5; i++) reader.get(`/images/blog/${KEY}.webp`);
    expect(reads).toHaveLength(1);
  });

  it('drops — with a warning, never a throw — a record it must not publish', () => {
    const cases: Array<[string, string, string]> = [
      ['not json', '{', 'not JSON'],
      ['invalid', JSON.stringify(record({ licence: { family: 'gfdl' as 'cc-by' } })), 'invalid record'],
      ['other cover', JSON.stringify(record({ cover: '/images/blog/another.webp' })), 'does not match the file name'],
      ['review', JSON.stringify(record({ status: 'review' })), 'status "review" is not publishable'],
    ];
    for (const [label, body, message] of cases) {
      const warn = vi.fn();
      const { fs } = memFs({ [`${CORPUS}/blog/${KEY}.json`]: body });
      expect(createImageCreditReader(fs, [CORPUS], { warn }).get(`/images/blog/${KEY}.webp`), label).toBeNull();
      expect(warn, label).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0]), label).toContain(message);
    }
  });

  it('never throws on an I/O error either', () => {
    const warn = vi.fn();
    const fs = {
      existsSync: () => true,
      readFileSync: () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); },
    };
    expect(createImageCreditReader(fs, [CORPUS], { warn }).get(`/images/blog/${KEY}.webp`)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unreadable (EACCES'));
  });

  it('works with a readFileSync-only fs (missing file = ENOENT)', () => {
    const fs = {
      readFileSync: (p: string) => {
        if (p === `${CORPUS}/blog/${KEY}.json`) return JSON.stringify(locarno());
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
    };
    expect(createImageCreditReader(fs, [SITE, CORPUS]).get(`/images/blog/${KEY}.webp`)!.commons.title).toBe('Locarno 1.jpg');
  });

  it('hands out frozen records, shared safely between pages', () => {
    const { fs } = memFs({ [`${CORPUS}/blog/${KEY}.json`]: JSON.stringify(locarno()) });
    const rec = createImageCreditReader(fs, [CORPUS]).get(`/images/blog/${KEY}.webp`)!;
    expect(Object.isFrozen(rec)).toBe(true);
    expect(Object.isFrozen(rec.author)).toBe(true);
  });
});
