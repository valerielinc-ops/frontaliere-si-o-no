import { describe, it, expect, afterEach } from 'vitest';
import ts from 'typescript';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  readAllKnownJobSlugs,
  writeAllKnownJobSlugs,
  knownSlugsStoreExists,
  knownSlugsShardIndex,
  knownSlugsShardFile,
  knownSlugsManifestFile,
  knownSlugsLegacyFile,
  listKnownSlugsShardFiles,
  KNOWN_SLUGS_SHARD_COUNT,
  KNOWN_SLUGS_SHARD_DIR,
  KNOWN_SLUGS_LEGACY_FILE,
} from '../scripts/lib/all-known-job-slugs-store.mjs';

/**
 * Guards the sharded canonical slug registry (issue #4248).
 *
 * The monolith `data/all-known-job-slugs.json` crossed GitHub's hard 100 MB
 * per-file push limit (116.36 MB) and made `sync-gsc-orphans.yml` fail on every
 * run from 2026-07-17 onward — three weeks in which the 404s Search Console
 * reports never got their soft landing. The fix splits it into
 * `data/all-known-job-slugs/part-NN.json` behind ONE shared accessor.
 *
 * The hazard this file exists for is NOT a crash. Almost every one of the ~20
 * readers degrades to `{}` on failure (`readJsonSafe(...) || {}`, or a catch
 * that starts fresh), so a reader left on the old path would find no file, see
 * an empty registry, and emit a build with no soft-landing pages at all —
 * green tests, green deploy, silent SEO regression. Two invariants therefore
 * have to be machine-checked:
 *
 *   1. NOBODY reads or writes the monolith path directly any more (only the
 *      store may name it, for its own read-fallback + cleanup).
 *   2. The accessor NEVER returns an empty registry while shards exist on disk.
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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'known-slugs-store-'));
  tmpDirs.push(d);
  return d;
}

function sampleRegistry(n: number): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (let i = 0; i < n; i++) {
    const slug = `job-slug-${i}-acme-lugano`;
    out[slug] = {
      it: `/cerca-lavoro-ticino/${slug}`,
      en: `/en/find-jobs-ticino/${slug}`,
      de: `/de/jobs-im-tessin/${slug}`,
      fr: `/fr/trouver-emploi-tessin/${slug}`,
    };
  }
  return out;
}

/* ── 1. Nobody may touch the monolith directly ─────────────────────────── */

const SCANNED_DIRS = ['scripts', 'build-plugins', 'tests', 'services', 'components'];

// The ONLY file allowed to name the legacy monolith: the store itself owns the
// read-fallback and the "delete the unpushable file" cleanup.
const ALLOWED_FILES = new Set([
  path.join('scripts', 'lib', 'all-known-job-slugs-store.mjs'),
  // This guard itself asserts on the constant's value.
  path.join('tests', 'all-known-job-slugs-store.test.ts'),
]);

/**
 * A literal only counts as a real access when it is PATH-SHAPED: it ends with
 * the filename and contains no whitespace. Prose that happens to quote the
 * filename inside a sentence (test titles, log messages) is not a filesystem
 * path and must not be flagged.
 */
function isMonolithPathLiteral(text: string): boolean {
  return !/\s/.test(text) && /(^|[/\\])all-known-job-slugs\.json$/.test(text);
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
 * `data/all-known-job-slugs.json` in prose — and there are many, legitimately.
 * Comments are not AST nodes, so parsing removes that whole class of false
 * positive: only a literal a program can actually pass to `fs` is reported.
 *
 * PRE-FILTRO (2026-08-26, mirrors tests/orphan-enriched-store.test.ts). Il
 * parse AST e' la parte cara, e la si pagava su OGNI file dell'albero
 * scansionato anche quando il nome del monolite non vi compare nemmeno una
 * volta. Un `String.prototype.includes` sul sorgente e' il filtro piu'
 * economico che esiste (nessuna regex, nessun backtracking) e scarta la
 * quasi totalita' dei candidati prima di `ts.createSourceFile`.
 *
 * E' un SUPERSTRINGA di cio' che il matcher cerca
 * (`all-known-job-slugs` ⊂ `all-known-job-slugs.json`), quindi non puo'
 * nascondere un hit — con una sola eccezione teorica: un literal che scriva
 * un carattere del nome come escape unicode invece che alla lettera. Li' il
 * testo COTTO dall'AST conterrebbe la stringa mentre il sorgente grezzo no, e
 * il pre-filtro scarterebbe il file. E' evasione deliberata, non un errore in
 * cui si inciampa, e questo guard esiste per intercettare la re-introduzione
 * ACCIDENTALE di un path morto.
 */
function monolithLiterals(filePath: string, source: string): string[] {
  // Vedi il docblock: scarto economico prima del parse, superstringa del match.
  if (!source.includes('all-known-job-slugs')) return [];
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (isMonolithPathLiteral(node.text)) hits.push(node.text);
    } else if (ts.isTemplateExpression(node)) {
      const raw = node.getText(sf);
      if (!/\s/.test(raw) && raw.includes('all-known-job-slugs.json')) hits.push(raw);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return hits;
}

describe('all-known-job-slugs store — no direct monolith access', () => {
  // Override SOLO di questo test, non del `testTimeout` globale
  // (`vitest.config.ts`, 15000 ms) che vale per tutti gli altri test: alzarlo
  // ovunque toglierebbe il segnale «test appeso» a tutta la suite per colpa di
  // uno che scansiona l'albero.
  //
  // Perche' serve, e perche' QUESTO numero — stessa causa e stessa cura di
  // tests/orphan-enriched-store.test.ts (v. commit 6ff599fd083, run
  // 32948270917): questo e' l'unico test del file che tocca il filesystem su
  // scala (~4.900 file in scripts/build-plugins/tests/services/components),
  // quindi l'unico esposto alla contesa sulle 4 vCPU del runner quando i due
  // gruppi vitest (independent + dependent) girano sovrapposti per
  // costruzione (tests.yml, step "vitest run (test che leggono il dataset)").
  // MEASURED, not estimated: run 32952024949 e' scaduto proprio a 15000 ms
  // dentro questo scan, mai arrivato all'assert — e quel numero e' CENSURATO,
  // non misurato: il test e' stato ucciso alla soglia. In isolamento, con il
  // pre-filtro sopra, questo albero: ~7.5s (invariato rispetto a prima del
  // pre-filtro, perche' qui gli hit sono pochi ma i file toccati dal prefiltro
  // erano gia' pochi; il costo dominante resta l'I/O di 4.900 `readFileSync`).
  // Il margine sul default (15000ms contro ~7.500ms misurati) e' 2,0x —
  // esattamente il margine che si e' gia' rivelato troppo sottile sul sibling
  // sotto la stessa contesa.
  //
  // 180_000 non e' un numero a caso: e' la stessa soglia che questo repo da'
  // gia' agli altri test che scansionano un albero (tests/url-max-length.test.ts,
  // tests/job-locale-consistency.test.ts, tests/orphan-enriched-store.test.ts).
  // E' una rete di sicurezza per la coda sotto contesa, non un bersaglio — se
  // questo test ci arriva davvero vicino, il problema non e' la soglia.
  it('no source outside the store names data/all-known-job-slugs.json in a string literal', { timeout: 180_000 }, () => {
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
        const hits = monolithLiterals(file, source);
        for (const h of hits) offenders.push(`${rel}: ${h}`);
      }
    }
    // Every reader/writer must go through readAllKnownJobSlugs /
    // writeAllKnownJobSlugs (AGENTS.md #6). A literal here means someone
    // re-introduced a path that no longer exists — which fails SILENTLY,
    // because the callers all default to an empty registry.
    expect(offenders).toEqual([]);
  });

  it('exposes the shard dir and legacy path as constants (so nothing re-hardcodes them)', () => {
    expect(KNOWN_SLUGS_SHARD_DIR).toBe('data/all-known-job-slugs');
    expect(KNOWN_SLUGS_LEGACY_FILE).toBe('data/all-known-job-slugs.json');
  });
});

/* ── 2. The accessor must never silently return empty ──────────────────── */

describe('all-known-job-slugs store — read/write round trip', () => {
  it('never returns an empty registry while shards exist on disk', () => {
    const root = mkTmp();
    const registry = sampleRegistry(500);
    writeAllKnownJobSlugs(registry, root);

    expect(listKnownSlugsShardFiles(root).length).toBe(KNOWN_SLUGS_SHARD_COUNT);

    const read = readAllKnownJobSlugs(root);
    // The fail-silent shape this whole migration has to avoid: shards present,
    // reader returns {}. That is what a half-migrated call site produces.
    expect(Object.keys(read).length).toBeGreaterThan(0);
    expect(Object.keys(read).length).toBe(Object.keys(registry).length);
    expect(read).toEqual(registry);
  });

  it('preserves non-locale metadata on an entry', () => {
    const root = mkTmp();
    const registry = {
      'orphan-slug-x': {
        it: '/cerca-lavoro-ticino/orphan-slug-x',
        source: 'gsc-404-import',
        importedAt: '2026-01-01',
      },
    };
    writeAllKnownJobSlugs(registry, root);
    expect(readAllKnownJobSlugs(root)).toEqual(registry);
  });

  it('removes the unpushable monolith once the shards are written', () => {
    const root = mkTmp();
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(knownSlugsLegacyFile(root), JSON.stringify(sampleRegistry(3)));
    expect(fs.existsSync(knownSlugsLegacyFile(root))).toBe(true);

    writeAllKnownJobSlugs(sampleRegistry(3), root);
    expect(fs.existsSync(knownSlugsLegacyFile(root))).toBe(false);
  });

  it('still reads a residual monolith during the transition, with shards winning', () => {
    const root = mkTmp();
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    // Shards: the migrated truth.
    writeAllKnownJobSlugs({ shared: { it: '/from-shard' }, 'only-in-shard': { it: '/s' } }, root);
    // A stale writer re-creates the monolith afterwards.
    fs.writeFileSync(
      knownSlugsLegacyFile(root),
      JSON.stringify({ shared: { it: '/from-monolith' }, 'only-in-monolith': { it: '/m' } }),
    );

    const read = readAllKnownJobSlugs(root);
    // Lossless both ways…
    expect(read['only-in-shard']).toEqual({ it: '/s' });
    expect(read['only-in-monolith']).toEqual({ it: '/m' });
    // …and the shards are authoritative on conflict.
    expect(read.shared).toEqual({ it: '/from-shard' });
  });

  it('returns {} — not a throw — when nothing is on disk', () => {
    const root = mkTmp();
    expect(readAllKnownJobSlugs(root)).toEqual({});
    expect(knownSlugsStoreExists(root)).toBe(false);
  });

  it('skips a corrupt shard instead of throwing away the rest', () => {
    const root = mkTmp();
    writeAllKnownJobSlugs(sampleRegistry(200), root);
    fs.writeFileSync(knownSlugsShardFile(0, root), '{ this is not json');

    const read = readAllKnownJobSlugs(root);
    expect(Object.keys(read).length).toBeGreaterThan(0);
  });
});

describe('all-known-job-slugs store — shard layout', () => {
  it('assigns a slug to the same shard every time (deterministic)', () => {
    const slug = 'software-engineer-acme-zurich';
    const first = knownSlugsShardIndex(slug);
    for (let i = 0; i < 50; i++) expect(knownSlugsShardIndex(slug)).toBe(first);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(KNOWN_SLUGS_SHARD_COUNT);
  });

  it('writes each shard with sorted keys, so a small append is a small diff', () => {
    const root = mkTmp();
    writeAllKnownJobSlugs(sampleRegistry(400), root);
    for (const f of listKnownSlugsShardFiles(root)) {
      const keys = Object.keys(JSON.parse(fs.readFileSync(f, 'utf-8')).slugs);
      expect(keys).toEqual([...keys].sort());
    }
  });

  it('re-writing an unchanged registry produces byte-identical shards', () => {
    const root = mkTmp();
    const registry = sampleRegistry(300);
    writeAllKnownJobSlugs(registry, root);
    const before = listKnownSlugsShardFiles(root).map((f) => fs.readFileSync(f, 'utf-8'));
    writeAllKnownJobSlugs(readAllKnownJobSlugs(root), root);
    const after = listKnownSlugsShardFiles(root).map((f) => fs.readFileSync(f, 'utf-8'));
    expect(after).toEqual(before);
  });

  it('records the slug total in the manifest', () => {
    const root = mkTmp();
    const { totalSlugs } = writeAllKnownJobSlugs(sampleRegistry(123), root);
    expect(totalSlugs).toBe(123);
    const manifest = JSON.parse(fs.readFileSync(knownSlugsManifestFile(root), 'utf-8'));
    expect(manifest.totalSlugs).toBe(123);
    expect(manifest.shardCount).toBe(KNOWN_SLUGS_SHARD_COUNT);
  });

  it('re-writing an unchanged registry does not touch any shard file on disk (issue #6384)', () => {
    // Byte-identical content isn't enough — a naive writer still calls
    // writeFileSync on all 32 shards every persist, which is the actual git
    // churn issue #6384 fixes. Assert no shard's mtime changes.
    const root = mkTmp();
    const registry = sampleRegistry(300);
    writeAllKnownJobSlugs(registry, root);
    const files = listKnownSlugsShardFiles(root);
    const mtimesBefore = files.map((f) => fs.statSync(f).mtimeMs);
    writeAllKnownJobSlugs(readAllKnownJobSlugs(root), root);
    const mtimesAfter = files.map((f) => fs.statSync(f).mtimeMs);
    expect(mtimesAfter).toEqual(mtimesBefore);
  });

  it('propagates a non-ENOENT error reading a shard instead of silently forcing a write (issue #6696)', () => {
    // A directory where a shard file is expected makes readFileSync throw
    // EISDIR, not ENOENT — the write-skip comparison used to swallow any
    // error here, masking a real disk condition as "shard doesn't exist yet".
    const root = mkTmp();
    fs.mkdirSync(knownSlugsShardFile(0, root), { recursive: true });
    expect(() => writeAllKnownJobSlugs(sampleRegistry(5), root)).toThrow();
  });
});

/* ── 3. The committed registry must stay pushable ──────────────────────── */

describe('all-known-job-slugs store — committed shards stay under the push limit', () => {
  it('no committed shard approaches GitHub 100 MB hard limit', () => {
    const shards = listKnownSlugsShardFiles(REPO_ROOT);
    if (shards.length === 0) return; // registry not present in this checkout
    // 90 MB leaves room for a run's growth between the check and the push;
    // crossing it means the shard count needs raising BEFORE main goes red
    // again, which is the whole failure this issue is about.
    const LIMIT = 90 * 1024 * 1024;
    for (const f of shards) {
      expect(fs.statSync(f).size).toBeLessThan(LIMIT);
    }
  });

  it('the unpushable monolith is gone from the working tree', () => {
    if (listKnownSlugsShardFiles(REPO_ROOT).length === 0) return;
    expect(fs.existsSync(knownSlugsLegacyFile(REPO_ROOT))).toBe(false);
  });
});
