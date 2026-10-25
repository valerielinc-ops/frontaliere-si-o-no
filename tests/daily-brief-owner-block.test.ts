import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

// @ts-expect-error — .mjs module without type declarations
import {
  main,
  parseDailyBriefOwnerBlock,
  readDailyBriefOwnerBlock,
} from '@/scripts/send-daily-brief.mjs';

const DECISION_MESSAGE = 'Decisione del proprietario del 25/10/2026';

describe('daily-brief owner block', () => {
  it('keeps the tracked owner decision blocked', () => {
    let block: any = null;
    try {
      block = JSON.parse(readFileSync(new URL('../data/daily-brief-owner-block.json', import.meta.url), 'utf8'));
    } catch {
      // The assertion below gives the actionable owner-decision failure.
    }

    expect(
      block?.blocked,
      `${DECISION_MESSAGE}: data/daily-brief-owner-block.json deve esistere con blocked:true; non rimuovere o modificare il blocco senza istruzione esplicita del proprietario.`,
    ).toBe(true);
    expect(readDailyBriefOwnerBlock().blocked).toBe(true);
  });

  it('rifiuta l invio reale anche con ENABLE_DAILY_BRIEF=true', async () => {
    expect(parseDailyBriefOwnerBlock('{"blocked":true}').blocked).toBe(true);
    expect(parseDailyBriefOwnerBlock('{"blocked":false}').blocked).toBe(false);

    const previousEnable = process.env.ENABLE_DAILY_BRIEF;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env.ENABLE_DAILY_BRIEF = 'true';
    let output = '';
    try {
      await main();
      output = log.mock.calls.flat().join('\n');
    } finally {
      if (previousEnable === undefined) delete process.env.ENABLE_DAILY_BRIEF;
      else process.env.ENABLE_DAILY_BRIEF = previousEnable;
      log.mockRestore();
    }

    expect(output).toContain('invio reale bloccato dal proprietario');
    expect(output).toContain('Nessuna email inviata');
  });
});
