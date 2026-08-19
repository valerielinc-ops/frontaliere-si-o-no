import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// _callClaudeCli spawna `node:child_process` direttamente (non fetch, a
// differenza di ogni altro provider): mockarlo e' l'unico modo di far scattare
// il ramo di timeout senza aspettare due minuti un `claude` vero.
const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

import { AI_MODELS, callLLM, getRunOutcomes, getScoreBoard, resetState } from '../../scripts/lib/ai-models.mjs';

/**
 * Il minimo per-chiamata del CLI, LETTO DAL SORGENTE e non ricopiato.
 *
 * Questi test avanzano timer finti, quindi hanno bisogno di un numero — ma
 * fissarlo come letterale li lega a una taratura. E' gia' costato: erano
 * inchiodati a `120_000` e sono diventati rossi appena il minimo si e' mosso,
 * senza che la proprieta' sotto test fosse cambiata di una virgola. Derivarlo
 * qui li rende asserzioni sull'ORDINE (la chiamata scade quando scade il
 * minimo) invece che sul valore.
 *
 * Nota: `chiama()` non passa `deadlineMs`, quindi il ramo che fa crescere il
 * timeout dentro l'allowance residua non si attiva e il tempo concesso e'
 * esattamente questo minimo.
 */
const AI_MODELS_SRC = readFileSync(
  new URL('../../scripts/lib/ai-models.mjs', import.meta.url),
  'utf-8',
);
const FLOOR_MS = Number(
  /const CLAUDE_CLI_MIN_TIMEOUT_MS = ([\d_]+);/.exec(AI_MODELS_SRC)![1].replace(/_/g, ''),
);


/**
 * ── «0 BYTE A 120s» NON ERA UNA DIAGNOSI ────────────────────────────────────
 *
 * `claude-cli/haiku` e' il modello a pagamento preferito e primo nella cascata
 * di generazione articoli. In produzione non e' MAI riuscito, nemmeno una volta
 * (corpus PR #438: «0 successi»), e ogni tentativo finiva identico:
 *
 *     ❌ [claude-cli/haiku] Failed: claude CLI timed out after 120000ms
 *        — stdout: 0 bytes (nessun byte scritto dal processo)
 *
 * Il conteggio dei byte era stato aggiunto proprio per separare «generava
 * lentamente» da «non ha mai scritto». Non poteva funzionare: con
 * `--output-format json` la CLI non scrive niente su stdout finche' non ha
 * finito — primo byte a 8442ms su una chiamata che chiude a 8995ms (CLI 2.1.234,
 * argomenti esatti di produzione, misurato il 2026-08-18). «0 byte» era il
 * comportamento normale di una chiamata sana fino all'ultimo istante.
 *
 * Con `--output-format stream-json --verbose` lo stdout diventa JSONL, il primo
 * byte arriva a 942ms, e il timeout puo' dire DOVE si e' fermato. Questo file e'
 * l'osservatore end-to-end di quella proprieta': i test unitari del tracciatore
 * stanno nel gemello del corpus
 * (`generator/tests/claude-cli-stream-json-diagnostica.test.mjs`), qui si prova
 * che il PROCESSO lo usi davvero — parsing incluso, che e' il pezzo che romperebbe
 * ogni chiamata riuscita se sbagliato.
 *
 * NOTA SULLO SCOPO: questa suite non prova che il difetto sia riparato, perche'
 * la PR non lo ripara — lo rende misurabile. Floor, semaforo e soglia del breaker
 * restano quelli che sono, deliberatamente: tre tentativi alla cieca su quelle
 * leve sono gia' stati spesi senza un dato su cui puntare.
 */
describe('claude CLI: il flusso stream-json rende diagnosticabile il timeout', () => {
  const ENV_KEYS = ['ENABLE_HAIKU_ARTICLE_FALLBACK', 'CLAUDE_CODE_OAUTH_TOKEN', 'LOCAL_LLM_ENABLED', 'AI_COMPETING_TIERS'] as const;
  const saved: Record<string, string | undefined> = {};

  /** Un `claude` finto che emette i chunk dati e poi chiude con `code`. */
  function cliChe(chunks: string[], code = 0) {
    return () => {
      const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
      const stdoutListeners: Record<string, ((...args: unknown[]) => void)[]> = {};
      const child = {
        stdout: { on: (ev: string, cb: (...args: unknown[]) => void) => { (stdoutListeners[ev] ||= []).push(cb); } },
        stderr: { on: (_ev: string, _cb: (...args: unknown[]) => void) => {} },
        on: (ev: string, cb: (...args: unknown[]) => void) => { (listeners[ev] ||= []).push(cb); },
        kill: vi.fn(),
      };
      queueMicrotask(() => {
        for (const c of chunks) stdoutListeners.data?.forEach((cb) => cb(Buffer.from(c)));
        listeners.close?.forEach((cb) => cb(code));
      });
      return child;
    };
  }

  /**
   * Un `claude` che scrive i chunk dati e poi NON chiude mai: e' la forma di
   * ogni incidente di produzione, un processo che resta appeso fino al SIGKILL.
   * I chunk vengono consegnati con timer finti, quindi l'istante in cui
   * arrivano e' quello che il messaggio deve poi riportare.
   */
  function cliAppesoDopo(eventi: Array<{ dopoMs: number; riga: string }>) {
    return () => {
      const stdoutListeners: Record<string, ((...args: unknown[]) => void)[]> = {};
      let trascorso = 0;
      for (const e of eventi) {
        trascorso += e.dopoMs;
        setTimeout(() => { stdoutListeners.data?.forEach((cb) => cb(Buffer.from(e.riga))); }, trascorso);
      }
      return {
        stdout: { on: (ev: string, cb: (...args: unknown[]) => void) => { (stdoutListeners[ev] ||= []).push(cb); } },
        stderr: { on: () => {} },
        on: () => {}, // non fira mai 'close': subprocess appeso
        kill: vi.fn(),
      };
    };
  }

  const INIT = `${JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' })}\n`;
  const ASSISTANT = `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } })}\n`;

  /**
   * Un `assistant` che NON porta niente di recuperabile: solo un blocco
   * `thinking`.
   *
   * Serve da quando il timeout salva il payload gia' arrivato invece di
   * buttarlo (vedi l'ultimo describe di questo file). Prima bastava un
   * `assistant` qualunque per provare la diagnostica, perche' qualunque
   * `assistant` finiva comunque in errore; ora un blocco `text` non vuoto e'
   * contenuto valido, e usarlo qui proverebbe l'opposto di cio' che il test
   * dice. La forma qui sotto e' quella vera dei timeout di produzione sotto
   * `--json-schema`: thinking + tool_use, con `textlen: 0` su ogni evento, e
   * il SIGKILL che cade prima del primo tool_use completo.
   */
  const ASSISTANT_PENSIERO = `${JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'thinking', thinking: 'sto pensando' }] },
  })}\n`;

  /** Un `assistant` che chiude un `tool_use` StructuredOutput: il canale vero. */
  const assistantStrutturato = (input: unknown) => `${JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'StructuredOutput', input }] },
  })}\n`;
  const RATE_LIMIT = `${JSON.stringify({
    type: 'rate_limit_event',
    rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1787066400 },
  })}\n`;

  beforeEach(() => {
    resetState();
    spawnMock.mockReset();
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.ENABLE_HAIKU_ARTICLE_FALLBACK = '1';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token';
    delete process.env.LOCAL_LLM_ENABLED;
    delete process.env.AI_COMPETING_TIERS;
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    resetState();
    vi.useRealTimers();
  });

  const chiama = () => callLLM(
    [{ role: 'user', content: 'Scrivi un articolo' }],
    { model: AI_MODELS.CLAUDE_CLI_HAIKU, chain: [AI_MODELS.CLAUDE_CLI_HAIKU] },
  );

  describe('argomenti', () => {
    it('chiede stream-json con --verbose, non piu\' il json cieco', async () => {
      spawnMock.mockImplementation(cliChe([
        INIT,
        `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'CORPO' })}\n`,
      ]));

      await chiama();

      const [, args] = spawnMock.mock.calls[0] as [string, string[]];
      const i = args.indexOf('--output-format');
      expect(args[i + 1]).toBe('stream-json');
      // `--verbose` non e' cosmetico: sotto `-p` e' quello che fa emettere gli
      // eventi. Senza, stream-json non produce il flusso e siamo daccapo.
      expect(args).toContain('--verbose');
    });
  });

  describe('parsing JSONL', () => {
    it('legge il risultato dalla riga type:"result", non dall\'intero stdout', async () => {
      spawnMock.mockImplementation(cliChe([
        INIT,
        ASSISTANT,
        `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'CORPO-ARTICOLO' })}\n`,
      ]));

      await expect(chiama()).resolves.toBe('CORPO-ARTICOLO');
    });

    it('una riga spezzata fra due chunk non fa fallire la chiamata', async () => {
      // Il caso che romperebbe un parser riga-per-chunk: `data` non ha alcun
      // obbligo di consegnare righe intere.
      const riga = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'SPEZZATO' });
      const meta = Math.floor(riga.length / 2);
      spawnMock.mockImplementation(cliChe([INIT + riga.slice(0, meta), `${riga.slice(meta)}\n`]));

      await expect(chiama()).resolves.toBe('SPEZZATO');
    });

    it('l\'ultima riga senza \\n finale viene comunque letta', async () => {
      // Senza il flush alla chiusura, ogni chiamata riuscita passerebbe per
      // fallita — e' il modo piu' facile di rompere il provider "riparandolo".
      spawnMock.mockImplementation(cliChe([
        JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'SENZA-NEWLINE' }),
      ]));

      await expect(chiama()).resolves.toBe('SENZA-NEWLINE');
    });

    it('l\'envelope di errore resta un fallimento (nessun successo silenzioso)', async () => {
      spawnMock.mockImplementation(cliChe([
        `${JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'model not found' })}\n`,
      ], 1));

      await expect(chiama()).rejects.toThrow(/model not found/);
    });

    it('un\'uscita senza evento result e senza niente di recuperabile non passa per successo, e lo dice', async () => {
      // `ASSISTANT_PENSIERO` e non un `assistant` con testo: da quando il
      // payload gia' arrivato viene salvato, un blocco `text` non vuoto E'
      // un risultato: vedi il test gemello nell'ultimo describe.
      spawnMock.mockImplementation(cliChe([INIT, ASSISTANT_PENSIERO]));

      await expect(chiama()).rejects.toThrow(/senza evento result/);
    });
  });

  describe('il messaggio di timeout dice DOVE si e\' fermato', () => {
    // `toFake` ristretto e NON il default: faking anche `Date`/`performance`
    // appende questa suite in locale (misurato: le 4 prove di timeout di
    // `ai-models-claude-cli-fallback.test.ts` scadono a 15000ms su questa
    // macchina, identicamente con e senza le modifiche di questa PR, mentre in
    // CI passano). E' lo stesso `toFake` esplicito che
    // `ai-models-hard-call-cap.test.ts` usa da prima, per la stessa ragione.
    // Conseguenza voluta: qui l'orologio e' reale, quindi si asserisce QUALE
    // evento e che un tempo ci sia; i millisecondi esatti sono provati con un
    // orologio iniettato nei test unitari gemelli del corpus.
    beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }); });

    it('«nessun evento»: la CLI non e\' mai partita', async () => {
      // Zero byte e stderr vuoto. Prima diceva solo «0 bytes», che una
      // chiamata sana produce comunque fino a 8442ms su 8995ms — cioe' non
      // diceva niente.
      //
      // E infatti non diceva niente: col floor a 120s la produzione riportava
      // «0 bytes» su OGNI timeout, e la diagnostica di questo file ha poi
      // mostrato che erano chiamate a 71-84 KB ferme dopo `assistant` (run
      // 32161215947). Il caso qui sotto — CLI davvero mai partita — resta reale
      // ma non e' piu' la firma comune: e' quello che «0 bytes» confondeva con
      // gli altri due.
      spawnMock.mockImplementation(cliAppesoDopo([]));

      const promise = chiama();
      const assertion = expect(promise).rejects.toThrow(/nessun evento \(il CLI non ne ha scritto uno solo/);
      await vi.advanceTimersByTimeAsync(FLOOR_MS);
      await assertion;
    });

    it('«fermo dopo system/init a 942ms»: stallo a valle dell\'avvio', async () => {
      spawnMock.mockImplementation(cliAppesoDopo([{ dopoMs: 942, riga: INIT }]));

      const promise = chiama();
      const assertion = expect(promise).rejects.toThrow(/fermo dopo system\/init a \d+ms/);
      await vi.advanceTimersByTimeAsync(FLOOR_MS);
      await assertion;
    });

    it('«fermo dopo assistant»: la risposta arrivava, era solo lenta', async () => {
      // L'unico dei tre casi in cui alzare il floor sarebbe il rimedio giusto.
      spawnMock.mockImplementation(cliAppesoDopo([
        { dopoMs: 942, riga: INIT },
        { dopoMs: 4123, riga: ASSISTANT_PENSIERO },
      ]));

      const promise = chiama();
      const assertion = expect(promise).rejects.toThrow(/fermo dopo assistant a \d+ms/);
      await vi.advanceTimersByTimeAsync(FLOOR_MS);
      await assertion;
    });

    it('un rate_limit_event e\' riportato esplicitamente nel messaggio', async () => {
      // Candidato causale forte e oggi invisibile: lo stesso
      // CLAUDE_CODE_OAUTH_TOKEN di Max plan e' condiviso con pr-review-loop,
      // issue-fix e il redflag-fixer, quindi un limite di sessione spiegherebbe
      // esattamente «funziona in locale, mai in CI».
      spawnMock.mockImplementation(cliAppesoDopo([
        { dopoMs: 942, riga: INIT },
        { dopoMs: 3067, riga: RATE_LIMIT },
      ]));

      const promise = chiama();
      const assertion = expect(promise).rejects.toThrow(/rate_limit_event a \d+ms \(status=rejected, tipo=five_hour\)/);
      await vi.advanceTimersByTimeAsync(FLOOR_MS);
      await assertion;
    });

    it('quando il rate_limit_event NON c\'e\', il messaggio lo dice comunque', async () => {
      // Un campo che appare solo quando c'e' qualcosa costringe chi legge il
      // prossimo incidente a distinguere «non e' successo» da «non lo
      // guardavamo»: e' la stessa ambiguita' che ha reso illeggibili i tre
      // incidenti precedenti.
      spawnMock.mockImplementation(cliAppesoDopo([{ dopoMs: 942, riga: INIT }]));

      const promise = chiama();
      const assertion = expect(promise).rejects.toThrow(/nessun rate_limit_event/);
      await vi.advanceTimersByTimeAsync(FLOOR_MS);
      await assertion;
    });

    it('il conteggio dei byte di stdout resta: la meta\' che gia\' c\'era non si perde', async () => {
      spawnMock.mockImplementation(cliAppesoDopo([]));

      const promise = chiama();
      const assertion = expect(promise).rejects.toThrow(/stdout: 0 bytes \(nessun byte scritto dal processo\)/);
      await vi.advanceTimersByTimeAsync(FLOOR_MS);
      await assertion;
    });

    it('la forma «timed out after Nms» non cambia: e\' cio\' su cui si grep-a lo storico', async () => {
      spawnMock.mockImplementation(cliAppesoDopo([]));

      const promise = chiama();
      const assertion = expect(promise).rejects.toThrow(/claude CLI timed out after \d+ms/);
      await vi.advanceTimersByTimeAsync(FLOOR_MS);
      await assertion;
    });
  });

  /**
   * ── IL PAYLOAD GIA' PAGATO NON SI BUTTA ─────────────────────────────────
   *
   * La diagnostica dei describe qui sopra ha portato alla causa vera, che non
   * era ne' il floor ne' il semaforo: con `--json-schema` la CLI espone un
   * tool sintetico `StructuredOutput` — lo dichiara in `system/init` anche con
   * `--tools ''` — ne valida l'input LOCALMENTE, e se manca una proprieta'
   * `required` risponde con un `tool_result` `is_error: true`
   * («Output does not match required schema: root: must have required property
   * 'reason'»). Il modello allora rigenera l'articolo DA CAPO. Ogni giro costa
   * ~3m30s e ~6800 token di output; il SIGKILL cade a meta' di un giro
   * qualunque. I 224-288 eventi e i 110-160 KB di stdout che i timeout di
   * produzione mostravano sono N giri di quell'anello — riprodotto con la CLI
   * 2.1.235 e gli argomenti esatti di produzione il 2026-08-18.
   *
   * L'anello non e' limitabile da qui: quella versione della CLI non ha
   * `--max-turns` (verificato). Quindi il rimedio non e' fermare l'anello ma
   * non buttare via cio' che ha gia' prodotto: nella riproduzione il tentativo
   * rifiutato era un articolo completo e pubblicabile, a cui mancava solo
   * `reason` — che lo schema ammette null.
   *
   * LA TRAPPOLA, ed e' la ragione per cui questi test esistono: il contenuto
   * NON sta nei blocchi `text`. Sotto `--json-schema` ogni evento `assistant`
   * di produzione ha `textlen: 0` e porta il payload dentro `tool_use.input`.
   * Un salvataggio che concatena i `text` recupera stringa vuota su ogni
   * chiamata reale, e lo fa in silenzio: sembra funzionare in test e non
   * recupera mai niente in produzione.
   *
   * I test unitari del collettore stanno nel gemello del corpus
   * (`generator/tests/claude-cli-stream-salvage.test.mjs`, gia' dentro con
   * nanako#483). Qui si prova che il PROCESSO lo usi davvero, capo a capo.
   */
  describe('il payload gia\' arrivato viene usato invece di essere scartato', () => {
    const ARTICOLO = {
      title: 'Frontalieri, la nuova soglia',
      body: 'Testo lungo e completo dell\'articolo.',
      slug: 'frontalieri-nuova-soglia',
    };

    describe('quando il processo resta appeso fino al SIGKILL', () => {
      beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }); });

      it('un tool_use StructuredOutput completo diventa il risultato della chiamata', async () => {
        // Il caso di produzione: N giri dell\'anello, il primo tentativo e\'
        // buono, il timeout cade prima del `result`. Prima questa chiamata
        // buttava via l\'articolo intero e tornava un errore.
        spawnMock.mockImplementation(cliAppesoDopo([
          { dopoMs: 942, riga: INIT },
          { dopoMs: 4123, riga: ASSISTANT_PENSIERO },
          { dopoMs: 2100, riga: assistantStrutturato(ARTICOLO) },
        ]));

        const promise = chiama();
        await vi.advanceTimersByTimeAsync(FLOOR_MS);

        expect(JSON.parse(await promise)).toEqual(ARTICOLO);
      });

      it('fra piu\' tentativi di schema vince l\'ultimo, non il primo', async () => {
        // L\'anello rigenera perche\' il tentativo precedente e\' stato
        // rifiutato: tenere il piu\' vecchio significherebbe scegliere
        // deliberatamente quello che la CLI ha gia\' bocciato.
        const primo = { ...ARTICOLO, title: 'BOZZA RIFIUTATA' };
        spawnMock.mockImplementation(cliAppesoDopo([
          { dopoMs: 942, riga: INIT },
          { dopoMs: 3000, riga: assistantStrutturato(primo) },
          { dopoMs: 3000, riga: assistantStrutturato(ARTICOLO) },
        ]));

        const promise = chiama();
        await vi.advanceTimersByTimeAsync(FLOOR_MS);

        expect(JSON.parse(await promise).title).toBe(ARTICOLO.title);
      });

      it('senza schema il canale e\' il testo, e un testo intero viene usato', async () => {
        spawnMock.mockImplementation(cliAppesoDopo([
          { dopoMs: 942, riga: INIT },
          { dopoMs: 4123, riga: `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Prima meta\'. ' }] } })}\n` },
          { dopoMs: 1000, riga: `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Seconda meta\'.' }] } })}\n` },
        ]));

        const promise = chiama();
        await vi.advanceTimersByTimeAsync(FLOOR_MS);

        await expect(promise).resolves.toBe('Prima meta\'. Seconda meta\'.');
      });

      it('un JSON troncato a meta\' NON viene spacciato per risultato', async () => {
        // La differenza fra recuperare e indovinare. I blocchi `tool_use`
        // arrivano solo interi, quindi il ramo strutturato e\' sicuro per
        // costruzione; il testo no, e un oggetto tagliato a meta\' e\' l\'unico
        // caso in cui si riconosce con certezza che manca qualcosa.
        spawnMock.mockImplementation(cliAppesoDopo([
          { dopoMs: 942, riga: INIT },
          { dopoMs: 4123, riga: `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '{"title":"Frontalieri","bo' }] } })}\n` },
        ]));

        const promise = chiama();
        const assertion = expect(promise).rejects.toThrow(/timed out after/);
        await vi.advanceTimersByTimeAsync(FLOOR_MS);
        await assertion;
      });

      it('un guasto di trasporto non abbassa il punteggio del modello, ma resta contato', async () => {
        // `claude-cli/haiku` e\' il modello a pagamento che deve funzionare
        // sempre. Nove timeout consecutivi lo avevano portato a -356: un
        // punteggio che descriveva il trasporto, non la qualita\' delle sue
        // risposte, e che lo spingeva in fondo alla cascata. E\' la stessa
        // scelta che il ramo `topic-gate-abort` fa gia\' deliberatamente.
        //
        // «Non punire» non vuol dire «non guardare»: il fallimento resta nel
        // conteggio della run, altrimenti il registro direbbe 0 errori mentre
        // il modello sta fallendo a ogni chiamata.
        spawnMock.mockImplementation(cliAppesoDopo([{ dopoMs: 942, riga: INIT }]));

        const promise = chiama();
        const assertion = expect(promise).rejects.toThrow(/timed out after/);
        await vi.advanceTimersByTimeAsync(FLOOR_MS);
        await assertion;

        const voce = getScoreBoard().find((v) => v.model === AI_MODELS.CLAUDE_CLI_HAIKU);
        expect(voce === undefined || voce.score === 0).toBe(true);

        const esito = getRunOutcomes().find((v) => v.model === AI_MODELS.CLAUDE_CLI_HAIKU);
        expect(esito?.failures).toBe(1);
      });
    });

    it('anche un\'uscita pulita senza evento result recupera il payload strutturato', async () => {
      // Stessa perdita, altra porta: il processo termina invece di restare
      // appeso, ma il contenuto era gia\' arrivato lo stesso.
      spawnMock.mockImplementation(cliChe([INIT, assistantStrutturato(ARTICOLO)], 0));

      expect(JSON.parse(await chiama())).toEqual(ARTICOLO);
    });
  });

});
