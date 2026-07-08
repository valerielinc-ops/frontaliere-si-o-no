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
