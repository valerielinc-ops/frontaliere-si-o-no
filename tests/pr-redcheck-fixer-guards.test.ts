/**
 * pr-redcheck-fixer.yml — le guardie che rendono sicuro un fixer che parte da
 * un CHECK ROSSO invece che da una review.
 *
 * Il buco che chiude: il 🔴-fixer parte su `pull_request_review`, cioè sui
 * findings che il reviewer SCRIVE. Ma il reviewer legge il diff, non la CI —
 * quindi una PR autonoma con un check required rosso e nessun 🔴 non aveva
 * alcun meccanismo che la guardasse. Verificato il 2026-08-23: nessuno dei 210
 * workflow del repo si attiva su `check_suite`/`check_run`.
 *
 * Il caso reale: PR #6296. Il 🔴-fixer pusha la sua fix alle 03:39, quella fix
 * rompe `monitor-issue-dedup`, il round cap scatta alle 04:12, e la PR resta
 * rossa **20 ore** — rossa per il commit del fixer stesso, con nessuno a
 * guardare. Misura di contorno: su 51 branch di PR, 11 hanno avuto un `tests`
 * rosso e 10 sono tornati verdi da soli; il buco è il residuo.
 *
 * Un fixer che parte dal rosso ha però un modo OVVIO e sbagliato di riuscire:
 * indebolire il test. Questi test fissano le guardie che lo impediscono, e
 * quelle che impediscono di lavorare su una PR o su un rosso che non sono suoi.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const WF = path.resolve(__dirname, '..', '.github', 'workflows', 'pr-redcheck-fixer.yml');
const src = readFileSync(WF, 'utf-8');
const TWIN = readFileSync(
  path.resolve(__dirname, '..', '.github', 'workflows', 'pr-redflag-fixer.yml'), 'utf-8');

describe('trigger — parte solo su un rosso vero, di una PR vera', () => {
  it('si attiva sul completamento di `tests`, non su ogni evento', () => {
    expect(src).toMatch(/workflow_run:\s*\n\s*workflows: \['tests'\]/);
    expect(src).toMatch(/types: \[completed\]/);
  });

  it('il gate richiede conclusion=failure, ed esclude i push su main', () => {
    // Senza il secondo termine il workflow partirebbe anche sui fallimenti di
    // `tests` su main — dove non c'è nessuna PR da riparare e il fixer
    // girerebbe a vuoto bruciando quota.
    expect(src).toContain("github.event.workflow_run.conclusion == 'failure'");
    expect(src).toContain("github.event.workflow_run.event != 'push'");
  });

  it('NON si restringe a `pull_request`: le head rebasate arrivano da dispatch', () => {
    // `pr-autorebase.yml` ri-testa una head rebasata con un `workflow_dispatch`
    // di `tests`, perché un push con PAT non ri-triggera affidabilmente i
    // workflow `pull_request`. Gatare sul solo `pull_request` lascerebbe fuori
    // proprio quei rossi. Il preflight resta la guardia vera: cerca una PR
    // APERTA con quel head branch, e su main non ne trova nessuna.
    expect(src).not.toContain("workflow_run.event == 'pull_request'");
    expect(src).toContain('Nessuna PR aperta per il branch');
  });

  it('è serializzato per branch, e NON cancella la run in corso', () => {
    // `cancel-in-progress: true` ucciderebbe un fix a metà push.
    expect(src).toMatch(/group: redcheck-fix-\$\{\{ github\.event\.workflow_run\.head_branch/);
    expect(src).toMatch(/cancel-in-progress: false/);
  });
});

describe('scope — non tocca ciò che non è suo', () => {
  it('salta le PR di un umano (stessa regola del gemello)', () => {
    expect(src).toContain('fuori scope per design');
    expect(src).toMatch(/autonomous=false/);
    expect(src).toMatch(/fix\/\*\) autonomous=true/);
  });

  it('salta le draft', () => {
    expect(src).toMatch(/\[ "\$draft" = "true" \]/);
  });

  it('salta un rosso STANTIO: il fallimento deve essere della HEAD corrente', () => {
    // Un rosso su uno SHA superato è già stato risolto da un push successivo.
    // Fixarlo significherebbe lavorare su una diagnosi vecchia.
    expect(src).toContain('rosso stantio');
    expect(src).toMatch(/\[ "\$RUN_SHA" != "\$head_sha" \]/);
  });

  it('ri-verifica che la CI sia rossa ADESSO, non solo al trigger', () => {
    // Fra il trigger e il job può essere passato un re-run che l'ha rimessa verde.
    expect(src).toMatch(/check-runs\?per_page=100/);
    expect(src).toContain("gia' rientrato");
  });

  it('non corre sopra il 🔴-fixer sullo stesso branch (push race)', () => {
    expect(src).toContain('pr-redflag-fixer.yml');
    expect(src).toContain('push race');
  });
});

describe('anti-loop — bounded come il gemello', () => {
  it('conta i round con un marker proprio, non con quello del 🔴-fixer', () => {
    // Un marker condiviso farebbe consumare a un fixer i round dell'altro.
    expect(src).toContain('REDCHECK_FIX_ROUND');
    expect(src).not.toContain('REDFLAG_FIX_ROUND');
  });

  it('al cap escala a needs-human e NON invoca Claude', () => {
    const guard = src.slice(src.indexOf('MAX_ROUNDS=2'), src.indexOf('Configure git identity'));
    expect(guard).toContain('needs-human');
    expect(guard).toContain('proceed=false');
  });

  it('il marker si incrementa PRIMA di Claude (una run che muore conta lo stesso)', () => {
    // Scelta deliberata ereditata dal gemello: se una run che va in crash non
    // consumasse il round, un fixer che crasha sistematicamente girerebbe
    // all'infinito. L'anti-loop vale più del round sprecato.
    const i = src.indexOf('REDCHECK_FIX_ROUND: %s');
    const j = src.indexOf('Run Claude');
    expect(i).toBeGreaterThan(0);
    expect(i).toBeLessThan(j);
  });
});

describe('REGOLA #0 — il modo ovvio e sbagliato di far tornare verde un test', () => {
  const prompt = src.slice(src.indexOf('prompt: |'), src.indexOf('- name: Claude usage metrics'));

  it('il prompt vieta esplicitamente di indebolire il test', () => {
    expect(prompt).toContain('non si fa passare un test indebolendolo');
    expect(prompt).toContain('AGENTS.md non-negotiable #1');
  });

  it('enumera le scorciatoie vietate una per una, non genericamente', () => {
    // «non barare» in astratto non è azionabile: le forme concrete sì.
    for (const forma of ['.skip', 'rilassare', 'ratchet', 'allowlist']) {
      expect(prompt.toLowerCase()).toContain(forma.toLowerCase());
    }
  });

  it('l\'unica eccezione è vincolata a tre condizioni verificabili', () => {
    // I guard di questo repo a volte dichiarano ESSI STESSI una via d'uscita
    // (RAW_CREATE_ALLOWED). Usarla è legittimo solo se documentata dal guard,
    // verificata contro il codice, e motivata per iscritto.
    expect(prompt).toContain('RAW_CREATE_ALLOWED');
    expect(prompt).toContain('contro il codice');
  });

  it('impone di distinguere un rosso EREDITATO da un rosso della PR', () => {
    // Ripararlo qui lo nasconderebbe invece di risolverlo.
    expect(prompt).toContain('EREDITATO');
    expect(prompt).toContain('TERMINA senza toccare la PR');
  });

  it('impone di riprodurre il fallimento prima di fixarlo', () => {
    expect(prompt).toContain('npx vitest run');
    expect(prompt).toContain('non è un fix');
  });
});

describe('costo — il contesto è raccolto senza Claude', () => {
  it('il log del job fallito è pre-raccolto e limitato', () => {
    // Far scaricare all'agente il log di `tests` (decine di MB) brucia turni di
    // setup, che è il primo consumatore misurato in questo repo.
    expect(src).toContain('Collect failing check context (zero-Claude)');
    expect(src).toContain('--log-failed');
    expect(src).toMatch(/head -c 24000/);
  });

  it('filtra sulle sole righe `FAIL `', () => {
    // `cancelled` e le righe di riepilogo si leggono come fallimenti e mandano
    // la diagnosi fuori strada.
    expect(src).toMatch(/FAIL /);
    expect(src).toContain('escape ANSI come TESTO');
  });
});

describe('parità col gemello — ciò che è stato ereditato deve restare intatto', () => {
  it('passa alla action lo stesso token con cui ha autenticato il remote', () => {
    // L'invariante di classe di issue-fix-app-token-wiring: senza, la action
    // conia un token proprio e riscrive il remote appena configurato.
    expect(src).toContain('github_token: ${{ env.APP_TOKEN || env.GITHUB_PAT }}');
  });

  it('classifica l\'esito sul LAVORO fatto, non sull\'exit della CLI', () => {
    expect(src).toContain('Classify outcome (work-done, not CLI exit)');
  });

  it('ha lo stesso capability guard su .github/workflows/**', () => {
    expect(src).toMatch(/touches_wf=/);
    expect(TWIN).toMatch(/touches_wf=/);
  });
});
