/**
 * Topic hubs — la premessa che rende TOTALE la guardia di sezione (PR #5290).
 *
 * #5290 chiude l'incidente #5287 saltando l'intera sezione quando
 * `ARTICOLI<SEZIONE>_BUILD_EMIT_SKIP` e' attivo: quegli hub vivono sotto le due
 * sezioni articoli, il deploy le esclude dal push verso lo shard, e la sitemap
 * — che sta sull'apex — le annunciava lo stesso (536 <loc> live, tutti 404,
 * misurati il 2026-08-07 con cache-buster sull'origin).
 *
 * Una guardia a scala di SEZIONE e' sufficiente SOLO se nessun hub sta fuori
 * dalle sezioni. Oggi e' vero — 4 locali x 2 sezioni x 14 argomenti, tutti
 * dentro gli otto prefissi instradati al Worker — ma niente lo verificava, ed
 * e' una premessa che si rompe in silenzio: basta un locale in piu' in
 * `TOPIC_HUB_LOCALES`, o uno slug di sezione che cambia in
 * `section-shard-slugs.json` senza che `ARTICLE_SECTION_CORE.indexSlug` lo
 * segua, perche' un hub finisca su un prefisso che la guardia non copre. In
 * quel caso il plugin tornerebbe a scrivere pagine che nessuno spedisce e a
 * metterle in sitemap — lo stesso difetto, sotto una guardia verde.
 *
 * NON duplica le quattro asserzioni di #5290 (che stanno in
 * `tests/topic-cluster-hubs.test.ts` e leggono il TESTO del plugin): qui non si
 * guarda affatto il plugin, si guarda lo spazio delle URL contro la fonte di
 * verita' del deploy.
 */

import fs from 'node:fs';
import np from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  TOPIC_HUB_CANONICAL_PATHS,
  TOPIC_HUB_LOCALES,
} from '../build-plugins/topicClusterHubsData';

describe('topic hubs — lo spazio delle URL sta tutto sotto le sezioni articoli', () => {
  it('ogni hub canonico sta sotto un prefisso di sezione instradato allo shard', () => {
    // I prefissi si leggono da scripts/lib/section-shard-slugs.json — la stessa
    // fonte che usano strip-section-subtree.sh, push-section-shard.sh e
    // rehydrate-section-shards.sh, e che infra/cloudflare-worker/locale-router.js
    // rispecchia inline in SECTION_ROUTES. Derivarli qui, invece di scrivere
    // otto letterali, e' cio' che fa fallire il test il giorno in cui uno slug
    // di sezione cambia da una parte sola.
    const slugs = JSON.parse(
      fs.readFileSync(np.resolve(__dirname, '../scripts/lib/section-shard-slugs.json'), 'utf-8'),
    ) as Record<string, Record<string, string>>;

    const prefixes = ['articolifrontaliere', 'articolisvizzera'].flatMap((section) =>
      TOPIC_HUB_LOCALES.map((loc) =>
        loc === 'it' ? `/${slugs[section][loc]}/` : `/${loc}/${slugs[section][loc]}/`,
      ),
    );
    // 2 sezioni x 4 locali. Se questo numero cambia, e' cambiata la topologia
    // del deploy e la guardia di sezione va rivista, non solo il test.
    expect(prefixes).toHaveLength(8);
    expect(new Set(prefixes).size).toBe(8);

    const outside = [...TOPIC_HUB_CANONICAL_PATHS].filter(
      (path) => !prefixes.some((p) => path.startsWith(p)),
    );
    expect(
      outside,
      'questi hub stanno fuori da ogni prefisso instradato allo shard: la guardia BUILD_EMIT_SKIP non li copre',
    ).toEqual([]);
  });
});
