/**
 * pr-collision-detector: le draft NON partecipano al grafo delle collisioni.
 *
 * Era l'unico componente del ciclo a non saltare le draft (auto-merge-eval,
 * auto-merge-sweep, pr-autorebase, stale-pr-rescuer e pr-review-loop lo fanno
 * tutti). Conseguenza osservata su nanakokyobashi-rgb/frontaliere-articles#33:
 * una draft di sola conservazione, aperta per NON essere mergiata, toccava 22
 * file `.github/workflows/**` e 7 `scripts/lib/**` e avrebbe etichettato
 * `collision-risk` ogni futura PR su quei path — contro una controparte che non
 * poteva mergiare mai.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { selectCollisionCandidates, computeColliders, findDuplicateHeadPrs } from '../scripts/ci/pr-collision-detector.mjs';

describe('selectCollisionCandidates', () => {
  it('tiene le open non-draft, scarta le draft', () => {
    expect(selectCollisionCandidates([
      { number: 1, isDraft: false },
      { number: 2, isDraft: true },
      { number: 3, isDraft: false },
    ])).toEqual([1, 3]);
  });

  it('isDraft assente → partecipa (degrada al comportamento storico, non a uno scan muto)', () => {
    expect(selectCollisionCandidates([{ number: 7 }])).toEqual([7]);
  });

  it('scarta entry senza numero intero valido', () => {
    const prs = [
      { number: 10, isDraft: false },
      { isDraft: false },
      { number: 'x', isDraft: false },
      null,
    ] as unknown as { number: number; isDraft: boolean }[];
    expect(selectCollisionCandidates(prs)).toEqual([10]);
  });

  it('input non-array o vuoto → []', () => {
    expect(selectCollisionCandidates(undefined as unknown as [])).toEqual([]);
    expect(selectCollisionCandidates([])).toEqual([]);
  });
});

describe('computeColliders', () => {
  const WF = '.github/workflows/tests.yml';

  it('due PR che condividono un file funnel-critical collidono, in entrambi i versi', () => {
    const files = new Map([
      [1, new Set([WF])],
      [2, new Set([WF])],
    ]);
    const c = computeColliders([1, 2], files);
    expect(c.get(1)?.get(2)).toEqual([WF]);
    expect(c.get(2)?.get(1)).toEqual([WF]);
  });

  it('una draft (set vuoto) non collide con nessuno, per quanti file condivida davvero', () => {
    // #33 = la draft di conservazione: il chiamante le assegna un set VUOTO
    // invece dei suoi 29 file funnel-critical, ed è così che esce dal grafo.
    const files = new Map([
      [33, new Set<string>()],
      [34, new Set([WF])],
      [35, new Set([WF])],
    ]);
    const c = computeColliders([33, 34, 35], files);
    expect(c.has(33)).toBe(false);
    // le due PR reali continuano a collidere fra loro: il filtro non spegne lo scan.
    expect(c.get(34)?.get(35)).toEqual([WF]);
  });

  it('PR assente dalla mappa → nessuna collisione, nessun throw', () => {
    const c = computeColliders([1, 2], new Map([[1, new Set([WF])]]));
    expect(c.size).toBe(0);
  });

  it('nessun file condiviso → grafo vuoto', () => {
    const files = new Map([
      [1, new Set(['scripts/lib/a.mjs'])],
      [2, new Set(['scripts/lib/b.mjs'])],
    ]);
    expect(computeColliders([1, 2], files).size).toBe(0);
  });
});

describe('findDuplicateHeadPrs — PR gemelle sullo stesso head ref (#10608/#10609)', () => {
  const owner = { login: 'valerielinc-ops' };
  const repo = { name: 'frontaliere-si-o-no' };
  const SHA = '9c388959fab7017806e820a417ba773e61f00644';
  const twin = (number: number, extra: Record<string, unknown> = {}) => ({
    number,
    headRefName: 'fix/issue-10544',
    headRefOid: SHA,
    baseRefName: 'main',
    headRepositoryOwner: owner,
    headRepository: repo,
    labels: [] as { name: string }[],
    ...extra,
  });

  it('REGRESSIONE #10609: tiene la più vecchia, chiude le altre e ne riporta le label', () => {
    expect(findDuplicateHeadPrs([
      twin(10609, { labels: [{ name: 'agent:autofix' }, { name: 'collision-risk' }] }),
      twin(10608, { labels: [{ name: 'collision-risk' }] }),
      twin(10555, { headRefName: 'fix-gh013-data-refresh-triad-20260930', headRefOid: 'a'.repeat(40) }),
    ])).toEqual([{ number: 10609, keeper: 10608, labels: ['agent:autofix', 'collision-risk'] }]);
  });

  it('review 5375807051: stesso owner e branch ma repository diversi non sono gemelle', () => {
    expect(findDuplicateHeadPrs([
      twin(1, { headRefName: 'fix/x', headRefOid: 'a'.repeat(40), headRepositoryOwner: { login: 'alice' }, headRepository: { nameWithOwner: 'alice/site-a' } }),
      twin(2, { headRefName: 'fix/x', headRefOid: 'b'.repeat(40), headRepositoryOwner: { login: 'alice' }, headRepository: { nameWithOwner: 'alice/site-b' } }),
    ])).toEqual([]);
    // Anche con lo stesso SHA il repository diverso li separa.
    expect(findDuplicateHeadPrs([
      twin(1, { headRepository: { nameWithOwner: 'alice/site-a' } }),
      twin(2, { headRepository: { nameWithOwner: 'alice/site-b' } }),
    ])).toEqual([]);
  });

  it('review 5375900587: una draft più vecchia non fa chiudere la gemella pronta', () => {
    expect(findDuplicateHeadPrs([twin(2, { isDraft: true }), twin(3, { isDraft: false })]))
      .toEqual([{ number: 2, keeper: 3, labels: [] }]);
    // Tutte draft: resta la più vecchia.
    expect(findDuplicateHeadPrs([twin(5, { isDraft: true }), twin(4, { isDraft: true })]))
      .toEqual([{ number: 5, keeper: 4, labels: [] }]);
  });

  it('SHA di testa o base diversi non sono gemelle', () => {
    expect(findDuplicateHeadPrs([twin(1), twin(2, { headRefOid: 'b'.repeat(40) })])).toEqual([]);
    expect(findDuplicateHeadPrs([twin(1), twin(2, { baseRefName: 'release' })])).toEqual([]);
  });

  it('stesso nome di branch su owner diversi (fork) non è una gemella', () => {
    expect(findDuplicateHeadPrs([
      twin(1),
      twin(2, { headRepositoryOwner: { login: 'someone-else' } }),
    ])).toEqual([]);
  });

  it('identità illeggibile → nessuna chiusura (fail-closed)', () => {
    expect(findDuplicateHeadPrs([
      { number: 1, headRefName: 'fix/x' },
      { number: 2, headRefName: 'fix/x' },
    ] as never)).toEqual([]);
    expect(findDuplicateHeadPrs([twin(1, { headRefOid: undefined }), twin(2, { headRefOid: undefined })])).toEqual([]);
    expect(findDuplicateHeadPrs([twin(1, { headRepository: undefined }), twin(2, { headRepository: undefined })])).toEqual([]);
    expect(findDuplicateHeadPrs(undefined as never)).toEqual([]);
  });

  it('main() chiude le duplicate PRIMA del grafo delle collisioni, senza cancellare il branch', () => {
    const source = readFileSync(new URL('../scripts/ci/pr-collision-detector.mjs', import.meta.url), 'utf8');
    const main = source.slice(source.indexOf('function main()'));
    const dedupe = main.indexOf('findDuplicateHeadPrs(prs)');
    const graph = main.indexOf('computeColliders(nums, funnelFiles)');
    expect(dedupe).toBeGreaterThan(-1);
    expect(graph).toBeGreaterThan(dedupe);
    expect(main).toContain("'--json', 'number,labels,isDraft,author,headRefName,headRefOid,baseRefName,headRepository,headRepositoryOwner,title'");
    expect(main).toContain("gh(['pr', 'close', String(dup.number), '--repo', REPO]");
    expect(main).not.toContain('--delete-branch');
  });
});
