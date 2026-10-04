import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import {
  CANDIDATE_BULLETS_READING_RULES,
  renderCandidateBulletsSection,
} from '../scripts/ci/followup-candidate-bullets.mjs';
import { validateWorkflowText } from '../scripts/ci/validate-modified-workflows.mjs';

const workflowPath = path.resolve('.github/workflows/post-merge-followup.yml');

describe('post-merge follow-up mint gates', () => {
  it('keeps site and corpus gates unconditional after quota became telemetry', () => {
    const workflowText = fs.readFileSync(workflowPath, 'utf8');
    const workflow = YAML.parse(workflowText) as {
      jobs?: { followup?: { steps?: Array<Record<string, unknown>> } };
    };
    const steps = workflow.jobs?.followup?.steps ?? [];
    const mintGates = steps.filter((step) => (
      typeof step.name === 'string' && step.name.startsWith('Gate sul conio')
    ));

    expect(mintGates).toHaveLength(2);
    expect(mintGates.map((step) => step.if)).toEqual(['always()', 'always()']);
    expect(mintGates.every((step) => !String(step.if).includes('quota_blocked'))).toBe(true);

    const quotaTelemetry = steps.find((step) => step.id === 'quota');
    expect(quotaTelemetry).toMatchObject({
      name: 'Pre-flight — Codex lane quota telemetry',
      'continue-on-error': true,
    });
  });
});

// Titolo di fallimento: «Triage follow-up: il prompt conia item con token già
// vero o nel repository sbagliato».
describe('post-merge follow-up triage prompt', () => {
  type Step = { name?: string; id?: string; run?: string; with?: { prompt?: string } };
  const workflow = YAML.parse(fs.readFileSync(workflowPath, 'utf8')) as {
    jobs?: { followup?: { steps?: Step[] } };
  };
  const steps = workflow.jobs?.followup?.steps ?? [];
  const prompt = steps.find((step) => step.id === 'followup')?.with?.prompt ?? '';
  const prefetch = steps.find((step) => step.id === 'batchctx')?.run ?? '';

  it('consegna al triage i bullet già classificati invece di fargli rileggere la sezione', () => {
    expect(prefetch).toMatch(/^\s*node scripts\/ci\/followup-candidate-bullets\.mjs --side site /m);
    expect(prefetch).toContain('cat "$CTX_DIR/candidate-bullets.md"');
    expect(fs.existsSync(path.resolve('scripts/ci/followup-candidate-bullets.mjs'))).toBe(true);
    expect(prompt).toContain('## Candidate bullets');
    expect(prompt).toMatch(/`candidate: false`[^\n]*NON creare issue/);
  });

  it('rende vincolante solo lo stato che chiude, e solo per le righe di lista', () => {
    // Il match lessicale dell'hard-exclude resta al giudizio del triage, e
    // `candidate: true` è ammissibilità, non un ordine di coniare.
    expect(prompt).toMatch(/`candidate: false` con `reason: closing-state`[^\n]*NON creare issue/);
    expect(prompt).toMatch(/`reason: hard-exclude`[^\n]*LESSICALE/);
    expect(prompt).toMatch(/`candidate: true` significa AMMISSIBILE/);
    expect(prompt).toMatch(/Solo `kind: bullet` è materia di conio/);
    expect(prompt).not.toMatch(/`candidate: true`[^\n]*\*\*crea issue\*\*/);
  });

  it('vincola il token derivato a essere assente oggi, accanto all\'istruzione di derivarlo', () => {
    const derive = prompt.indexOf('DERIVALO invece di scartarlo');
    const absent = prompt.indexOf('ASSENTE OGGI');
    expect(derive).toBeGreaterThanOrEqual(0);
    expect(absent).toBeGreaterThan(derive);
    // «Accanto»: nello stesso bullet, prima della nota sul gate deterministico.
    expect(absent).toBeLessThan(prompt.indexOf('scripts/ci/gate-minted-followups.mjs'));
    expect(prompt).toContain('NON trova oggi');
    expect(prompt).toContain('already-on-main');
  });

  // GitHub rifiuta un prompt block scalar (e il blocco `with:` che lo contiene)
  // oltre 20.000 caratteri: il workflow non parte e nessun test di contenuto lo
  // dice. E' la stessa funzione del gate «Validate modified workflows», qui
  // perche' chi tocca il prompt lo veda in locale. Il dettaglio delle regole
  // vive nella sezione generata proprio per tenere il prompt sotto il limite.
  it('prompt e blocco with restano sotto il limite di GitHub', () => {
    const text = fs.readFileSync(workflowPath, 'utf8');
    expect(validateWorkflowText('.github/workflows/post-merge-followup.yml', text)).toEqual([]);
  });

  it('rimanda alle regole di lettura che la sezione generata porta con se\'', () => {
    expect(prompt).toContain('«Regole di lettura»');
    expect(CANDIDATE_BULLETS_READING_RULES[0]).toBe('### Regole di lettura');
    const section = renderCandidateBulletsSection([], { manifestOk: true });
    for (const rule of CANDIDATE_BULLETS_READING_RULES) expect(section).toContain(rule);
    // Le sei regole di dettaglio: nel prompt resta solo il riassunto.
    expect(section).toMatch(/`candidate: false` con `reason: closing-state` \(`in questa PR`/);
    expect(section).toMatch(/`reason: hard-exclude` → è un match LESSICALE/);
    expect(section).toMatch(/`candidate: true` significa AMMISSIBILE/);
    expect(section).toMatch(/`candidate: true` con `blocked: <causa>`[^\n]*`State: blocked`/);
    expect(section).toMatch(/`candidate: true` senza stato → resta candidato/);
    expect(section).toMatch(/Solo `kind: bullet` è materia di conio[^\n]*`kind: prose`/);
  });

  it('instrada con le route del bundle e marca quelle non verificate', () => {
    expect(prompt).toMatch(/`repo` → `Target repository`, `targetPath` → `Target file`/);
    expect(prompt).toContain('route-unverified');
  });

  it('non conia la verifica rinviata alla CI che la run `tests` dell\'head ha già eseguito verde', () => {
    // Titolo di fallimento: «Triage follow-up: verifica rinviata alla CI
    // coniata senza leggere la run del merge».
    expect(prefetch).toMatch(/gh pr view "\$n" --repo "\$REPO" --json [^\n]*\bheadRefOid\b/);
    expect(prompt).toMatch(/`reason: verified-by-merge-run`[^\n]*NON creare issue[^\n]*`ownVerification\.runId`/);
  });

  it('conia con `State: blocked` i bullet bloccati da una causa non di codice', () => {
    expect(prompt).toMatch(/causa NON è di codice[^\n]*`State: blocked`/);
  });

  it('non manda in un item di codice una prova post-merge né un COMANDO che riscrive dati', () => {
    expect(prompt).toMatch(/prova post-merge senza file da modificare[^\n]*`Live-verification`/);
    expect(prompt).toMatch(/`COMANDO`[^\n]*mai uno script che riscrive dati/);
  });
});
