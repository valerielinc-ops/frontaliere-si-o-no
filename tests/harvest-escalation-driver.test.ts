/**
 * lessons-harvester — isEscalationDriver (#4750).
 *
 * `fix-outcome:no-root-cause` escalated a SECOND time (#4750, 6/14d) after its
 * first structural fix (#4580, `isAvoidableNoRootCause`) shipped. All 5 fresh
 * examples (#4748/#4738/#4735/#4702/#4696) were, once again, correct aborts —
 * verified-transient-live or blocked-on-a-separately-tracked-issue — but with
 * SLIGHTLY different phrasing than the regexes added for #4580 (e.g. "verificato
 * live: nessuna root cause di codice" with a colon vs. the regex's comma, or
 * "blip edge/deploy-churn transitorio" vs. the regex's "blip edge transitorio").
 * Unlike its siblings (isAvoidableAlreadyFixed / isAvoidableMaxTurns, which key
 * off fixed-format issue titles/labels), isAvoidableNoRootCause keys off
 * open-ended LLM-authored diagnosis prose — an unbounded input space no regex
 * can close by construction. Widening the regex again would only repeat the
 * same failure a third time.
 *
 * The structural fix: `no-root-cause` is carved out of the `fix-outcome`
 * source's escalation-driver status entirely (same treatment as the
 * `issue-class` source, which is operational volume/context, never a proposal
 * driver) — so no phrasing of a correct abort can ever re-trigger this
 * escalation again, regardless of regex accuracy.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  buildEscalationSignals,
  escalationBody,
  isEscalationDriver,
  selfHealDecision,
  SELF_HEAL_PIN_LABELS,
  SELF_HEAL_CLAIM_LABEL,
} from '../scripts/ci/harvest-agent-lessons.mjs';
import { FIXER_EXEMPT_LABELS } from '../scripts/lib/classify-issue.mjs';
import { detectAlreadyResolved } from '../scripts/ci/followup-resolution-match.mjs';
import { KEEP_OPEN_LABELS } from '../scripts/ci/reconcile-followups.mjs';

describe('buildEscalationSignals — contratto reporter zero-Claude (#6685)', () => {
  it('porta bucket, misura, comando dry-run ed esempi senza diagnosi inventata', () => {
    const signals = buildEscalationSignals({
      source: 'reviewer-finding',
      key: 'pr-body-contract',
      count: 7,
      examples: [{ pr: 101 }, { issue: 202 }],
    });

    expect(signals).toMatchObject({
      cosa: expect.stringContaining('reviewer-finding/pr-body-contract'),
      metrica: { osservato: 7 },
      comando: 'node scripts/ci/harvest-agent-lessons.mjs --dry-run',
    });
    expect(signals.evidenza).toEqual(expect.arrayContaining([
      'bucket=reviewer-finding/pr-body-contract',
      'esempi=#101, #202',
    ]));
  });

  it('non mostra placeholder per esempi privi di PR e issue', () => {
    const signals = buildEscalationSignals({
      source: 'reviewer-finding',
      key: 'pr-body-contract',
      count: 2,
      examples: [{ pr: 101 }, {}, { issue: 202 }],
    });

    expect(signals.evidenza).toEqual(expect.arrayContaining(['esempi=#101, #202']));
    expect(signals.evidenza.join('\n')).not.toContain('#undefined');
  });

  it('preserva gli id numerici zero nell evidenza', () => {
    const signals = buildEscalationSignals({
      source: 'reviewer-finding',
      key: 'pr-body-contract',
      count: 2,
      examples: [{ pr: 0 }, { issue: 0 }, { pr: '', issue: null }],
    });

    expect(signals.evidenza).toEqual(expect.arrayContaining(['esempi=#0, #0']));
  });
});

describe('isEscalationDriver — no-root-cause non può più driveare un\'escalation (#4750)', () => {
  it('fix-outcome:no-root-cause → mai driver, indipendentemente dal count', () => {
    expect(isEscalationDriver('fix-outcome', 'no-root-cause')).toBe(false);
  });

  // #4938: la carve-out sopra non scattava mai in produzione. main() costruisce
  // la chiave come `fix-outcome:${code}` (già prefissata con il source), non
  // come il solo `code` nudo testato sopra — questo caso copre la shape reale
  // usata dalla chiamata `consider('fix-outcome', outcomeCounts, ...)`.
  it('fix-outcome:fix-outcome:no-root-cause (shape reale del call site in main()) → mai driver', () => {
    expect(isEscalationDriver('fix-outcome', 'fix-outcome:no-root-cause')).toBe(false);
  });

  it('altri fix-outcome code restano driver (es. blocked-workflows-scope, già un fix strutturale riuscito)', () => {
    expect(isEscalationDriver('fix-outcome', 'blocked-workflows-scope')).toBe(true);
    expect(isEscalationDriver('fix-outcome', 'already-fixed')).toBe(true);
    expect(isEscalationDriver('fix-outcome', 'max-turns')).toBe(true);
  });

  it('revenue-tracker-manual resta contesto, non una regola violata', () => {
    // Il marker copre handoff manuali eterogenei (provider, dispatch o misura
    // production) e non una singola classe di errore dell’agente. Copriamo sia
    // il codice nudo sia la shape prefissata usata dal call site reale.
    expect(isEscalationDriver('fix-outcome', 'revenue-tracker-manual')).toBe(false);
    expect(isEscalationDriver('fix-outcome', 'fix-outcome:revenue-tracker-manual')).toBe(false);
  });

  it('altri fix-outcome code con la shape prefissata reale restano driver', () => {
    expect(isEscalationDriver('fix-outcome', 'fix-outcome:blocked-workflows-scope')).toBe(true);
    expect(isEscalationDriver('fix-outcome', 'fix-outcome:already-fixed')).toBe(true);
  });

  it('issue-class resta sempre non-driver (comportamento preesistente, volume operativo)', () => {
    expect(isEscalationDriver('issue-class', 'crawler-failure')).toBe(false);
    expect(isEscalationDriver('issue-class', 'anything')).toBe(false);
  });

  it('reviewer-finding resta driver per qualunque bucket (comportamento preesistente)', () => {
    expect(isEscalationDriver('reviewer-finding', 'pr-body-contract')).toBe(true);
    expect(isEscalationDriver('reviewer-finding', 'sibling-class-fix')).toBe(true);
  });
});

describe('isEscalationDriver — rate-limited non può driveare un\'escalation (quota ≠ regola violata)', () => {
  // Il marker `rate-limited` (issue-fix.yml, post-step deterministico) dice che
  // la quota Max condivisa era esaurita quando è arrivato il turno di quella
  // issue: run morta su HTTP 429 al primo turno, `num_turns: 1`, costo 0, issue
  // mai letta. Misurato il 2026-08-05: 60 delle 61 run fallite di issue-fix nella
  // finestra 7gg erano di questa forma. Senza la carve-out il bucket supererebbe
  // la soglia ≥3/14gg in poche ore e farebbe partire la proposta Claude del
  // harvester — un turno speso a redigere regole che non possono fixare
  // un'interruzione di quota, e speso proprio quando la quota manca.
  it('fix-outcome:rate-limited → mai driver, in entrambe le shape della chiave', () => {
    expect(isEscalationDriver('fix-outcome', 'rate-limited')).toBe(false);
    expect(isEscalationDriver('fix-outcome', 'fix-outcome:rate-limited')).toBe(false);
  });

  it('fix-outcome:skip-duplicate-diagnosis → mai driver (#5288: il guard che funziona non è una regola violata)', () => {
    // Emesso SOLO dal Mode 2 di check-workflows-scope.mjs: una issue con titolo
    // identico a una già diagnosticata viene short-circuitata PRIMA di spendere un
    // turno Claude. Prima condivideva il marker con `blocked-workflows-scope`, e la
    // conflazione era perversa: più il guard è efficace, più alza il bucket la cui
    // ricorrenza fa scattare l'escalation su quel bucket.
    expect(isEscalationDriver('fix-outcome', 'skip-duplicate-diagnosis')).toBe(false);
    expect(isEscalationDriver('fix-outcome', 'fix-outcome:skip-duplicate-diagnosis')).toBe(false);
  });

  it('la separazione NON tocca il codice originale: blocked-workflows-scope resta driver', () => {
    // Il blocco vero (capability mancante in una run reale) è ancora segnale di burn
    // ricorrente e deve poter scalare — è il caso che ha aperto #5288.
    expect(isEscalationDriver('fix-outcome', 'blocked-workflows-scope')).toBe(true);
  });

  it('resta contato come volume/context: la carve-out tocca solo l\'escalation, non il tally', () => {
    // `max-turns` è il contro-esempio vicino: anche lui è emesso da un post-step
    // deterministico, ma indica un budget di turni DAVVERO speso su questa issue
    // → è un segnale azionabile sui doc e resta driver.
    expect(isEscalationDriver('fix-outcome', 'max-turns')).toBe(true);
  });
});

describe('isEscalationDriver — overlap-skip / pr-already-open sono scheduling, non fault (corpus #229, metà sito)', () => {
  // I due esiti che `followup-drainer.mjs` esclude APPOSTA da NON_RETRYABLE («l'overlap è
  // transitorio: la PR bloccante può mergiare → ri-tentabile») e che
  // `close-recovered-structural-hold.mjs` si rifiuta di trattenere («scheduling, not a
  // fault»). Il harvester era l'unico dei tre a non saperlo: misurato sul mirror corpus il
  // 2026-08-13, 11 marker `overlap-skip` su 11 contati come burn ricorrente. Nessuna riga
  // di doc impedisce a due issue indipendenti di nominare lo stesso file nello stesso
  // momento — è la forma normale di un ciclo con più fixer in parallelo.
  it('fix-outcome:overlap-skip → mai driver, in entrambe le shape della chiave', () => {
    expect(isEscalationDriver('fix-outcome', 'overlap-skip')).toBe(false);
    expect(isEscalationDriver('fix-outcome', 'fix-outcome:overlap-skip')).toBe(false);
  });

  it('fix-outcome:pr-already-open → mai driver (stessa dichiarazione, stessa riga del drainer)', () => {
    expect(isEscalationDriver('fix-outcome', 'pr-already-open')).toBe(false);
    expect(isEscalationDriver('fix-outcome', 'fix-outcome:pr-already-open')).toBe(false);
  });

  it('la carve-out non tocca gli esiti vicini che restano segnale', () => {
    expect(isEscalationDriver('fix-outcome', 'blocked-secrets')).toBe(true);
    expect(isEscalationDriver('fix-outcome', 'max-turns')).toBe(true);
  });
});

describe('corpo dell escalation: la misura e le prove dopo il cutoff', () => {
  const cutoffAt = '2026-09-27T20:19:47.000Z';
  const cluster = {
    source: 'reviewer-finding',
    key: 'workflow-scope-creds',
    count: 10,
    effectiveCount: 7,
    cutoffAt,
    examples: [{ pr: 9001, at: '2026-09-20T10:00:00Z', snippet: 'PRE-CUTOFF snippet che non deve comparire' }],
    postCutoffExamples: [
      { pr: 10687, at: '2026-10-01T05:45:54Z', snippet: '🔴 Important: `git fetch` fallito trattato come assenza' },
      { pr: 10596, at: '2026-09-30T23:02:40Z', snippet: '🔴 Important: APP_TOKEN senza guardia @someone' },
    ],
  };

  it('porta effectiveCount, il conteggio di finestra come dato secondario e la data del cutoff', () => {
    const body = escalationBody(cluster);
    expect(body).toContain('**7** occorrenze dopo il cutoff');
    expect(body).toContain('in finestra 14gg');
    expect(body).toMatch(/in finestra 14gg \(dal \d{4}-\d{2}-\d{2}\): 10/);
    expect(body).toContain(`Cutoff: **${cutoffAt}**`);
  });

  it('riporta gli snippet dei soli esempi post-cutoff, col numero della PR', () => {
    const body = escalationBody(cluster);
    expect(body).toContain('PR 10687 (2026-10-01): 🔴 Important:');
    expect(body).toContain('PR 10596 (2026-09-30)');
    expect(body).toContain('Numeri: #10687, #10596');
  });

  it('fuori dal blocco recintato al piu 5 riferimenti #N, anche con 30 esempi', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ pr: 20000 + i, at: '2026-10-01T00:00:00Z', snippet: 'x' }));
    const body = escalationBody({ ...cluster, effectiveCount: many.length, postCutoffExamples: many });
    const outsideFence = body.slice(0, body.indexOf('```text'));
    expect(outsideFence.match(/#\d+/g)?.length).toBe(5); // cron-count-ok: tetto fisso dei riferimenti fuori dal fence
    expect(body).toContain(`PR ${20000 + many.length - 1}`);
    expect(body).not.toContain('PRE-CUTOFF');
    expect(body).not.toContain('#9001');
  });

  it('gli snippet stanno in un blocco recintato: niente token per il reconcile, niente backtick', () => {
    const body = escalationBody(cluster);
    const fence = body.slice(body.indexOf('```text'), body.lastIndexOf('```') + 3);
    expect(fence).toContain("'git fetch' fallito");
    expect(fence.slice('```text'.length, -3)).not.toContain('`');
    // Il corpo non dà al matcher dei follow-up né file né token prescritti dagli snippet.
    const r = detectAlreadyResolved(body, { fileExists: () => true, readFile: () => 'git fetch APP_TOKEN' });
    expect(r.resolved).toBe(false);
    expect(r.tokens.join(' ')).not.toContain('git fetch');
  });

  it('senza cutoff lo dichiara: conta l intera finestra', () => {
    const body = escalationBody({ ...cluster, cutoffAt: null, effectiveCount: 10, postCutoffExamples: cluster.examples });
    expect(body).toContain('Cutoff: nessuno');
    expect(body).toContain('**10** occorrenze');
  });

  it('i Segnali misurano effectiveCount, non la finestra', () => {
    const signals = buildEscalationSignals(cluster);
    expect(signals.metrica.osservato).toBe(7);
    expect(signals.evidenza).toEqual(expect.arrayContaining(['in-finestra=10', `cutoff=${cutoffAt}`]));
  });
});

describe('self-heal: rispetta pin, claim e completezza; chiude con la misura', () => {
  const key = 'reviewer-finding/workflow-scope-creds';
  const cutoffMs = Date.parse('2026-09-27T22:26:55Z');
  const quiet = { effectiveCount: 5, cutoffMs };
  const base = { key, measure: quiet, partialSources: new Set<string>(), windowDays: 14,
    sinceDay: '2026-09-19', threshold: 3, factor: 2 };

  it.each(['keep-open', 'agent:no-age-out', 'pinned', 'do-not-close', 'tracker'])('pin %s → mai chiusa', (pin) => {
    const d = selfHealDecision({ ...base, labels: [{ name: 'follow-up' }, { name: pin }] });
    expect(d.action).toBe('skip');
    expect(d.reason).toContain(pin);
  });

  it('claim agent:in-progress → mai chiusa', () => {
    expect(SELF_HEAL_CLAIM_LABEL).toBe('agent:in-progress');
    expect(selfHealDecision({ ...base, labels: ['agent:in-progress'] }).action).toBe('skip');
  });

  it('finestra parziale per la sorgente del bucket → mai chiusa', () => {
    const d = selfHealDecision({ ...base, labels: [], partialSources: new Set(['reviewer-finding']) });
    expect(d.action).toBe('skip');
    expect(d.reason).toContain('PARZIALE');
  });

  it('finestra parziale per un altra sorgente non blocca', () => {
    expect(selfHealDecision({ ...base, labels: [], partialSources: new Set(['fix-outcome']) }).action).toBe('close');
  });

  it('senza pin, vista completa, sotto soglia → chiusa con la misura nel testo', () => {
    const d = selfHealDecision({ ...base, labels: [{ name: 'follow-up' }, { name: 'severity:medium' }] });
    expect(d.action).toBe('close');
    expect(d.comment).toContain('non supera la soglia nella finestra di 14 giorni dopo l\'ultimo cutoff');
    expect(d.comment).toContain('2026-09-27T22:26:55.000Z');
    expect(d.comment).toContain('5 su soglia 6');
    expect(d.comment).not.toContain('il pattern si è fermato');
  });

  it('sopra soglia ma non attivo (non driver / non documentato) → non si chiude', () => {
    const d = selfHealDecision({ ...base, labels: [], measure: { effectiveCount: 6, cutoffMs } });
    expect(d.action).toBe('skip');
  });

  it('bucket assente dalla finestra: 0 occorrenze, cutoff dalla chiusura', () => {
    const d = selfHealDecision({ ...base, labels: [], measure: null, cutoffMs });
    expect(d.action).toBe('close');
    expect(d.comment).toContain('0 su soglia 6');
  });

  it('misura non canonica (finestra corta o soglia alzata da un dispatch manuale) → mai chiusa', () => {
    const short = selfHealDecision({ ...base, labels: [], windowDays: 3 });
    expect(short.action).toBe('skip');
    expect(short.reason).toContain('NON canonica');
    const higher = selfHealDecision({ ...base, labels: [], threshold: 5 });
    expect(higher.action).toBe('skip');
    expect(higher.reason).toContain('NON canonica');
    // Ai default (finestra 14gg, soglia 3×2) chiude; una finestra piu' lunga o
    // una soglia piu' bassa misurano di piu', quindi non bloccano.
    expect(selfHealDecision({ ...base, labels: [] }).action).toBe('close');
    expect(selfHealDecision({ ...base, labels: [], windowDays: 30 }).action).toBe('close');
    expect(selfHealDecision({ ...base, labels: [], threshold: 2, measure: { effectiveCount: 3, cutoffMs } }).action)
      .toBe('close');
  });

  it('sorgente sconosciuta → non si chiude', () => {
    expect(selfHealDecision({ ...base, key: 'boh/qualcosa', labels: [] }).action).toBe('skip');
  });

  it('parità: i pin includono FIXER_EXEMPT_LABELS e il veto KEEP_OPEN_LABELS del reconcile', () => {
    for (const l of FIXER_EXEMPT_LABELS) expect(SELF_HEAL_PIN_LABELS).toContain(l);
    expect(KEEP_OPEN_LABELS.size).toBeGreaterThan(0);
    for (const l of KEEP_OPEN_LABELS) expect(SELF_HEAL_PIN_LABELS).toContain(l);
  });
});

describe('contratto sul workflow: il self-heal non è più spento', () => {
  const stepEnv = (file: string, stepName: string) => {
    const yml = readFileSync(file, 'utf8');
    const start = yml.indexOf(`- name: ${stepName}`);
    expect(start, `${stepName} non trovato in ${file}`).toBeGreaterThanOrEqual(0);
    const next = yml.indexOf('\n      - name:', start + 1);
    return yml.slice(start, next === -1 ? undefined : next);
  };

  it('lo step dell harvester non imposta FOLLOWUP_NO_AUTOCLOSE, quello del drainer sì', () => {
    const harvest = stepEnv('.github/workflows/lessons-harvester.yml', 'Aggregate recurring patterns');
    expect(harvest).toContain('node scripts/ci/harvest-agent-lessons.mjs');
    expect(harvest).not.toMatch(/^\s*FOLLOWUP_NO_AUTOCLOSE:/m);
    const drainer = stepEnv('.github/workflows/followup-drainer.yml', 'Drain follow-up queue');
    expect(drainer).toMatch(/^\s*FOLLOWUP_NO_AUTOCLOSE: '1'/m);
  });
});
