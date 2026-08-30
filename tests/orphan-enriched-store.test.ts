import { describe, it, expect, afterEach } from 'vitest';
import ts from 'typescript';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  readOrphanEnriched,
  writeOrphanEnriched,
  orphanEnrichedStoreExists,
  orphanEnrichedShardIndex,
  orphanEnrichedShardFile,
  orphanEnrichedManifestFile,
  orphanEnrichedLegacyFile,
  listOrphanEnrichedShardFiles,
  orphanRecordKey,
  ORPHAN_ENRICHED_SHARD_COUNT,
  ORPHAN_ENRICHED_SHARD_DIR,
  ORPHAN_ENRICHED_LEGACY_FILE,
} from '../scripts/lib/orphan-enriched-store.mjs';

/**
 * Guards the sharded enriched-orphan ledger (issue #4248, second half).
 *
 * `data/orphan-enriched-data.json` reached 111.90 MB and crossed GitHub's hard
 * 100 MB per-blob push limit, so `git push` was rejected with GH001 on every
 * `sync-gsc-orphans.yml` run. PR #5146 sharded the OTHER oversize blob in the
 * same push; because GH001 rejects the whole push if any single blob is over,
 * fixing one of two changed nothing observable. This store is what actually
 * unblocks it.
 *
 * The hazard here is NOT a crash. Every reader degrades to `[]` on failure
 * (`readJsonSafe(path, [])`, or a catch that swallows a missing file), so a
 * reader left on the old path would find no file, see zero enriched orphans,
 * and emit soft-landing pages stripped of the GSC queries and translated titles
 * they exist to show — green tests, green deploy, silent SEO regression on the
 * highest-volume surface of the site. Three invariants are machine-checked:
 *
 *   1. NOBODY reads or writes the monolith path directly any more (only the
 *      store may name it, for its own read-fallback + cleanup).
 *   2. The accessor NEVER returns an empty ledger while shards exist on disk,
 *      and the round trip is lossless.
 *   3. Within a slug, the record carrying the strongest GSC signal is LAST —
 *      every consumer indexes the ledger with last-one-wins, so this ordering
 *      IS the read contract, not cosmetics.
 */

const REPO_ROOT = path.resolve(__dirname, '..');

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* already gone */
    }
  }
});

function mkTmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-enriched-store-'));
  tmpDirs.push(d);
  return d;
}

type Rec = Record<string, unknown>;

function sampleLedger(n: number): Rec[] {
  const out: Rec[] = [];
  for (let i = 0; i < n; i++) {
    const slug = `job-slug-${i}-acme-lugano`;
    out.push({
      slug,
      locale: 'it',
      path: `/cerca-lavoro-ticino/${slug}/`,
      queries: [{ query: `q-${i}`, clicks: 1, impressions: 10 }],
      totalImpressions: 10,
      totalClicks: 1,
      titleByLocale: { it: `Titolo ${i}` },
    });
  }
  return out;
}

/* ── 1. Nobody may touch the monolith directly ─────────────────────────── */

const SCANNED_DIRS = ['scripts', 'build-plugins', 'tests', 'services', 'components'];

// The ONLY file allowed to name the legacy monolith: the store itself owns the
// read-fallback and the "delete the unpushable file" cleanup.
const ALLOWED_FILES = new Set([
  path.join('scripts', 'lib', 'orphan-enriched-store.mjs'),
  // This guard itself asserts on the constant's value.
  path.join('tests', 'orphan-enriched-store.test.ts'),
]);

/**
 * A literal only counts as a real access when it is PATH-SHAPED: it ends with
 * the filename and contains no whitespace. Prose that happens to quote the
 * filename inside a sentence (test titles, log messages) is not a filesystem
 * path and must not be flagged.
 */
function isMonolithPathLiteral(text: string): boolean {
  return !/\s/.test(text) && /(^|[/\\])orphan-enriched-data\.json$/.test(text);
}

function walkSources(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkSources(full, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * String/template literals that name the monolith, via the real TypeScript AST.
 * A raw text scan would flag every docblock that *mentions*
 * `data/orphan-enriched-data.json` in prose — and there are several,
 * legitimately, because the size incident is worth explaining where it bit.
 * Comments are not AST nodes, so parsing removes that whole class of false
 * positive: only a literal a program can actually pass to `fs` is reported.
 *
 * PRE-FILTRO (2026-08-26). Il parse AST e' la parte cara, e la si pagava su
 * OGNI file dell'albero scansionato anche quando il nome del monolite non vi
 * compare nemmeno una volta. Un `String.prototype.includes` sul sorgente e' il
 * filtro piu' economico che esiste (nessuna regex, nessun backtracking) e
 * scarta la quasi totalita' dei candidati prima di `ts.createSourceFile`.
 *
 * MEASURED, not estimated (2026-08-26, questo albero): 4.918 file scansionati,
 * di cui solo 7 contengono la stringa — l'AST si costruisce 7 volte invece di
 * 4.918. La scansione passa da 3.802 ms a 208 ms (18,3x), e il test intero da
 * 7.363 ms a ~300-980 ms (vedi il commento sul suo `timeout` sotto).
 *
 * NON cambia cosa il test rileva, ed e' verificato in due direzioni, non
 * assunto: (a) sull'albero vero i due rami producono lo stesso identico set di
 * offender (vuoto in entrambi); (b) su un fixture sintetico che nomina davvero
 * il monolite, i due rami producono gli stessi due hit (literal + template),
 * mentre il file innocente accanto salta il parse.
 *
 * Il pre-filtro e' un SUPERSTRINGA di cio' che il matcher cerca
 * (`orphan-enriched-data` ⊂ `orphan-enriched-data.json`), quindi non puo'
 * nascondere un hit — con una sola eccezione teorica: un literal che scriva il
 * trattino (o qualunque altro carattere del nome) come escape unicode invece
 * che alla lettera. Li' il testo COTTO dall'AST conterrebbe la stringa mentre
 * il sorgente grezzo no, e il pre-filtro scarterebbe il file. E' evasione
 * deliberata, non un errore in cui si inciampa, e questo guard esiste per
 * intercettare la re-introduzione ACCIDENTALE di un path morto.
 */
function monolithLiterals(filePath: string, source: string): string[] {
  // Vedi il docblock: scarto economico prima del parse, superstringa del match.
  if (!source.includes('orphan-enriched-data')) return [];
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (isMonolithPathLiteral(node.text)) hits.push(node.text);
    } else if (ts.isTemplateExpression(node)) {
      const raw = node.getText(sf);
      if (!/\s/.test(raw) && raw.includes('orphan-enriched-data.json')) hits.push(raw);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return hits;
}

describe('orphan-enriched store — no direct monolith access', () => {
  // Override SOLO di questo test, non del `testTimeout` globale
  // (`vitest.config.ts`, 15000 ms) che vale per tutti i 1.358 test: alzarlo
  // ovunque toglierebbe il segnale «test appeso» a tutta la suite per colpa di
  // uno che scansiona l'albero.
  //
  // Perche' serve, e perche' QUESTO numero. Questo e' l'unico test del file
  // che tocca il filesystem su scala (4.918 file), quindi e' l'unico esposto
  // alla contesa sulle 4 vCPU del runner quando i due gruppi vitest girano
  // sovrapposti. MEASURED, not estimated: sul run 32948270917 e' scaduto
  // proprio a 15000 ms sotto quella contesa — e quel numero e' CENSURATO, non
  // misurato: il test e' stato ucciso alla soglia, quindi quanto avrebbe
  // impiegato davvero resta ignoto e non si puo' tarare una soglia su di esso.
  // In isolamento, sempre misurato oggi su questo albero: 7.363 ms prima del
  // pre-filtro; 979 / 864 / 301 / 305 ms su quattro run dopo (la varianza e' la
  // cache del filesystem — ~1s a freddo, ~300 ms a caldo). Il margine sul
  // default era 2,0x: troppo sottile per assorbire un fattore di contesa di cui
  // sappiamo solo che e' >2x.
  //
  // 180_000 non e' un numero a caso ne' il massimo possibile: e' la stessa
  // soglia che questo repo da' gia' agli altri test che scansionano un albero
  // (`tests/url-max-length.test.ts`, `tests/job-locale-consistency.test.ts`; i
  // test che scansionano `dist/` stanno anche piu' su, a `SCAN_TEST_TIMEOUT_MS`
  // = 300_000). Sono ~180x la misura post-pre-filtro a freddo: una rete di
  // sicurezza per la coda sotto contesa, non un bersaglio — se questo test ci
  // arriva davvero vicino, il problema non e' la soglia.
  it('no source outside the store names data/orphan-enriched-data.json in a string literal', { timeout: 180_000 }, () => {
    const offenders: string[] = [];
    for (const dir of SCANNED_DIRS) {
      for (const file of walkSources(path.join(REPO_ROOT, dir))) {
        const rel = path.relative(REPO_ROOT, file);
        if (ALLOWED_FILES.has(rel)) continue;
        let source: string;
        try {
          source = fs.readFileSync(file, 'utf-8');
        } catch {
          continue; // dangling symlink / unreadable — nothing to scan
        }
        for (const h of monolithLiterals(file, source)) offenders.push(`${rel}: ${h}`);
      }
    }
    // Every reader/writer must go through readOrphanEnriched /
    // writeOrphanEnriched (AGENTS.md #6). A literal here means someone
    // re-introduced a path that no longer exists — which fails SILENTLY,
    // because the callers all default to an empty ledger.
    expect(offenders).toEqual([]);
  });

  it('exposes the shard dir and legacy path as constants (so nothing re-hardcodes them)', () => {
    expect(ORPHAN_ENRICHED_SHARD_DIR).toBe('data/orphan-enriched-data');
    expect(ORPHAN_ENRICHED_LEGACY_FILE).toBe('data/orphan-enriched-data.json');
  });
});

/* ── 2. The accessor must never silently return empty ──────────────────── */

describe('orphan-enriched store — read/write round trip', () => {
  it('never returns an empty ledger while shards exist on disk', () => {
    const root = mkTmp();
    const ledger = sampleLedger(500);
    writeOrphanEnriched(ledger, root);

    expect(listOrphanEnrichedShardFiles(root).length).toBe(ORPHAN_ENRICHED_SHARD_COUNT);

    const read = readOrphanEnriched(root);
    // The fail-silent shape this whole migration has to avoid: shards present,
    // reader returns []. That is what a half-migrated call site produces.
    expect(read.length).toBeGreaterThan(0);
    expect(read.length).toBe(ledger.length);
    expect([...read].sort((a, b) => String(a.slug).localeCompare(String(b.slug)))).toEqual(
      [...ledger].sort((a, b) => String(a.slug).localeCompare(String(b.slug))),
    );
  });

  it('preserves every field of a record verbatim', () => {
    const root = mkTmp();
    const rich = {
      slug: 'infermiere-eoc-bellinzona',
      locale: 'de',
      path: '/de/jobs-im-tessin/infermiere-eoc-bellinzona/',
      queries: [{ query: 'pflege tessin', clicks: 3, impressions: 44 }],
      totalImpressions: 44,
      totalClicks: 3,
      topQuery: 'pflege tessin',
      titleByLocale: { it: 'Infermiere', de: 'Pflegefachperson' },
      descriptionByLocale: { de: 'Beschreibung' },
      company: 'EOC',
      companyKey: 'eoc',
      location: 'Bellinzona',
      salaryMin: 70000,
      salaryCurrency: 'CHF',
      slugByLocale: { it: 'infermiere-eoc-bellinzona' },
      localePaths: { it: '/cerca-lavoro-ticino/infermiere-eoc-bellinzona/' },
      observedPaths: { fr: '/fr/trouver-emploi-tessin/infermiere-eoc-bellinzona/' },
      source: 'previous-run',
    };
    writeOrphanEnriched([rich], root);
    expect(readOrphanEnriched(root)).toEqual([rich]);
  });

  it('keeps every locale sibling of a slug — the coverage the 404 landings depend on', () => {
    const root = mkTmp();
    const slug = 'case-anziani';
    const ledger = ['it', 'en', 'de', 'fr'].map((locale) => ({
      slug,
      locale,
      path: `/${locale}/board/${slug}/`,
      totalImpressions: locale === 'it' ? 2372 : 0,
      queries: [] as unknown[],
    }));
    writeOrphanEnriched(ledger, root);
    const read = readOrphanEnriched(root);
    expect(read.length).toBe(4);
    expect(new Set(read.map((r) => r.locale))).toEqual(new Set(['it', 'en', 'de', 'fr']));
  });

  it('removes the unpushable monolith once the shards are written', () => {
    const root = mkTmp();
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(orphanEnrichedLegacyFile(root), JSON.stringify(sampleLedger(3)));
    expect(fs.existsSync(orphanEnrichedLegacyFile(root))).toBe(true);

    writeOrphanEnriched(sampleLedger(3), root);
    expect(fs.existsSync(orphanEnrichedLegacyFile(root))).toBe(false);
  });

  it('still reads a residual monolith during the transition, with shards winning', () => {
    const root = mkTmp();
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    // Shards: the migrated truth.
    writeOrphanEnriched(
      [
        { slug: 'shared', locale: 'it', path: '/from-shard' },
        { slug: 'only-in-shard', locale: 'it', path: '/s' },
      ],
      root,
    );
    // A stale writer re-creates the monolith afterwards.
    fs.writeFileSync(
      orphanEnrichedLegacyFile(root),
      JSON.stringify([
        { slug: 'shared', locale: 'it', path: '/from-monolith' },
        { slug: 'only-in-monolith', locale: 'it', path: '/m' },
      ]),
    );

    const read = readOrphanEnriched(root);
    const bySlug = new Map(read.map((r) => [String(r.slug), r]));
    // Lossless both ways…
    expect(bySlug.get('only-in-shard')?.path).toBe('/s');
    expect(bySlug.get('only-in-monolith')?.path).toBe('/m');
    // …and the shards are authoritative on conflict.
    expect(bySlug.get('shared')?.path).toBe('/from-shard');
  });

  it('returns [] — not a throw — when nothing is on disk', () => {
    const root = mkTmp();
    expect(readOrphanEnriched(root)).toEqual([]);
    expect(orphanEnrichedStoreExists(root)).toBe(false);
  });

  it('skips a corrupt shard instead of throwing away the rest', () => {
    const root = mkTmp();
    writeOrphanEnriched(sampleLedger(200), root);
    fs.writeFileSync(orphanEnrichedShardFile(0, root), '{ this is not json');

    expect(readOrphanEnriched(root).length).toBeGreaterThan(0);
  });

  it('collapses duplicate (locale, slug) records — one identity, one record', () => {
    // The committed ledger carried 295 such pairs: byte-identical re-observations
    // of the same URL, which also means their impressions were being counted
    // twice by anything summing the array.
    const root = mkTmp();
    writeOrphanEnriched(
      [
        { slug: 'dup', locale: 'it', path: '/p', totalImpressions: 1 },
        { slug: 'dup', locale: 'it', path: '/p', totalImpressions: 1 },
      ],
      root,
    );
    const read = readOrphanEnriched(root);
    expect(read.length).toBe(1);
    expect(orphanRecordKey(read[0])).toBe('it:dup');
  });

  it('keeps the RICHER duplicate, not merely the later one', () => {
    // Collapsing to "whatever came last" would silently drop Search Console
    // signal — the one thing these records exist to carry.
    const root = mkTmp();
    writeOrphanEnriched(
      [
        { slug: 'dup', locale: 'it', path: '/rich', totalImpressions: 900, queries: [1, 2] },
        { slug: 'dup', locale: 'it', path: '/poor', totalImpressions: 0, queries: [] },
      ],
      root,
    );
    const read = readOrphanEnriched(root);
    expect(read.length).toBe(1);
    expect(read[0].path).toBe('/rich');
    expect(read[0].totalImpressions).toBe(900);
  });
});

/* ── 3. Ordering IS the contract for last-one-wins consumers ───────────── */

describe('orphan-enriched store — signal ordering', () => {
  /**
   * `build-plugins/jobsSeoPagesPlugin.ts` does `orphanGscData.set(entry.slug,
   * data)` and `scripts/reconcile-job-slugs.mjs` does
   * `enrichmentBySlug[entry.slug] = entry` — both last-one-wins. On the
   * committed ledger 689 slugs were being built from a locale record with zero
   * impressions and zero queries while a sibling holding the real GSC signal was
   * discarded. Nothing pinned the order, so nothing caught it.
   */
  it('puts the strongest-signal record last within a slug, so last-one-wins picks it', () => {
    const root = mkTmp();
    writeOrphanEnriched(
      [
        { slug: 'case-anziani', locale: 'it', totalImpressions: 2372, totalClicks: 241, queries: [1, 2, 3] },
        { slug: 'case-anziani', locale: 'en', totalImpressions: 0, totalClicks: 0, queries: [] },
        { slug: 'case-anziani', locale: 'de', totalImpressions: 5, totalClicks: 0, queries: [1] },
        { slug: 'case-anziani', locale: 'fr', totalImpressions: 0, totalClicks: 0, queries: [] },
      ],
      root,
    );

    const winner = new Map<string, Record<string, unknown>>();
    for (const e of readOrphanEnriched(root)) winner.set(String(e.slug), e);

    expect(winner.get('case-anziani')?.locale).toBe('it');
    expect(winner.get('case-anziani')?.totalImpressions).toBe(2372);
  });

  it('is deterministic when siblings carry identical signal', () => {
    const root = mkTmp();
    const flat = ['fr', 'it', 'de', 'en'].map((locale) => ({
      slug: 's',
      locale,
      totalImpressions: 0,
      totalClicks: 0,
      queries: [] as unknown[],
    }));
    writeOrphanEnriched(flat, root);
    const first = readOrphanEnriched(root).map((r) => r.locale);
    writeOrphanEnriched(readOrphanEnriched(root), root);
    expect(readOrphanEnriched(root).map((r) => r.locale)).toEqual(first);
  });
});

/* ── 4. Shard layout: deterministic, sorted, stable ────────────────────── */

describe('orphan-enriched store — shard layout', () => {
  it('assigns a slug to the same shard every time (deterministic)', () => {
    const slug = 'software-engineer-acme-zurich';
    const first = orphanEnrichedShardIndex(slug);
    for (let i = 0; i < 50; i++) expect(orphanEnrichedShardIndex(slug)).toBe(first);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(ORPHAN_ENRICHED_SHARD_COUNT);
  });

  it('keeps every locale sibling of a slug in ONE shard', () => {
    // Load-bearing: the winner resolution above must be decided inside a single
    // file, never across shards read in directory order.
    const slug = 'infermiere-eoc-bellinzona';
    const idx = orphanEnrichedShardIndex(slug);
    const root = mkTmp();
    writeOrphanEnriched(
      ['it', 'en', 'de', 'fr'].map((locale) => ({ slug, locale })),
      root,
    );
    for (let i = 0; i < ORPHAN_ENRICHED_SHARD_COUNT; i++) {
      const shard = JSON.parse(fs.readFileSync(orphanEnrichedShardFile(i, root), 'utf-8'));
      expect(shard.orphans.length).toBe(i === idx ? 4 : 0);
    }
  });

  it('writes each shard sorted by (slug, locale), so a small append is a small diff', () => {
    const root = mkTmp();
    writeOrphanEnriched(sampleLedger(400), root);
    for (const f of listOrphanEnrichedShardFiles(root)) {
      const { orphans } = JSON.parse(fs.readFileSync(f, 'utf-8'));
      const keys = orphans.map((r: Rec) => `${r.slug}|${r.locale}`);
      expect(keys).toEqual([...keys].sort());
    }
  });

  it('re-writing an unchanged ledger produces byte-identical shards', () => {
    const root = mkTmp();
    writeOrphanEnriched(sampleLedger(300), root);
    const before = listOrphanEnrichedShardFiles(root).map((f) => fs.readFileSync(f, 'utf-8'));
    writeOrphanEnriched(readOrphanEnriched(root), root);
    const after = listOrphanEnrichedShardFiles(root).map((f) => fs.readFileSync(f, 'utf-8'));
    expect(after).toEqual(before);
  });

  it('re-writing an unchanged ledger does not touch any shard file on disk (issue #6384)', () => {
    // Byte-identical content isn't enough — a naive writer still calls
    // writeFileSync on all 32 shards every persist, which is the actual git
    // churn issue #6384 fixes. Assert no shard's mtime changes.
    const root = mkTmp();
    writeOrphanEnriched(sampleLedger(300), root);
    const files = listOrphanEnrichedShardFiles(root);
    const mtimesBefore = files.map((f) => fs.statSync(f).mtimeMs);
    writeOrphanEnriched(readOrphanEnriched(root), root);
    const mtimesAfter = files.map((f) => fs.statSync(f).mtimeMs);
    expect(mtimesAfter).toEqual(mtimesBefore);
  });

  it('a changed impression count does NOT move a record between shards', () => {
    // The on-disk sort key is content-independent on purpose: if it were
    // signal-ranked, every run would re-sort ~32 multi-MB blobs and the commit
    // would be the whole ledger again.
    const root = mkTmp();
    writeOrphanEnriched([{ slug: 'x', locale: 'it', totalImpressions: 1 }], root);
    const firstShard = fs
      .readdirSync(path.join(root, ORPHAN_ENRICHED_SHARD_DIR))
      .filter((n) => /^part-\d+\.json$/.test(n))
      .find((n) => JSON.parse(fs.readFileSync(path.join(root, ORPHAN_ENRICHED_SHARD_DIR, n), 'utf-8')).orphans.length > 0);

    writeOrphanEnriched([{ slug: 'x', locale: 'it', totalImpressions: 9999 }], root);
    const secondShard = fs
      .readdirSync(path.join(root, ORPHAN_ENRICHED_SHARD_DIR))
      .filter((n) => /^part-\d+\.json$/.test(n))
      .find((n) => JSON.parse(fs.readFileSync(path.join(root, ORPHAN_ENRICHED_SHARD_DIR, n), 'utf-8')).orphans.length > 0);

    expect(secondShard).toBe(firstShard);
  });

  it('records the totals in the manifest', () => {
    const root = mkTmp();
    const { totalRecords, totalSlugs } = writeOrphanEnriched(sampleLedger(123), root);
    expect(totalRecords).toBe(123);
    expect(totalSlugs).toBe(123);
    const manifest = JSON.parse(fs.readFileSync(orphanEnrichedManifestFile(root), 'utf-8'));
    expect(manifest.totalRecords).toBe(123);
    expect(manifest.totalSlugs).toBe(123);
    expect(manifest.shardCount).toBe(ORPHAN_ENRICHED_SHARD_COUNT);
  });

  it('propagates a non-ENOENT error reading a shard instead of silently forcing a write (issue #6696)', () => {
    // A directory where a shard file is expected makes readFileSync throw
    // EISDIR, not ENOENT — the write-skip comparison used to swallow any
    // error here, masking a real disk condition as "shard doesn't exist yet".
    const root = mkTmp();
    fs.mkdirSync(orphanEnrichedShardFile(0, root), { recursive: true });
    expect(() => writeOrphanEnriched(sampleLedger(5), root)).toThrow();
  });
});

/* ── 5. The committed ledger must stay pushable ────────────────────────── */

describe('orphan-enriched store — committed shards stay under the push limit', () => {
  it('no committed shard approaches GitHub 100 MB hard limit', () => {
    const shards = listOrphanEnrichedShardFiles(REPO_ROOT);
    if (shards.length === 0) return; // ledger not present in this checkout
    // 90 MB leaves room for a run's growth between the check and the push;
    // crossing it means the shard count needs raising BEFORE main goes red
    // again, which is the whole failure this issue is about.
    const LIMIT = 90 * 1024 * 1024;
    for (const f of shards) {
      expect(fs.statSync(f).size).toBeLessThan(LIMIT);
    }
  });

  it('the unpushable monolith is gone from the working tree', () => {
    if (listOrphanEnrichedShardFiles(REPO_ROOT).length === 0) return;
    expect(fs.existsSync(orphanEnrichedLegacyFile(REPO_ROOT))).toBe(false);
  });
});
