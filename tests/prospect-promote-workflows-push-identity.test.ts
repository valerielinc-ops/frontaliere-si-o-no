/**
 * La capacità `workflows` letta nel prospector deve descrivere l'IDENTITÀ CHE
 * PUSHA, non una qualunque presente nell'env.
 *
 * Il difetto che chiude (follow-up #7292, item 3 di #7276). Lo step «Promote
 * validated crawlers» di `prospector-loop.yml` fissa la credenziale di push
 * riscrivendo il remote su `x-access-token:${APP_TOKEN}` — pusha la GitHub App.
 * `prospect-promote.mjs` gatava però la rigenerazione dei gruppi su
 * `canPushWorkflows()`, che è l'OR delle due sorgenti e accetta anche
 * `PAT_WORKFLOWS_SCOPE`. Oggi quel ramo è inerte (la sonda PAT non gira in quel
 * job), ma cablarcela — un `PUSH_TOKEN` PAT mentre il push resta della App —
 * avrebbe fatto dire `true` al gate per l'identità sbagliata: 10 crawler
 * scaffoldati e poi «refusing to allow a GitHub App to create or update
 * workflow» al push, un guasto TARDIVO che nel log somiglia a un problema di
 * generazione e non di credenziale.
 *
 * L'osservatore ha due metà, perché il difetto vive nella giuntura fra le due:
 * la semantica fail-closed di `canPushWorkflowsAs`, e il cablaggio — che il
 * consumatore usi la variante legata all'identità e che il job dichiari la
 * propria accanto al token che la porta.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  canPushWorkflowsAs,
  canPushWorkflows,
  WORKFLOWS_CAPABILITY_SOURCES,
} from '../scripts/ci/followup-drainer.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(`${root}${p}`, 'utf8');

describe('canPushWorkflowsAs — una sola sorgente per identità', () => {
  it('`app` legge SOLO APP_TOKEN_WORKFLOWS', () => {
    expect(canPushWorkflowsAs('app', { APP_TOKEN_WORKFLOWS: 'true' } as NodeJS.ProcessEnv)).toBe(true);
    expect(canPushWorkflowsAs('app', { PAT_WORKFLOWS_SCOPE: 'true' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('`pat` legge SOLO PAT_WORKFLOWS_SCOPE', () => {
    expect(canPushWorkflowsAs('pat', { PAT_WORKFLOWS_SCOPE: 'true' } as NodeJS.ProcessEnv)).toBe(true);
    expect(canPushWorkflowsAs('pat', { APP_TOKEN_WORKFLOWS: 'true' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('è la falsificazione del difetto: la capacità dell\'altra identità non concede nulla', () => {
    // Lo scenario esatto del rilievo: sonda PAT cablata nel job del prospector,
    // push ancora della App con `workflows` NON concesso.
    const env = { PAT_WORKFLOWS_SCOPE: 'true', APP_TOKEN_WORKFLOWS: 'false' } as NodeJS.ProcessEnv;
    expect(canPushWorkflows(env)).toBe(true); // l'OR: vero, ma per l'identità sbagliata
    expect(canPushWorkflowsAs('app', env)).toBe(false); // legato al push reale
  });

  it('identità assente, vuota o ignota → false (fail-closed)', () => {
    const env = { APP_TOKEN_WORKFLOWS: 'true', PAT_WORKFLOWS_SCOPE: 'true' } as NodeJS.ProcessEnv;
    for (const id of [undefined, null, '', '  ', 'github-token', 'App Token', 42]) {
      expect(canPushWorkflowsAs(id as unknown as string, env)).toBe(false);
    }
  });

  it('normalizza case e spazi dell\'identità dichiarata', () => {
    const env = { APP_TOKEN_WORKFLOWS: 'true' } as NodeJS.ProcessEnv;
    expect(canPushWorkflowsAs(' APP ', env)).toBe(true);
  });

  it('nessun valore diverso dalla stringa `true` concede la capacità', () => {
    for (const v of [undefined, '1', 'yes', 'TRUE', '']) {
      expect(canPushWorkflowsAs('app', { APP_TOKEN_WORKFLOWS: v } as NodeJS.ProcessEnv)).toBe(false);
    }
  });

  it('la mappa copre esattamente le due identità note', () => {
    expect(Object.keys(WORKFLOWS_CAPABILITY_SOURCES).sort()).toEqual(['app', 'pat']);
  });
});

describe('cablaggio: capacità letta e identità che pusha non possono divergere', () => {
  const promote = read('scripts/prospect-promote.mjs');
  const loop = read('.github/workflows/prospector-loop.yml');

  it('`prospect-promote.mjs` gata sull\'identità dichiarata, non sull\'OR', () => {
    expect(promote).toMatch(/canPushWorkflowsAs\(process\.env\.WORKFLOWS_PUSH_IDENTITY\)/);
    // L'OR non deve rientrare da nessuna porta: qui l'identità di push è fissa.
    // Sul CODICE, non sui commenti — il commento sopra il gate cita `canPushWorkflows()`
    // proprio per spiegare perché NON si usa, e sopprimerlo perderebbe la ragione.
    const code = promote.split('\n').filter((l) => !l.trim().startsWith('//'));
    expect(code.some((l) => /\bcanPushWorkflows\(/.test(l))).toBe(false);
  });

  it('lo step che pusha dichiara la propria identità accanto al token', () => {
    // La dichiarazione deve stare nello STESSO step che riscrive il remote:
    // separarle è ciò che permette alle due di divergere in silenzio.
    const step = loop.split(/^ {6}- name: /m).find((s) => s.startsWith('Promote validated crawlers'));
    expect(step, 'step «Promote validated crawlers» non trovato').toBeDefined();
    expect(step).toMatch(/WORKFLOWS_PUSH_IDENTITY:\s*app\b/);
    expect(step).toMatch(/x-access-token:\$\{APP_TOKEN\}/);
  });
});
