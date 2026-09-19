import { describe, expect, it } from 'vitest';
import { parsePostJobDetail } from '@/scripts/lib/postch-job-parser.mjs';

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
});
