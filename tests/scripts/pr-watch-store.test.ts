/**
 * pr-watch-store.mjs — the persisted watch list that keeps a session from
 * ending while a PR it opened has not reached a terminal state.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  storePath,
  readEntries,
  writeEntries,
  addEntry,
  removeEntry,
  extractPrRef,
  entriesForSession,
  entriesOfOtherSessions,
  STORE_REL_PATH,
} from '../../scripts/ci/lib/pr-watch-store.mjs';

describe('extractPrRef — pulled out of raw text, not a structured field', () => {
  it('finds owner/repo/number in a plain PR URL', () => {
    expect(extractPrRef('https://github.com/valerielinc-ops/frontaliere-si-o-no/pull/6318')).toEqual({
      owner: 'valerielinc-ops',
      repo: 'frontaliere-si-o-no',
      number: 6318,
    });
  });

  it('finds it inside a larger JSON blob, quoted', () => {
    const text = '{"tool_response":{"stdout":"https://github.com/o/r/pull/42\\n"}}';
    expect(extractPrRef(text)).toEqual({ owner: 'o', repo: 'r', number: 42 });
  });

  it('returns null when there is no PR URL', () => {
    expect(extractPrRef('gh pr list --repo o/r')).toBeNull();
    expect(extractPrRef('')).toBeNull();
    expect(extractPrRef(undefined as unknown as string)).toBeNull();
  });
});

describe('addEntry / removeEntry — pure list operations', () => {
  const base = { owner: 'o', repo: 'r', number: 1, openedAt: '2026-08-24T00:00:00.000Z' };

  it('adds a new entry', () => {
    expect(addEntry([], base)).toEqual([base]);
  });

  it('does not duplicate an entry for the same owner/repo/number', () => {
    const dup = { ...base, openedAt: 'later' };
    expect(addEntry([base], dup)).toEqual([base]); // original kept, not overwritten
  });

  it('treats a different number as a distinct entry', () => {
    const other = { ...base, number: 2 };
    expect(addEntry([base], other)).toHaveLength(2);
  });

  it('removes only the matching entry', () => {
    const other = { ...base, number: 2 };
    expect(removeEntry([base, other], { owner: 'o', repo: 'r', number: 1 })).toEqual([other]);
  });

  it('removeEntry is a no-op when nothing matches', () => {
    expect(removeEntry([base], { owner: 'o', repo: 'r', number: 99 })).toEqual([base]);
  });
});

describe('readEntries / writeEntries — file round-trip, and tolerance of a bad file', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-watch-test-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads an empty list when the file does not exist — never crashes the caller', () => {
    expect(readEntries(dir)).toEqual([]);
  });

  it('round-trips what it writes', () => {
    const entries = [{ owner: 'o', repo: 'r', number: 1, openedAt: 'x' }];
    writeEntries(dir, entries);
    expect(readEntries(dir)).toEqual(entries);
    expect(fs.existsSync(storePath(dir))).toBe(true);
    expect(storePath(dir)).toBe(path.join(dir, STORE_REL_PATH));
  });

  it('drops malformed entries instead of throwing (a corrupt append must not blind the gate)', () => {
    fs.mkdirSync(path.dirname(storePath(dir)), { recursive: true });
    fs.writeFileSync(storePath(dir), JSON.stringify([{ owner: 'o' }, { owner: 'o', repo: 'r', number: 1 }]));
    expect(readEntries(dir)).toEqual([{ owner: 'o', repo: 'r', number: 1 }]);
  });

  it('reads an empty list from a file that is not valid JSON at all', () => {
    fs.mkdirSync(path.dirname(storePath(dir)), { recursive: true });
    fs.writeFileSync(storePath(dir), '{not json');
    expect(readEntries(dir)).toEqual([]);
  });
});

describe('scoping per sessione — una sessione non blocca sulle PR di un’altra', () => {
  const mine = { owner: 'o', repo: 'r', number: 1, openedAt: 'x', sessionId: 'A' };
  const theirs = { owner: 'o', repo: 'r', number: 2, openedAt: 'x', sessionId: 'B' };
  const legacy = { owner: 'o', repo: 'r', number: 3, openedAt: 'x' };

  it('enforce SOLO le proprie — non quelle altrui, non quelle senza padrone', () => {
    // Il messaggio del gate dice «leggi la review e applica il fix»: bloccare
    // la sessione A sulla PR della sessione B (o su una legacy senza id) la
    // manda a pushare sul branch di un altro agente, cioè la collisione che
    // il resto del ciclo previene. Incidente in diretta 2026-08-24: due entry
    // legacy hanno bloccato 6+ sessioni parallele contemporaneamente perché
    // la versione precedente le faceva enforce-are da chiunque.
    expect(entriesForSession([mine, theirs, legacy], 'A')).toEqual([mine]);
  });

  it('senza session id sul CHIAMANTE enforce TUTTO — un gate che si spegne quando non sa non protegge', () => {
    // Distinto dal caso sopra: qui è QUESTA sessione a non sapere chi è, non
    // un'entry senza padrone vista da una sessione che il proprio id ce l'ha.
    expect(entriesForSession([mine, theirs, legacy], null)).toEqual([mine, theirs, legacy]);
    expect(entriesForSession([mine, theirs, legacy], '')).toEqual([mine, theirs, legacy]);
  });

  it('le entry altrui e quelle senza padrone restano tracciate: il filtro restringe chi blocca, non chi è seguito', () => {
    // Il gate riscrive il file con ciò che resta: senza questa metà, filtrare
    // per sessione cancellerebbe le PR degli altri (comprese le legacy) dallo
    // store e nessuno le seguirebbe più.
    expect(entriesOfOtherSessions([mine, theirs, legacy], 'A')).toEqual([theirs, legacy]);
  });

  it('senza session id sul chiamante nessuna entry è «di altri» — niente da riscrivere a parte', () => {
    expect(entriesOfOtherSessions([mine, theirs, legacy], null)).toEqual([]);
  });

  it('unione e complemento coprono tutte le entry, senza perderne né duplicarne', () => {
    const all = [mine, theirs, legacy];
    const union = [...entriesOfOtherSessions(all, 'A'), ...entriesForSession(all, 'A')];
    expect(union.map((e) => e.number).sort()).toEqual([1, 2, 3]);
  });
});
