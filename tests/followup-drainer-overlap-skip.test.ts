/**
 * followup-drainer — extractCodePaths + findOverlapFile pre-flight (#3810).
 *
 * fix-outcome:overlap-skip ricorre 8×/14gg: Claude rileva l'overlap solo dopo aver
 * bruciato ~1M token. Questi due detector zero-Claude rilevano l'overlap PRIMA della
 * promozione (bias a promuovere — un falso-skip ritarda, un falso-promote brucia quota).
 * Stessa filosofia di detectWorkflowScoped (#1724) e detectMalformedBody (#2291).
 */
import { describe, it, expect } from 'vitest';
import {
  extractCodePaths,
  findOverlapFile,
} from '../scripts/ci/followup-drainer.mjs';

describe('extractCodePaths', () => {
  it('estrae path di codice espliciti dal body', () => {
    const body = [
      '## Causa radice',
      'Il problema è in `scripts/lib/dedicated-crawler-common.mjs` (riga 42).',
      '## Suggested action',
      'Modifica `build-plugins/eventsSeoPagesPlugin.ts` per aggiungere la mappa.',
    ].join('\n');
    const paths = extractCodePaths(body);
    expect(paths).toContain('scripts/lib/dedicated-crawler-common.mjs');
    expect(paths).toContain('build-plugins/eventsSeoPagesPlugin.ts');
  });

  it('deduplica path ripetuti nello stesso body', () => {
    const body = 'Fix `scripts/foo.mjs` and update `scripts/foo.mjs` again';
    expect(extractCodePaths(body)).toEqual(['scripts/foo.mjs']);
  });

  it('NON estrae path workflow (non coperti da CODE_PATH_RE)', () => {
    const body = 'Fix `.github/workflows/issue-fix.yml`';
    expect(extractCodePaths(body)).toEqual([]);
  });

  it('NON estrae path data-blob o public (non code)', () => {
    const body = 'Aggiorna `data/jobs.json` e `public/img/logo.png`';
    expect(extractCodePaths(body)).toEqual([]);
  });

  it('ritorna array vuoto senza path', () => {
    expect(extractCodePaths('No file paths here')).toEqual([]);
    expect(extractCodePaths('')).toEqual([]);
    expect(extractCodePaths(undefined as unknown as string)).toEqual([]);
  });

  it('gestisce path multipli in sezioni diverse del body', () => {
    const body = [
      '## Problema',
      'Vedi `scripts/relocalize-pending-jobs.mjs` riga 100.',
      '## Fix',
      'Tocca anche `services/jobService.ts`.',
    ].join('\n');
    const paths = extractCodePaths(body);
    expect(paths).toContain('scripts/relocalize-pending-jobs.mjs');
    expect(paths).toContain('services/jobService.ts');
  });
});

describe('findOverlapFile', () => {
  type PrEntry = { number: number; title: string; files: string[] };
  const makeMap = (prs: PrEntry[]) =>
    new Map(prs.map(({ number, title, files }) => [number, { title, files: new Set(files) }]));

  it('trova overlap quando la PR modifica un file citato nel body', () => {
    const paths = ['scripts/lib/dedicated-crawler-common.mjs'];
    const prMap = makeMap([
      {
        number: 3805,
        title: 'Fix eHnv job feed',
        files: ['scripts/lib/dedicated-crawler-common.mjs', 'scripts/other.mjs'],
      },
    ]);
    const result = findOverlapFile(paths, prMap);
    expect(result).not.toBeNull();
    expect(result!.prNumber).toBe(3805);
    expect(result!.file).toBe('scripts/lib/dedicated-crawler-common.mjs');
    expect(result!.prTitle).toBe('Fix eHnv job feed');
  });

  it('null quando la PR NON tocca i file citati', () => {
    const paths = ['scripts/lib/dedicated-crawler-common.mjs'];
    const prMap = makeMap([
      { number: 999, title: 'Unrelated PR', files: ['scripts/other-file.mjs'] },
    ]);
    expect(findOverlapFile(paths, prMap)).toBeNull();
  });

  it('null su mappa vuota (nessuna PR aperta) → promuovi', () => {
    expect(findOverlapFile(['scripts/foo.mjs'], new Map())).toBeNull();
  });

  it('null su paths vuoto → promuovi (nessun segnale estratto)', () => {
    const prMap = makeMap([
      { number: 1, title: 'Some PR', files: ['scripts/foo.mjs'] },
    ]);
    expect(findOverlapFile([], prMap)).toBeNull();
  });

  it('pattern reale #3742/#3741: eventsSeoPagesPlugin.ts + crawl-myswitzerland-events.mjs in PR #3751', () => {
    const body =
      'Tocca `build-plugins/eventsSeoPagesPlugin.ts` (stesso file di #3739) e i crawler nationwide (`scripts/crawl-myswitzerland-events.mjs`)';
    const paths = extractCodePaths(body);
    const prMap = makeMap([
      {
        number: 3751,
        title: 'unresolved-canton events no longer mislabeled as Ticino',
        files: [
          'build-plugins/eventsSeoPagesPlugin.ts',
          'scripts/crawl-myswitzerland-events.mjs',
          'tests/events-crawler.test.ts',
        ],
      },
    ]);
    const result = findOverlapFile(paths, prMap);
    expect(result).not.toBeNull();
    expect(result!.prNumber).toBe(3751);
  });

  it('pattern reale #3767: relocalize-pending-jobs.mjs in PR #3781', () => {
    const paths = extractCodePaths('Fix `scripts/relocalize-pending-jobs.mjs` heap OOM');
    const prMap = makeMap([
      {
        number: 3781,
        title: 'fix: heap OOM in Translate Pending Jobs',
        files: ['scripts/relocalize-pending-jobs.mjs'],
      },
    ]);
    const result = findOverlapFile(paths, prMap);
    expect(result).not.toBeNull();
    expect(result!.prNumber).toBe(3781);
    expect(result!.file).toBe('scripts/relocalize-pending-jobs.mjs');
  });

  it('scansiona TUTTE le PR aperte e trova anche la seconda se la prima non ha overlap', () => {
    const paths = ['scripts/target.mjs'];
    const prMap = makeMap([
      { number: 1, title: 'PR A', files: ['scripts/unrelated.mjs'] },
      { number: 2, title: 'PR B', files: ['scripts/target.mjs'] },
    ]);
    const result = findOverlapFile(paths, prMap);
    expect(result).not.toBeNull();
    expect(result!.prNumber).toBe(2);
  });
});

/**
 * La pre-flight era INERTE sul mirror corpus, e questo file gira identico là (il modulo
 * `scripts/lib/workflow-scope-detect.mjs` è `mode: identical` nel loop-sync-manifest).
 *
 * `CODE_PATH_RE` si ancorava con `\b` direttamente sulla directory, quindi da un body che
 * cita `generator/scripts/create-article.mjs` estraeva `scripts/create-article.mjs` — una
 * stringa che non esiste in nessun repo — e `findOverlapFile` confronta con un `Set.has`
 * ESATTO contro la lista file di una PR. Risultato misurato: 0 overlap rilevati, sempre.
 * In più `content/**`, l'albero più modificato del corpus (14.748 file), non era nemmeno
 * nella regex. È la causa a monte dei marker `overlap-skip` di
 * nanakokyobashi-rgb/frontaliere-articles#229 e #274.
 *
 * DUE casi obbligatori: la forma del sito e quella del corpus. Stringere la regex per far
 * passare la seconda rompendo la prima sarebbe una regressione silenziosa sul lato che
 * oggi funziona.
 */
describe('overlap pre-flight sui path del corpus (#229/#274 — metà sito della fix)', () => {
  type PrEntry = { number: number; title: string; files: string[] };
  const makeMap = (prs: PrEntry[]) =>
    new Map(prs.map(({ number, title, files }) => [number, { title, files: new Set(files) }]));

  it('forma CORPUS `generator/scripts/x.mjs`: estrae il path COMPLETO e trova l\'overlap', () => {
    const body = [
      '## Causa radice',
      'La guardia manca in `generator/scripts/create-article.mjs` (riga 210).',
    ].join('\n');
    const paths = extractCodePaths(body);
    expect(paths).toContain('generator/scripts/create-article.mjs');
    const prMap = makeMap([
      {
        number: 293,
        title: 'fix(generator): guardia sul titolo duplicato',
        files: ['generator/scripts/create-article.mjs', 'generator/tests/create-article.test.mjs'],
      },
    ]);
    const overlap = findOverlapFile(paths, prMap);
    expect(overlap).not.toBeNull();
    expect(overlap!.prNumber).toBe(293);
    expect(overlap!.file).toBe('generator/scripts/create-article.mjs');
  });

  it('forma CORPUS `content/y.ts`: l\'albero più modificato del corpus ora è visibile', () => {
    const paths = extractCodePaths('Il registro sbagliato è `content/it/blog-body-2026-08.ts`.');
    expect(paths).toContain('content/it/blog-body-2026-08.ts');
    const prMap = makeMap([
      { number: 301, title: 'fix(content): accenti mangiati', files: ['content/it/blog-body-2026-08.ts'] },
    ]);
    expect(findOverlapFile(paths, prMap)?.prNumber).toBe(301);
  });

  it('forma SITO `scripts/x.mjs`: invariata — il lato che funzionava non si rompe', () => {
    const paths = extractCodePaths('Fix in `scripts/ci/followup-drainer.mjs` e `build-plugins/eventsSeoPagesPlugin.ts`.');
    expect(paths).toContain('scripts/ci/followup-drainer.mjs');
    expect(paths).toContain('build-plugins/eventsSeoPagesPlugin.ts');
    const prMap = makeMap([
      { number: 5774, title: 'fix(loop): drainer rescue', files: ['scripts/ci/followup-drainer.mjs'] },
    ]);
    expect(findOverlapFile(paths, prMap)?.prNumber).toBe(5774);
  });

  it('forma SITO `packages/articles/content/**`: stesso file del corpus, radice diversa → entrambe le forme', () => {
    const paths = extractCodePaths('Vedi `packages/articles/content/it/blog-body-2026-08.ts`.');
    expect(paths).toContain('packages/articles/content/it/blog-body-2026-08.ts'); // radice sito
    expect(paths).toContain('content/it/blog-body-2026-08.ts'); // radice corpus
  });

  it('un path citato dentro un URL continua a produrre la coda confrontabile (nessuna regressione)', () => {
    const paths = extractCodePaths('vedi https://github.com/o/r/blob/main/scripts/x.mjs');
    expect(paths).toContain('scripts/x.mjs');
  });

  it('quel che NON deve entrare resta fuori: workflow, data-blob, public', () => {
    expect(extractCodePaths('`.github/workflows/issue-fix.yml`')).toEqual([]);
    expect(extractCodePaths('`data/jobs.json` e `public/img/logo.png`')).toEqual([]);
    expect(extractCodePaths('descripts/foo.mjs non è un path di codice')).toEqual([]);
  });
});
