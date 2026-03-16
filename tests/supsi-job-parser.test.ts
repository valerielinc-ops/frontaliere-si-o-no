import { describe, expect, it } from 'vitest';

import { parseSupsiJobDetail } from '../scripts/lib/supsi-job-parser.mjs';

describe('supsi-job-parser', () => {
  it('extracts only the real job body from Liferay fragments and keeps structure', () => {
    const html = [
      '<html><head>',
      '<title>Assistente per il corso di laurea in Economia aziendale (SUPSI 26_2002) - SUPSI</title>',
      '<meta property="og:title" content="Assistente per il corso di laurea in Economia aziendale (SUPSI 26_2002) - SUPSI" />',
      '</head><body>',
      '<div class="fragment_3824"><article><label data-lfr-editable-id="articleTitle">Assistente per il corso di laurea in Economia aziendale</label></article></div>',
      '<div class="fragment_3822"><article><ul><li><time>28 febbraio 2026</time></li></ul><p>Condividi</p></article></div>',
      '<script>const Configuration = {"shareOnTW":true};</script>',
      '<div class="fragment_5811"><article class="text-article px-0">',
      '<div class="lfr-richtext" data-lfr-editable-id="paragraphItem" data-lfr-editable-type="rich-text">',
      'La SUPSI mette a concorso una posizione di <strong>Assistente per il corso di laurea in Economia aziendale</strong> con sede a Manno.<br>',
      'Grado di occupazione: 70%. Entrata in funzione: 1 maggio 2026.',
      '<h5>Ambito e scopo della posizione</h5>',
      '<p>La persona collabora alle attivita didattiche e di supporto del corso di laurea.</p>',
      '<h5>Requisiti</h5>',
      '<ul>',
      '<li>Formazione universitaria in economia aziendale</li>',
      '<li>Ottime conoscenze della lingua italiana e buona conoscenza dell inglese</li>',
      '</ul>',
      '</div></article></div>',
      '<div class="fragment_101"><ul class="download-list"><li><a class="docuware-document">Informativa trattamento dati candidati</a></li></ul></div>',
      '</body></html>',
    ].join('');

    const result = parseSupsiJobDetail(html);

    expect(result.title).toBe('Assistente per il corso di laurea in Economia aziendale');
    expect(result.location).toBe('Manno');
    expect(result.description).toContain('# Assistente per il corso di laurea in Economia aziendale');
    expect(result.description).toContain('## Ambito e scopo della posizione');
    expect(result.description).toContain('## Requisiti');
    expect(result.description).toContain('- Formazione universitaria in economia aziendale');
    expect(result.description).not.toContain('Condividi');
    expect(result.description).not.toContain('const Configuration');
    expect(result.description).not.toContain('.fragment_3824');
    expect(result.description).not.toContain('Informativa trattamento dati candidati');
    expect(result.requirements).toEqual([
      'Formazione universitaria in economia aziendale',
      'Ottime conoscenze della lingua italiana e buona conoscenza dell inglese',
    ]);
  });
});
