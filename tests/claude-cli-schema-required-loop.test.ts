/**
 * ── L'ANELLO DI RIGENERAZIONE DIETRO I «TIMEOUT» DEL CLI ────────────────────
 *
 * Sotto `--json-schema` il CLI valida in LOCALE la chiamata a `StructuredOutput`.
 * Una prop `required` mancante non degrada: torna un `tool_result` d'errore
 * («root: must have required property 'reason'») e il modello rigenera
 * l'articolo intero, ~3m30s e ~6.800 token per giro.
 *
 * Lo schema `article_primary_locale` dichiara *ogni* prop `required` e nullable
 * — idioma obbligatorio per lo strict mode di OpenAI, letale per il validatore
 * del CLI, perche' il modello che scrive un articolo pieno non ha nessun motivo
 * di emettere `"reason": null`.
 *
 * META' SITO di nanako#487. Il gemello `scripts/lib/ai-models.mjs` e' dichiarato
 * `identical` nel manifest e alimenta `publish-journalist-article`, che gira ogni
 * 15 minuti: la guardia messa solo sul corpus non protegge quel percorso. Il
 * PORT non e' una copia — il corpus gira su `node --test`, qui e' vitest — ma le
 * 13 asserzioni sono le stesse, una per una.
 *
 * Questi test difendono le due meta' della fix:
 *   1. cade il `required` dove non poteva enforce-are niente (prop nullable);
 *   2. resta il `required` dove enforce-a davvero (body1/body2/body3 & co.),
 *      che e' l'unica ragione per cui lo schema esiste.
 *
 * E difendono la PRECONDIZIONE della correttezza: che per chi legge il payload
 * `undefined` e `null` siano la stessa cosa. Se quel codice cambiasse, la
 * rilassatura smetterebbe di essere lossless e questo test lo direbbe.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// @ts-expect-error — ai-models.mjs e' JS senza dichiarazioni di tipo
import { relaxSchemaForClaudeCli } from '../scripts/lib/ai-models.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.resolve(HERE, '../scripts/lib/ai-models.mjs'), 'utf-8');
const CREATE_ARTICLE = readFileSync(path.resolve(HERE, '../scripts/create-article.mjs'), 'utf-8');

/** Lo schema 'full' come lo costruisce create-article.mjs (stessa forma). */
function schemaFull(): any {
  const nullableString = { type: ['string', 'null'] };
  const nullableBoolean = { type: ['boolean', 'null'] };
  const localeStringRecord = {
    type: ['object', 'null'],
    additionalProperties: false,
    required: ['it', 'en', 'de', 'fr'],
    properties: { it: { type: 'string' }, en: { type: 'string' }, de: { type: 'string' }, fr: { type: 'string' } },
  };
  const contentBlock = {
    type: ['object', 'null'],
    additionalProperties: false,
    required: ['title', 'excerpt', 'body1', 'body2', 'body3', 'faq'],
    properties: {
      title: { type: 'string' },
      excerpt: { type: 'string' },
      body1: { type: 'string' },
      body2: { type: 'string' },
      body3: { type: 'string' },
      faq: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['q', 'a'],
          properties: { q: { type: 'string' }, a: { type: 'string' } },
        },
      },
    },
  };
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'id', 'category', 'image', 'hasCalculator', 'imagePrompt',
      'imageAlt', 'slugs', 'content', 'seo', 'abort_topical_relevance', 'reason',
    ],
    properties: {
      id: nullableString,
      category: nullableString,
      image: nullableString,
      hasCalculator: nullableBoolean,
      imagePrompt: nullableString,
      imageAlt: localeStringRecord,
      slugs: localeStringRecord,
      content: {
        type: ['object', 'null'],
        additionalProperties: false,
        required: ['it'],
        properties: { it: contentBlock },
      },
      seo: {
        type: ['object', 'null'],
        additionalProperties: false,
        required: ['title', 'description', 'keywords', 'ogTitle', 'ogDescription', 'headline', 'breadcrumbName'],
        properties: {
          title: { type: 'string' }, description: { type: 'string' }, keywords: { type: 'string' },
          ogTitle: { type: 'string' }, ogDescription: { type: 'string' },
          headline: { type: 'string' }, breadcrumbName: { type: 'string' },
        },
      },
      abort_topical_relevance: nullableBoolean,
      reason: nullableString,
    },
  };
}

/**
 * La sola regola che il CLI ha applicato nell'incidente: presenza delle chiavi
 * `required`, ricorsiva. Deliberatamente minuscola — non e' un validatore
 * JSON-Schema, e' la riproduzione del messaggio d'errore misurato.
 */
function chiaviRequiredMancanti(schema: any, valore: any, percorso = 'root'): string[] {
  const mancanti: string[] = [];
  if (!schema || typeof schema !== 'object') return mancanti;
  if (valore === null || typeof valore !== 'object') return mancanti;
  for (const nome of schema.required || []) {
    if (!Object.prototype.hasOwnProperty.call(valore, nome)) mancanti.push(`${percorso}.${nome}`);
  }
  for (const [nome, sotto] of Object.entries(schema.properties || {})) {
    if (Object.prototype.hasOwnProperty.call(valore, nome)) {
      mancanti.push(...chiaviRequiredMancanti(sotto, valore[nome], `${percorso}.${nome}`));
    }
  }
  return mancanti;
}

/** Cio' che il modello emette davvero quando scrive un articolo: niente rami null. */
function payloadArticoloPieno(): any {
  return {
    id: 'a1', category: 'frontaliere', image: 'x.jpg', hasCalculator: false,
    imagePrompt: 'p', imageAlt: { it: 'a', en: 'a', de: 'a', fr: 'a' },
    slugs: { it: 's', en: 's', de: 's', fr: 's' },
    content: { it: { title: 't', excerpt: 'e', body1: 'b1', body2: 'b2', body3: 'b3', faq: [] } },
    seo: {
      title: 't', description: 'd', keywords: 'k', ogTitle: 'o',
      ogDescription: 'od', headline: 'h', breadcrumbName: 'b',
    },
    // niente `abort_topical_relevance`, niente `reason`: e' il ramo non preso.
  };
}

describe('relaxSchemaForClaudeCli', () => {
  it('riproduce il rifiuto misurato: senza rilassatura manca `reason`', () => {
    const mancanti = chiaviRequiredMancanti(schemaFull(), payloadArticoloPieno());
    assert.deepEqual(mancanti, ['root.abort_topical_relevance', 'root.reason']);
  });

  it('con la rilassatura lo stesso payload passa', () => {
    const mancanti = chiaviRequiredMancanti(relaxSchemaForClaudeCli(schemaFull()), payloadArticoloPieno());
    assert.deepEqual(mancanti, []);
  });

  it('toglie dal required SOLO le prop nullable', () => {
    const r = relaxSchemaForClaudeCli(schemaFull());
    assert.equal(r.required, undefined, 'root: tutte e 11 sono nullable, `required` va rimosso, non lasciato vuoto');
  });

  it('LA PROPRIETA CHE CONTA: il vincolo su body1/body2/body3 sopravvive', () => {
    const r = relaxSchemaForClaudeCli(schemaFull());
    assert.deepEqual(
      r.properties.content.properties.it.required,
      ['title', 'excerpt', 'body1', 'body2', 'body3', 'faq'],
      'e la ragione per cui lo schema esiste: il modello non puo omettere body2/body3',
    );
    assert.deepEqual(r.properties.seo.required, [
      'title', 'description', 'keywords', 'ogTitle', 'ogDescription', 'headline', 'breadcrumbName',
    ]);
    assert.deepEqual(r.properties.imageAlt.required, ['it', 'en', 'de', 'fr']);
    assert.deepEqual(r.properties.slugs.required, ['it', 'en', 'de', 'fr']);
    assert.deepEqual(r.properties.content.properties.it.properties.faq.items.required, ['q', 'a']);
  });

  it('un body mancante resta un errore anche dopo la rilassatura', () => {
    const rotto = payloadArticoloPieno();
    delete rotto.content.it.body2;
    const mancanti = chiaviRequiredMancanti(relaxSchemaForClaudeCli(schemaFull()), rotto);
    assert.deepEqual(mancanti, ['root.content.it.body2']);
  });

  it('non cambia nient altro: la differenza sta tutta nelle liste `required`', () => {
    const senzaRequired = (n: any): any => {
      if (!n || typeof n !== 'object') return n;
      if (Array.isArray(n)) return n.map(senzaRequired);
      return Object.fromEntries(
        Object.entries(n).filter(([k]) => k !== 'required').map(([k, v]) => [k, senzaRequired(v)]),
      );
    };
    assert.deepEqual(senzaRequired(relaxSchemaForClaudeCli(schemaFull())), senzaRequired(schemaFull()));
  });

  it('non muta lo schema in ingresso — lo stesso oggetto va anche a OpenAI', () => {
    const originale = schemaFull();
    const prima = JSON.stringify(originale);
    relaxSchemaForClaudeCli(originale);
    assert.equal(JSON.stringify(originale), prima,
      'una mutazione in place manderebbe lo schema rilassato ai provider strict, che rispondono 400');
  });

  it('e idempotente', () => {
    const uno = relaxSchemaForClaudeCli(schemaFull());
    assert.deepEqual(relaxSchemaForClaudeCli(uno), uno);
  });

  it('il segnale e `type`, non `anyOf`: in dubbio si resta required', () => {
    const r = relaxSchemaForClaudeCli({
      type: 'object',
      required: ['a', 'b', 'c'],
      properties: {
        a: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        b: {},
        c: { type: ['string', 'null'] },
      },
    });
    assert.deepEqual(r.required, ['a', 'b'], 'solo `c` dichiara null nel proprio `type`');
  });

  it('sopravvive a input degeneri', () => {
    assert.equal(relaxSchemaForClaudeCli(null), null);
    assert.equal(relaxSchemaForClaudeCli(undefined), undefined);
    assert.equal(relaxSchemaForClaudeCli('x'), 'x');
    // `required` senza `properties` fratelle: non c e modo di sapere i tipi, non si tocca.
    assert.deepEqual(relaxSchemaForClaudeCli({ required: ['a'] }), { required: ['a'] });
  });
});

describe('il cablaggio, che nessun import puo verificare', () => {
  it('lo schema passato al CLI passa dalla rilassatura', () => {
    assert.ok(
      SRC.includes("args.push('--json-schema', JSON.stringify(relaxSchemaForClaudeCli(opts.jsonSchema.schema || opts.jsonSchema)))"),
      'il push di --json-schema non passa piu da relaxSchemaForClaudeCli — l anello di rigenerazione e tornato',
    );
  });

  it('AI_MODELS_SCHEMA_MODE=off ora spegne anche il CLI', () => {
    assert.ok(
      SRC.includes("if (opts.jsonSchema && getSchemaMode() !== 'off') {"),
      'il terzo mittente dello schema e di nuovo fuori dall interruttore d emergenza',
    );
  });
});

describe('la precondizione della correttezza', () => {
  it('chi legge il payload tratta `undefined` come `null`', () => {
    // Se questi due call site cambiassero forma, «chiave assente» smetterebbe di
    // essere equivalente a «chiave a null» e la rilassatura perderebbe informazione.
    assert.ok(
      CREATE_ARTICLE.includes('itData?.abort_topical_relevance === true'),
      'il gate di abort non testa piu con ?. + === true: verificare che l assenza della chiave sia ancora innocua',
    );
    assert.ok(
      CREATE_ARTICLE.includes("String(itData.reason || '')"),
      'la lettura di `reason` non e piu difesa da || : una chiave assente potrebbe ora rompere',
    );
  });
});
