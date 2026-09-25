import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parentDequeueBudgetDecision } from '../scripts/ci/followup-drainer.mjs';

const ITEM_COST_MS = 8_000;
const PARENT_CLOSE_CAP = 5;

describe('parent-dequeue — budget e capacità riservata a parent-close', () => {
  it('richiede il costo del dequeue più un intero pass parent-close', () => {
    const exact = parentDequeueBudgetDecision({
      remainingMs: ITEM_COST_MS * (PARENT_CLOSE_CAP + 1),
      itemCostMs: ITEM_COST_MS,
      parentCloseMaxPerRun: PARENT_CLOSE_CAP,
    });
    expect(exact).toEqual({
      canStart: true,
      reserveMs: ITEM_COST_MS * PARENT_CLOSE_CAP,
      requiredMs: ITEM_COST_MS * (PARENT_CLOSE_CAP + 1),
    });

    expect(parentDequeueBudgetDecision({
      remainingMs: exact.requiredMs - 1,
      itemCostMs: ITEM_COST_MS,
      parentCloseMaxPerRun: PARENT_CLOSE_CAP,
    }).canStart).toBe(false);
  });

  it('resta trasparente quando il deadline non è configurato', () => {
    expect(parentDequeueBudgetDecision({
      remainingMs: Number.POSITIVE_INFINITY,
      itemCostMs: ITEM_COST_MS,
      parentCloseMaxPerRun: PARENT_CLOSE_CAP,
    }).canStart).toBe(true);
  });
});

describe('parent-dequeue — il sorgente mantiene cap e riserva', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../scripts/ci/followup-drainer.mjs', import.meta.url)),
    'utf8',
  );

  it('applica un cap esplicito per run e riporta il residuo', () => {
    expect(source).toContain("const PARENT_DEQUEUE_MAX_PER_RUN = positiveIntFromEnv('FOLLOWUP_PARENT_DEQUEUE_MAX_PER_RUN', 5);");
    expect(source).toContain('const dequeueCap = Math.min(PARENT_DEQUEUE_MAX_PER_RUN, parentDequeueCandidates.length);');
    expect(source).toContain('for (let dequeueIndex = 0; dequeueIndex < dequeueCap; dequeueIndex += 1)');
    expect(source).toContain('no silent cap');
  });

  it('non entra nel dequeue se non può lasciare il budget a parent-close', () => {
    expect(source).toContain('parentDequeueBudgetDecision({');
    expect(source).toContain('parentCloseMaxPerRun: PARENT_CLOSE_MAX_PER_RUN');
    expect(source).toContain('budget.defer(`#${deferredParent.number} (parent-dequeue: riserva parent-close)`);');
    expect(source).toContain('budget.take(`#${p.number} (parent-dequeue)`, ITEM_COST_MS)');
  });
});
