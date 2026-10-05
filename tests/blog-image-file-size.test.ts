import { describe, expect, it } from 'vitest';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

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
] as const;

describe('article-hub blog image payloads', () => {
  it('keeps the audited article images below the 200 KB warning threshold', () => {
    for (const filename of BLOG_IMAGES) {
      const bytes = statSync(resolve(__dirname, '..', 'public/images/blog', filename)).size;
      expect(bytes, filename).toBeLessThanOrEqual(MAX_BLOG_IMAGE_BYTES);
    }
  });
});
