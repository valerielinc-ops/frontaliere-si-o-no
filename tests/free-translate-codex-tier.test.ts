import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Tier Codex Luna Max della cascata MT (decisione del proprietario del
 * 2026-09-25: «Quando deepl e azure translation sono fuori quota USA codex luna
 * Max»). Gemello di generator/tests/free-translate-codex-tier.test.mjs del
 * corpus.
 *
 * Pinna: il tier entra SOLO quando DeepL e Azure sono fuori gioco per la run
 * (chiavi esaurite), non quando falliscono su un testo solo; senza lane
 * (socket del broker assente) si salta in silenzio; il budget per processo e i
 * fallimenti consecutivi lo fermano con UNA riga di log; la risposta passa da
 * `tryTier`/`finalize` come ogni altro tier (eco della sorgente rifiutato e
 * contato, token protetti rimessi nella lingua di arrivo); la cornice si toglie
 * solo con i marcatori della chiamata, quindi un testo che contiene davvero
 * `END_TEXT` resta intero; le richieste del processo non superano le sue
 * corsie (FREE_TRANSLATE_CODEX_LANES) ne' insieme il budget di tempo, e con le
 * corsie occupate i testi in coda partono insieme in una richiesta a id,
 * ognuno con la sua traduzione; con FREE_TRANSLATE_CODEX_TIER=last
 * (translate-pending, dopo Argos) il tier non prende il testo prima dei tier
 * senza quota e lo traduce in coda, solo quando ogni altro tier lo ha lasciato.
 *
 * Nessuna rete e nessun Codex vero: `fetch` e' uno stub (DeepL, Azure,
 * MyMemory) e la chiamata a Codex passa da `setCodexTranslateCallForTests`.
 * Le chiavi sono lette all'import del modulo: l'ambiente si prepara prima di un
 * import fresco (`vi.resetModules`), e lo stato dei tier (chiavi esaurite)
 * prosegue fra i casi nell'ordine in cui sono scritti.
 */

type FreeTranslate = typeof import('../scripts/lib/free-translate.mjs');
type CodexStub = (messages: Array<{ role: string; content: string }>, opts: Record<string, unknown>) => Promise<string>;

const IT = 'Il permesso G si rinnova ogni cinque anni presso l\'ufficio della migrazione del Cantone Ticino.';
const EN = 'The G permit is renewed every five years at the migration office of the Canton of Ticino.';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-tier-'));
const SOCKET = path.join(tmp, 'broker.sock');
fs.writeFileSync(SOCKET, '');

const premium = { deepl: 200, azure: 200 };
// MyMemory che rimanda la sorgente: eco rifiutato, la cascata prosegue fino in fondo.
const free = { mymemoryEcho: false, googleEcho: false, mymemoryDown: false };
const realFetch = globalThis.fetch;
let ft: FreeTranslate;
let codexModel: string;

beforeAll(async () => {
  for (const key of [
    'DEEPL_API_KEY_2', 'AZURE_TRANSLATOR_KEY_2', 'GOOGLE_APPLICATION_CREDENTIALS', 'GSC_CLIENT_ID', 'GSC_CLIENT_SECRET',
    'GSC_REFRESH_TOKEN', 'HF_TOKEN', 'HUGGINGFACE_API_KEY', 'LIBRETRANSLATE_SELF_HOSTED_URL',
    'MT_LOCAL_OPUSMT', 'ENABLE_CODEX_ARTICLE_FALLBACK', 'AI_MODELS_PREFER', 'AI_MODELS_FORCE_CHAIN',
    'FREE_TRANSLATE_CODEX_MAX_CALLS', 'FREE_TRANSLATE_CODEX_MAX_MS', 'FREE_TRANSLATE_CODEX_LANES', 'FREE_TRANSLATE_CODEX_BATCH_MAX_TEXTS',
  ]) vi.stubEnv(key, '');
  vi.stubEnv('DEEPL_API_KEY', 'deepl-finta');
  vi.stubEnv('AZURE_TRANSLATOR_KEY', 'azure-finta');
  vi.stubEnv('CODEX_AUTH_BROKER_SOCKET', SOCKET);
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    if (u.includes('api-free.deepl.com')) {
      if (premium.deepl === 200) return { ok: true, status: 200, json: async () => ({ translations: [{ text: `DEEPL ${EN}` }] }) };
      return { ok: false, status: premium.deepl, json: async () => ({}), text: async () => '' };
    }
    if (u.includes('api.cognitive.microsofttranslator.com')) {
      if (premium.azure === 200) return { ok: true, status: 200, json: async () => [{ translations: [{ text: `AZURE ${EN}` }] }] };
      return { ok: false, status: premium.azure, json: async () => ({}), text: async () => 'credenziali rifiutate' };
    }
    if (free.googleEcho && u.includes('translate.googleapis.com/translate_a/single')) {
      const q = new URL(u).searchParams.get('q');
      return { ok: true, status: 200, text: async () => JSON.stringify([[[q, q]]]) };
    }
    if (free.mymemoryDown && u.includes('api.mymemory.translated.net')) throw new Error('offline nel test');
    if (u.includes('api.mymemory.translated.net')) {
      const translatedText = free.mymemoryEcho ? new URL(u).searchParams.get('q') : `MYMEMORY ${EN}`;
      return { ok: true, json: async () => ({ responseData: { translatedText, match: 1 } }) };
    }
    throw new Error('offline nel test');
  }) as unknown as typeof globalThis.fetch;
  vi.resetModules();
  ft = await import('../scripts/lib/free-translate.mjs');
  const ai = await import('../scripts/lib/ai-models.mjs');
  codexModel = ai.AI_MODELS.CODEX_CLI_PRIMARY;
});

afterAll(() => {
  ft?.setCodexTranslateCallForTests(null);
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Contatori del tier Codex: `getCascadeStats` copia solo il primo livello. */
/** Suffisso dei marcatori della chiamata, letto dal messaggio utente. */
function markerOf(messages: Array<{ role: string; content: string }>) {
  return /^BEGIN_TEXT_([A-Z0-9]{8})\n/.exec(messages.find((m) => m.role === 'user')!.content)?.[1];
}

function codexCounters() {
  const s = ft.getCascadeStats();
  return {
    hits: s.tierHits.codex || 0,
    errors: s.tierErrors.codex || 0,
    passthroughs: s.tierPassthroughs.codex || 0,
  };
}

function stubCodex(answer: string | ((messages: Array<{ role: string; content: string }>) => string | Promise<string>)) {
  const calls: Array<{ messages: Array<{ role: string; content: string }>; opts: Record<string, unknown> }> = [];
  const stub: CodexStub = async (messages, opts) => {
    calls.push({ messages, opts });
    return typeof answer === 'function' ? answer(messages) : answer;
  };
  ft.setCodexTranslateCallForTests(stub);
  return calls;
}

async function captureLog<T>(fn: () => Promise<T> | T) {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
  try {
    return { value: await fn(), lines };
  } finally {
    spy.mockRestore();
  }
}

const tr = (text = IT) => ft.freeTranslate({ text, sourceLang: 'it', targetLang: 'en', fieldType: 'description' });

/** Testi distinti, tutti it→en: `Numero N` li distingue. */
const numbered = (count: number) => Array.from({ length: count }, (_, i) => `${IT} Numero ${i + 1}.`);
const translationOf = (text: string) => `${EN} [${/Numero (\d+)/.exec(text)?.[1] ?? '?'}]`;

/** Richiesta di gruppo: il messaggio utente e' l'array JSON delle voci. */
function batchItems(messages: Array<{ role: string; content: string }>) {
  const user = messages.find((m) => m.role === 'user')!.content;
  return user.startsWith('[') ? JSON.parse(user) as Array<{ id: number; text: string }> : null;
}

/**
 * Date in it→de: la regola del prompt chiede di localizzarle (nomi dei mesi,
 * ordine, ordinali) con gli stessi valori. Gemello dei casi del corpus
 * (issue nanakokyobashi-rgb/frontaliere-articles 2113).
 */
const DATE_CASES = [
  {
    source: 'La domanda e\' valida dal 1° gennaio 2024 e il limite e\' di 42 giorni.',
    de: 'Der Antrag ist ab dem 1. Januar 2024 gültig und die Frist beträgt 42 Tage.',
  },
  {
    source: 'La scadenza e\' il 2 febbraio 2025 e il valore resta 7.',
    de: 'Die Frist ist am 2. Februar 2025 und der Wert bleibt 7.',
  },
  {
    source: 'Il contratto decorre dal 3 marzo 2026 e prevede 9 mesi.',
    de: 'Der Vertrag beginnt am 3. März 2026 und sieht 9 Monate vor.',
  },
];
const DATE_CASE_BY_SOURCE = new Map(DATE_CASES.map((item) => [item.source, item]));

function assertLocalizedDateRule(system: string) {
  expect(system).toMatch(/Localize dates using the target language's customary format/);
  expect(system).toMatch(/same calendar day, month, year and numeric values/);
  expect(system).toMatch(/non-date numbers, amounts/);
  expect(system).not.toMatch(/Copy unchanged:[^\n]*dates/);
}

function localizedDateAnswer(messages: Array<{ role: string; content: string }>) {
  assertLocalizedDateRule(messages.find((m) => m.role === 'system')!.content);
  const items = batchItems(messages);
  if (items) {
    return JSON.stringify({ items: items.map(({ id, text }) => ({ id, text: DATE_CASE_BY_SOURCE.get(text)?.de ?? '' })) });
  }
  const user = messages.find((m) => m.role === 'user')!.content;
  const framed = /^BEGIN_TEXT_[A-Z0-9]{8}\n([\s\S]*)\nEND_TEXT_[A-Z0-9]{8}$/.exec(user);
  return DATE_CASE_BY_SOURCE.get(framed?.[1] ?? '')?.de ?? '';
}

/** Risponde come Codex: al testo singolo con la traduzione, al gruppo con lo schema a id. */
function codexAnswer(translate: (text: string) => string = translationOf) {
  return (messages: Array<{ role: string; content: string }>) => {
    const items = batchItems(messages);
    if (items) return JSON.stringify({ items: items.map(({ id, text }) => ({ id, text: translate(text) })) });
    const user = messages.find((m) => m.role === 'user')!.content;
    return translate(/^BEGIN_TEXT_[A-Z0-9]{8}\n([\s\S]*)\nEND_TEXT_[A-Z0-9]{8}$/.exec(user)![1]);
  };
}

describe('freeTranslate — tier Codex Luna Max', () => {
  it('DeepL sano: Codex non viene chiamato', async () => {
    const calls = stubCodex(`CODEX ${EN}`);
    expect(await tr()).toBe(`DEEPL ${EN}`);
    expect(calls).toHaveLength(0);
  });

  it('DeepL e Azure giu\' su UN testo (5xx), chiavi non esaurite: niente Codex', async () => {
    premium.deepl = 500;
    premium.azure = 500;
    const calls = stubCodex(`CODEX ${EN}`);
    expect(await tr()).toBe(`MYMEMORY ${EN}`);
    expect(calls).toHaveLength(0);
  });

  it('DeepL 456 e Azure 401: tier Codex, con il prompt stretto e la sola lane Codex', async () => {
    premium.deepl = 456;
    premium.azure = 401;
    const before = codexCounters();
    const calls = stubCodex(`CODEX ${EN}`);
    const { value, lines } = await captureLog(() => tr());
    expect(value).toBe(`CODEX ${EN}`);
    expect(calls).toHaveLength(1);
    expect(codexCounters().hits - before.hits).toBe(1);
    expect(lines.filter((l) => l.includes('traduzioni via Codex Luna Max'))).toHaveLength(1);

    const { messages, opts } = calls[0];
    const system = messages.find((m) => m.role === 'system')!.content;
    expect(system).toMatch(/from Italian to English/);
    expect(system).toMatch(/Translate only/);
    expect(system).toMatch(/\*\*bold\*\*/);
    expect(system).toMatch(/URLs/);
    expect(system).toMatch(/ZQX0XQZ/);
    expect(system).toMatch(/translated text only/);
    assertLocalizedDateRule(system);
    const user = messages.find((m) => m.role === 'user')!.content;
    const framed = /^BEGIN_TEXT_([A-Z0-9]{8})\n([\s\S]*)\nEND_TEXT_\1$/.exec(user);
    expect(framed, 'testo incorniciato dai marcatori della chiamata').toBeTruthy();
    expect(framed![2]).toBe(IT);
    expect(system).toContain(`between BEGIN_TEXT_${framed![1]} and END_TEXT_${framed![1]}`);
    expect(opts.chain).toEqual([codexModel]);
    expect(opts.prefer).toEqual([codexModel]);
    expect(opts.bypassForceChain).toBe(true);
    expect(opts.deadlineMs as number).toBeGreaterThan(Date.now());
    expect(opts.deadlineMs as number).toBeLessThanOrEqual(Date.now() + 180_000);
  });

  it('le date sono localizzate nella lingua di arrivo, con valori invariati, in singola e batch', async () => {
    const de = (text: string) => ft.freeTranslate({ text, sourceLang: 'it', targetLang: 'de', fieldType: 'description' });
    const singleCalls = stubCodex(localizedDateAnswer);
    expect(await de(DATE_CASES[0].source)).toBe(DATE_CASES[0].de);
    expect(singleCalls).toHaveLength(1);

    vi.stubEnv('FREE_TRANSLATE_CODEX_LANES', '1');
    try {
      const batchCalls = stubCodex(localizedDateAnswer);
      const { value } = await captureLog(() => Promise.all(DATE_CASES.map(({ source }) => de(source))));
      expect(value).toEqual(DATE_CASES.map(({ de: out }) => out));
      expect(batchCalls).toHaveLength(2);
      expect(batchItems(batchCalls[1].messages)).toHaveLength(2);
    } finally {
      vi.stubEnv('FREE_TRANSLATE_CODEX_LANES', '');
    }
  });

  it('la risposta passa da finalize: cornice tolta, token protetto rimesso nella lingua di arrivo', async () => {
    const calls = stubCodex((messages) => {
      const user = messages.find((m) => m.role === 'user')!.content;
      const token = /ZQX\d+XQZ/.exec(user)?.[0];
      expect(token, 'il trigramma di genere deve arrivare mascherato').toBeTruthy();
      const marker = markerOf(messages);
      return `\`\`\`\nBEGIN_TEXT_${marker}\nInfermiere diplomato ${token}\nEND_TEXT_${marker}\n\`\`\``;
    });
    const out = await ft.freeTranslate({ text: 'Pflegefachperson HF (m/w/d)', sourceLang: 'de', targetLang: 'it' });
    expect(calls).toHaveLength(1);
    expect(out).toMatch(/^Infermiere diplomato/);
    expect(out).not.toMatch(/ZQX|BEGIN_TEXT|END_TEXT|```/);
  });

  it('un testo che contiene davvero BEGIN_TEXT o END_TEXT resta intero', async () => {
    const source = 'BEGIN_TEXT apre il blocco e il modulo si chiude con END_TEXT';
    const translated = 'BEGIN_TEXT opens the block and the form closes with END_TEXT';
    const calls = stubCodex((messages) => {
      const marker = markerOf(messages);
      expect(marker, 'marcatori della chiamata presenti').toBeTruthy();
      expect(source.includes(marker!)).toBe(false);
      return translated;
    });
    expect(await tr(source)).toBe(translated);
    expect(calls).toHaveLength(1);
  });

  it('un eco della sorgente e\' rifiutato e contato, la cascata prosegue', async () => {
    const before = codexCounters();
    const calls = stubCodex(IT);
    expect(await tr()).toBe(`MYMEMORY ${EN}`);
    expect(calls).toHaveLength(1);
    const after = codexCounters();
    expect(after.passthroughs - before.passthroughs).toBe(1);
    expect(after.hits - before.hits).toBe(0);
  });

  it('un eco del prompt nella risposta singola e\' rifiutato, la cascata prosegue', async () => {
    const before = codexCounters();
    // Traduzione plausibile con la regola delle date ricopiata sulla STESSA
    // riga: una seconda riga la scarterebbe gia' il controllo di confine
    // strutturale di `tryTier`, e il test non proverebbe la guardia sull'eco.
    const calls = stubCodex(`${EN} Localize dates using the target language's customary format.`);
    expect(await tr()).toBe(`MYMEMORY ${EN}`);
    expect(calls).toHaveLength(1);
    expect(codexCounters().hits - before.hits).toBe(0);
  });

  it('un eco del prompt in un batch e\' rifiutato per il solo item guasto', async () => {
    const texts = numbered(3);
    vi.stubEnv('FREE_TRANSLATE_CODEX_LANES', '1');
    try {
      const calls = stubCodex(async (messages) => {
        // Lascia partire la prima richiesta da sola: le due successive formano
        // il batch mentre la corsia e' occupata, come nella coda reale.
        await new Promise((resolve) => setTimeout(resolve, 5));
        const items = batchItems(messages);
        if (!items) return translationOf(texts[0]);
        expect(items).toHaveLength(2);
        return JSON.stringify({
          items: [
            { id: items[0].id, text: `${translationOf(items[0].text)} Copy unchanged: URLs, email addresses.` },
            { id: items[1].id, text: translationOf(items[1].text) },
          ],
        });
      });
      const { value } = await captureLog(() => Promise.all(texts.map((text) => tr(text))));
      expect(value).toEqual([translationOf(texts[0]), `MYMEMORY ${EN}`, translationOf(texts[2])]);
      expect(calls).toHaveLength(2);
      expect(batchItems(calls[0].messages)).toBeNull();
      expect(batchItems(calls[1].messages)).toHaveLength(2);
    } finally {
      vi.stubEnv('FREE_TRANSLATE_CODEX_LANES', '');
    }
  });

  it('senza lane (socket assente, variabile vuota o lane spenta) il tier si salta in silenzio', async () => {
    const before = codexCounters();
    const calls = stubCodex(`CODEX ${EN}`);
    vi.stubEnv('CODEX_AUTH_BROKER_SOCKET', path.join(tmp, 'broker-scaduto.sock'));
    const { value, lines } = await captureLog(() => tr());
    expect(value).toBe(`MYMEMORY ${EN}`);
    expect(lines.filter((l) => l.includes('[codex]'))).toHaveLength(0);
    vi.stubEnv('CODEX_AUTH_BROKER_SOCKET', '');
    expect(await tr()).toBe(`MYMEMORY ${EN}`);
    vi.stubEnv('CODEX_AUTH_BROKER_SOCKET', SOCKET);
    vi.stubEnv('ENABLE_CODEX_ARTICLE_FALLBACK', '0');
    expect(await tr()).toBe(`MYMEMORY ${EN}`);
    vi.stubEnv('ENABLE_CODEX_ARTICLE_FALLBACK', '');
    expect(calls).toHaveLength(0);
    expect(codexCounters().errors).toBe(before.errors);
  });

  it('il budget di chiamate ferma il tier con una riga sola', async () => {
    vi.stubEnv('FREE_TRANSLATE_CODEX_MAX_CALLS', '2');
    const calls = stubCodex(`CODEX ${EN}`);
    const { value, lines } = await captureLog(async () => [await tr(), await tr(), await tr(), await tr()]);
    expect(value).toEqual([`CODEX ${EN}`, `CODEX ${EN}`, `MYMEMORY ${EN}`, `MYMEMORY ${EN}`]);
    expect(calls).toHaveLength(2);
    expect(lines.filter((l) => l.includes('budget di 2 chiamate esaurito'))).toHaveLength(1);
    const summary = await captureLog(() => ft.logCascadeSummary());
    expect(summary.lines.some((l) => l.includes('Codex Luna Max: 2/2 calls'))).toBe(true);
    vi.stubEnv('FREE_TRANSLATE_CODEX_MAX_CALLS', '');
  });

  it('le richieste concorrenti non superano il budget, anche quando traducono piu\' testi', async () => {
    // Una corsia: il primo testo parte da solo, i cinque successivi insieme
    // nella seconda richiesta, e il settimo trova il budget di 2 esaurito.
    vi.stubEnv('FREE_TRANSLATE_CODEX_MAX_CALLS', '2');
    vi.stubEnv('FREE_TRANSLATE_CODEX_LANES', '1');
    try {
      const texts = numbered(7);
      const answer = codexAnswer();
      const calls = stubCodex(async (messages) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return answer(messages);
      });
      const { value } = await captureLog(() => Promise.all(texts.map((text) => tr(text))));
      expect(calls).toHaveLength(2);
      expect(batchItems(calls[0].messages)).toBeNull();
      expect(batchItems(calls[1].messages)).toHaveLength(5);
      expect(value.slice(0, 6)).toEqual(texts.slice(0, 6).map(translationOf));
      expect(value[6]).toBe(`MYMEMORY ${EN}`);
    } finally {
      vi.stubEnv('FREE_TRANSLATE_CODEX_MAX_CALLS', '');
      vi.stubEnv('FREE_TRANSLATE_CODEX_LANES', '');
    }
  });

  it('con una corsia le richieste passano una alla volta e non superano insieme il budget di tempo', async () => {
    // Orologio finto: ogni chiamata "dura" 10 s. Con 20 s di budget la prima
    // chiamata lascia 10 s, sotto il minimo di 15 s per chiamata: le altre non
    // partono. Lette in parallelo prima dell'await, tutte e tre avrebbero visto
    // 20 s di residuo e sarebbero partite.
    vi.stubEnv('FREE_TRANSLATE_CODEX_MAX_MS', '20000');
    vi.stubEnv('FREE_TRANSLATE_CODEX_LANES', '1');
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    try {
      let inFlight = 0;
      let maxInFlight = 0;
      const calls = stubCodex(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        offset += 10_000;
        inFlight -= 1;
        return `CODEX ${EN}`;
      });
      const { value, lines } = await captureLog(() => Promise.all([tr(), tr(), tr()]));
      expect(calls).toHaveLength(1);
      expect(maxInFlight).toBe(1);
      expect(value).toEqual([`CODEX ${EN}`, `MYMEMORY ${EN}`, `MYMEMORY ${EN}`]);
      expect(lines.filter((l) => l.includes('budget di 20s esaurito'))).toHaveLength(1);
    } finally {
      clock.mockRestore();
      vi.stubEnv('FREE_TRANSLATE_CODEX_MAX_MS', '');
      vi.stubEnv('FREE_TRANSLATE_CODEX_LANES', '');
    }
  });

  it('il budget di tempo conta l\'orologio: due richieste parallele di 10 s ne costano 10', async () => {
    // Con la somma delle durate due richieste parallele avrebbero speso 20 s e
    // fermato il tier; a orologio ne hanno spesi 10, e la terza parte.
    vi.stubEnv('FREE_TRANSLATE_CODEX_MAX_MS', '30000');
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    try {
      let started = 0;
      let release: () => void = () => {};
      const bothStarted = new Promise<void>((resolve) => { release = resolve; });
      const answer = codexAnswer();
      const calls = stubCodex(async (messages) => {
        started += 1;
        if (started === 2) {
          offset += 10_000;
          release();
        }
        if (started <= 2) await bothStarted;
        return answer(messages);
      });
      const [a, b] = numbered(2);
      const first = await captureLog(() => Promise.all([tr(a), tr(b)]));
      expect(first.value).toEqual([translationOf(a), translationOf(b)]);
      const [c] = numbered(3).slice(2);
      expect(await tr(c)).toBe(translationOf(c));
      expect(calls).toHaveLength(3);
    } finally {
      clock.mockRestore();
      vi.stubEnv('FREE_TRANSLATE_CODEX_MAX_MS', '');
    }
  });

  it('mai piu\' richieste in volo delle corsie del processo', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const answer = codexAnswer();
    const calls = stubCodex(async (messages) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return answer(messages);
    });
    const texts = numbered(6);
    const { value } = await captureLog(() => Promise.all(texts.map((text) => tr(text))));
    expect(value).toEqual(texts.map(translationOf));
    // Default: due corsie. I primi due testi partono da soli; al primo posto
    // libero la coda di 4 si divide per le 2 corsie (gruppo di 2), poi i due
    // testi rimasti partono uno per corsia.
    expect(maxInFlight).toBe(2);
    expect(calls.map((c) => batchItems(c.messages)?.length ?? 1)).toEqual([1, 1, 2, 1, 1]);
  });

  it('una voce di gruppo avvolta in una cornice di codice arriva senza cornice', async () => {
    vi.stubEnv('FREE_TRANSLATE_CODEX_LANES', '1');
    try {
      const answer = codexAnswer();
      const fence = '```';
      const calls = stubCodex((messages) => {
        const items = batchItems(messages);
        if (!items) return answer(messages);
        return JSON.stringify({ items: items.map(({ id, text }) => ({ id, text: `${fence}\n${translationOf(text)}\n${fence}` })) });
      });
      const texts = numbered(3);
      const { value } = await captureLog(() => Promise.all(texts.map((text) => tr(text))));
      expect(calls).toHaveLength(2);
      expect(value).toEqual(texts.map(translationOf));
    } finally {
      vi.stubEnv('FREE_TRANSLATE_CODEX_LANES', '');
    }
  });

  it('FREE_TRANSLATE_CODEX_BATCH_MAX_TEXTS=1 con una corsia torna una richiesta per testo, una alla volta', async () => {
    vi.stubEnv('FREE_TRANSLATE_CODEX_LANES', '1');
    vi.stubEnv('FREE_TRANSLATE_CODEX_BATCH_MAX_TEXTS', '1');
    try {
      let inFlight = 0;
      let maxInFlight = 0;
      const answer = codexAnswer();
      const calls = stubCodex(async (messages) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return answer(messages);
      });
      const texts = numbered(4);
      const { value } = await captureLog(() => Promise.all(texts.map((text) => tr(text))));
      expect(value).toEqual(texts.map(translationOf));
      expect(calls).toHaveLength(4);
      expect(maxInFlight).toBe(1);
      expect(calls.every((c) => batchItems(c.messages) === null)).toBe(true);
    } finally {
      vi.stubEnv('FREE_TRANSLATE_CODEX_LANES', '');
      vi.stubEnv('FREE_TRANSLATE_CODEX_BATCH_MAX_TEXTS', '');
    }
  });

  it('con le corsie occupate i testi in coda partono insieme, con lo schema a id e le regole del testo singolo', async () => {
    vi.stubEnv('FREE_TRANSLATE_CODEX_LANES', '1');
    try {
      const answer = codexAnswer();
      const calls = stubCodex(answer);
      const texts = numbered(4);
      const { value } = await captureLog(() => Promise.all(texts.map((text) => tr(text))));
      expect(value).toEqual(texts.map(translationOf));
      expect(calls).toHaveLength(2);
      const { messages, opts } = calls[1];
      expect(batchItems(messages)).toEqual(texts.slice(1).map((text, i) => ({ id: i + 1, text })));
      const system = messages.find((m) => m.role === 'system')!.content;
      expect(system).toMatch(/from Italian to English/);
      expect(system).toMatch(/Translate each item on its own/);
      expect(system).toMatch(/ZQX0XQZ/);
      expect(opts.jsonMode).toBe(true);
      const schema = (opts.jsonSchema as { schema: { properties: { items: { items: { required: string[] } } } } }).schema;
      expect(schema.properties.items.items.required).toEqual(['id', 'text']);
      expect(opts.chain).toEqual([codexModel]);
      expect(opts.bypassForceChain).toBe(true);
    } finally {
      vi.stubEnv('FREE_TRANSLATE_CODEX_LANES', '');
    }
  });

  it('una voce mancante, vuota o con un id estraneo scende al tier successivo, le altre restano', async () => {
    vi.stubEnv('FREE_TRANSLATE_CODEX_LANES', '1');
    try {
      const answer = codexAnswer();
      const calls = stubCodex((messages) => {
        const items = batchItems(messages);
        if (!items) return answer(messages);
        return JSON.stringify({ items: [
          { id: 1, text: translationOf(items[0].text) },
          { id: 2, text: '' },
          { id: 99, text: 'estranea' },
        ] });
      });
      const texts = numbered(4);
      const { value } = await captureLog(() => Promise.all(texts.map((text) => tr(text))));
      expect(calls).toHaveLength(2);
      expect(value).toEqual([translationOf(texts[0]), translationOf(texts[1]), `MYMEMORY ${EN}`, `MYMEMORY ${EN}`]);
    } finally {
      vi.stubEnv('FREE_TRANSLATE_CODEX_LANES', '');
    }
  });

  it('testi identici in coda diventano una voce sola', async () => {
    vi.stubEnv('FREE_TRANSLATE_CODEX_LANES', '1');
    try {
      const calls = stubCodex(codexAnswer());
      const [a, b] = numbered(2);
      const { value } = await captureLog(() => Promise.all([tr(a), tr(b), tr(b), tr(b)]));
      expect(value).toEqual([translationOf(a), translationOf(b), translationOf(b), translationOf(b)]);
      // Tre copie dello stesso testo: una voce, quindi il prompt del testo singolo.
      expect(calls).toHaveLength(2);
      expect(batchItems(calls[1].messages)).toBeNull();
    } finally {
      vi.stubEnv('FREE_TRANSLATE_CODEX_LANES', '');
    }
  });

  it('una richiesta di gruppo fallita e\' un errore per ogni suo testo e un fallimento solo', async () => {
    vi.stubEnv('FREE_TRANSLATE_CODEX_LANES', '1');
    try {
      const before = codexCounters();
      const answer = codexAnswer();
      const calls = stubCodex((messages) => {
        if (batchItems(messages)) throw new Error('broker non raggiungibile');
        return answer(messages);
      });
      const texts = numbered(4);
      const { value, lines } = await captureLog(() => Promise.all(texts.map((text) => tr(text))));
      expect(calls).toHaveLength(2);
      expect(value).toEqual([translationOf(texts[0]), `MYMEMORY ${EN}`, `MYMEMORY ${EN}`, `MYMEMORY ${EN}`]);
      expect(codexCounters().errors - before.errors).toBe(3);
      expect(lines.filter((l) => l.includes('fallimenti consecutivi'))).toHaveLength(0);
    } finally {
      vi.stubEnv('FREE_TRANSLATE_CODEX_LANES', '');
    }
  });

  it('tre fallimenti consecutivi fermano il tier, contati come errori del tier', async () => {
    const before = codexCounters();
    const calls = stubCodex(() => { throw new Error('broker non raggiungibile'); });
    const { value, lines } = await captureLog(async () => [await tr(), await tr(), await tr(), await tr()]);
    expect(value).toEqual(Array(4).fill(`MYMEMORY ${EN}`));
    expect(calls).toHaveLength(3);
    expect(codexCounters().errors - before.errors).toBe(3);
    expect(lines.filter((l) => l.includes('3 fallimenti consecutivi'))).toHaveLength(1);
    // Il messaggio dell'errore non finisce nel log.
    expect(lines.every((l) => !l.includes('broker non raggiungibile'))).toBe(true);
  });
  it('tre echi di fila fermano il tier come tre fallimenti, e restano contati come passthrough', async () => {
    const before = codexCounters();
    const calls = stubCodex(IT);
    const { value, lines } = await captureLog(async () => [await tr(), await tr(), await tr(), await tr()]);
    expect(value).toEqual(Array(4).fill(`MYMEMORY ${EN}`));
    expect(calls).toHaveLength(3);
    expect(codexCounters().passthroughs - before.passthroughs).toBe(3);
    expect(lines.filter((l) => l.includes('3 fallimenti consecutivi'))).toHaveLength(1);
  });

  it('tre rifiuti di fila fermano il tier come tre fallimenti (review della PR corpus 2166)', async () => {
    // Un rifiuto non e' un eco della sorgente: prima di questa guardia la lane
    // lo contava come traduzione riuscita, azzerava lo streak e non si fermava.
    const calls = stubCodex("Sorry, I can't help with that.");
    const { value, lines } = await captureLog(async () => [await tr(), await tr(), await tr(), await tr()]);
    expect(value).toEqual(Array(4).fill(`MYMEMORY ${EN}`));
    expect(calls).toHaveLength(3);
    expect(lines.filter((l) => l.includes('3 fallimenti consecutivi'))).toHaveLength(1);
  });

  it('FREE_TRANSLATE_CODEX_TIER=last: Codex non prende il testo prima dei tier senza quota', async () => {
    // DeepL e Azure sono fuori gioco dai casi precedenti: nella posizione di
    // default Codex risponderebbe qui, prima di MyMemory.
    vi.stubEnv('FREE_TRANSLATE_CODEX_TIER', 'last');
    try {
      const calls = stubCodex(`CODEX ${EN}`);
      expect(await tr()).toBe(`MYMEMORY ${EN}`);
      expect(calls).toHaveLength(0);
    } finally {
      vi.stubEnv('FREE_TRANSLATE_CODEX_TIER', '');
    }
  });

  it('FREE_TRANSLATE_CODEX_TIER=last: Codex traduce in coda il testo che ogni altro tier ha lasciato', async () => {
    vi.stubEnv('FREE_TRANSLATE_CODEX_TIER', 'last');
    free.mymemoryEcho = true;
    try {
      const calls = stubCodex(`CODEX ${EN}`);
      const { value, lines } = await captureLog(() => tr());
      expect(value).toBe(`CODEX ${EN}`);
      expect(calls).toHaveLength(1);
      expect(lines.filter((l) => l.includes('testi che nessun altro tier ha tradotto'))).toHaveLength(1);
    } finally {
      free.mymemoryEcho = false;
      vi.stubEnv('FREE_TRANSLATE_CODEX_TIER', '');
    }
  });

  it('FREE_TRANSLATE_CODEX_TIER=last: un testo rimandato identico da due motori non arriva a Codex', async () => {
    // Un nome o una sigla: ogni motore lo rimanda identico, Codex farebbe lo
    // stesso e tre echi di fila spegnerebbero il tier per i testi veri.
    vi.stubEnv('FREE_TRANSLATE_CODEX_TIER', 'last');
    free.mymemoryEcho = true;
    free.googleEcho = true;
    try {
      const calls = stubCodex(`CODEX ${EN}`);
      const { value, lines } = await captureLog(async () => {
        const out = await tr();
        ft.logCascadeSummary();
        return out;
      });
      expect(value).toBe('');
      expect(calls).toHaveLength(0);
      expect(lines.some((l) => /Codex Luna Max \(last\): \d+ texts not sent/.test(l))).toBe(true);
    } finally {
      free.mymemoryEcho = false;
      free.googleEcho = false;
      vi.stubEnv('FREE_TRANSLATE_CODEX_TIER', '');
    }
  });

  it('FREE_TRANSLATE_CODEX_TIER=last: gli echi di UN solo motore (endpoint e tentativi) non bastano a saltare Codex', async () => {
    // Google gratuito prova due endpoint e tre tentativi: sono sei echi dello
    // stesso motore, non due motori che concordano.
    vi.stubEnv('FREE_TRANSLATE_CODEX_TIER', 'last');
    free.googleEcho = true;
    free.mymemoryDown = true;
    try {
      const calls = stubCodex(`CODEX ${EN}`);
      const googleEchoesBefore = ft.getCascadeStats().tierPassthroughs.google || 0;
      expect(await tr()).toBe(`CODEX ${EN}`);
      expect((ft.getCascadeStats().tierPassthroughs.google || 0) - googleEchoesBefore).toBeGreaterThanOrEqual(2);
      expect(calls).toHaveLength(1);
    } finally {
      free.googleEcho = false;
      free.mymemoryDown = false;
      vi.stubEnv('FREE_TRANSLATE_CODEX_TIER', '');
    }
  });

  it('senza FREE_TRANSLATE_CODEX_TIER la posizione resta quella di default, senza secondo tentativo in coda', async () => {
    free.mymemoryEcho = true;
    try {
      const calls = stubCodex(`CODEX ${EN}`);
      expect(await tr()).toBe(`CODEX ${EN}`);
      expect(calls).toHaveLength(1);
      const failing = stubCodex(() => { throw new Error('broker non raggiungibile'); });
      expect(await tr()).toBe('');
      expect(failing).toHaveLength(1);
    } finally {
      free.mymemoryEcho = false;
    }
  });
});

// Scadenza del processo (corpus nanakokyobashi-rgb/frontaliere-articles#1931,
// portata con #7483): la sezione Codex e' byte-identica nei due repo. Sul sito
// nessuno installa una scadenza, quindi la finestra resta quella di prima; il
// caso che la usa (create-article del corpus) e' coperto dal gemello.
describe('codexCallDeadlineMs — clamp della deadline di una chiamata Codex', () => {
  const now = 1_000_000;

  it('senza scadenza del processo resta min(tetto 180 s, budget del tier)', () => {
    expect(ft.codexCallDeadlineMs({ now, budgetRemainingMs: 300_000, processDeadlineMs: null })).toBe(now + 180_000);
    expect(ft.codexCallDeadlineMs({ now, budgetRemainingMs: 40_000, processDeadlineMs: null })).toBe(now + 40_000);
  });

  it('la scadenza del processo vince quando e\' la piu\' vicina, e non allunga mai la finestra', () => {
    expect(ft.codexCallDeadlineMs({ now, budgetRemainingMs: 300_000, processDeadlineMs: now + 60_000 })).toBe(now + 60_000);
    expect(ft.codexCallDeadlineMs({ now, budgetRemainingMs: 300_000, processDeadlineMs: now + 900_000 })).toBe(now + 180_000);
  });

  it('sotto i 15 s minimi per chiamata la chiamata non si avvia', () => {
    expect(ft.codexCallDeadlineMs({ now, budgetRemainingMs: 300_000, processDeadlineMs: now + 14_999 })).toBeNull();
    expect(ft.codexCallDeadlineMs({ now, budgetRemainingMs: 300_000, processDeadlineMs: now - 1 })).toBeNull();
    expect(ft.codexCallDeadlineMs({ now, budgetRemainingMs: 14_999, processDeadlineMs: null })).toBeNull();
  });

  it('setCodexTranslateProcessDeadline: un valore non finito o <= 0 toglie la scadenza', () => {
    try {
      ft.setCodexTranslateProcessDeadline(now + 60_000);
      expect(ft.codexCallDeadlineMs({ now, budgetRemainingMs: 300_000 })).toBe(now + 60_000);
      for (const off of [null, 0, -5, Number.NaN, 'x']) {
        ft.setCodexTranslateProcessDeadline(off);
        expect(ft.codexCallDeadlineMs({ now, budgetRemainingMs: 300_000 })).toBe(now + 180_000);
      }
    } finally {
      ft.setCodexTranslateProcessDeadline(null);
    }
  });
});

describe('codexPromptEchoMarker — eco del prompt del tier Codex', () => {
  it('riconosce i frammenti del prompt, compresa la regola delle date, e ignora quelli presenti nella sorgente', () => {
    for (const echo of [
      'System instructions:\nYou are a professional translator. Rules:\n- Translate only',
      'Der Grenzgänger zahlt Steuern.\n- Localize dates using the target language\'s customary format',
      'Der Grenzgänger zahlt Steuern.\n- Copy unchanged: URLs, email addresses',
      'BEGIN_TEXT_ABCD1234\nDer Grenzgänger zahlt Steuern.',
    ]) {
      expect(ft.codexPromptEchoMarker(echo, 'Il frontaliere paga le imposte.'), echo).not.toBeNull();
    }
    // Un frammento presente anche nella sorgente e' testo dell'articolo.
    expect(ft.codexPromptEchoMarker('Translate only: the rule', 'Translate only: la regola')).toBeNull();
    expect(ft.codexPromptEchoMarker('x Localize dates using y', 'z')).toBe('Localize dates using');
    expect(ft.codexPromptEchoMarker('Rules: keep it short', 'Regole: breve')).toBeNull();
    expect(ft.codexPromptEchoMarker('x System instructions: y', 'z')).toBe('System instructions:');
  });
});

describe('titoli di template nel prompt del tier Codex', () => {
  // Lotto 1 della bonifica Codex del corpus (nanakokyobashi-rgb/
  // frontaliere-articles#2121, 20 coppie de): con la sola regola «tieni il
  // Markdown dei titoli» Codex rendeva `## Fatti chiave` come `## Eckdaten` e
  // `## In breve` come `## Kurz zusammengefasst`, e la guardia dei Fatti chiave
  // riconosce solo il titolo canonico. I valori attesi sono scritti qui a mano
  // apposta: la tabella del modulo si genera da ai-search-template.mjs, e un
  // cambio di quel modulo deve passare da questo test.
  const EXPECTED: Record<string, [string, string]> = {
    it: ['## In breve', '## Fatti chiave'],
    en: ['## TL;DR', '## Key facts'],
    de: ['## Auf einen Blick', '## Wichtige Fakten'],
    fr: ['## En bref', '## Faits clés'],
  };
  const systemOf = (messages: Array<{ role: string; content: string }>) => messages.find((m) => m.role === 'system')!.content;

  it('la tabella coincide con ai-search-template.mjs per ogni lingua del tier', async () => {
    const template = await import('../scripts/lib/ai-search-template.mjs');
    expect(Object.keys(ft.CODEX_TEMPLATE_HEADINGS).sort()).toEqual(['de', 'en', 'fr', 'it']);
    for (const [lang, headings] of Object.entries(ft.CODEX_TEMPLATE_HEADINGS)) {
      expect(headings, lang).toEqual([template.getTldrHeading(lang), template.getKeyFactsHeading(lang)]);
      expect(headings, lang).toEqual(EXPECTED[lang]);
    }
  });

  it.each(['en', 'de', 'fr'])('richiesta singola e a gruppi it→%s portano il titolo canonico della lingua di arrivo', (target) => {
    const [tldr, keyFacts] = EXPECTED[target];
    const rule = `write the heading line "## In breve" as "${tldr}" and "## Fatti chiave" as "${keyFacts}", exactly, never with a synonym.`;
    const single = systemOf(ft.codexTranslatePromptsForTests.single('## In breve\n- uno\n\n## Fatti chiave\n- Termine: valore', 'it', target));
    const batch = systemOf(ft.codexTranslatePromptsForTests.batch(['## In breve\n- uno', '## Fatti chiave\n- Termine: valore'], 'it', target));
    expect(single).toContain(rule);
    expect(batch).toContain(rule);
  });

  it('nessuna regola per una lingua senza template', () => {
    expect(systemOf(ft.codexTranslatePromptsForTests.single('testo', 'it', 'es'))).not.toContain('Template headings');
    expect(systemOf(ft.codexTranslatePromptsForTests.batch(['a', 'b'], 'it', 'es'))).not.toContain('Template headings');
  });
});
