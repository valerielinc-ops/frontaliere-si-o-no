import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CORPUS_OBSERVER_FILES,
  CRAWLER_WORKFLOW_FILES,
  assertEmittedFamiliesRegistered,
  diffEmittedFamiliesAgainstRegistry,
  listPortableTreeSitePaths,
  prepareCrawlerWorkflowCorpusSync,
  registeredCorpusSitePaths,
} from '../scripts/ci/prepare-crawler-workflow-corpus-sync.mjs';
import { checkPortableTreeLockstep } from '../scripts/generate-crawler-group-workflows.mjs';

// #9621: ogni famiglia che il generatore emette sotto .github/corpus-workflows/
// deve essere una mappa del trasporto, cioe' una voce `identical` del
// loop-sync manifest del corpus. Senza, il corpus la scopre solo dal censimento
// notturno dei gemelli (corpus PR 1571: 12, 10, 5, 5 file segnalati).
const ROOT = path.resolve(import.meta.dirname, '..');
const PORTABLE_DIR = path.join(ROOT, '.github/corpus-workflows');
const NEW_FAMILY = 'observers/scripts/lib/new-crawler-family.mjs';

const tmpDirs: string[] = [];
function tmpDir(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function copyPortableTree() {
  const dir = path.join(tmpDir('crawler-lockstep-src-'), 'corpus-workflows');
  fs.cpSync(PORTABLE_DIR, dir, { recursive: true });
  return dir;
}

function emptyCorpus() {
  const corpusRoot = tmpDir('crawler-lockstep-corpus-');
  const manifestPath = path.join(corpusRoot, 'scripts/ci/loop-sync-manifest.json');
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify({ files: [] }, null, 2)}\n`);
  return { corpusRoot, manifestPath };
}

describe('crawler family lockstep (#9621)', () => {
  it('il registro coincide con le mappe del trasporto: gruppi, translate, observer e contratto', () => {
    const registered = registeredCorpusSitePaths();
    expect(registered).toHaveLength(CRAWLER_WORKFLOW_FILES.length + CORPUS_OBSERVER_FILES.length + 1);
    expect(registered).toContain('.github/corpus-workflows/contract.json');
    for (const { source } of CORPUS_OBSERVER_FILES) {
      expect(registered).toContain(`.github/corpus-workflows/${source}`);
    }
  });

  it('l albero portabile committato non contiene famiglie emesse non registrate', () => {
    expect(checkPortableTreeLockstep()).toEqual({ unregistered: [], unemitted: [] });
  });

  it('una famiglia aggiunta all albero senza mappa fa fallire il controllo del generatore', () => {
    const dir = copyPortableTree();
    fs.writeFileSync(path.join(dir, NEW_FAMILY), 'export const x = 1;\n');
    expect(checkPortableTreeLockstep({ portableDir: dir })).toEqual({
      unregistered: [`.github/corpus-workflows/${NEW_FAMILY}`],
      unemitted: [],
    });
  });

  it('una voce registrata senza file emesso e segnalata come registro scoperto', () => {
    const dir = copyPortableTree();
    fs.rmSync(path.join(dir, 'translate-pending.yml'));
    expect(checkPortableTreeLockstep({ portableDir: dir }).unemitted)
      .toEqual(['.github/corpus-workflows/translate-pending.yml']);
  });

  it('un registro mancante o vuoto e fail-closed, non un verde vacuo', () => {
    const emittedSitePaths = listPortableTreeSitePaths(PORTABLE_DIR);
    expect(() => diffEmittedFamiliesAgainstRegistry({ emittedSitePaths, registeredSitePaths: [] }))
      .toThrow(/lockstep registry missing or empty/);
    expect(() => diffEmittedFamiliesAgainstRegistry({ emittedSitePaths } as any))
      .toThrow(/lockstep registry missing or empty/);
    expect(() => assertEmittedFamiliesRegistered({
      emittedSitePaths: [...emittedSitePaths, `.github/corpus-workflows/${NEW_FAMILY}`],
      registeredSitePaths: registeredCorpusSitePaths(),
    })).toThrow(/unregistered emitted family: \.github\/corpus-workflows\/observers\/scripts\/lib\/new-crawler-family\.mjs/);
  });

  it('il trasporto registra in lockstep ogni famiglia dell albero committato', () => {
    const { corpusRoot, manifestPath } = emptyCorpus();
    prepareCrawlerWorkflowCorpusSync({ sourceDir: PORTABLE_DIR, corpusRoot, alignedAt: '2026-09-24' });
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const sitePaths = manifest.files.map((entry: any) => entry.sitePath).sort();
    expect(sitePaths).toEqual(listPortableTreeSitePaths(PORTABLE_DIR));
    expect(manifest.files.every((entry: any) => entry.mode === 'identical')).toBe(true);
  });

  it('il trasporto rifiuta una famiglia esportata non registrata prima di scrivere nel corpus', () => {
    const dir = copyPortableTree();
    fs.writeFileSync(path.join(dir, NEW_FAMILY), 'export const x = 1;\n');
    const { corpusRoot, manifestPath } = emptyCorpus();
    const before = fs.readFileSync(manifestPath, 'utf8');
    expect(() => prepareCrawlerWorkflowCorpusSync({ sourceDir: dir, corpusRoot, alignedAt: '2026-09-24' }))
      .toThrow(/unregistered exported family: \.github\/corpus-workflows\/observers\/scripts\/lib\/new-crawler-family\.mjs/);
    expect(fs.readFileSync(manifestPath, 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(corpusRoot, '.github/workflows'))).toBe(false);
  });
});
