/**
 * Guardie della tabella delle sezioni articoli cantonali
 * (`packages/articles/engine/shared/cantonArticleSectionCore.generated.mjs`).
 *
 * 1. Parità: il file generato è esattamente l'output di
 *    `scripts/generate-canton-article-sections.mjs` su `data/canton-url-slugs.json`
 *    (stessa forma di `tests/canton-url-slugs-parity.test.ts`: due copie dello
 *    stesso dato non possono divergere in silenzio).
 * 2. Forma: 24 gruppi URL, slug derivati dalla formula, nessuno attivo.
 * 3. Collisioni: i 96 `indexSlug` non coincidono con nessuna route nota (tabella
 *    degli slug del router, sezioni del Worker, shard di sezione, hub esistenti)
 *    e gli slug riservati degli hub tematici non coincidono con i figli già
 *    usati sotto una sezione (archivio `tutti`, segmento argomenti, `page-N`).
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import slugTable from '../../data/canton-url-slugs.json';
import sectionShardSlugs from '../../scripts/lib/section-shard-slugs.json';
import { SLUG_TABLES } from '../../services/routeSlugs.data';
import { TOPIC_HUB_SEGMENT } from '../../packages/articles/engine/topicTaxonomy';
import {
  ACTIVE_CANTON_SECTIONS,
  CANTON_ARTICLE_SECTION_CORE,
  CANTON_HUB_TOPICS,
  CANTON_HUB_TOPIC_KEYS,
} from '../../packages/articles/engine/shared/cantonArticleSectionCore.generated.mjs';
import { ARTICLE_SECTION_CORE_ALL } from '../../packages/articles/engine/shared/articleSectionCore.mjs';
import {
  ACTIVE_CANTON_CODES,
  GENERATED_MARKER,
  OUTPUT_REL,
  renderCantonArticleSectionCore,
} from '../../scripts/generate-canton-article-sections.mjs';

const rootDir = path.resolve(__dirname, '..', '..');
const LOCALES = ['it', 'en', 'de', 'fr'] as const;
type Entry = (typeof CANTON_ARTICLE_SECTION_CORE)[keyof typeof CANTON_ARTICLE_SECTION_CORE];
const ENTRIES = Object.values(CANTON_ARTICLE_SECTION_CORE) as Entry[];

describe('cantonArticleSectionCore.generated.mjs (parità con data/canton-url-slugs.json)', () => {
  it('il file committato è byte-identico all\'output del generatore', () => {
    const committed = readFileSync(path.join(rootDir, OUTPUT_REL), 'utf-8');
    expect(committed.startsWith(GENERATED_MARKER)).toBe(true);
    expect(committed).toBe(renderCantonArticleSectionCore(slugTable));
  });

  it('`--check` esce 0 sul file committato', () => {
    const res = spawnSync(process.execPath, ['scripts/generate-canton-article-sections.mjs', '--check'], {
      cwd: rootDir,
      encoding: 'utf-8',
    });
    expect(res.status, res.stderr).toBe(0);
  });

  it('`--check` rileva una sorgente che ha cambiato uno slug', () => {
    const drifted = structuredClone(slugTable);
    drifted.cantons.TI.it = 'ticino-sud';
    expect(renderCantonArticleSectionCore(drifted)).not.toBe(renderCantonArticleSectionCore(slugTable));
  });

  it('il generatore rifiuta una tabella incompleta o uno slug non ASCII', () => {
    const missing = structuredClone(slugTable);
    delete (missing.cantons as Record<string, unknown>).ZH;
    expect(() => renderCantonArticleSectionCore(missing)).toThrow(/24 gruppi/);
    const accented = structuredClone(slugTable);
    accented.cantons.ZH.de = 'zürich';
    expect(() => renderCantonArticleSectionCore(accented)).toThrow(/non valido/);
    expect(() => renderCantonArticleSectionCore(slugTable, ['XX'])).toThrow(/sconosciuto/);
  });
});

describe('sezioni cantonali: forma delle voci', () => {
  it('una voce per gruppo URL (22 cantoni + APPENZELLO + BASILEA), id canton-<codice>', () => {
    const codes = Object.keys(slugTable.cantons).sort();
    expect(codes).toHaveLength(24);
    expect(ENTRIES.map((e) => e.canton)).toEqual(codes);
    expect(Object.keys(CANTON_ARTICLE_SECTION_CORE)).toEqual(codes.map((c) => `canton-${c.toLowerCase()}`));
    expect(CANTON_ARTICLE_SECTION_CORE['canton-appenzello'].canton).toBe('APPENZELLO');
    expect(CANTON_ARTICLE_SECTION_CORE['canton-basilea'].canton).toBe('BASILEA');
  });

  it('nessuna sezione cantonale è attiva', () => {
    expect(ACTIVE_CANTON_SECTIONS).toEqual([]);
    expect(ACTIVE_CANTON_CODES).toEqual([]);
  });

  it('ogni voce segue la formula degli slug (D1) e dei path per sezione (D14)', () => {
    for (const e of ENTRIES) {
      const s = slugTable.cantons[e.canton as keyof typeof slugTable.cantons];
      const lower = e.canton.toLowerCase();
      expect(e).toEqual({
        section: `canton-${lower}`,
        kind: 'canton',
        canton: e.canton,
        indexSlug: { it: `articoli-${s.it}`, en: `${s.en}-articles`, de: `${s.de}-artikel`, fr: `articles-${s.fr}` },
        bodyDir: `blog-body-canton-${lower}`,
        metaPrefix: `blog-meta-canton-${lower}`,
        registryFile: `packages/articles/content/cantons/canton-${lower}/registry.ts`,
        slugDataFile: `packages/articles/content/cantons/canton-${lower}/slugs.ts`,
        slugConst: 'CANTON_SLUGS',
        shardKey: null,
        topicHubs: CANTON_HUB_TOPICS,
      });
      expect(ARTICLE_SECTION_CORE_ALL[e.section]).toBe(e);
    }
  });

  it('esempi letterali: Ticino, San Gallo, Basilea', () => {
    expect(CANTON_ARTICLE_SECTION_CORE['canton-ti'].indexSlug).toEqual({
      it: 'articoli-ticino', en: 'ticino-articles', de: 'tessin-artikel', fr: 'articles-tessin',
    });
    expect(CANTON_ARTICLE_SECTION_CORE['canton-sg'].indexSlug).toEqual({
      it: 'articoli-san-gallo', en: 'st-gallen-articles', de: 'st-gallen-artikel', fr: 'articles-saint-gall',
    });
    expect(CANTON_ARTICLE_SECTION_CORE['canton-basilea'].indexSlug).toEqual({
      it: 'articoli-basilea', en: 'basel-articles', de: 'basel-artikel', fr: 'articles-bale',
    });
  });

  it('i 6 temi hanno gli slug riservati di D2', () => {
    expect(CANTON_HUB_TOPIC_KEYS).toEqual(['carburanti', 'fisco', 'mobilita', 'eventi', 'pensioni', 'servizi']);
    expect(CANTON_HUB_TOPICS).toEqual({
      carburanti: { it: 'carburanti', en: 'fuel', de: 'treibstoff', fr: 'carburants' },
      fisco: { it: 'fisco', en: 'tax', de: 'steuern', fr: 'fiscalite' },
      mobilita: { it: 'mobilita', en: 'mobility', de: 'mobilitaet', fr: 'mobilite' },
      eventi: { it: 'eventi', en: 'events', de: 'veranstaltungen', fr: 'evenements' },
      pensioni: { it: 'pensioni', en: 'pensions', de: 'renten', fr: 'retraites' },
      servizi: { it: 'servizi', en: 'services', de: 'dienstleistungen', fr: 'services' },
    });
  });
});

describe('sezioni cantonali: collisioni con le route note', () => {
  const cantonIndexSlugs = ENTRIES.flatMap((e) => LOCALES.map((l) => e.indexSlug[l]));

  it('i 96 indexSlug sono distinti tra loro e dagli hub delle sezioni storiche', () => {
    expect(cantonIndexSlugs).toHaveLength(96);
    expect(new Set(cantonIndexSlugs).size).toBe(96);
    const historical = ['frontaliere', 'svizzera'].flatMap((id) => Object.values(ARTICLE_SECTION_CORE_ALL[id].indexSlug));
    for (const slug of cantonIndexSlugs) expect(historical).not.toContain(slug);
  });

  it('nessun indexSlug coincide con uno slug della tabella del router (tutte le lingue)', () => {
    const routeSlugs = new Set<string>();
    for (const table of Object.values(SLUG_TABLES)) {
      for (const value of Object.values(table)) {
        if (typeof value !== 'string') continue;
        for (const segment of value.split('/')) if (segment) routeSlugs.add(segment);
      }
    }
    expect(routeSlugs.size).toBeGreaterThan(100);
    for (const slug of cantonIndexSlugs) expect(routeSlugs.has(slug), slug).toBe(false);
  });

  it('nessun indexSlug coincide con uno shard di sezione o una route di sezione del Worker', () => {
    const shardSlugs = new Set<string>();
    for (const [key, value] of Object.entries(sectionShardSlugs as Record<string, unknown>)) {
      if (key.startsWith('_') || !value || typeof value !== 'object') continue;
      for (const slug of Object.values(value as Record<string, string>)) shardSlugs.add(slug);
    }
    expect(shardSlugs.size).toBeGreaterThan(50);
    const worker = readFileSync(path.join(rootDir, 'infra/cloudflare-worker/locale-router.js'), 'utf-8');
    const workerPrefixes = [...worker.matchAll(/prefix:\s*'([^']+)'/g)].map((m) => m[1].split('/').filter(Boolean).pop()!);
    expect(workerPrefixes.length).toBeGreaterThan(50);
    for (const slug of cantonIndexSlugs) {
      expect(shardSlugs.has(slug), `${slug} in section-shard-slugs.json`).toBe(false);
      expect(workerPrefixes, `${slug} in SECTION_ROUTES`).not.toContain(slug);
    }
  });

  it('nessun indexSlug compare come segmento di path nel router della SPA o nel Worker', () => {
    // The Worker carries the closed set ON PURPOSE in CORPUS_CANTON_SECTION_SLUGS
    // (it cannot import; parity with this core is pinned by
    // tests/locale-router-corpus-sections.test.ts). That one table is the
    // owner, not a collision: it is cut out, and every other line of the file
    // must still be free of these slugs.
    const withoutCorpusTable = (src: string) => {
      const start = src.indexOf('export const CORPUS_CANTON_SECTION_SLUGS = {');
      const end = src.indexOf('\n};\n', start);
      expect(start, 'CORPUS_CANTON_SECTION_SLUGS not found in the Worker').toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      return src.slice(0, start) + src.slice(end + 4);
    };
    const sources = ['services/router.ts', 'infra/cloudflare-worker/locale-router.js']
      .map((rel) => {
        const src = readFileSync(path.join(rootDir, rel), 'utf-8');
        return [rel, rel.endsWith('locale-router.js') ? withoutCorpusTable(src) : src] as const;
      });
    for (const slug of cantonIndexSlugs) {
      const rx = new RegExp(`(?:^|[^a-z0-9-])${slug}(?:[^a-z0-9-]|$)`);
      for (const [rel, src] of sources) expect(rx.test(src), `${slug} in ${rel}`).toBe(false);
    }
  });

  it('gli slug degli hub tematici sono distinti per lingua e non occupano i figli già riservati di una sezione', () => {
    const archiveAll: Record<(typeof LOCALES)[number], string> = { it: 'tutti', en: 'all', de: 'alle', fr: 'tous' };
    for (const locale of LOCALES) {
      const hubSlugs = CANTON_HUB_TOPIC_KEYS.map((k) => CANTON_HUB_TOPICS[k][locale]);
      expect(new Set(hubSlugs).size, locale).toBe(6);
      for (const slug of hubSlugs) {
        expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
        expect(slug).not.toBe(archiveAll[locale]);
        expect(slug).not.toBe(TOPIC_HUB_SEGMENT[locale]);
        expect(slug).not.toMatch(/^page-\d+$/);
      }
    }
  });
});
