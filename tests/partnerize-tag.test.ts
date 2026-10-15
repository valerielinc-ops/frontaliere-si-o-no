import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Il tag Partnerize deve stare nel <head> di OGNI pagina emessa (doc Partnerize,
 * "The Partnerize Tag for Partners"): se sparisce da un emettitore, i click su
 * quella famiglia di pagine smettono di essere attribuiti e il Tag Health
 * Checker segna la pagina come non coperta — nessun errore, nessun test rosso,
 * solo commissioni perse. Da qui il pinning.
 *
 * Deliberatamente su TESTO, non su import: `build-plugins/constants.ts` legge
 * `public/assets/seo-static.css` a module-load, e nei checkout sparse (dove
 * `public/` non e' materializzato) l'import esplode con ENOENT. Leggere i
 * sorgenti come stringhe rende il test verde sia in CI sia in locale.
 */

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const TAG_ID = 'c98741ed-da90-49d5-a83f-d66821a170e5';

describe('Partnerize tag', () => {
  it('lo snippet in constants.ts e\' quello consegnato da Partnerize, non riscritto', () => {
    const constants = read('build-plugins/constants.ts');
    expect(constants).toContain(`var tid = '${TAG_ID}';`);
    // Le quattro parti che fanno il tag: rotazione dominio via SHA-1, montaggio
    // dello script, health check, aggancio a DOMContentLoaded. Se una sparisce,
    // qualcuno ha "semplificato" uno snippet che la doc vieta di modificare.
    expect(constants).toContain("window.crypto.subtle.digest('SHA-1', bin)");
    expect(constants).toContain("return h.slice(0, 6) + 'p.' + h + '.com';");
    expect(constants).toContain("fetch('https://api.performancehorizon.com/v3/pzthc/' + tid");
    expect(constants).toContain("document.addEventListener('DOMContentLoaded', pzti);");
  });

  it('e\' servito come file esterno con defer, non inline sulle pagine statiche', () => {
    const constants = read('build-plugins/constants.ts');
    expect(constants).toContain("export const PARTNERIZE_TAG_FILENAME = 'partnerize-tag.js';");
    expect(constants).toContain(
      'export const PARTNERIZE_TAG_SNIPPET = `<script defer src="/assets/${PARTNERIZE_TAG_FILENAME}"></script>`;',
    );
  });

  it('viene emesso in dist/assets da staticScriptsPlugin', () => {
    const plugin = read('build-plugins/staticScriptsPlugin.ts');
    expect(plugin).toContain('[PARTNERIZE_TAG_FILENAME, PARTNERIZE_TAG_CONTENT]');
  });

  it('e\' nel <head> di ogni emettitore di pagine', () => {
    const emitters = [
      'build-plugins/constants.ts', // ANALYTICS_SNIPPET → pagine statiche, whitepaper PDF
      'build-plugins/htmlTemplate.ts', // buildSimplePage + HEAD_SUFFIX_*
      'build-plugins/jobsSeoPagesPlugin.ts',
      'build-plugins/jobSectorPagesPlugin.ts',
      'build-plugins/jobRecencyPagesPlugin.ts',
      'build-plugins/affiliateRedirectPlugin.ts', // pagine /go/<partner>/
      'packages/articles/engine/ogPagesPlugin.ts', // pagine articolo
      'packages/articles/engine/articleHubPagesPlugin.ts', // hub articoli
    ];
    for (const file of emitters) {
      expect(read(file), `${file} non inietta piu' il tag Partnerize`).toContain(
        '${PARTNERIZE_TAG_SNIPPET}',
      );
    }
  });

  it('e\' inline e in alto nel <head> della shell SPA', () => {
    const html = read('index.html');
    expect(html).toContain(TAG_ID);
    // "il piu' in alto possibile", come chiede la doc: prima del blocco SEO.
    expect(html.indexOf(TAG_ID)).toBeLessThan(html.indexOf('<!-- SEO & Metadata -->'));
  });

  it('il contenitore del Dynamic Ad Widget espone il selettore configurato in dashboard', () => {
    // Rinominare l'id senza aggiornare la dashboard spegne il widget in silenzio.
    expect(read('components/comparators/CurrencyExchange.tsx')).toContain('id="pz-ad-landscape"');
  });
});
