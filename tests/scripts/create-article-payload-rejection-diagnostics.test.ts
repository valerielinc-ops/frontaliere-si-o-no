/**
 * ── IL RIGETTO CHE NON SI POTEVA ATTRIBUIRE (issue #6027) ───────────────────
 *
 * `scripts/create-article.mjs` rigetta la generazione e riprova fino a 5
 * volte quando `normalizeItalianContentFromPayload()` torna `null`. Il
 * messaggio che finisce nel log era sempre lo stesso:
 *
 *     ⚠️  output JSON incompleto: content.it non normalizzabile (tentativo 1/5)
 *
 * La diagnostica che direbbe COSA e' arrivato — `🔎 JSON parse fallito` /
 * `📄 describeRawForDiagnostics(result)` — stava dietro una guardia
 * `if (parseErr)`. Quando `JSON.parse` riesce e a tornare `null` e' il
 * normalizzatore, il caso restava muto: sul gemello del corpus
 * (`frontaliere-articles/generator/scripts/create-article.mjs`, stessa
 * guardia) e' stato misurato che 49 rigetti su 64 raccolti dai log sono
 * "non normalizzabile", e nella run che ha speso il 76% dello step in
 * rigenerazioni erano muti 4 su 4.
 *
 * QUESTO TEST E' L'OSSERVATORE. Non prova che il rigetto sia sparito: prova
 * che al PROSSIMO incidente si potra' dire quale famiglia e' — output
 * troncato (leva: maxTokens) vs forma sbagliata (leva: prompt/normalizzatore)
 * — senza riprodurlo. Se la diagnostica torna dietro `if (parseErr)`, il
 * test qui sotto diventa rosso.
 *
 * `publish-journalist-article` importa `create-article.mjs` e gira ogni 15
 * minuti: questo percorso e' vivo, non codice morto (vedi CLAUDE.md della
 * root, "Il gemello create-article del sito e' vivo").
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  classifyTruncation,
  describePayloadRejection,
} from '../../scripts/lib/llm-payload-diagnostics.mjs';
import { findMatchingClose, fixJsonStringBody, stripCodeFences } from '../../scripts/lib/llm-json-repair.mjs';

const ROOT = path.resolve(__dirname, '../..');
const SRC = fs.readFileSync(path.join(ROOT, 'scripts/create-article.mjs'), 'utf-8');

/**
 * Il documento che il modello DOVEVA mandare, nella stessa forma che il
 * gemello del corpus usa per riprodurre l'incidente misurato in produzione:
 * metadati, `imageAlt` con i 4 locali, `slugs`, poi `content.it`.
 */
function documentoSano(body = 'Un paragrafo di corpo abbastanza lungo da superare la soglia dei quaranta caratteri.') {
  return `{
  "id": "vivere-oggebbio-lavorare-ticino-frontalieri",
  "category": "pratico",
  "image": "lugano-view.webp",
  "hasCalculator": true,
  "imagePrompt": "Un giornalista fotografisce la vista di Lugano dalla collina.",
  "imageAlt": {
    "it": "Una vista di Lugano dalla collina.",
    "en": "A view of Lugano from the hill.",
    "de": "Eine Aussicht auf Lugano vom Hügel.",
    "fr": "Une vue de Lugano depuis la colline."
  },
  "slugs": {
    "it": "a", "en": "b", "de": "c", "fr": "d"
  },
  "content": {
    "it": {
      "title": "Vivere a Oggebbio e lavorare in Ticino da frontaliere",
      "excerpt": "Il nuovo Accordo Frontalieri ha cambiato le regole per chi lavora in Ticino.",
      "body1": ${JSON.stringify(body)},
      "body2": ${JSON.stringify(body)},
      "body3": ${JSON.stringify(body)}
    }
  }
}`;
}

/** `repairLlmJson()` di scripts/create-article.mjs, ricopiato: la' non e' esportata. */
function repairLike(raw: string): string {
  let c = stripCodeFences(raw);
  const start = c.indexOf('{');
  if (start !== -1) {
    const closeIdx = findMatchingClose(c, start, true);
    if (closeIdx !== -1) c = c.slice(start, closeIdx + 1);
    else {
      const end = c.lastIndexOf('}');
      if (end > start) c = c.slice(start, end + 1);
    }
  }
  return fixJsonStringBody(c, { fixAsterisks: true })
    .replace(/,(\s*,)+/g, ',')
    .replace(/,(\s*[}\]])/g, '$1');
}

/** Il giro completo del ramo `isBody2Check`: repair → parse → diagnostica. */
function diagnostica(raw: string, model: string | null = 'nvidia/meta/llama-3.1-8b-instruct'): string {
  const repaired = repairLike(raw);
  let parsed;
  let parseErr: Error | null = null;
  try {
    parsed = JSON.parse(repaired);
  } catch (e) {
    parseErr = e as Error;
  }
  return describePayloadRejection({ raw, repaired, parsed, parseErr, model });
}

describe('classifyTruncation distingue un documento chiuso da uno tagliato a meta\'', () => {
  it('un documento chiuso non e\' troncato', () => {
    const t = classifyTruncation(documentoSano());
    expect(t.troncato).toBe(false);
    expect(t.chiude).toBe(true);
    expect(t.profondita).toBe(0);
    expect(t.inStringa).toBe(false);
  });

  it('una completion tagliata a meta\' frase e\' troncata', () => {
    const raw = documentoSano().slice(0, 900);
    const t = classifyTruncation(raw);
    expect(t.troncato, 'un testo che non finisce con una graffa deve risultare troncato').toBe(true);
    expect(t.profondita, `profondita attesa > 0, ottenuta ${t.profondita}`).toBeGreaterThan(0);
    expect(t.coda.length, 'la coda serve a far vedere DOVE si e\' fermato').toBeGreaterThan(0);
  });

  it('la graffa di chiusura vale anche dietro un code fence', () => {
    expect(classifyTruncation('{"a":1}\n```').troncato).toBe(false);
  });
});

describe('la riga di rigetto attribuisce la famiglia senza riprodurre l\'incidente', () => {
  it('output troncato → famiglia=troncato, e dice quanto il repair ha buttato via', () => {
    const raw = documentoSano('Il Nuovo Accordo Frontalieri ha modificato le regole. '.repeat(40)).slice(0, 900);
    const riga = diagnostica(raw);

    expect(riga).toMatch(/famiglia=troncato/);
    expect(riga).toMatch(/chiudeConGraffa=no/);

    const kept = Number(/kept=([\d.]+)%/.exec(riga)?.[1]);
    expect(Number.isFinite(kept), `kept= assente dalla riga: ${riga}`).toBe(true);
    expect(kept, `il ritaglio ha buttato via meta' documento e kept= non lo dice (${kept}%)`).toBeLessThan(100);
  });

  it('JSON valido ma senza i campi → famiglia=forma-sbagliata(chiavi), NON troncato', () => {
    // Il caso muto: JSON.parse riesce, il normalizzatore torna null. E'
    // esattamente cio' che un troncamento NON puo' produrre.
    const riga = diagnostica('{"articolo": {"content": {"it": {"titolo": "x"}}}}');
    expect(riga).toMatch(/famiglia=forma-sbagliata\(chiavi\)/);
    expect(riga).toMatch(/parse=ok/);
    expect(riga).toMatch(/chiaviRadice=\[articolo\]/);
  });

  it('campi presenti ma vuoti → li distingue da campi assenti', () => {
    const riga = diagnostica('{"content": {"it": {"title": "", "excerpt": "ok", "body1": 3}}}');
    expect(riga).toMatch(/title:vuoto/);
    expect(riga).toMatch(/excerpt:2ch/);
    expect(riga).toMatch(/body1:nonstringa\(number\)/);
    expect(riga).toMatch(/body2:assente/);
  });

  it('ogni campo c\'e\' sempre, anche a zero', () => {
    const riga = diagnostica('', null);
    for (const campo of [
      'famiglia=', 'model=', 'rawChars=', 'repairedChars=', 'kept=', 'parse=',
      'tipo=', 'chiaviRadice=', 'chiaviContent=', 'chiaviIt=', 'campiIt=',
      'campiRadice=', 'chiudeConGraffa=', 'profondita=', 'inStringa=', 'coda=',
    ]) {
      expect(riga.includes(campo), `campo ${campo} assente su input vuoto: ${riga}`).toBe(true);
    }
    expect(riga).toMatch(/model=sconosciuto/);
  });

  it('nomina il modello che ha DAVVERO risposto', () => {
    expect(diagnostica('{}', 'nvidia/meta/llama-3.1-8b-instruct')).toMatch(/model=nvidia\/meta\/llama-3\.1-8b-instruct/);
  });
});

describe('il ramo di rigetto di scripts/create-article.mjs resta parlante', () => {
  /** Il blocco `if (!itContent) { … }`, ritagliato dal sorgente. */
  function ramoNonNormalizzabile(): string {
    const a = SRC.indexOf("missing.push('content.it non normalizzabile');");
    expect(a, 'ancora iniziale non trovata — aggiornare questo test').not.toBe(-1);
    const b = SRC.indexOf('      } else {', a);
    expect(b, 'ancora finale non trovata — aggiornare questo test').not.toBe(-1);
    const blocco = SRC.slice(a, b);
    expect(blocco.length, `ritaglio troppo corto (${blocco.length}) — ancore sbagliate`).toBeGreaterThan(200);
    return blocco;
  }

  it('la diagnostica del rigetto e\' incondizionata, non dietro `if (parseErr)`', () => {
    // QUESTO E' IL TEST CHE CHIUDE #6027: prima della fix `describePayloadRejection(`
    // compariva SOLO dentro `if (parseErr) { ... }`, quindi il caso muto
    // (JSON.parse riuscito, normalizzatore a null — la maggioranza) non
    // chiamava mai la diagnostica. Rosso prima della fix, verde dopo.
    const blocco = ramoNonNormalizzabile();
    const chiamata = blocco.indexOf('describePayloadRejection(');
    expect(chiamata, 'il ramo non chiama describePayloadRejection: il caso muto torna muto').not.toBe(-1);
    const guardia = blocco.indexOf('if (parseErr) {');
    expect(
      guardia === -1 || chiamata < guardia,
      'describePayloadRejection e\' finita dentro `if (parseErr)`: e\' esattamente il difetto '
        + 'che rendeva muta la maggioranza dei rigetti "content.it non normalizzabile"',
    ).toBe(true);
  });

  it('il raw viene sempre allegato, non solo quando il parse fallisce', () => {
    const blocco = ramoNonNormalizzabile();
    const raw = blocco.indexOf('describeRawForDiagnostics(result)');
    expect(raw, 'il ramo non allega piu\' il raw').not.toBe(-1);
    const guardia = blocco.indexOf('if (parseErr) {');
    expect(
      guardia === -1 || raw > blocco.indexOf('}', guardia),
      'il raw e\' tornato dentro `if (parseErr)`: senza di lui la famiglia del caso muto resta indecidibile',
    ).toBe(true);
  });

  it('anche il ramo «campi mancanti» dice modello e lunghezza', () => {
    const a = SRC.indexOf('output JSON incompleto: ${missing.join');
    expect(a, 'ancora non trovata — aggiornare questo test').not.toBe(-1);
    const blocco = SRC.slice(a, a + 1500);
    expect(
      blocco.includes('describePayloadRejection('),
      '`body1, body2, body3` senza modello ne\' lunghezza e\' compatibile sia con un troncamento '
        + 'sia con un involucro di troppo',
    ).toBe(true);
  });
});
