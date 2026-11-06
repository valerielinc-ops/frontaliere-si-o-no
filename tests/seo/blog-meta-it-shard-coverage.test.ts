import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONTENT_DIR = path.join(ROOT, 'packages', 'articles', 'content');
const SEO_DIR = path.join(CONTENT_DIR, 'seo');

// These 21 IT metadata entries arrived in the sync contribution. SEO metadata
// is sharded; checking only seo-blog.ts would report false orphans.
const SYNCED_META_IDS = [
  'stra-woman-varese-2026',
  'lido-san-domenico-lugano-concorsi',
  'gordola-avviso-scomparsa-revocato',
  'uyba-esordio-pari-novara',
  'gran-fondo-varese-2025',
  'chef-nazionale-ristoratori-de-filippi',
  'novantaquattro-scatti-varese',
  'openjobmetis-scafati-vittoria-basket',
  'storia-restauro-torre-velasca',
  'bellucci-finale-jingshan-2026',
  'a2-rumore-galbisio',
  'magrini-cultura-provincia-varese',
  'castellanzese-vittoria-santangelo',
  'gianpaolo-calzi-solbiatese',
  'sequestro-contanti-como-brogeda',
  'raduno-auto-moto-cocquio',
  'camion-avaria-san-nicolao',
  'sequestri-contanti-brogeda',
  'prevenzione-salute-aziende-ticinesi',
  'osservatorio-varese-spettacolo-galileo',
  'valuta-intercettata-brogeda',
];

describe('sync IT metadata and sharded SEO coverage', () => {
  it('keeps all 21 synced meta entries paired with an SEO shard entry', () => {
    const meta = fs.readFileSync(path.join(CONTENT_DIR, 'blog-meta-it.ts'), 'utf8');
    const seo = fs.readdirSync(SEO_DIR)
      .filter((file) => /^seo-blog(?:-\d+)?\.ts$/.test(file))
      .map((file) => fs.readFileSync(path.join(SEO_DIR, file), 'utf8'))
      .join('\n');

    expect(SYNCED_META_IDS).toHaveLength(21);
    for (const id of SYNCED_META_IDS) {
      expect(meta).toContain(`'blog.article.${id}.title':`);
      expect(seo).toContain(`'blog-${id}':`);
    }
  });
});
