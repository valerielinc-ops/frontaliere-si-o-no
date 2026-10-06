import { describe, expect, it } from 'vitest';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const MAX_BLOG_IMAGE_BYTES = 200_000;
const BLOG_IMAGES = [
  'affitti-svizzera-aumento-asi.webp',
  'affitti-svizzera-regole-2026.webp',
  'allarme-aumento-affitti-svizzera.webp',
  'autisti-uber-svizzera-condizioni.webp',
  'axa-ue-svizzera-posizione.webp',
  'bellucci-finale-jingshan-2026.webp',
  'bern-risanamento-energia.webp',
  'camion-avaria-san-nicolao.webp',
  'castellanzese-vittoria-santangelo.webp',
  'chef-nazionale-ristoratori-de-filippi.webp',
  'formazione-continua-zurigo-contributi.webp',
  'gordola-avviso-scomparsa-revocato.webp',
  'guida-fiscale-ginevra-2026.webp',
  'lugano-trasparenza-partecipate.webp',
  'magrini-cultura-provincia-varese.webp',
  'novantaquattro-scatti-varese.webp',
  'openjobmetis-scafati-vittoria-basket.webp',
  'protezione-civile-zurigo.webp',
  'radar-strade-ticinesi-ottobre.webp',
  'rita-fuhrer-consiglio-federale-donne.webp',
  'rita-fuhrer-consiglio-federale.webp',
  'sostegno-sociale-berna-procedura.webp',
  'startup-ticinesi-top100-2026.webp',
  'storia-restauro-torre-velasca.webp',
  'stra-woman-varese-2026.webp',
  'svizzera-tassa-ingresso-franchi.webp',
  'swiss-steel-ristrutturazione-germania.webp',
  'tappi-chiodi-parcheggio-luino.webp',
  'tariffe-usa-agenda-seco.webp',
  'ticinoskills-2026-gordola-event.webp',
  'uyba-esordio-pari-novara.webp',
  'a4-milano-brescia-diviazione-obbligatoria-2026.webp',
  'accordi-bilaterali-3-parlamento.webp',
  'affitti-rialzo-crisi-ticino-2026.webp',
  'ai-lombardia-ticino-frontaliere-2026.webp',
  'aiuti-svizzera-ucraina-2026.webp',
  'alluvione-lavizzara-piano-pericoli-approvato.webp',
  'apertura-pesca-ticino.webp',
  'bellinzona-auscultazione-2026.webp',
  'bellinzona-crescita-qualita-vita.webp',
  'benessere-integrita-allievi-bellinzona-2026.webp',
  'benzina-ticino-oriente.webp',
  'bici-bellinzona-valli-strategia.webp',
  'borsa-di-zurigo-sprazzi-qu-c3-a0-l-27umor-grigio-resta.webp',
  'calcio-dnb-bellinzona-ultimo-appello.webp',
  'cardiocentro-lugano-ristrutturazione-2026.webp',
  'caronno-varesino-campetto-dante-mercanti-2026.webp',
] as const;

const committedBlobSizes = (() => {
  const refs = BLOG_IMAGES.map((filename) => `HEAD:public/images/blog/${filename}`);
  const output = execFileSync('git', ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], {
    cwd: resolve(__dirname, '..'),
    input: `${refs.join('\n')}\n`,
    encoding: 'utf8',
  });
  return new Map(
    output.trim().split('\n').map((line, index) => {
      const parts = line.split(' ');
      return [refs[index], parts[1] === 'blob' ? Number(parts[2]) : 0] as const;
    }),
  );
})();

describe('article-hub blog image payloads', () => {
  it('keeps the audited article images below the 200 KB warning threshold', () => {
    for (const filename of BLOG_IMAGES) {
      const relativePath = `public/images/blog/${filename}`;
      const localPath = resolve(__dirname, '..', relativePath);
      // CI uses the repository's sparse checkout and intentionally does not
      // materialize public/images. Read the committed blob size in that case.
      const bytes = existsSync(localPath)
        ? statSync(localPath).size
        : committedBlobSizes.get(`HEAD:${relativePath}`) ?? 0;
      expect(bytes, `${filename} must resolve to a committed image blob`).toBeGreaterThan(0);
      expect(bytes, filename).toBeLessThanOrEqual(MAX_BLOG_IMAGE_BYTES);
    }
  });
});
