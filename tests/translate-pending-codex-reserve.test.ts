import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

/**
 * Riserva Codex Luna Max della cascata dei lavori (fase 2b di translate-pending).
 * Decisione del proprietario H7 (2026-10-05): «utilizza codex luna max per le
 * traduzioni quando falliscono le chiavi». Contesto: corpus issue 2054, Azure
 * 401001 su entrambe le chiavi, quota DeepL esaurita, Google Cloud 403.
 *
 * La cascata e' quella vera di `free-translate.mjs`, con l'ambiente che la
 * fase 2b riceve dal workflow (letto dallo YAML, non riscritto qui): i tre
 * tier a chiave falliscono (DeepL 456, Azure 401, Google Cloud 403) e i tier
 * gratuiti non rispondono (rete assente). Pinna:
 *   · senza la riserva (la 2b com'era, senza socket) l'esito e' `incomplete`;
 *   · con la riserva Codex traduce, e la traduzione passa dagli stessi gate;
 *   · Codex che rifiuta o va in errore lascia l'esito `incomplete`;
 *   · il tetto per run del workflow e' rispettato;
 *   · una chiave DeepL rifiutata (403) conta come una chiave esaurita;
 *   · Codex è primario anche quando DeepL risponde;
 *   · il report della fase dice quante traduzioni ha fatto la riserva e quante
 *     ne ha rifiutate, e il verdetto per l'allarme delle credenziali.
 * Nessuna rete e nessun Codex vero: `fetch` e' uno stub e la chiamata a Codex
 * passa da `setCodexTranslateCallForTests`.
 */

type FreeTranslate = typeof import('../scripts/lib/free-translate.mjs');
type Messages = Array<{ role: string; content: string }>;

const WORKFLOW = '.github/workflows/translate-pending-logic.yml';
const PHASE_2B = 'Phase 2b: Translate pending jobs (cascade top-up)';
const PHASE_2D = 'Phase 2d: Fix untranslated titles (free cascade)';
const PHASE_2E = 'Phase 2e: Fix untranslated descriptions (free cascade)';
const CODEX_BUDGET_RESOLVER = 'Resolve Codex reserve budget';
const SOCKET_EXPR = '${{ steps.setup_claude_haiku_fallback.outputs.codex_auth_broker_socket }}';

const IT = 'Cerchiamo un impiegato amministrativo con esperienza nella contabilita\' per il nostro ufficio di Lugano.';
const EN = 'We are looking for an administrative clerk with accounting experience for our Lugano office.';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-reserve-'));
const SOCKET = path.join(tmp, 'broker.sock');
fs.writeFileSync(SOCKET, '');
const RUNNER_TEMP = path.join(tmp, 'runner');

/** L'env effettivo della fase 2b, con resolver e vars GitHub Actions renderizzati. */
function phase2bEnv(
  workflowVars: Record<string, string> = {},
  inheritedEnv: Record<string, string> = {},
): Record<string, string> {
  const workflow = YAML.parse(fs.readFileSync(path.resolve(process.cwd(), WORKFLOW), 'utf8')) as {
    jobs: Record<string, { steps: Array<{ name?: string; env?: Record<string, unknown>; run?: string }> }>;
  };
  const step = workflow.jobs.translate.steps.find((candidate) => candidate.name === PHASE_2B);
  if (!step?.env) throw new Error(`${PHASE_2B} senza env`);
  if (Object.prototype.hasOwnProperty.call(step.env, 'FREE_TRANSLATE_CODEX_MAX_CALLS')) {
    throw new Error(`${PHASE_2B} sovrascrive il budget Codex invece di ereditarlo`);
  }
  const resolver = workflow.jobs.translate.steps.find((candidate) => candidate.name === CODEX_BUDGET_RESOLVER);
  if (!resolver?.run?.includes('FREE_TRANSLATE_CODEX_MAX_CALLS')) {
    throw new Error(`${CODEX_BUDGET_RESOLVER} mancante o senza pass-through del budget`);
  }
  const env: Record<string, string> = { ...inheritedEnv };
  for (const [key, raw] of Object.entries(step.env)) {
    const value = String(raw);
    if (value === SOCKET_EXPR) env[key] = SOCKET;
    else if (value.startsWith('${{ runner.temp }}')) env[key] = value.replace('${{ runner.temp }}', RUNNER_TEMP);
    else if (!value.includes('${{')) env[key] = value;
  }
  env.FREE_TRANSLATE_CODEX_MAX_CALLS = env.FREE_TRANSLATE_CODEX_MAX_CALLS
    || workflowVars.FREE_TRANSLATE_CODEX_MAX_CALLS
    || '350';
  return env;
}

const realFetch = globalThis.fetch;
let deeplStatus = 456;

function stubFetch() {
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    if (u.includes('api-free.deepl.com')) {
      if (deeplStatus === 200) return { ok: true, status: 200, json: async () => ({ translations: [{ text: `DEEPL ${EN}` }] }) };
      return { ok: false, status: deeplStatus, json: async () => ({}), text: async () => '' };
    }
    if (u.includes('api.cognitive.microsofttranslator.com')) {
      return { ok: false, status: 401, json: async () => ({ error: { code: 401001 } }), text: async () => '{"error":{"code":401001}}' };
    }
    if (u.includes('oauth2.googleapis.com/token')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'token-finto', expires_in: 3600 }) };
    }
    if (u.includes('translation.googleapis.com')) {
      const body = '{"error":{"code":403,"message":"Request had insufficient authentication scopes.","details":[{"reason":"ACCESS_TOKEN_SCOPE_INSUFFICIENT"}]}}';
      return { ok: false, status: 403, json: async () => JSON.parse(body), text: async () => body };
    }
    // Tier gratuiti (MyMemory, LibreTranslate, Mozhi, Lingva…): nessuna rete.
    throw new Error('offline nel test');
  }) as unknown as typeof globalThis.fetch;
}

/**
 * Cascata fresca con l'env della 2b. Chiavi e budget si leggono all'import:
 * ogni caso parte da un modulo nuovo. `withoutReserve` toglie il socket, cioe'
 * la 2b di prima della decisione H7.
 */
async function loadCascade({
  withoutReserve = false,
  overrides = {} as Record<string, string>,
  workflowVars = {} as Record<string, string>,
} = {}) {
  for (const key of [
    'DEEPL_API_KEY_2', 'GOOGLE_APPLICATION_CREDENTIALS', 'HF_TOKEN', 'HUGGINGFACE_API_KEY',
    'LIBRETRANSLATE_SELF_HOSTED_URL', 'ENABLE_CODEX_ARTICLE_FALLBACK', 'AI_MODELS_PREFER', 'AI_MODELS_FORCE_CHAIN',
    'FREE_TRANSLATE_CODEX_TIER', 'FREE_TRANSLATE_CODEX_LANES', 'FREE_TRANSLATE_CODEX_BATCH_MAX_TEXTS',
    'CODEX_AUTH_BROKER_SOCKET', 'FREE_TRANSLATE_CODEX_CALL_TIMEOUT_MS', 'FREE_TRANSLATE_CODEX_MAX_CALLS', 'FREE_TRANSLATE_CODEX_MAX_MS',
  ]) vi.stubEnv(key, '');
  // Le chiavi che Remote Config carica nella run (Azure la 2b la svuota da se').
  vi.stubEnv('DEEPL_API_KEY', 'deepl-finta');
  vi.stubEnv('AZURE_TRANSLATOR_KEY', 'azure-finta');
  vi.stubEnv('AZURE_TRANSLATOR_KEY_2', 'azure-finta-2');
  vi.stubEnv('GSC_CLIENT_ID', 'id-finto');
  vi.stubEnv('GSC_CLIENT_SECRET', 'secret-finto');
  vi.stubEnv('GSC_REFRESH_TOKEN', 'refresh-finto');
  for (const [key, value] of Object.entries(phase2bEnv(workflowVars))) vi.stubEnv(key, value);
  // Opus-MT locale e' un tier gratuito (dopo Codex): qui non si carica il modello.
  vi.stubEnv('MT_LOCAL_OPUSMT', '');
  if (withoutReserve) vi.stubEnv('CODEX_AUTH_BROKER_SOCKET', '');
  for (const [key, value] of Object.entries(overrides)) vi.stubEnv(key, value);
  stubFetch();
  vi.resetModules();
  return import('../scripts/lib/free-translate.mjs') as Promise<FreeTranslate>;
}

function stubCodex(ft: FreeTranslate, answer: (messages: Messages) => string | Promise<string>) {
  const calls: Messages[] = [];
  ft.setCodexTranslateCallForTests(async (messages: Messages) => {
    calls.push(messages);
    return answer(messages);
  });
  return calls;
}

/** La risposta che Codex darebbe: il testo tradotto fra i marcatori della chiamata. */
function translatedAnswer(messages: Messages, text = EN) {
  const user = messages.find((m) => m.role === 'user')!.content;
  const marker = /^BEGIN_TEXT_([A-Z0-9]{8})\n/.exec(user)?.[1];
  return marker ? `BEGIN_TEXT_${marker}\n${text}\nEND_TEXT_${marker}` : text;
}

const quiet = () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
};

const translate = (ft: FreeTranslate, text = IT, outcome: Record<string, unknown> = {}) =>
  ft.freeTranslate({ text, sourceLang: 'it', targetLang: 'en', fieldType: 'description', _outcome: outcome });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  globalThis.fetch = realFetch;
  deeplStatus = 456;
});

describe('translate-pending 2b: riserva Codex quando falliscono le chiavi', () => {
  it('350 chiamate, 3 corsie e batch da 10 nelle fasi 2b/2d/2e; 25 minuti alla 2b, 15 alle corsie di riparazione', () => {
    const workflow = YAML.parse(fs.readFileSync(path.resolve(process.cwd(), WORKFLOW), 'utf8')) as {
      jobs: { translate: { steps: Array<{ id?: string; name?: string; env?: Record<string, unknown> }> } };
    };
    const steps = workflow.jobs.translate.steps;
    expect(phase2bEnv().FREE_TRANSLATE_CODEX_MAX_CALLS).toBe('350');
    for (const phase of [PHASE_2B, PHASE_2D, PHASE_2E]) {
      const step = steps.find((candidate) => candidate.name === phase);
      expect(step?.env).toMatchObject({
        FREE_TRANSLATE_CODEX_CALL_TIMEOUT_MS: '480000',
        // La 2b ha una finestra di 30 minuti; 2d/2e partono con almeno 15
        // minuti residui (gate) e non devono essere saltate piu' spesso.
        FREE_TRANSLATE_CODEX_MAX_MS: phase === PHASE_2B ? '1500000' : '900000',
        FREE_TRANSLATE_CODEX_LANES: '3',
        FREE_TRANSLATE_CODEX_BATCH_MAX_TEXTS: '10',
      });
    }
    const gate = steps.find((candidate) => candidate.id === 'repair_lane_budget');
    expect(gate?.env?.REPAIR_LANE_MIN_REMAINING_MS).toBe('900000');
  });

  it('senza la riserva (la 2b com\'era) i tre tier a chiave giu\' danno `incomplete`', async () => {
    quiet();
    const ft = await loadCascade({ withoutReserve: true });
    const calls = stubCodex(ft, (messages) => translatedAnswer(messages));
    const outcome: Record<string, unknown> = {};
    expect(await translate(ft, IT, outcome)).toBe('');
    expect(outcome.incomplete).toBeTruthy();
    expect(calls).toHaveLength(0);
    ft.setCodexTranslateCallForTests(null);
  });

  it('con l\'env della 2b del workflow Codex traduce, prima dei tier gratuiti', async () => {
    quiet();
    expect(phase2bEnv().FREE_TRANSLATE_CODEX_CALL_TIMEOUT_MS).toBe('480000');
    const ft = await loadCascade();
    const calls = stubCodex(ft, (messages) => translatedAnswer(messages));
    const out = await translate(ft);
    expect(out).toBe(EN);
    expect(calls).toHaveLength(1);
    const stats = ft.getCodexTierStats();
    expect(stats).toMatchObject({ position: 'primary', lanePresent: true, premiumDown: false, calls: 1, accepted: 1, rejected: 0 });
    ft.setCodexTranslateCallForTests(null);
  });

  it('con FREE_TRANSLATE_CODEX_MAX_CALLS=0 la riserva rende zero chiamate', async () => {
    quiet();
    const rendered = phase2bEnv({ FREE_TRANSLATE_CODEX_MAX_CALLS: '0' });
    expect(rendered.FREE_TRANSLATE_CODEX_MAX_CALLS).toBe('0');
    const ft = await loadCascade({ workflowVars: { FREE_TRANSLATE_CODEX_MAX_CALLS: '0' } });
    const calls = stubCodex(ft, (messages) => translatedAnswer(messages));
    const outcome: Record<string, unknown> = {};
    expect(await translate(ft, IT, outcome)).toBe('');
    expect(outcome.incomplete).toBeTruthy();
    expect(calls).toHaveLength(0);
    expect(ft.getCodexTierStats()).toMatchObject({ maxCalls: 0, calls: 0 });
    ft.setCodexTranslateCallForTests(null);
  });

  it('Codex che rifiuta o va in errore lascia l\'esito `incomplete`', async () => {
    quiet();
    const ft = await loadCascade();
    stubCodex(ft, () => 'Sorry, I can\'t help with that.');
    const refused: Record<string, unknown> = {};
    expect(await translate(ft, IT, refused)).toBe('');
    expect(refused.incomplete).toBeTruthy();

    stubCodex(ft, () => { throw new Error('broker giu\''); });
    const failed: Record<string, unknown> = {};
    expect(await translate(ft, `${IT} Secondo annuncio.`, failed)).toBe('');
    expect(failed.incomplete || failed.errors).toBeTruthy();
    const stats = ft.getCodexTierStats();
    expect(stats.accepted).toBe(0);
    expect(stats.rejected).toBeGreaterThan(0);
    ft.setCodexTranslateCallForTests(null);
  });

  it('il tetto di chiamate per run del workflow e\' rispettato', async () => {
    quiet();
    const ft = await loadCascade({ overrides: { FREE_TRANSLATE_CODEX_LANES: '1', FREE_TRANSLATE_CODEX_BATCH_MAX_TEXTS: '1' } });
    const maxCalls = Number(phase2bEnv().FREE_TRANSLATE_CODEX_MAX_CALLS);
    expect(maxCalls).toBeGreaterThan(0);
    const calls = stubCodex(ft, (messages) => translatedAnswer(messages, `${EN} (${calls.length})`));
    const results: string[] = [];
    // In fila, come la coda per traffico della 2b: ogni testo e' distinto.
    for (let i = 0; i <= maxCalls + 2; i += 1) results.push(await translate(ft, `${IT} Annuncio ${i + 1}.`));
    expect(calls).toHaveLength(maxCalls);
    expect(results.filter(Boolean)).toHaveLength(maxCalls);
    expect(results.slice(maxCalls).every((out) => out === '')).toBe(true);
    expect(ft.getCodexTierStats().stopReason).toContain('FREE_TRANSLATE_CODEX_MAX_CALLS');
    ft.setCodexTranslateCallForTests(null);
  });

  it('una chiave DeepL rifiutata (403) e\' fuori gioco come una esaurita', async () => {
    quiet();
    deeplStatus = 403;
    const ft = await loadCascade();
    const calls = stubCodex(ft, (messages) => translatedAnswer(messages));
    expect(await translate(ft)).toBe(EN);
    expect(calls).toHaveLength(1);
    ft.setCodexTranslateCallForTests(null);
  });

  it('con DeepL che risponde Codex resta primario', async () => {
    quiet();
    deeplStatus = 200;
    const ft = await loadCascade();
    const calls = stubCodex(ft, (messages) => translatedAnswer(messages));
    expect(await translate(ft)).toBe(EN);
    expect(calls).toHaveLength(1);
    expect(ft.getCodexTierStats().premiumDown).toBe(false);
    ft.setCodexTranslateCallForTests(null);
  });
});

describe('report della riserva per la storia e per l\'allarme', () => {
  it('conta traduzioni e rifiuti e da\' il verdetto della run', async () => {
    quiet();
    const ft = await loadCascade();
    const report = await import('../scripts/lib/codex-reserve-report.mjs');
    let answer = (messages: Messages) => translatedAnswer(messages);
    stubCodex(ft, (messages) => answer(messages));
    expect(await translate(ft)).toBe(EN);
    answer = () => 'Sorry, I can\'t help with that.';
    expect(await translate(ft, `${IT} Altro annuncio.`)).toBe('');

    const phase = report.buildCodexReserveReport('2b-cascade', ft.getCodexTierStats(), ft.getCascadeStats());
    expect(phase).toMatchObject({ phase: '2b-cascade', calls: 2, accepted: 1, lanePresent: true });
    expect(report.classifyCodexReserveReport(phase)).toBe('ready');
    expect(report.codexReserveCoverage([phase]).verdict).toBe('covered');
    // Il rifiuto e' scartato dentro la sezione Codex, prima di `tryTier`: si conta lo stesso.
    expect(phase.rejected).toBe(1);
    expect(report.summarizeCodexReserve([phase])).toMatchObject({ calls: 2, translated: 1, rejected: 1, verdict: 'covered' });
    ft.setCodexTranslateCallForTests(null);
  });

  it('il rosso vero: Codex che non traduce niente, lane assente o nessun report', async () => {
    const report = await import('../scripts/lib/codex-reserve-report.mjs');
    const base = { lanePresent: true, premiumDown: false, position: 'primary', maxCalls: 350, maxMs: 1500000 };
    const failed = report.buildCodexReserveReport('2b-cascade', { ...base, calls: 3, accepted: 0, rejected: 3, stopReason: '3 fallimenti consecutivi' }, { calls: 40 });
    expect(report.codexReserveCoverage([failed]).verdict).toBe('codex-failed');
    // La lane primaria doveva entrare e non ha chiamato.
    const silent = report.buildCodexReserveReport('2b-cascade', { ...base, calls: 0, accepted: 0 }, { calls: 40 });
    expect(report.codexReserveCoverage([silent]).verdict).toBe('codex-failed');
    const noLane = report.buildCodexReserveReport('2b-cascade', { ...base, lanePresent: false }, { calls: 40 });
    expect(report.codexReserveCoverage([noLane]).verdict).toBe('codex-unavailable');
    expect(report.codexReserveCoverage([]).verdict).toBe('unknown');
    // Budget speso dopo aver tradotto: non e' un guasto.
    const spent = report.buildCodexReserveReport('2b-cascade', { ...base, calls: 350, accepted: 41, stopReason: 'budget di 350 chiamate esaurito (FREE_TRANSLATE_CODEX_MAX_CALLS)' }, { calls: 900 });
    expect(report.codexReserveCoverage([spent]).verdict).toBe('covered');
    expect(report.codexReserveCoverage([spent]).verdict).toBe('covered');
    expect(report.summarizeCodexReserve([spent])).toMatchObject({ calls: 350, translated: 41, rejected: 0 });
  });

  it('il report si scrive all\'uscita della fase e si rilegge dalla cartella', async () => {
    const report = await import('../scripts/lib/codex-reserve-report.mjs');
    const dir = path.join(tmp, 'reports');
    fs.mkdirSync(dir, { recursive: true });
    const phase = report.buildCodexReserveReport('2b-cascade', { lanePresent: true, calls: 2, accepted: 2, maxCalls: 350 }, { calls: 5 });
    fs.writeFileSync(path.join(dir, '2b-cascade.json'), JSON.stringify(phase));
    fs.writeFileSync(path.join(dir, 'rotto.json'), '{');
    expect(report.readCodexReserveReports(dir).map((entry: { phase: string }) => entry.phase)).toEqual(['2b-cascade']);
    expect(report.readCodexReserveReports(path.join(tmp, 'assente'))).toEqual([]);
    expect(report.installCodexReserveReport('2b-cascade', () => ({ codex: {}, cascade: {} }), { dir: '' })).toBe(false);
  });
});
