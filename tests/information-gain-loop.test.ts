/**
 * La catena automatica del ciclo Information Gain (issue #5002).
 *
 * Lo scan live non è testabile end-to-end senza rete, ma la parte che decide
 * **cosa fa il ciclo** è pura, ed è quella che sbaglia in silenzio: ogni
 * bucket è un loop diverso, e scambiarne due non rompe niente di visibile.
 * Il caso peggiore è una coorte dell'inventario risalita che venisse
 * classificata come «opportunità» invece che come «ratchet»: la sua riga
 * resterebbe nell'inventario per sempre e il gate non si stringerebbe più,
 * senza che nulla diventi rosso.
 *
 * Il resto del file pinna le due proprietà per cui la catena è una catena e
 * non un generatore di rumore: i titoli sono stabili (altrimenti il dedup a 60
 * caratteri di `github-issue-creator` apre una issue nuova a ogni run) e la
 * misura sta nel corpo (altrimenti il ciclo lavora su numeri scaduti).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { classifyCohorts } from '@/scripts/ci/information-gain-live-scan.mjs';
import { INFORMATION_GAIN_GATE } from '@/scripts/audit-information-gain.mjs';

const REPO_ROOT = path.resolve(__dirname, '..');

const cohort = (label: string, medianIgs: number, pages = 20) => ({
  label,
  medianIgs,
  pages,
  gated: true,
  zeroGainPages: medianIgs === 0 ? pages : 0,
  worst: [],
});

const OPTS = { floor: 5, tolerance: 1.5, target: 40, inventory: new Map<string, number>() };

describe('classifyCohorts — i tre bucket sono tre loop diversi', () => {
  it('una coorte fuori inventario sotto il floor è una regressione', () => {
    const { regressions, ratchets, opportunities } = classifyCohorts([cohort('it:/a/', 0)], OPTS);
    expect(regressions.map((r) => r.label)).toEqual(['it:/a/']);
    expect(regressions[0].reason).toBe('below-floor');
    expect(ratchets).toEqual([]);
    expect(opportunities).toEqual([]);
  });

  it('una coorte dell’inventario risalita sopra il floor è un ratchet, non un’opportunità', () => {
    // Se finisse fra le opportunità, la sua riga resterebbe nell'inventario per
    // sempre: il gate continuerebbe a proteggerla da un peggioramento senza mai
    // chiederle di stare sopra il floor come a tutte le altre.
    const { ratchets, opportunities, regressions } = classifyCohorts([cohort('it:/b/', 9)], {
      ...OPTS,
      inventory: new Map([['it:/b/', 0]]),
    });
    expect(ratchets.map((r) => r.label)).toEqual(['it:/b/']);
    expect(ratchets[0].recorded).toBe(0);
    expect(opportunities).toEqual([]);
    expect(regressions).toEqual([]);
  });

  it('una coorte dell’inventario che peggiora oltre la tolleranza è una regressione', () => {
    const { regressions } = classifyCohorts([cohort('it:/c/', 2.4)], {
      ...OPTS,
      inventory: new Map([['it:/c/', 4.2]]),
    });
    expect(regressions[0].reason).toBe('regressed-vs-inventory');
    expect(regressions[0].recorded).toBe(4.2);
  });

  it('dentro la tolleranza non è né regressione né ratchet: resta ferma', () => {
    // 4,2 → 3,5 è meno di 1,5 punti di calo e resta sotto il floor: niente da
    // segnalare e niente da togliere. Senza questo ramo il ciclo aprirebbe e
    // chiuderebbe la stessa issue a giorni alterni sul rumore del campione.
    const { regressions, ratchets, opportunities } = classifyCohorts([cohort('it:/d/', 3.5)], {
      ...OPTS,
      inventory: new Map([['it:/d/', 4.2]]),
    });
    expect(regressions).toEqual([]);
    expect(ratchets).toEqual([]);
    expect(opportunities).toEqual([]);
  });

  it('sopra il floor ma sotto il target è un’opportunità, e la peggiore viene prima', () => {
    const { opportunities } = classifyCohorts(
      [cohort('it:/alta/', 30), cohort('it:/bassa/', 6), cohort('it:/media/', 15)],
      OPTS,
    );
    expect(opportunities.map((o) => o.label)).toEqual(['it:/bassa/', 'it:/media/', 'it:/alta/']);
  });

  it('una coorte che ha raggiunto il target non produce niente', () => {
    const { regressions, ratchets, opportunities } = classifyCohorts([cohort('it:/ok/', 52)], OPTS);
    expect([regressions, ratchets, opportunities].every((b) => b.length === 0)).toBe(true);
  });

  it('legge floor e tolleranza dal gate, non da costanti proprie', () => {
    // Due soglie in due file divergono: quella che il ciclo usa per aprire una
    // issue deve essere la stessa che il gate usa per bloccare.
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'scripts/ci/information-gain-live-scan.mjs'),
      'utf-8',
    );
    expect(src).toContain('INFORMATION_GAIN_GATE');
    expect(src).toMatch(/floor:\s*MEDIAN_IGS_FLOOR_PCT/);
    expect(src).toMatch(/tolerance:\s*REGRESSION_TOLERANCE_PCT/);
    expect(INFORMATION_GAIN_GATE.MEDIAN_IGS_FLOOR_PCT).toBeGreaterThan(0);
  });
});

describe('i titoli delle issue sono stabili e la misura sta nel corpo', () => {
  const src = fs.readFileSync(
    path.join(REPO_ROOT, 'scripts/ci/information-gain-loop-issues.mjs'),
    'utf-8',
  );

  it('nessun titolo interpola una misura', () => {
    // `createGithubIssue` dedupa sui primi 60 caratteri: una percentuale nel
    // titolo cambia a ogni run e ogni run aprirebbe una issue nuova.
    const titlesBlock = src.slice(src.indexOf('const titles = {'), src.indexOf('const worstList'));
    expect(titlesBlock).not.toMatch(/medianIgs|pct\(|recorded/);
    expect(titlesBlock).toMatch(/\$\{label\}/);
  });

  it('l’etichetta della coorte è il PRIMO token di ogni titolo', () => {
    // Il discriminante deve stare dentro il prefisso di dedup, altrimenti due
    // famiglie diverse si deduplicano l'una nell'altra.
    const titlesBlock = src.slice(src.indexOf('const titles = {'), src.indexOf('const worstList'));
    for (const line of titlesBlock.split('\n').filter((l) => l.includes('=> `'))) {
      expect(line).toMatch(/=> `\$\{label\}/);
    }
  });

  it('ogni corpo riporta la misura e il criterio di chiusura', () => {
    for (const fn of ['regressionBody', 'ratchetBody', 'opportunityBody']) {
      const body = src.slice(src.indexOf(`function ${fn}`), src.indexOf('}', src.indexOf(`function ${fn}`) + 2000));
      expect(body, fn).toMatch(/pct\(/);
      expect(body, fn).toMatch(/hiusura|hiude/);
    }
  });

  it('le regressioni passano dal gate delle occorrenze consecutive', () => {
    // Fra il merge e le pagine servite c'è un deploy: una singola run che vede
    // l'HTML vecchio è lo stato normale subito dopo una fix.
    expect(src).toMatch(/consecutiveGate:\s*2/);
  });

  it('lo scan non fa fallire la run', () => {
    const scan = fs.readFileSync(
      path.join(REPO_ROOT, 'scripts/ci/information-gain-live-scan.mjs'),
      'utf-8',
    );
    expect(scan).toMatch(/process\.exit\(0\)/);
  });
});

describe('il workflow aggancia entrambe le metà', () => {
  const wf = fs.readFileSync(
    path.join(REPO_ROOT, '.github/workflows/information-gain-scan.yml'),
    'utf-8',
  );

  it('gira lo scan e poi lo script delle issue', () => {
    expect(wf).toContain('scripts/ci/information-gain-live-scan.mjs');
    expect(wf).toContain('scripts/ci/information-gain-loop-issues.mjs');
  });

  it('ha il permesso di scrivere issue e non altro', () => {
    expect(wf).toMatch(/issues:\s*write/);
    expect(wf).toMatch(/contents:\s*read/);
  });

  it('è schedulato e lanciabile a mano', () => {
    expect(wf).toMatch(/schedule:/);
    expect(wf).toMatch(/workflow_dispatch:/);
  });
});
