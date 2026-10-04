/**
 * Osservazione al conio del REFERENTE di un item (`followup-mint-admission.mjs`).
 *
 * Titolo di fallimento: «Conio follow-up: item nato con la condizione di
 * accettazione già vera».
 *
 * Il difetto sorvegliato: il gate sul conio controllava solo la FORMA
 * dell'accettazione. Sul bucket 10677, 57 item su 60 avevano il token già vero
 * al commit precedente al conio, e il reconciler li marcava `done` senza PR.
 * Il modulo usa lo stesso oracolo della chiusura (`detectAlreadyResolved`) e,
 * per ora, MISURA soltanto: l'item resta ammesso.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEMOTE_BORN_SATISFIED,
  MINT_OBSERVATIONS,
  acceptanceAlreadySatisfied,
  acceptanceIsDeclaration,
  closedStateBullet,
  contentsApiIo,
  isSchedaOnlyItem,
  mintAdmission,
  originalTextOf,
  rewriteTargetFileField,
  targetResolves,
} from '../scripts/ci/lib/followup-mint-admission.mjs';
import { parseFollowupItems } from '../scripts/ci/followup-resolution-match.mjs';

const DAY = '2026-10-04';
const TARGET = 'scripts/example.mjs';

const itemText = (token = 'firstGuard()', extra: string[] = []) => [
  `### FU-${DAY}-001 — Proteggi il comportamento`,
  '- State: open',
  '- Sources: PR #8101',
  `- Target file: \`${TARGET}\``,
  `- Suggested action: aggiungi \`${token}\` in \`${TARGET}\``,
  `- Acceptance token: \`${token}\``,
  ...extra,
  '',
].join('\n');

const parsed = (text: string) => parseFollowupItems(text)[0];

/** `io` finto: file noti presenti, il resto assente; conta le letture. */
function fakeIo(files: Record<string, string>) {
  const calls: string[] = [];
  return {
    calls,
    fileExists: (path: string) => { calls.push(`exists:${path}`); return path in files; },
    readFile: (path: string) => { calls.push(`read:${path}`); return files[path] ?? null; },
  };
}

describe('ammissione al conio — osservazione del referente', () => {
  it('l\'interruttore della demozione è spento: in questa versione si misura e basta', () => {
    expect(DEMOTE_BORN_SATISFIED).toBe(false);
  });

  it('token già invocato nel file → acceptance-already-true, ma ammesso', () => {
    const item = parsed(itemText());
    const io = fakeIo({ [TARGET]: 'export function firstGuard(x) { return x; }\nfirstGuard(value);\n' });
    expect(acceptanceAlreadySatisfied(item, io)).toBe(true);
    const verdict = mintAdmission(item, io);
    expect(verdict.admit).toBe(true);
    expect(verdict.observed).toEqual([MINT_OBSERVATIONS.bornSatisfied]);
  });

  it('token `nome()` solo dichiarato → token-is-declaration, ammesso; aggiungere la chiamata lo fa combaciare', () => {
    const item = parsed(itemText());
    const declared = fakeIo({ [TARGET]: 'export function firstGuard(input) {\n  return input;\n}\n' });
    expect(acceptanceAlreadySatisfied(item, declared)).toBe(false);
    expect(acceptanceIsDeclaration(item, declared)).toBe(true);
    const verdict = mintAdmission(item, declared);
    expect(verdict.admit).toBe(true);
    expect(verdict.observed).toEqual([MINT_OBSERVATIONS.declaration]);

    const fixed = fakeIo({ [TARGET]: 'export function firstGuard(input) {\n  return input;\n}\nfirstGuard(data);\n' });
    expect(mintAdmission(item, fixed).observed).toEqual([MINT_OBSERVATIONS.bornSatisfied]);
  });

  it('token assente dal file → nessuna osservazione', () => {
    const item = parsed(itemText());
    const io = fakeIo({ [TARGET]: 'export const unrelated = 1;\n' });
    expect(mintAdmission(item, io)).toEqual({ admit: true, observed: [], skipped: null });
  });

  it('file assente (404) → nessuna osservazione, non unknown', () => {
    const item = parsed(itemText());
    expect(mintAdmission(item, fakeIo({})).observed).toEqual([]);
  });

  it('item ammesso con la sola scheda COMANDO → controlli non applicati, io mai letto', () => {
    const text = [
      `### FU-${DAY}-002 — Misura il drift`,
      '- State: open',
      '- Sources: PR #8102',
      '- METRICA: prima=3 atteso=0 | COMANDO: node scripts/ci/measure-drift.mjs',
      '',
    ].join('\n');
    const item = parsed(text);
    const io = fakeIo({ 'scripts/ci/measure-drift.mjs': 'measure()' });
    expect(isSchedaOnlyItem(item)).toBe(true);
    expect(mintAdmission(item, io)).toEqual({ admit: true, observed: [], skipped: 'scheda-only' });
    expect(io.calls).toEqual([]);
  });

  it('io che non sa rispondere → admission-unknown, ammesso, mai un «no» inventato', () => {
    const item = parsed(itemText());
    const throwing = {
      fileExists: () => { throw new Error('rete giù'); },
      readFile: () => { throw new Error('rete giù'); },
    };
    expect(acceptanceAlreadySatisfied(item, throwing)).toBe('unknown');
    expect(mintAdmission(item, throwing)).toEqual({ admit: true, observed: [MINT_OBSERVATIONS.unknown], skipped: null });
    const statusUnknown = { status: () => 'unknown', fileExists: () => false, readFile: () => null };
    expect(mintAdmission(item, statusUnknown).observed).toEqual([MINT_OBSERVATIONS.unknown]);
  });

  it('l\'oracolo è iniettabile (adattatore del corpus) e riceve il token esplicito', () => {
    const item = parsed(itemText());
    const seen: unknown[] = [];
    const detect = (text: string, _io: unknown, options: unknown) => {
      seen.push([text.includes('firstGuard'), options]);
      return { resolved: true };
    };
    expect(acceptanceAlreadySatisfied(item, fakeIo({}), { detect })).toBe(true);
    expect(seen).toEqual([[true, { acceptanceToken: 'firstGuard()' }]]);
  });
});

describe('contentsApiIo — il main del repository del bucket, non il disco', () => {
  const ok = (content: string) => () => content;
  const fail = (stderr: string) => () => {
    const error = new Error('Command failed') as Error & { stderr: string };
    error.stderr = stderr;
    throw error;
  };

  it('legge dall\'API contents (raw) del repository e del ref dati, una chiamata per path', () => {
    const calls: string[][] = [];
    const io = contentsApiIo({
      repo: 'owner/corpus',
      ref: 'main',
      gh: (args: string[]) => { calls.push(args); return ok('firstGuard(x)')(); },
      cap: 10,
    });
    expect(io.status(TARGET)).toBe('present');
    expect(io.fileExists(TARGET)).toBe(true);
    expect(io.readFile(TARGET)).toBe('firstGuard(x)');
    expect(io.readFile(`\`${TARGET}\``)).toBe('firstGuard(x)');
    expect(calls).toEqual([[
      'api', '-H', 'Accept: application/vnd.github.raw',
      `repos/owner/corpus/contents/${TARGET}?ref=main`,
    ]]);
    expect(io.stats()).toEqual({ reads: 1, cap: 10, capped: 0, errors: 0 });
  });

  it('404 → missing; ogni altro errore → unknown e contato', () => {
    const missing = contentsApiIo({ repo: 'o/r', gh: fail('gh: Not Found (HTTP 404)'), cap: 5 });
    expect(missing.status(TARGET)).toBe('missing');
    expect(missing.stats().errors).toBe(0);
    const broken = contentsApiIo({ repo: 'o/r', gh: fail('HTTP 502: Bad Gateway'), cap: 5 });
    expect(broken.status(TARGET)).toBe('unknown');
    expect(broken.readFile(TARGET)).toBeNull();
    expect(broken.stats().errors).toBe(1);
  });

  it('il tetto è rispettato e dichiarato: oltre il tetto un path nuovo è unknown, senza chiamate', () => {
    let calls = 0;
    const io = contentsApiIo({ repo: 'o/r', gh: () => { calls += 1; return 'x'; }, cap: 1 });
    expect(io.status('scripts/a.mjs')).toBe('present');
    expect(io.status('scripts/b.mjs')).toBe('unknown');
    expect(io.status('scripts/a.mjs')).toBe('present');
    // Lo stesso path oltre il tetto consultato di nuovo (fileExists, readFile)
    // resta unknown e non gonfia `capped`: conta i path non letti.
    expect(io.fileExists('scripts/b.mjs')).toBe(false);
    expect(io.readFile('scripts/b.mjs')).toBeNull();
    expect(calls).toBe(1);
    expect(io.stats()).toEqual({ reads: 1, cap: 1, capped: 1, errors: 0 });
  });

  it('path fuori dal repository non vengono richiesti', () => {
    let calls = 0;
    const io = contentsApiIo({ repo: 'o/r', gh: () => { calls += 1; return 'x'; } });
    expect(io.status('../secret.mjs')).toBe('missing');
    expect(io.status('/etc/passwd')).toBe('missing');
    expect(calls).toBe(0);
  });

  it('senza repository → unknown (non un falso «assente»)', () => {
    const io = contentsApiIo({ repo: '', gh: () => 'x' });
    expect(io.status(TARGET)).toBe('unknown');
    const item = parsed(itemText());
    expect(mintAdmission(item, io).observed).toEqual([MINT_OBSERVATIONS.unknown]);
  });

  it('end-to-end: lo stesso item dà lo stesso esito con l\'io API e con un io in memoria', () => {
    const content = 'firstGuard(value);\n';
    const item = parsed(itemText());
    const api = contentsApiIo({ repo: 'o/r', gh: (args: string[]) => {
      if (args[3].startsWith(`repos/o/r/contents/${TARGET}`)) return content;
      return fail('HTTP 404')();
    } });
    expect(mintAdmission(item, api)).toEqual(mintAdmission(item, fakeIo({ [TARGET]: content })));
  });
});

// Titolo di fallimento: «Conio follow-up: item con bersaglio inesistente o da
// bullet già chiuso». Sul bucket 10433, 36 item su 60 venivano da bullet che
// `isCandidateItem()` dichiara chiusi («falso positivo», `per scelta`…); nei
// bucket del 21-22-09 e 02-10, 4 `Target file` coniati nel bucket del sito
// esistevano solo nel corpus, e `host/batchWrite.ts` sul sito si chiama
// `build-plugins/batchWrite.ts`.
describe('ammissione al conio — bullet già chiusi e bersagli', () => {
  const FIXTURE = JSON.parse(readFileSync(
    fileURLToPath(new URL('./fixtures/followup-mint/closed-bullets-10258-10289.json', import.meta.url)), 'utf-8',
  )) as { closed: Array<{ pr: number; bullet: string }>; admitted: Array<{ pr: number; bullet: string }> };

  const minted = (original: string, { target = TARGET, extra = [] as string[] } = {}) => parsed([
    `### FU-${DAY}-003 — Item coniato da un bullet`,
    '- State: open',
    '- Sources: PR #10289; PR body `## Non implementato (ancora)`',
    `- Target file: \`${target}\``,
    '- Original text:',
    `  > ${original}`,
    `- Suggested action: aggiungi \`firstGuard()\` in \`${target}\``,
    '- Acceptance token: `firstGuard()`',
    ...extra,
    '',
  ].join('\n'));

  it('le righe reali delle PR 10258 e 10289 → zero item ammessi, anche con l\'io che non risponde', () => {
    expect(FIXTURE.closed.length).toBeGreaterThan(0);
    const unknownIo = { status: () => 'unknown', fileExists: () => false, readFile: () => null };
    for (const { bullet } of FIXTURE.closed) {
      const item = minted(bullet);
      expect(originalTextOf(item.text)).toBe(bullet);
      expect(closedStateBullet(item)).toBe(true);
      const verdict = mintAdmission(item, unknownIo);
      expect(verdict.admit).toBe(false);
      expect(verdict.demotion?.code).toBe(MINT_OBSERVATIONS.closedState);
    }
    // Controllo positivo: il bullet `blocked:` con causa tecnica resta lavoro.
    for (const { bullet } of FIXTURE.admitted) {
      expect(mintAdmission(minted(bullet), fakeIo({})).admit).toBe(true);
    }
  });

  it('«non è un falso positivo, va sistemato» resta ammesso', () => {
    const item = minted(`\`${TARGET}\` — non è un falso positivo, va sistemato: il controllo manca.`);
    expect(closedStateBullet(item)).toBe(false);
    expect(mintAdmission(item, fakeIo({})).admit).toBe(true);
  });

  it('un match lessicale hard-exclude («post-deploy», «deferred», «missing test») non è un bullet chiuso', () => {
    for (const original of [
      '🟡 the deferred import in scripts/x.mjs swallows errors',
      'post-deploy: anche fixX() in scripts/x.mjs va corretto',
      'missing test: il test tests/a.test.ts usa una data assoluta, da correggere',
    ]) {
      const item = minted(original);
      expect(closedStateBullet(item)).toBe(false);
      expect(mintAdmission(item, fakeIo({})).admit).toBe(true);
    }
  });

  it('Original text in linea e in un fence si legge come quello citato', () => {
    const closed = 'scripts/x.mjs — falso positivo: legge solo. **Motivo:** non tocca X. **Prossimo passo:** nessuna modifica.';
    expect(originalTextOf(`- Original text: > ${closed}\n- Suggested action: x`)).toBe(closed);
    expect(originalTextOf(`- Original text:\n\`\`\`\n${closed}\n- State: done\n\`\`\`\n- Suggested action: x`))
      .toBe(`${closed} - State: done`);
    expect(originalTextOf('- Suggested action: x')).toBe('');
  });

  const SITE = 'site' as const;
  const manifest = [
    { path: 'host/batchWrite.ts', sitePath: 'build-plugins/batchWrite.ts', mode: 'identical' },
    { path: 'scripts/lib/corpus-floors.mjs', mode: 'corpus-only' },
    { path: '.github/workflows/crawler-group-01.yml', sitePath: '.github/corpus-workflows/crawler-group-01.yml', mode: 'identical' },
    { path: 'scripts/ci/shared.mjs', mode: 'identical' },
  ];
  const context = (here: Record<string, string>, twin: Record<string, string> = {}, files: unknown = manifest) => ({
    side: SITE, manifestFiles: files, twinIo: fakeIo(twin), io: fakeIo(here),
  });
  const admit = (target: string, ctx: ReturnType<typeof context>, extra: string[] = []) => {
    const { io, ...target_ } = ctx;
    return mintAdmission(itemFor(target, extra), io, { target: target_ });
  };
  const itemFor = (target: string, extra: string[] = []) => parsed([
    `### FU-${DAY}-004 — Bersaglio`,
    '- State: open',
    '- Sources: PR #9508',
    `- Target file: \`${target}\``,
    `- Suggested action: aggiungi \`firstGuard()\` in \`${target}\``,
    '- Acceptance token: `firstGuard()`',
    ...extra,
    '',
  ].join('\n'));

  it('host/batchWrite.ts nel bucket del sito → riscritto a build-plugins/batchWrite.ts, ammesso, nessun «va coniato»', () => {
    const verdict = admit('host/batchWrite.ts', context({ 'build-plugins/batchWrite.ts': 'export {}\n' }, { 'host/batchWrite.ts': 'x' }));
    expect(verdict.admit).toBe(true);
    expect(verdict.demotion).toBeUndefined();
    expect(verdict.observed).toContain(MINT_OBSERVATIONS.targetRewritten);
    expect(verdict.item?.text).toContain('- Target file: `build-plugins/batchWrite.ts`');
    expect(verdict.item?.raw).toContain('- Target file: `build-plugins/batchWrite.ts`');
    expect(verdict.item?.text).toContain('- Suggested action: aggiungi `firstGuard()` in `host/batchWrite.ts`');
  });

  it('engine/shared/x.mjs con packages/articles/engine/shared/x.mjs presente → riscritto', () => {
    const verdict = admit('engine/shared/x.mjs', context({ 'packages/articles/engine/shared/x.mjs': 'x' }));
    expect(verdict.admit).toBe(true);
    expect(verdict.item?.text).toContain('- Target file: `packages/articles/engine/shared/x.mjs`');
  });

  it('file corpus-only nel bucket del sito → target-file-missing + target-in-twin, con la riga per il commento', () => {
    const verdict = admit('scripts/lib/corpus-floors.mjs', context({}, { 'scripts/lib/corpus-floors.mjs': 'x' }));
    expect(verdict.admit).toBe(false);
    expect(verdict.demotion?.code).toBe(MINT_OBSERVATIONS.targetMissing);
    expect(verdict.observed).toEqual([MINT_OBSERVATIONS.targetInTwin, MINT_OBSERVATIONS.targetMissing]);
    expect(verdict.demotion?.detail).toContain('secondo il manifest va coniato in corpus come `scripts/lib/corpus-floors.mjs`');
  });

  it('manifest illeggibile → nessuna demozione per il bersaglio, admission-unknown', () => {
    const verdict = admit('scripts/lib/corpus-floors.mjs', context({}, { 'scripts/lib/corpus-floors.mjs': 'x' }, null));
    expect(verdict.admit).toBe(true);
    expect(verdict.observed).toContain(MINT_OBSERVATIONS.unknown);
    const lazy = admit('scripts/lib/corpus-floors.mjs', context({}, {}, () => null));
    expect(lazy.admit).toBe(true);
    expect(lazy.observed).toContain(MINT_OBSERVATIONS.unknown);
  });

  it('un workflow assente non viene mai riscritto verso .github/corpus-workflows', () => {
    const renamed = admit('.github/workflows/crawler-group-01.yml',
      context({ '.github/corpus-workflows/crawler-group-01.yml': 'on: push\n' }));
    expect(renamed.admit).toBe(false);
    expect(renamed.demotion?.code).toBe(MINT_OBSERVATIONS.targetMissing);
    expect(renamed.item).toBeUndefined();
    const nowhere = admit('.github/workflows/x.yml', context({}));
    expect(nowhere.demotion?.code).toBe(MINT_OBSERVATIONS.targetMissing);
    expect(nowhere.observed).not.toContain(MINT_OBSERVATIONS.targetInTwin);
  });

  it('file assente ovunque ma nominato dalla scheda COMANDO come referente futuro → ammesso', () => {
    const verdict = admit('tests/new-guard.test.ts', context({}),
      ['- METRICA: prima=0 atteso=1 | COMANDO: npx vitest run tests/new-guard.test.ts']);
    expect(verdict.admit).toBe(true);
    expect(admit('tests/new-guard.test.ts', context({})).admit).toBe(false);
  });

  it('COMANDO con ./ o ancora di riga nomina comunque il referente futuro', () => {
    expect(admit('tests/new-guard.test.ts', context({}),
      ['- METRICA: prima=0 atteso=1 | COMANDO: `npx vitest run ./tests/new-guard.test.ts`']).admit).toBe(true);
  });

  it('segnaposto senza path (n/a) e port corpus-only-pending verso il sito → nessuna demozione', () => {
    expect(admit('n/a', context({})).admit).toBe(true);
    const pending = [{ path: 'scripts/lib/ported.mjs', mode: 'corpus-only-pending' }];
    const verdict = admit('scripts/lib/ported.mjs', context({}, { 'scripts/lib/ported.mjs': 'x' }, pending));
    expect(verdict.admit).toBe(true);
    expect(verdict.demotion).toBeUndefined();
  });

  it('il campo Target file indentato viene riscritto davvero, non solo annunciato', () => {
    const item = parsed([
      `### FU-${DAY}-005 — Bersaglio indentato`,
      '- State: open',
      '- Sources: PR #9508',
      '  - Target file: `host/batchWrite.ts`',
      '- Suggested action: aggiungi `firstGuard()` in `host/batchWrite.ts`',
      '- Acceptance token: `firstGuard()`',
      '',
    ].join('\n'));
    const { io, ...target } = context({ 'build-plugins/batchWrite.ts': 'x' });
    const verdict = mintAdmission(item, io, { target });
    expect(verdict.observed).toContain(MINT_OBSERVATIONS.targetRewritten);
    expect(verdict.item?.text).toContain('  - Target file: `build-plugins/batchWrite.ts`');
    expect(verdict.item?.text).not.toContain('Target file: `host/batchWrite.ts`');
  });

  it('bucket del corpus su un file identical → nessuna demozione, target-identical-in-corpus', () => {
    const verdict = mintAdmission(itemFor('scripts/ci/shared.mjs'), fakeIo({ 'scripts/ci/shared.mjs': 'x' }),
      { target: { side: 'corpus', manifestFiles: manifest, twinIo: fakeIo({}) } });
    expect(verdict.admit).toBe(true);
    expect(verdict.observed).toContain(MINT_OBSERVATIONS.targetIdenticalInCorpus);
  });

  it('la riscrittura tocca solo il campo vivo, non le copie citate o in un fence', () => {
    const text = [
      '- Target file: `host/batchWrite.ts`',
      '- Original text:',
      '  > - Target file: `host/batchWrite.ts`',
      '```',
      '- Target file: `host/batchWrite.ts`',
      '```',
    ].join('\n');
    expect(rewriteTargetFileField(text, 'build-plugins/batchWrite.ts').split('\n')).toEqual([
      '- Target file: `build-plugins/batchWrite.ts`',
      ...text.split('\n').slice(1),
    ]);
  });

  it('bersaglio presente nel bucket del sito → ok, senza leggere il manifest', () => {
    expect(targetResolves(itemFor('scripts/example.mjs'), fakeIo({ 'scripts/example.mjs': 'x' }), {
      side: SITE, manifestFiles: () => { throw new Error('non deve leggere'); },
    })).toEqual({ status: 'ok', target: 'scripts/example.mjs' });
  });
});
