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
import { describe, expect, it } from 'vitest';
import {
  DEMOTE_BORN_SATISFIED,
  MINT_OBSERVATIONS,
  acceptanceAlreadySatisfied,
  acceptanceIsDeclaration,
  contentsApiIo,
  isSchedaOnlyItem,
  mintAdmission,
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
