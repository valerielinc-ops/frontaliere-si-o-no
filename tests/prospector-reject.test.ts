/**
 * Prospector — respingere una spec con causa accertata.
 *
 * Il verdetto e' terminale e libera uno slot di validazione ogni notte: deve
 * colpire il candidato giusto (le chiavi candidato e crawler divergono),
 * scrivere sempre la causa, e non poter spegnere un crawler gia' spedito.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { rejectCandidates, resolveCandidateRef, SHIPPED_STATUSES } from '../scripts/lib/prospector/reject-candidates.mjs';

// Il registro e' un file committato: una transizione di test non deve finirci.
const ledgerFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prospect-reject-')), 'ledger.jsonl');
const reject = (store: any, entries: any[]) => rejectCandidates(store, entries, { ledgerFile });

const storeWith = (candidates: Record<string, any>) => ({ version: 1, updatedAt: null, candidates });

const base = () => storeWith({
  'picks.ch': { key: 'picks.ch', status: 'promoted', crawlerKey: 'picks' },
  'recruitingapp-2316@umantis.com': { key: 'recruitingapp-2316@umantis.com', status: 'promoted', crawlerKey: 'kinderspital-zurich' },
  'shipped.ch': { key: 'shipped.ch', status: 'production', crawlerKey: 'shipped' },
});

describe('rejection con causa accertata', () => {
  it('risolve un ref sia per chiave candidato sia per chiave crawler', () => {
    const store = base();
    expect(resolveCandidateRef(store, 'picks.ch').candidate?.key).toBe('picks.ch');
    expect(resolveCandidateRef(store, 'kinderspital-zurich').candidate?.key).toBe('recruitingapp-2316@umantis.com');
    expect(resolveCandidateRef(store, 'sconosciuto').candidate).toBeNull();
    expect(resolveCandidateRef(store, '').candidate).toBeNull();
  });

  it('rifiuta un ref che colpisce due record diversi invece di sceglierne uno', () => {
    // Il caso reale che ha motivato la guardia: `vebego` e' insieme la chiave
    // di un candidato `new` (stesso datore, visto solo per nome) e il
    // crawlerKey della spec `vebego@castione` che occupa lo slot.
    const store = storeWith({
      'vebego@castione': { key: 'vebego@castione', status: 'promoted', crawlerKey: 'vebego' },
      vebego: { key: 'vebego', status: 'new' },
    });
    const resolved = resolveCandidateRef(store, 'vebego');
    expect(resolved.candidate).toBeNull();
    expect(resolved.why).toContain('ambiguo');

    const { applied, skipped } = reject(store, [{ ref: 'vebego', reason: 'UI agganciata' }]);
    expect(applied).toEqual([]);
    expect(skipped[0].why).toContain('ambiguo');
    expect(store.candidates.vebego.status).toBe('new');
    expect(store.candidates['vebego@castione'].status).toBe('promoted');
  });

  it('porta a rejected scrivendo la causa nel record', () => {
    const store = base();
    const { applied, skipped } = reject(store, [{ ref: 'picks', reason: 'aggregatore: annunci di altri datori' }]);
    expect(skipped).toEqual([]);
    expect(applied).toEqual([{ ref: 'picks', key: 'picks.ch', from: 'promoted', reason: 'aggregatore: annunci di altri datori' }]);
    expect(store.candidates['picks.ch'].status).toBe('rejected');
    expect(store.candidates['picks.ch'].reason).toBe('aggregatore: annunci di altri datori');
    expect(store.candidates['picks.ch'].rejectedAt).toBeTruthy();
  });

  it('con ledgerFile null non scrive nessuna voce di registro (dry-run)', () => {
    const store = base();
    const silent = path.join(path.dirname(ledgerFile), 'mai-scritto.jsonl');
    const { applied } = rejectCandidates(store, [{ ref: 'picks', reason: 'aggregatore' }], { ledgerFile: null });
    expect(applied).toHaveLength(1);
    expect(fs.existsSync(silent)).toBe(false);
  });

  it('non respinge senza causa: un rejected muto non e\' verificabile', () => {
    const store = base();
    const { applied, skipped } = reject(store, [{ ref: 'picks', reason: '   ' }]);
    expect(applied).toEqual([]);
    expect(skipped[0].why).toBe('causa mancante');
    expect(store.candidates['picks.ch'].status).toBe('promoted');
  });

  it('non tocca un candidato gia\' spedito ne\' uno gia\' rejected', () => {
    const store = base();
    const { applied, skipped } = reject(store, [
      { ref: 'shipped', reason: 'refuso di chiave' },
      { ref: 'sconosciuto', reason: 'causa qualunque' },
    ]);
    expect(applied).toEqual([]);
    expect(store.candidates['shipped.ch'].status).toBe('production');
    expect(skipped.map((s) => s.why)).toEqual([
      "stato production: gia' spedito, si ritira il crawler",
      'candidato non trovato',
    ]);
    expect([...SHIPPED_STATUSES]).toContain('promoting');

    const twice = reject(store, [{ ref: 'picks', reason: 'aggregatore' }, { ref: 'picks', reason: 'aggregatore' }]);
    expect(twice.applied).toHaveLength(1);
    expect(twice.skipped[0].why).toBe("gia' rejected");
  });
});
