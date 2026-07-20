/**
 * lessons-harvester — isAvoidableNoRootCause: spegne il FALSO POSITIVO che ha
 * fatto ricorrere l'escalation `fix-outcome:no-root-cause` (#4580, bucket 6/14d).
 *
 * Ogni esempio dell'escalation (#4540/#4516/#4515/#4484/#4458) era un abort
 * CORRETTO forzato nel codice generico `no-root-cause` perché la tassonomia non
 * aveva un codice dedicato per nessuna delle due classi reali:
 *   1. TRANSIENT / VERIFIED-LIVE NON-BUG: il fixer ha verificato live che
 *      l'alert è un falso positivo del monitor (self-heal debounced-opener
 *      by-design, o un blip edge/deploy-churn transitorio già risolto).
 *   2. BLOCKED-ON-DEPENDENCY: il fixer ha trovato la root cause (un epic/sub-
 *      issue da cui questa issue dipende esplicitamente non è ancora completo)
 *      ma non può agire qui senza sforare lo scope chirurgico della issue.
 * Nessuna delle due è un fallimento di diagnosi: "esplora di più" non elimina
 * un blip transitorio né una dipendenza non soddisfatta. Un genuino
 * no-root-cause (diagnosi tentata, nessuna conferma in nessuna direzione) non
 * ha nessuno dei due tell e resta contabile.
 */
import { describe, it, expect } from 'vitest';
import { isAvoidableNoRootCause } from '../scripts/ci/harvest-agent-lessons.mjs';

describe('isAvoidableNoRootCause — non escalare abort corretti forzati nel codice generico', () => {
  it('self-heal debounced-opener issue (verificato live, non è un bug) → NON contabile (#4540)', () => {
    expect(isAvoidableNoRootCause(
      'Nessun bug di codice da fixare qui: questa è un\'issue di self-heal pending generata da `.github/workflows/traffic-data-freshness.yml` ("1st stale reading" — meccanismo debounced-opener by-design, vedi step "Open / debounce stale issue").',
    )).toBe(false);
  });

  it('CF 5xx verificato live come blip transitorio deploy-churn → NON contabile (#4516/#4515)', () => {
    expect(isAvoidableNoRootCause(
      '**Diagnosi:** verificato live, nessuna root cause di codice.\n\n- curl ripetuto → 200 consistente.\n- stessa classe già diagnosticata come blip transitorio in #4332.\nChiudo senza PR; riaprire se dovesse ricorrere.',
    )).toBe(false);
    expect(isAvoidableNoRootCause(
      'Nessun bug di codice riprodotto: la pagina esiste, è corretta, servita 200 in ogni verifica. Chiudo come rumore transitorio da deploy-churn.',
    )).toBe(false);
  });

  it('blocked su dipendenza dati non soddisfatta (epic sub-issue non completa) → NON contabile (#4484)', () => {
    expect(isAvoidableNoRootCause(
      '**Blocked: dipendenza dati non soddisfatta.**\n\nQuesta issue dipende esplicitamente dalla sub-issue dataset MEF (#4483, epic #4482).',
    )).toBe(false);
  });

  it('root cause chiara ma blocco di dipendenza a monte (epic step) → NON contabile (#4458)', () => {
    expect(isAvoidableNoRootCause(
      'Root cause chiara ma **blocco di dipendenza a monte** non risolvibile in questo run: questa issue è esplicitamente sequenziata come 3° step dell\'epic #4455.',
    )).toBe(false);
  });

  it('genuino "non riesco a diagnosticare" senza i tell transient/blocked → contabile', () => {
    expect(isAvoidableNoRootCause(
      'Esplorato ~15 turni: il selector del parser sembra corretto, il markup della pagina non mostra deviazioni evidenti, ma non riesco a determinare con confidenza perché il crawler ritorna 0 risultati. Serve indagine umana.',
    )).toBe(true);
  });

  it('input degeneri → contabile-safe (nessuna esclusione senza tell esplicito)', () => {
    expect(isAvoidableNoRootCause(undefined)).toBe(true);
    expect(isAvoidableNoRootCause('')).toBe(true);
    expect(isAvoidableNoRootCause(null)).toBe(true);
  });
});
