import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  freeTranslate,
  getCascadeStats,
  logCascadeSummary,
  isSourcePassthrough,
  mergeTranslationOutcome,
} from '@/scripts/lib/free-translate.mjs';
import { translateWithMyMemory } from '@/scripts/lib/mymemory-translate.mjs';

vi.mock('@/scripts/lib/mymemory-translate.mjs', () => ({
  translateWithMyMemory: vi.fn(),
}));

/**
 * La cascata MT poteva rendere la SORGENTE ITALIANA verbatim e nessuno se ne
 * accorgeva: a valle `translateFieldFreeMt` scarta il vuoto, il marker `null` e
 * la sentinella nav mangled, e un passthrough italiano non e' nessuna delle
 * tre — e' testo perfettamente valido, quindi passava. Il 2026-09-06 la stessa
 * classe di difetto ha colpito tre scrittori diversi
 * (`retranslate-blocking-bodies.mjs` nanako#994, `repair-object-object-bodies.mjs`
 * #7704, `batch-add-faq-to-articles.mjs` #7710) proprio perche' ognuno doveva
 * difendersi da solo.
 *
 * Questo file pinna i DUE versi, che e' il punto: la guardia deve rifiutare il
 * passthrough E deve lasciar passare intatto tutto il resto. Il verso positivo
 * da solo si soddisfa rifiutando tutto.
 *
 * Le asserzioni guardano la RAGIONE (il bucket `tierPassthroughs`, la riga di
 * `logCascadeSummary`), non solo il valore di ritorno. `freeTranslate` rende ''
 * per DUE motivi diversi — «ho rifiutato una non-traduzione» e «i motori sono
 * giu'» — e sul solo valore di ritorno sono indistinguibili: l'ultimo caso di
 * questo file pinna proprio quella differenza, ed e' l'unico che si accorge di
 * una guardia che etichetta come passthrough un fallimento di rete.
 *
 * Falsificazione misurata il 2026-09-06 su questo file, nei due versi:
 *   · aggancio rimosso da `tryTier` (difetto reintrodotto) → 3 rossi, i casi
 *     inversi restano verdi;
 *   · `isSourcePassthrough` forzata a `false` (regola spenta) → 4 rossi, i casi
 *     inversi restano verdi;
 *   · `isSourcePassthrough` forzata a `true` (rifiuta tutto) → 3 rossi, tutti
 *     nei casi inversi: le asserzioni che pinnano il comportamento legittimo
 *     mordono davvero, non sono decorative.
 */

const IT = [
  '## In breve',
  '- I frontalieri residenti entro venti chilometri dal confine restano nel vecchio regime fiscale',
  '- La soglia dei quarantacinque giorni di telelavoro vale dal primo gennaio',
  '',
  'Chi ha iniziato a lavorare in Svizzera dopo il 2023 rientra fra i nuovi frontalieri e paga le imposte in entrambi i Paesi.',
].join('\n');

function runRealCascadeWithSelfHostedBody(selfHostedBody: Record<string, unknown>) {
  const moduleUrl = new URL('../scripts/lib/free-translate.mjs', import.meta.url).href;
  const childScript = `
    const echo = ${JSON.stringify(IT)};
    const selfHostedBody = ${JSON.stringify(selfHostedBody)};
    globalThis.fetch = async (url) => {
      const value = String(url);
      if (value.startsWith('http://self-hosted.test/')) {
        return { ok: true, json: async () => selfHostedBody };
      }
      if (value.includes('api.mymemory.translated.net')) {
        return { ok: true, json: async () => ({ responseData: { translatedText: echo, match: 1 } }) };
      }
      if (value.includes('translate.googleapis.com')) {
        return { ok: true, text: async () => JSON.stringify([[[echo]]]) };
      }
      if (value.includes('clients5.google.com')) {
        return { ok: true, text: async () => JSON.stringify({ sentences: [{ trans: echo }] }) };
      }
      if (value.includes('/api/v1/')) {
        return { ok: true, json: async () => ({ translation: echo }) };
      }
      if (value.includes('mozhi.')) {
        return { ok: true, json: async () => ({ 'translated-text': echo }) };
      }
      if (value.includes('simplytranslate')) {
        return { ok: true, json: async () => ({ translated_text: echo }) };
      }
      if (value.includes('/translate')) {
        return { ok: true, json: async () => ({ translatedText: echo }) };
      }
      throw new Error('endpoint inatteso: ' + value);
    };
    const { freeTranslateWithRetryDetailed } = await import(${JSON.stringify(moduleUrl)});
    const result = await freeTranslateWithRetryDetailed({
      text: echo,
      sourceLang: 'it',
      targetLang: 'en',
      maxRetries: 0,
    });
    process.stdout.write(JSON.stringify(result));
  `;

  return spawnSync(process.execPath, ['--input-type=module', '--eval', childScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      AZURE_TRANSLATOR_KEY: '',
      AZURE_TRANSLATOR_KEY_2: '',
      DEEPL_API_KEY: '',
      DEEPL_API_KEY_2: '',
      GOOGLE_APPLICATION_CREDENTIALS: '',
      GSC_CLIENT_ID: '',
      GSC_CLIENT_SECRET: '',
      GSC_REFRESH_TOKEN: '',
      HF_TOKEN: '',
      HUGGINGFACE_API_KEY: '',
      LIBRETRANSLATE_SELF_HOSTED_URL: 'http://self-hosted.test/translate',
      MT_LOCAL_OPUSMT: '',
      VITEST: '1',
    },
  });
}

function runExhaustedTierSkipScenario(
  service: 'deepl' | 'azure',
  options: { myMemoryResult?: string; detailed?: boolean } = {},
) {
  const { myMemoryResult = 'traduzione di prova', detailed = false } = options;
  const modulePath = new URL('../scripts/lib/free-translate.mjs', import.meta.url).pathname;
  const myMemoryStub = `const translateWithMyMemory = async () => ${JSON.stringify(myMemoryResult)};`;
  const invoke = detailed
    ? '({ text, sourceLang, targetLang }) => freeTranslateWithRetryDetailed({ text, sourceLang, targetLang, maxRetries: 0 })'
    : '({ text, sourceLang, targetLang }, outcome) => freeTranslate({ text, sourceLang, targetLang, _outcome: outcome })';
  const resultObject = detailed
    ? '{ out: secondResult, first: firstResult, second: secondResult }'
    : '{ out: secondResult, first: firstOutcome, second: secondOutcome }';
  const childScript = `
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(${JSON.stringify(modulePath)}, 'utf8');
    const standalone = source
      .replace(
        "import { translateWithMyMemory } from './mymemory-translate.mjs';",
        ${JSON.stringify(myMemoryStub)},
      )
      .replace(
        "import { finalizeTranslatedText, maskProtectedTokens } from './translation-glossary.mjs';",
        "const finalizeTranslatedText = ({ translatedText }) => translatedText; const maskProtectedTokens = (text) => ({ text, tokens: [] });",
      )
      .replace(
        "import { translateWithLocalOpusMt, localOpusMtEnabled } from './local-opus-mt.mjs';",
        "const translateWithLocalOpusMt = async () => ''; const localOpusMtEnabled = () => false;",
      );
    globalThis.console.log = () => {};
    globalThis.console.warn = () => {};
    globalThis.fetch = async (url) => {
      const value = String(url);
      if (${JSON.stringify(service)} === 'deepl' && value.includes('api-free.deepl.com')) {
        return { ok: false, status: 456 };
      }
      if (${JSON.stringify(service)} === 'azure' && value.includes('api.cognitive.microsofttranslator.com')) {
        return { ok: false, status: 429 };
      }
      if (${detailed}) {
        const echo = ${JSON.stringify(myMemoryResult)};
        if (value.includes('translate.googleapis.com')) {
          return { ok: true, text: async () => JSON.stringify([[[echo]]]) };
        }
        if (value.includes('clients5.google.com')) {
          return { ok: true, text: async () => JSON.stringify({ sentences: [{ trans: echo }] }) };
        }
        if (value.includes('/api/v1/')) {
          return { ok: true, json: async () => ({ translation: echo }) };
        }
        if (value.includes('simplytranslate')) {
          return { ok: true, json: async () => ({ translated_text: echo }) };
        }
        if (value.includes('mozhi.')) {
          return { ok: true, json: async () => ({ 'translated-text': echo }) };
        }
        if (value.includes('translate.fedilab.app')) {
          return { ok: true, json: async () => ({ translatedText: echo }) };
        }
        if (value.includes('router.huggingface.co')) {
          return { ok: true, json: async () => [{ translation_text: echo }] };
        }
      }
      throw new Error('endpoint inatteso: ' + value);
    };
    const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(standalone).toString('base64');
    const { freeTranslate, freeTranslateWithRetryDetailed } = await import(moduleUrl);
    const invoke = ${invoke};
    const firstOutcome = { passthroughs: 0, errors: 0, incomplete: false };
    const firstResult = await invoke({ text: 'Titolo di prova', sourceLang: 'it', targetLang: 'en' }, firstOutcome);
    const secondOutcome = { passthroughs: 0, errors: 0, incomplete: false };
    const secondResult = await invoke({ text: 'Titolo di prova', sourceLang: 'it', targetLang: 'en' }, secondOutcome);
    process.stdout.write(JSON.stringify(${resultObject}));
  `;

  return spawnSync(process.execPath, ['--input-type=module', '--eval', childScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      AZURE_TRANSLATOR_KEY: service === 'azure' ? 'azure-one' : '',
      AZURE_TRANSLATOR_KEY_2: service === 'azure' ? 'azure-two' : '',
      DEEPL_API_KEY: service === 'deepl' ? 'deepl-one' : '',
      DEEPL_API_KEY_2: service === 'deepl' ? 'deepl-two' : '',
      GOOGLE_APPLICATION_CREDENTIALS: '',
      GSC_CLIENT_ID: '',
      GSC_CLIENT_SECRET: '',
      GSC_REFRESH_TOKEN: '',
      HF_TOKEN: '',
      HUGGINGFACE_API_KEY: '',
      LIBRETRANSLATE_SELF_HOSTED_URL: '',
      MT_LOCAL_OPUSMT: '',
      VITEST: '1',
    },
  });
}

function runRetryOutcomeResetScenario() {
  const modulePath = new URL('../scripts/lib/free-translate.mjs', import.meta.url).pathname;
  const signature = "export async function freeTranslate({ text, sourceLang, targetLang, fieldType = 'title', _outcome = null }) {";
  const childScript = `
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(${JSON.stringify(modulePath)}, 'utf8');
    const signature = ${JSON.stringify(signature)};
    const injected = source.replace(
      signature,
      "let retryProbeCalls = 0;\\n" + signature + "\\n" +
        "    retryProbeCalls += 1;\\n" +
        "    _outcome.passthroughs += 1;\\n" +
        "    if (retryProbeCalls === 1) _outcome.tierUnavailable = true;\\n" +
        "    return '';",
    );
    if (injected === source) throw new Error('freeTranslate signature not found');
    const standalone = injected
      .replace(
        "import { translateWithMyMemory } from './mymemory-translate.mjs';",
        "const translateWithMyMemory = async () => '';",
      )
      .replace(
        "import { finalizeTranslatedText, maskProtectedTokens } from './translation-glossary.mjs';",
        "const finalizeTranslatedText = ({ translatedText }) => translatedText; const maskProtectedTokens = (text) => ({ text, tokens: [] });",
      )
      .replace(
        "import { translateWithLocalOpusMt, localOpusMtEnabled } from './local-opus-mt.mjs';",
        "const translateWithLocalOpusMt = async () => ''; const localOpusMtEnabled = () => false;",
      );
    globalThis.console.log = () => {};
    globalThis.console.warn = () => {};
    const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(standalone).toString('base64');
    const { freeTranslateWithRetryDetailed } = await import(moduleUrl);
    const result = await freeTranslateWithRetryDetailed({
      text: 'Titolo di prova',
      sourceLang: 'it',
      targetLang: 'en',
      maxRetries: 1,
    });
    process.stdout.write(JSON.stringify(result));
  `;

  return spawnSync(process.execPath, ['--input-type=module', '--eval', childScript], {
    encoding: 'utf8',
    env: { ...process.env, VITEST: '1' },
  });
}

function runUnconfiguredTierScenario(service: 'googleCloud' | 'huggingFace') {
  const moduleUrl = new URL('../scripts/lib/free-translate.mjs', import.meta.url).href;
  const childScript = `
    const { translateWithGoogleCloud, translateWithHuggingFace } = await import(${JSON.stringify(moduleUrl)});
    const translate = ${service === 'googleCloud' ? 'translateWithGoogleCloud' : 'translateWithHuggingFace'};
    const invoke = async (text, targetLang) => {
      const outcome = { passthroughs: 0, errors: 0, incomplete: false, tierUnavailable: false };
      await translate(text, 'it', targetLang, outcome);
      return outcome;
    };
    process.stdout.write(JSON.stringify({
      empty: await invoke('', 'en'),
      sameLanguage: await invoke('Titolo di prova', 'it'),
      unavailable: await invoke('Titolo di prova', 'en'),
    }));
  `;

  return spawnSync(process.execPath, ['--input-type=module', '--eval', childScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      AZURE_TRANSLATOR_KEY: '',
      AZURE_TRANSLATOR_KEY_2: '',
      DEEPL_API_KEY: '',
      DEEPL_API_KEY_2: '',
      GSC_CLIENT_ID: '',
      GSC_CLIENT_SECRET: '',
      GSC_REFRESH_TOKEN: '',
      HF_TOKEN: '',
      HUGGINGFACE_API_KEY: '',
      VITEST: '1',
    },
  });
}

const EN = [
  '## In brief',
  '- Cross-border workers living within twenty kilometres of the border stay in the old tax regime',
  '- The forty-five day teleworking threshold applies from the first of January',
  '',
  'Anyone who started working in Switzerland after 2023 falls under the new cross-border worker rules and pays tax in both countries.',
].join('\n');

/** Delta dei contatori: sono globali di modulo e non c'e' un reset esportato. */
function statsSnapshot() {
  const s = getCascadeStats();
  return {
    hits: s.tierHits.myMemory || 0,
    passthroughs: s.tierPassthroughs.myMemory || 0,
  };
}

describe('freeTranslate — guardia «uscita == sorgente»', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(translateWithMyMemory).mockReset();
    // Ogni tier sotto MyMemory parla via `fetch` globale. Farlo fallire rende
    // il test deterministico e OFFLINE: senza, il caso "passthrough rifiutato"
    // proseguirebbe la cascata fino a LibreTranslate/HuggingFace/Mozhi e il
    // verdetto dipenderebbe da endpoint pubblici. I tier SOPRA MyMemory
    // (DeepL, Azure, Google Cloud, LT self-hosted) escono '' da soli senza
    // chiave/URL in env, quindi non serve toccarli.
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline nel test'));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('rifiuta il motore che rende la sorgente verbatim, e lo dice come passthrough non come errore', async () => {
    // IL DIFETTO: il motore risponde 200 con l'italiano d'ingresso.
    vi.mocked(translateWithMyMemory).mockResolvedValue(IT);
    const before = statsSnapshot();

    const out = await freeTranslate({ text: IT, sourceLang: 'it', targetLang: 'en', fieldType: 'description' });
    const after = statsSnapshot();

    expect(out).toBe('');
    // La RAGIONE, non solo l'esito: il tier e' contato come passthrough e NON
    // come hit. Senza questa riga il caso resterebbe verde anche con la guardia
    // rimossa dal giorno in cui i motori sono giu'.
    expect(after.passthroughs - before.passthroughs).toBe(1);
    expect(after.hits - before.hits).toBe(0);
  });

  it('rifiuta anche il passthrough con spaziatura e maiuscole cambiate (confronto normalizzato, non `===`)', async () => {
    const mangled = IT.replace(/ /g, '  ').replace('## In breve', '## IN BREVE');
    vi.mocked(translateWithMyMemory).mockResolvedValue(mangled);
    const before = statsSnapshot();

    const out = await freeTranslate({ text: IT, sourceLang: 'it', targetLang: 'de', fieldType: 'description' });

    expect(out).toBe('');
    expect(statsSnapshot().passthroughs - before.passthroughs).toBe(1);
  });

  it('conta il passthrough anche sul ramo a CHUNK, che e\' quello dei body lunghi', async () => {
    // MyMemory passa al ramo a chunk sopra i 5000 caratteri. E' il ramo dei
    // body — cioe' esattamente dei 27 passthrough misurati sul corpus — e la
    // copia locale del confronto che stava li' li consumava prima di `tryTier`:
    // il bucket non li avrebbe visti mai, e la riga `Tier passthrough` sarebbe
    // stata cieca sul caso per cui e' stata scritta.
    //
    // Sorgente su UNA riga di proposito: il ramo a chunk riassembla con
    // `parts.join(' ')`, quindi su un testo a piu' paragrafi l'uscita non e'
    // mai byte-uguale all'ingresso nemmeno quando il motore l'ha ricopiata —
    // limite dichiarato nel body della PR, non qualcosa che questo caso possa
    // pinnare fingendo il contrario.
    const frase = 'I frontalieri residenti entro venti chilometri dal confine restano nel vecchio regime fiscale e la soglia dei quarantacinque giorni di telelavoro vale dal primo gennaio. ';
    const lungo = frase.repeat(40).trim();
    expect(lungo.length).toBeGreaterThan(5000);
    vi.mocked(translateWithMyMemory).mockImplementation(async (chunk: string) => chunk);
    const before = statsSnapshot();

    const out = await freeTranslate({ text: lungo, sourceLang: 'it', targetLang: 'en', fieldType: 'description' });
    const after = statsSnapshot();

    expect(out).toBe('');
    expect(after.passthroughs - before.passthroughs).toBe(1);
    expect(after.hits - before.hits).toBe(0);
  });

  it('nomina il passthrough nel sommario della cascata', async () => {
    vi.mocked(translateWithMyMemory).mockResolvedValue(IT);
    await freeTranslate({ text: IT, sourceLang: 'it', targetLang: 'fr', fieldType: 'description' });

    const lines: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a) => { lines.push(a.join(' ')); });
    logCascadeSummary();
    logSpy.mockRestore();

    const summary = lines.join('\n');
    expect(summary).toMatch(/Tier passthrough/);
    expect(summary).toMatch(/myMemory=\d+/);
  });

  // ── IL VERSO INVERSO: cio' che NON deve cambiare ───────────────────────────

  it('lascia passare una traduzione vera e la conta come hit', async () => {
    vi.mocked(translateWithMyMemory).mockResolvedValue(EN);
    const before = statsSnapshot();

    const out = await freeTranslate({ text: IT, sourceLang: 'it', targetLang: 'en', fieldType: 'description' });
    const after = statsSnapshot();

    expect(out).toContain('cross-border workers'.split(' ')[0]);
    expect(out).not.toBe('');
    expect(after.hits - before.hits).toBe(1);
    expect(after.passthroughs - before.passthroughs).toBe(0);
  });

  it('non tocca il passthrough LEGITTIMO sourceLang === targetLang', async () => {
    const before = statsSnapshot();

    const out = await freeTranslate({ text: IT, sourceLang: 'it', targetLang: 'it', fieldType: 'description' });

    // Questo ramo esce PRIMA della cascata ed e' l'identita' voluta: renderla
    // '' spegnerebbe ogni chiamante che normalizza testo senza tradurlo.
    expect(out).toBe(IT);
    expect(translateWithMyMemory).not.toHaveBeenCalled();
    expect(statsSnapshot().passthroughs - before.passthroughs).toBe(0);
  });

  it('non spaccia un motore GIU\' per un passthrough', async () => {
    // I due esiti che valgono entrambi '' e che il chiamante deve poter
    // distinguere: qui la cascata fallisce davvero (nessun tier risponde) e il
    // bucket dei passthrough NON si deve muovere. E' il caso che si accorge di
    // una guardia troppo entusiasta, che sul solo valore di ritorno non si
    // vedrebbe: `out` e' '' in tutti e due i modi.
    vi.mocked(translateWithMyMemory).mockResolvedValue('');
    const before = statsSnapshot();

    const out = await freeTranslate({ text: IT, sourceLang: 'it', targetLang: 'en', fieldType: 'description' });
    const after = statsSnapshot();

    expect(out).toBe('');
    expect(after.passthroughs - before.passthroughs).toBe(0);
    expect(after.hits - before.hits).toBe(0);
  });

  it('non memoizza un echo quando i tier premium non sono configurati', () => {
    const child = runRealCascadeWithSelfHostedBody({ translatedText: IT });

    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ text: '', passthrough: false });
  });

  it('non riporta passthrough quando la cascata reale incontra una risposta 200 vuota', () => {
    const child = runRealCascadeWithSelfHostedBody({});

    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ text: '', passthrough: false });
  });

  it.each(['deepl', 'azure'] as const)('non marca incomplete quando tutte le chiavi %s sono gia esauste e il tier non prova alcuna chiave', (service) => {
    const child = runExhaustedTierSkipScenario(service);

    expect(child.status).toBe(0);
    const second = JSON.parse(child.stdout).second;
    expect(second).toMatchObject({ passthroughs: 0, errors: 0, incomplete: false, tierUnavailable: true });
  });

  it('non memoizza un passthrough quando DeepL ha tutte le chiavi gia esauste', () => {
    const child = runExhaustedTierSkipScenario('deepl', {
      myMemoryResult: 'Titolo di prova',
      detailed: true,
    });

    expect(child.status).toBe(0);
    const result = JSON.parse(child.stdout);
    expect(result.first).toEqual({ text: '', passthrough: false });
    expect(result.second).toEqual({ text: '', passthrough: false });
  });

  it('non memoizza un passthrough quando Azure ha tutte le chiavi gia esauste', () => {
    const child = runExhaustedTierSkipScenario('azure', {
      myMemoryResult: 'Titolo di prova',
      detailed: true,
    });

    expect(child.status).toBe(0);
    const result = JSON.parse(child.stdout);
    expect(result.first).toEqual({ text: '', passthrough: false });
    expect(result.second).toEqual({ text: '', passthrough: false });
  });

  it('propaga tierUnavailable nel merge senza perdere un flag gia presente', () => {
    const target = { passthroughs: 0, errors: 0, incomplete: false, tierUnavailable: false };

    mergeTranslationOutcome(target, { passthroughs: 0, errors: 0, incomplete: false, tierUnavailable: true });
    mergeTranslationOutcome(target, { passthroughs: 0, errors: 0, incomplete: false, tierUnavailable: false });

    expect(target.tierUnavailable).toBe(true);
  });

  it('resetta tierUnavailable tra i retry per accettare un passthrough genuino successivo', () => {
    const child = runRetryOutcomeResetScenario();

    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ text: '', passthrough: true });
  });

  it.each(['googleCloud', 'huggingFace'] as const)('marca %s non configurato senza toccare i guard input', (service) => {
    const child = runUnconfiguredTierScenario(service);

    expect(child.status).toBe(0);
    const result = JSON.parse(child.stdout);
    expect(result.empty.tierUnavailable).toBe(false);
    expect(result.sameLanguage.tierUnavailable).toBe(false);
    expect(result.unavailable.tierUnavailable).toBe(true);
  });
});

describe('isSourcePassthrough', () => {
  it('e\' vero solo quando i due testi sono lo stesso testo', () => {
    expect(isSourcePassthrough(IT, IT)).toBe(true);
    expect(isSourcePassthrough(IT, `  ${IT.toUpperCase()}  `)).toBe(true);
    expect(isSourcePassthrough(IT, EN)).toBe(false);
    expect(isSourcePassthrough(IT, `${IT} coda in piu'`)).toBe(false);
  });

  it('una sorgente vuota non e\' un passthrough', () => {
    // Altrimenti ogni chiamata con testo vuoto verrebbe contata come rifiuto e
    // il bucket direbbe che la guardia lavora dove non c'e' niente da tradurre.
    expect(isSourcePassthrough('', '')).toBe(false);
    expect(isSourcePassthrough('   ', 'qualcosa')).toBe(false);
  });
});
