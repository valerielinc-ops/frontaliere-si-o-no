import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  countAggregateItems,
  countBacklogItems,
} from '../scripts/ci/followup-drainer.mjs';
import {
  hasEnumeratedItems as preflightHasEnumeratedItems,
  isAggregate,
  isAggregateForAnalytics,
} from '../scripts/ci/check-issue-already-resolved.mjs';
import {
  hasEnumeratedItems as harvestHasEnumeratedItems,
  isAvoidableAlreadyFixed,
  isAvoidableMaxTurns,
} from '../scripts/ci/harvest-agent-lessons.mjs';
import {
  hasEnumeratedItems as reconcileHasEnumeratedItems,
  isAggregateTitle,
} from '../scripts/ci/reconcile-followups.mjs';

const G5_BODY = [
  '## 1. Primo item',
  '## 2. Secondo item',
].join('\n');

describe('G5 — follow-up detector regressions', () => {
  it('ignora fence anche quando sono indentati sotto un bullet', () => {
    const body = [
      '- contesto',
      '    ```markdown',
      '    ## 1. item inventato',
      '    ## 2. item inventato',
      '    ```',
    ].join('\n');

    expect(countBacklogItems(body)).toBe(0);
    expect(countAggregateItems(body)).toBe(0);
    expect(preflightHasEnumeratedItems(body)).toBe(false);
    expect(harvestHasEnumeratedItems(body)).toBe(false);
    expect(reconcileHasEnumeratedItems(body)).toBe(false);
  });

  it('mantiene il testo di un fence non chiuso come fallback conservativo', () => {
    const body = ['```markdown', '## 1. item reale', '## 2. item reale'].join('\n');

    expect(countBacklogItems(body)).toBe(2);
    expect(countAggregateItems(body)).toBe(2);
    expect(preflightHasEnumeratedItems(body)).toBe(true);
    expect(harvestHasEnumeratedItems(body)).toBe(true);
    expect(reconcileHasEnumeratedItems(body)).toBe(true);
  });

  it('conta come item un lead bold che chiude sulla riga successiva', () => {
    const wrapped = '1. **Un titolo che\n   continua**\n2. **Altro titolo**';

    expect(preflightHasEnumeratedItems(wrapped)).toBe(true);
    expect(harvestHasEnumeratedItems(wrapped)).toBe(true);
    expect(reconcileHasEnumeratedItems(wrapped)).toBe(true);
  });

  it('riconosce la stessa enumerazione reale nelle tre copie del detector', () => {
    const valid = '1. **Primo titolo.**\n2. **Secondo titolo.**';

    expect(preflightHasEnumeratedItems(valid)).toBe(true);
    expect(harvestHasEnumeratedItems(valid)).toBe(true);
    expect(reconcileHasEnumeratedItems(valid)).toBe(true);
  });

  it('allinea i titoli markdown Item al conteggio del drainer', () => {
    const headings = '### Item 1 — Primo item\n### 2 — Secondo item';

    expect(preflightHasEnumeratedItems(headings)).toBe(true);
    expect(harvestHasEnumeratedItems(headings)).toBe(true);
    expect(reconcileHasEnumeratedItems(headings)).toBe(true);
    expect(isAggregateTitle('follow-up(#1): cleanup', headings)).toBe(true);
  });

  it('condivide la grammatica per dash senza spazio, anni e quarto livello (#8030)', () => {
    const noSpaceAfterDash = '## Item 1—Primo item\n### 2—Secondo item';
    expect(countAggregateItems(noSpaceAfterDash)).toBe(2);
    expect(preflightHasEnumeratedItems(noSpaceAfterDash)).toBe(true);
    expect(harvestHasEnumeratedItems(noSpaceAfterDash)).toBe(true);
    expect(reconcileHasEnumeratedItems(noSpaceAfterDash)).toBe(true);

    const yearHeadings = '## 2026 — Retro\n### 2025—Retro';
    expect(countAggregateItems(yearHeadings)).toBe(0);
    expect(preflightHasEnumeratedItems(yearHeadings)).toBe(false);
    expect(harvestHasEnumeratedItems(yearHeadings)).toBe(false);
    expect(reconcileHasEnumeratedItems(yearHeadings)).toBe(false);

    const levelFour = '#### 1. Primo item\n#### 2. Secondo item';
    expect(countAggregateItems(levelFour)).toBe(0);
    expect(preflightHasEnumeratedItems(levelFour)).toBe(false);
    expect(harvestHasEnumeratedItems(levelFour)).toBe(false);
    expect(reconcileHasEnumeratedItems(levelFour)).toBe(false);
  });

  it('non lascia che un conteggio nel body sopprima gli item enumerati', () => {
    expect(isAggregate('follow-up(#1): cleanup', `${G5_BODY}\n1 item deferred`)).toBe(true);
  });

  it('rimuove i fence e legge il fallback keyword anche dal body', () => {
    const fencedKeyword = ['```text', 'batch of unrelated prose', '```'].join('\n');

    expect(isAggregate('follow-up(#1): cleanup', fencedKeyword)).toBe(false);
    expect(isAggregate('follow-up(#1): cleanup', 'This batch has work to do.')).toBe(true);
    expect(isAggregate('follow-up(#1): batch cleanup', 'ordinary single-item prose')).toBe(true);
  });

  it('usa la forma esplicita bilingue `items deferred` / `item deferiti` in tutti gli stadi', () => {
    expect(isAggregateTitle('follow-up(#1): 3 items deferred — a, b, c')).toBe(true);
    expect(isAggregateTitle('follow-up(#1): 3 item deferiti — a, b, c')).toBe(true);
    expect(isAggregateTitle('follow-up(#1): 1 item deferito — a')).toBe(false);
    expect(isAggregateTitle('follow-up(#1): 3 items planned — a, b, c')).toBe(false);
    expect(isAggregateTitle('follow-up(#1): 3 items — a, b, c')).toBe(false);
    expect(isAggregate('follow-up(#1): 3 items — a, b, c', '')).toBe(false);
    expect(isAggregate('follow-up(#1): 3 item deferiti — a, b, c', '')).toBe(true);
    expect(isAggregateTitle('follow-up(#1): cleanup', G5_BODY)).toBe(true);
  });

  it('non classifica il lavoro enumerato come burn evitabile nell’harvester', () => {
    expect(isAvoidableAlreadyFixed('follow-up(#1): cleanup', ['follow-up'], G5_BODY)).toBe(false);
    expect(isAvoidableMaxTurns('follow-up(#1): cleanup', ['follow-up'], false, G5_BODY)).toBe(false);
    expect(isAvoidableAlreadyFixed('follow-up(#1): 3 item deferiti — a, b, c', ['follow-up'])).toBe(false);
    expect(isAvoidableMaxTurns('follow-up(#1): 3 item deferiti — a, b, c', ['follow-up'])).toBe(false);
  });

  it('tratta un daily bucket a un solo item come aggregate anche nell’analytics', () => {
    const title = 'follow-up(daily:2026-09-13): 1 item — owner/repo';

    expect(isAggregate(title, '')).toBe(true);
    expect(isAvoidableAlreadyFixed(title, ['follow-up'])).toBe(false);
    expect(isAvoidableMaxTurns(title, ['follow-up'], false)).toBe(false);
  });

  it('mantiene il keyword body-only fuori dal burn analytics, ma non dal pre-flight', () => {
    const title = 'follow-up(#1): cleanup';
    const body = 'The single item has a batch-related note in ordinary prose.';

    expect(isAggregate(title, body)).toBe(true);
    expect(isAggregateForAnalytics(title, body)).toBe(false);
    expect(isAvoidableAlreadyFixed(title, ['follow-up'], body)).toBe(true);
    expect(isAvoidableMaxTurns(title, ['follow-up'], false, body)).toBe(true);
  });
});

describe('G5 — kill switch di auto-chiusura nei workflow', () => {
  it('passa FOLLOWUP_NO_AUTOCLOSE ai due percorsi che possono chiudere issue', () => {
    const drainer = readFileSync('.github/workflows/followup-drainer.yml', 'utf8');
    const harvest = readFileSync('.github/workflows/lessons-harvester.yml', 'utf8');
    const harvestScript = readFileSync('scripts/ci/harvest-agent-lessons.mjs', 'utf8');

    const drainStep = drainer.slice(drainer.indexOf('- name: Drain follow-up queue'));
    const harvestStep = harvest.slice(harvest.indexOf('- name: Aggregate recurring patterns'));
    expect(drainStep).toContain("FOLLOWUP_NO_AUTOCLOSE: '1'");
    expect(harvestStep).toContain("FOLLOWUP_NO_AUTOCLOSE: '1'");
    expect(harvestScript).toMatch(/const NO_AUTOCLOSE = process\.env\.FOLLOWUP_NO_AUTOCLOSE === '1'/);
    expect(harvestScript).toContain('SELF-HEAL close skipped');
  });
});
