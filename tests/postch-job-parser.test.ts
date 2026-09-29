import { describe, expect, it } from 'vitest';
import {
  keyPostDescriptionBySourceLocale,
  parsePostJobDetail,
} from '@/scripts/lib/postch-job-parser.mjs';

function token(content = '') {
  return `<div class="joblayouttoken"><span class="rtltextaligneligible">${content}</span></div>`;
}

function buildPage(values: Record<number, string>, tokenCount: number) {
  return `<div id="search-wrapper">${Array.from({ length: tokenCount }, (_, index) => token(values[index] || '')).join('')}</div>`;
}

describe('Post.ch SuccessFactors detail parser', () => {
  it('keeps regular descriptions after nested inline spans', () => {
    const html = buildPage({
      0: 'Zusteller:in Briefe und Pakete',
      1: '80',
      2: '100',
      3: 'Brunnen|Schwyz|SZ|Schweiz|CHE',
      18: '<p>Stehst du gerne früh auf und suchst eine körperlich herausfordernde Tätigkeit? Dann passt du perfekt zu uns.</p><p><span>Mit dir kommen Briefe und Pakete zuverlässig an.</span></p><ul><li><span>Frühmorgens bereitest du gemeinsam mit deinem Team die Zustelltour vor.</span></li><li>Du stellst die Sendungen pünktlich und einwandfrei zu.</li><li><span>Auch Quereinsteiger:innen sind herzlich willkommen.</span></li></ul>',
    }, 19);

    const parsed = parsePostJobDetail(html, 'https://job.post.ch/default/job/post/74742-de_DE');

    expect(parsed.title).toBe('Zusteller:in Briefe und Pakete');
    expect(parsed.city).toBe('Brunnen');
    expect(parsed.description).toContain('Mit dir kommen Briefe und Pakete zuverlässig an.');
    expect(parsed.description).toContain('- Frühmorgens bereitest du gemeinsam mit deinem Team die Zustelltour vor.');
    expect(parsed.description).toContain('Auch Quereinsteiger:innen sind herzlich willkommen.');
    expect(parsed.description.split(/\s+/).filter(Boolean).length).toBeGreaterThan(45);
  });

  it('keeps apprenticeship descriptions whose nested spans live in token 11', () => {
    const html = buildPage({
      0: 'Apprentissage de gestionnaire de commerce de détail CFC - Berne (francophone)',
      3: 'Bienne|Berne|BE|Suisse|CHE',
      11: '<div><p><span>Tu apprécies d’être en contact quotidien avec les gens et tu aimes conseiller et vendre.</span><span> Au cours de la formation, tu feras l’acquisition des connaissances nécessaires.</span></p><p><strong>Ta formation</strong></p><ul><li><p><span>Tu seras chaque jour en contact avec nos clientes et nos clients.</span></p></li><li><p>Tu développes tes compétences spécialisées et partages volontiers tes connaissances.</p></li></ul></div>',
    }, 12);

    const parsed = parsePostJobDetail(html, 'https://job.post.ch/default/job/post/73819-fr_FR');

    expect(parsed.title).toContain('Apprentissage de gestionnaire');
    expect(parsed.city).toBe('Bienne');
    expect(parsed.description).toContain('Au cours de la formation');
    expect(parsed.description).toContain('- Tu seras chaque jour en contact avec nos clientes et nos clients.');
    expect(parsed.description.split(/\s+/).filter(Boolean).length).toBeGreaterThan(35);
  });

  it('keeps every list item when the rich-text editor writes CRLF and NBSP inside <li> (job 73924)', () => {
    // Minimised from https://job.post.ch/default/job/…/73924-de_DE (token 11):
    // the editor wraps each item as `<li>\r\n<p>…</p>\r\n</li>` and pads the
    // sections with NBSP paragraphs. Before the fix the "- " marker stayed on
    // its own `\r` line and the published list collapsed into paragraphs.
    const body = '<div>\r\n<div>\r\n<p>Startest du gerne früh in den Tag, liebst du es, an der frischen Luft zu sein, und hast du Freude daran, den Menschen ein Lächeln ins Gesicht zu zaubern? Dann ist eine Ausbildung in der Zustellung (Fachrichtung Distribution) genau das Richtige für dich! </p>\r\n</div>\r\n<div>\r\n<p>\u00a0</p>\r\n</div>\r\n<div>\r\n<p><strong>Deine Ausbildung </strong></p>\r\n</div>\r\n<div>\r\n<ul style="list-style-type:disc">\r\n<li>\r\n<p>Am frühen Morgen sortierst du deine Briefe und Pakete und belädst dein Zustellfahrzeug für die anschliessende Zustelltour. </p>\r\n</li>\r\n</ul>\r\n</div>\r\n<div>\r\n<ul style="list-style-type:disc">\r\n<li>\r\n<p>Danach bist du selbstständig unterwegs, bringst und holst Sendungen jeder Art und kümmerst dich um die Anliegen unserer Kundinnen und Kunden. </p>\r\n</li>\r\n</ul>\r\n</div>\r\n<div>\r\n<ul style="list-style-type:disc">\r\n<li>\r\n<p>&nbsp;</p>\r\n<p>Bei Lehrbeginn verfügst du über das Sprachniveau B2 in Deutsch.</p>\r\n</li>\r\n</ul>\r\n</div>\r\n</div>';
    const html = buildPage({
      0: 'Lehre als Logistiker:in EFZ Distribution gemischte Zustellung (Briefe und Pakete)',
      3: 'Winterthur|Zürich|ZH|Schweiz|CHE',
      11: body,
    }, 12);

    const parsed = parsePostJobDetail(html, 'https://job.post.ch/default/job/post/73924-de_DE');

    expect(parsed.description).toContain('\n- Am frühen Morgen sortierst du deine Briefe');
    expect(parsed.description).toContain('\n- Danach bist du selbstständig unterwegs');
    expect(parsed.description).toContain('\n- Bei Lehrbeginn verfügst du über das Sprachniveau B2');
    expect(parsed.description).not.toMatch(/[\r\u00a0]/);
    // No orphan marker line left behind.
    expect(parsed.description).not.toMatch(/(^|\n)[ \t]*-[ \t]*(\n|$)/);
  });
});

describe('keyPostDescriptionBySourceLocale', () => {
  const german = 'Startest du gerne früh in den Tag und liebst du es, an der frischen Luft zu sein? Dann ist eine Ausbildung in der Zustellung genau das Richtige für dich.';
  const english = 'Do you like starting your day early and being outdoors? Then an apprenticeship in delivery is exactly right for you.';
  const italian = 'Ti piace iniziare presto la giornata e stare all’aria aperta? Allora un apprendistato nella distribuzione fa per te.';
  const detect = (text: string) => (/\b(?:du|und|ist)\b/.test(text) ? 'de' : (/\b(?:ti|un|per)\b/.test(text) ? 'it' : 'en'));

  it('moves the body out of the Italian slot into its own language and keeps real translations', () => {
    // 214/216 Post.ch vacancies on 2026-09-29: German text stored as `it`.
    expect(keyPostDescriptionBySourceLocale({ it: german, en: english }, german, 'de', detect))
      .toEqual({ de: german, en: english });
  });

  it('drops an older source-language copy that is no longer byte-identical', () => {
    const olderGerman = `${german} Wir freuen uns auf deine Bewerbung.`;
    expect(keyPostDescriptionBySourceLocale({ it: olderGerman }, german, 'de', detect))
      .toEqual({ de: german });
  });

  it('keeps an Italian translation and leaves Italian-source vacancies keyed as it', () => {
    expect(keyPostDescriptionBySourceLocale({ it: italian, en: english }, german, 'de', detect))
      .toEqual({ it: italian, en: english, de: german });
    expect(keyPostDescriptionBySourceLocale({}, italian, 'it', detect)).toEqual({ it: italian });
  });

  it('leaves the map untouched without a usable source language or body', () => {
    expect(keyPostDescriptionBySourceLocale({ it: german }, german, '', detect)).toEqual({ it: german });
    expect(keyPostDescriptionBySourceLocale({ it: german }, '', 'de', detect)).toEqual({ it: german });
  });
});
