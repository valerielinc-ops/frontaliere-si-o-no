/**
 * Un rischio diventa item tracciato SOLO se porta una condizione di
 * accettazione falsificabile (decisione del proprietario, 2026-09-05).
 *
 * Il difetto che questi test sorvegliano: un rischio formulato in prosa
 * («nessun gate impedisce un drift futuro») non cita nulla che un check possa
 * cercare, quindi NESSUNA evidenza potrà mai provarlo affrontato. Coniato come
 * item, entra in coda e non ne esce più — e in un'aggregata fa da gate
 * permanente, tenendo aperta l'intera issue anche quando il lavoro vero è
 * finito. Misurato il 2026-09-05 sul sito: 36 item su 49 nelle aggregate
 * bloccate e 81 su 129 nelle ultime 60 follow-up sono di questa classe; il
 * detector marcava 21 issue `maybe-resolved` e ne chiudeva 2.
 *
 * La riclassificazione NON abbassa la barra di chiusura. Un item non
 * falsificabile non viene chiuso «lo stesso»: viene riconosciuto come mai
 * stato un item valido, quindi non gatea. Gli item validi rimasti devono
 * essere TUTTI token-confermati, uno per uno. E se non resta nessun item
 * valido, l'aggregata NON si chiude — quello sarebbe chiudere su evidenza
 * assente, cioè l'incidente #5849 (aggregata chiusa con due item ancora
 * deferiti, poi riaperta).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hasFalsifiableAcceptance, ACCEPTANCE_CONDITION } from '../scripts/ci/followup-resolution-match.mjs';
import { aggregateCloseGate } from '../scripts/ci/reconcile-followups.mjs';

const prose = `
- Source: reviewer \`## Adversarial check\`
- Stato dichiarato nella PR: nessuno
- Suggested action: valutare se serve un campo esplicito nel registry, o se l'assunzione resta accettabile.
`;
const withToken = `
- Source: reviewer \`## Adversarial check\`
- Stato dichiarato nella PR: nessuno
- Suggested action: aggiungere in \`services/seoService.ts\` un gate che confronti \`resolveSearchConsoleCompatTarget()\` con la sorgente.
`;
const body = (items: string[]) =>
  items.map((s, i) => `### ${i + 1}. item\n${s}`).join('\n');

const io = (content: string) => ({ fileExists: () => true, readFile: () => content });

describe('la condizione di accettazione', () => {
  it('un rischio in prosa non ne ha una', () => {
    expect(hasFalsifiableAcceptance(prose)).toBe(false);
  });

  it('un item che cita un token-codice ce l\'ha', () => {
    expect(hasFalsifiableAcceptance(withToken)).toBe(true);
  });

  it('è lo STESSO oracolo che poi chiude l\'item', () => {
    // Se aprire e chiudere usassero oracoli diversi, un item potrebbe entrare
    // in coda e non esserne mai estraibile: è il difetto, non un dettaglio.
    expect(ACCEPTANCE_CONDITION.id).toBe('cited-code-token');
    expect(ACCEPTANCE_CONDITION.holds(prose)).toBe(false);
    expect(ACCEPTANCE_CONDITION.holds(withToken)).toBe(true);
  });
});

describe('il gate dell\'aggregata', () => {
  it('GUARDRAIL #5849: nessun item valido → NON chiudere', () => {
    const g = aggregateCloseGate(body([prose, prose]), io('qualsiasi cosa'));
    expect(g.blocks).toBe(true);
    expect(g.reason).toBe('no-valid-item');
  });

  it('item valido non confermato → NON chiudere', () => {
    const g = aggregateCloseGate(body([prose, withToken]), io('file che non contiene il token'));
    expect(g.blocks).toBe(true);
    expect(g.reason).toBe('valid-item-unconfirmed');
  });

  it('tutti gli item validi confermati → chiudere, anche con prosa accanto', () => {
    const g = aggregateCloseGate(body([prose, withToken]), io('… resolveSearchConsoleCompatTarget() …'));
    expect(g.blocks).toBe(false);
    expect(g.reason).toBe(null);
  });

  it('corpo senza struttura a item → veto storico, mai «vuoto quindi chiudi»', () => {
    const g = aggregateCloseGate('prosa libera senza sezioni', io('x'));
    expect(g.blocks).toBe(true);
    expect(g.reason).toBe('aggregate-unparsed');
  });
});

describe('pin sul sorgente', () => {
  // I test comportamentali sopra restano verdi anche se il difetto rientra:
  // esercitano `aggregateCloseGate` in isolamento, mentre il difetto vero
  // sarebbe smettere di CHIAMARLO (tornando al veto per titolo) o togliere la
  // regola dal prompt che conia gli item. Vanno pinnati i due punti d'uso.
  const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

  it('reconcile-followups usa il gate per CONTENUTO, non il titolo nudo', () => {
    const src = read('../scripts/ci/reconcile-followups.mjs');
    expect(src).toMatch(/aggGate\s*=\s*isAggregateTitle\([^)]*\)\s*\n?\s*\?\s*aggregateCloseGate\(/);
    expect(src).toContain('const isAggregate = aggGate.blocks;');
    expect(src).not.toMatch(/const isAggregate = isAggregateTitle\(iss\.title\);/);
  });

  it('il prompt che conia gli item porta la regola', () => {
    const wf = read('../.github/workflows/post-merge-followup.yml');
    expect(wf).toContain('no-acceptance-condition');
    expect(wf).toMatch(/condizione di accettazione falsificabile/i);
  });
});
