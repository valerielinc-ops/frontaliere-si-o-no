/**
 * Riconoscimento del terminal outcome "quota esaurita" (HTTP 429) e del beacon
 * di backoff.
 *
 * Regressione della classe misurata il 2026-08-05 sul tracker #1951: su 61 run
 * fallite di `issue-fix.yml` nella finestra 7gg (2026-07-29 → 08-05), 60 erano
 * 429 e ZERO `error_max_turns`. Il payload di un 429 porta `"subtype": "success"`
 * con `is_error: true`, quindi il vecchio gate subtype-only di issue-fix.yml non
 * scattava: la issue restava senza marker granulare, il drainer la classificava
 * «run morta ri-tentabile», la ri-accodava 3× contro la stessa quota esaurita e
 * infine la parcheggiava (`fu-parked`) — da dove l'age-out la chiudeva dopo 10
 * giorni. Senza il fix, il primo test qui sotto fallisce.
 *
 * Le fixture riproducono il payload reale osservato nel log della run
 * 30687330658 (issue #5006), ridotto ai campi rilevanti.
 */

import { describe, it, expect } from 'vitest';
import {
  detectClaudeRateLimit,
  parseExecutionMessages,
  parseQuotaResetsAt,
  isBackoffActive,
  formatRateLimitComment,
  RATE_LIMITED_OUTCOME,
} from '../scripts/ci/claude-rate-limit.mjs';
import { formatRecoverableBranchStamp, resultSubtype } from '../scripts/ci/mark-claude-terminal-outcome.mjs';
import { parseRecoverableBranchStamp } from '../scripts/ci/harvest-agent-lessons.mjs';

// Epoch relativo: mai date assolute nelle fixture (AGENTS.md → test fixture).
const nowSec = () => Math.floor(Date.now() / 1000);
const inHours = (h: number) => nowSec() + Math.round(h * 3600);

const RATE_LIMIT_EXEC = JSON.stringify([
  { type: 'system', subtype: 'init', session_id: 's1' },
  {
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'rejected',
      resetsAt: 1785610800,
      rateLimitType: 'seven_day',
      overageStatus: 'rejected',
      overageDisabledReason: 'out_of_credits',
      isUsingOverage: false,
    },
  },
  {
    type: 'assistant',
    message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your weekly limit · resets 7pm (UTC)" }] },
    error: 'rate_limit',
    is_api_error_message: true,
  },
  {
    type: 'result',
    // Il campo che rendeva il 429 invisibile al gate subtype-only:
    subtype: 'success',
    is_error: true,
    num_turns: 1,
    total_cost_usd: 0,
    terminal_reason: 'api_error',
    api_error_status: 429,
    result: "You've hit your weekly limit · resets 7pm (UTC)",
  },
]);

const MAX_TURNS_EXEC = JSON.stringify([
  { type: 'system', subtype: 'init' },
  { type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 70, terminal_reason: 'max_turns' },
]);

const OVERLOADED_EXEC = JSON.stringify([
  { type: 'result', subtype: 'success', is_error: true, num_turns: 1, terminal_reason: 'api_error', api_error_status: 529 },
]);

describe('detectClaudeRateLimit', () => {
  it('riconosce un 429 che si presenta con subtype "success" (il caso dominante: 60/61 fail)', () => {
    const r = detectClaudeRateLimit(RATE_LIMIT_EXEC);
    expect(r.rateLimited).toBe(true);
    expect(r.rateLimitType).toBe('seven_day');
    expect(r.resetsAt).toBe(1785610800);
  });

  it('NON confonde error_max_turns con la quota (recuperi opposti: park vs attesa)', () => {
    expect(detectClaudeRateLimit(MAX_TURNS_EXEC).rateLimited).toBe(false);
    expect(resultSubtype(MAX_TURNS_EXEC)).toBe('error_max_turns');
  });

  it('pinning della trappola: il subtype di un 429 è "success", quindi un gate subtype-only è CIECO', () => {
    // Questa è, letteralmente, la riga che teneva l'allarme acceso da ≥7 report
    // settimanali: `issue-fix.yml` decideva se emettere telemetria granulare
    // guardando SOLO `subtype === 'error_max_turns'`. Su un 429 il subtype è
    // 'success' → nessun marker → il drainer non aveva modo di distinguere
    // «quota esaurita» da «run crashata» e sceglieva il recupero sbagliato.
    expect(resultSubtype(RATE_LIMIT_EXEC)).toBe('success');
    expect(resultSubtype(RATE_LIMIT_EXEC)).not.toBe('error_max_turns');
    // Il riconoscimento corretto non può quindi passare dal subtype:
    expect(detectClaudeRateLimit(RATE_LIMIT_EXEC).rateLimited).toBe(true);
  });

  it('NON tratta un 5xx come quota: un 529 è transiente e va ri-tentato subito', () => {
    expect(detectClaudeRateLimit(OVERLOADED_EXEC).rateLimited).toBe(false);
  });

  it('legge anche il formato ndjson (la action ha cambiato forma nel tempo)', () => {
    const ndjson = JSON.parse(RATE_LIMIT_EXEC).map((m: unknown) => JSON.stringify(m)).join('\n');
    const r = detectClaudeRateLimit(ndjson);
    expect(r.rateLimited).toBe(true);
    expect(r.resetsAt).toBe(1785610800);
  });

  it('tollera righe troncate/illeggibili senza invalidare il file intero', () => {
    const ndjson = JSON.parse(RATE_LIMIT_EXEC).map((m: unknown) => JSON.stringify(m)).join('\n') + '\n{"type":"resu';
    expect(detectClaudeRateLimit(ndjson).rateLimited).toBe(true);
  });

  it('input vuoto/illeggibile → nessun rate limit (mai un falso positivo che congeli la coda)', () => {
    expect(detectClaudeRateLimit('').rateLimited).toBe(false);
    expect(detectClaudeRateLimit('non json').rateLimited).toBe(false);
    expect(parseExecutionMessages('')).toEqual([]);
  });

  it('accetta un resetsAt in millisecondi normalizzandolo a secondi', () => {
    const ms = JSON.stringify([
      { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1785610800000 } },
    ]);
    expect(detectClaudeRateLimit(ms).resetsAt).toBe(1785610800);
  });
});

describe('parseQuotaResetsAt / isBackoffActive', () => {
  it('estrae il beacon dal commento', () => {
    expect(parseQuotaResetsAt('<!-- QUOTA_RESETS_AT: 1785610800 -->')).toBe(1785610800);
  });

  it('il beacon è un commento SEPARATO dal marker FIX_OUTCOME (che non ammette attributi)', () => {
    const body = formatRateLimitComment({ resetsAt: inHours(2), rateLimitType: 'seven_day' });
    // Il drainer parsa `/<!--\s*FIX_OUTCOME:\s*([a-z0-9-]+)\s*-->/i`: il codice
    // deve restare da solo dentro il proprio commento, altrimenti smette di
    // matchare e la issue torna a essere «senza verdetto» → il bug di partenza.
    const m = /<!--\s*FIX_OUTCOME:\s*([a-z0-9-]+)\s*-->/i.exec(body);
    expect(m?.[1]).toBe(RATE_LIMITED_OUTCOME);
    expect(parseQuotaResetsAt(body)).not.toBeNull();
  });

  it('finestra futura → backoff attivo; passata → chiuso', () => {
    expect(isBackoffActive(inHours(3))).toBe(true);
    expect(isBackoffActive(inHours(-1))).toBe(false);
  });

  it('beacon assente/malformato → backoff NON attivo (mai congelare la coda per sempre)', () => {
    expect(parseQuotaResetsAt('nessun beacon')).toBeNull();
    expect(isBackoffActive(null)).toBe(false);
    expect(isBackoffActive(Number.NaN)).toBe(false);
    expect(isBackoffActive(0)).toBe(false);
  });

  it('tetto di sanità: un reset assurdamente lontano non blocca il loop per settimane', () => {
    expect(isBackoffActive(inHours(24 * 30))).toBe(false);
    // il limite più lungo dichiarato dall'API è `seven_day` → 7gg resta valido
    expect(isBackoffActive(inHours(24 * 7))).toBe(true);
  });
});

describe('stamp del lavoro recuperabile: chi scrive e chi legge parlano la stessa lingua', () => {
  // Il marker `max-turns` e il harvester sono due file diversi che si passano una riga di
  // HTML comment. Il round-trip è l'unica prova che il contratto regge: se lo stamp cambia
  // forma da un lato, il lato che LEGGE torna a vedere «run senza consegna» e le morti con
  // lavoro recuperabile (11 su 31, misurate sul corpus) tornano a passare per rumore.
  it('format → parse conserva branch e numero di commit', () => {
    const stamp = formatRecoverableBranchStamp({ branch: 'fix/issue-5767', aheadBy: 3 });
    expect(stamp).toContain('<!-- RECOVERABLE_BRANCH: fix/issue-5767 ahead=3 -->');
    expect(parseRecoverableBranchStamp(stamp)).toEqual({ branch: 'fix/issue-5767', aheadBy: 3 });
  });

  it('niente lavoro da recuperare → nessuno stamp (il marker resta quello di prima)', () => {
    expect(formatRecoverableBranchStamp(null as unknown as { branch: string })).toBe('');
    expect(formatRecoverableBranchStamp({ branch: 'fix/issue-1', aheadBy: 0 })).toBe('');
    expect(formatRecoverableBranchStamp({ branch: '', aheadBy: 4 })).toBe('');
    expect(formatRecoverableBranchStamp({ branch: 'fix/issue-1' } as { branch: string })).toBe('');
  });
});
