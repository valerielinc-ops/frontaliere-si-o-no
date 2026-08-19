/**
 * ── LA STIMA CHE NON SAPEVA CHE IL CLI SPEDISCE UNO SCHEMA (misurato 2026-08-19) ─
 *
 * `estimateRequestTokens` decide se aggiungere i byte serializzati dello schema
 * chiedendo "questo provider lo riceve?" — prima chiedendolo a
 * `shouldUseSchemaMode()`. Quella funzione risponde correttamente `false` per
 * `claude_cli`: non e' OpenAI-compat, non sta in
 * `PROVIDERS_WITH_STRICT_JSON_SCHEMA`. Ma `_callClaudeCli` lo schema lo spedisce
 * lo stesso, via `--json-schema` (vedi #6080 / corpus#487, e la meta' rilevante
 * qui e' `relaxSchemaForClaudeCli`) — un terzo mittente che il commento di
 * `shouldUseSchemaMode` non nominava. Risultato: ogni chiamata a
 * `claude-cli/haiku` con uno schema veniva sotto-contata di ~1805 byte ≈ 452
 * token, la stessa classe di difetto del caso Groq gia' documentato nel
 * sorgente, segno opposto.
 *
 * La fix NON tocca PROVIDERS_WITH_STRICT_JSON_SCHEMA (quel Set governa anche il
 * COMPORTAMENTO di invio lato _callOpenAICompatible/_callGeminiRaw): introduce
 * `_schemaBytesWillBeSent`, un predicato usato SOLO dalla stima, che per
 * claude_cli rispecchia la condizione che _callClaudeCli usa davvero
 * (`getSchemaMode() !== 'off'`) invece di shouldUseSchemaMode().
 *
 * E la stima deve contare lo schema CHE VIENE SPEDITO DAVVERO: _callClaudeCli
 * passa lo schema da `relaxSchemaForClaudeCli` (#6080) prima di serializzarlo,
 * il che toglie chiavi da `required` e cambia i byte. Contare lo schema non
 * rilassato conterebbe il numero sbagliato — questi test misurano entrambi e
 * verificano che la stima usi quello giusto.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { estimateRequestTokens, relaxSchemaForClaudeCli, shouldUseSchemaMode } from '../../scripts/lib/ai-models.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.resolve(HERE, '../../scripts/lib/ai-models.mjs'), 'utf-8');

const MESSAGES = [{ role: 'user', content: 'x'.repeat(1000) }];

/** Schema minimale con una prop nullable (rilassabile) e una non-nullable
 * (deve restare required) — abbastanza per far divergere byte relaxed/raw. */
function schemaWithNullable() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'reason', 'body'],
    properties: {
      id: { type: ['string', 'null'] },
      reason: { type: ['string', 'null'] },
      body: { type: 'string' }, // non nullable: resta required, non tocca il conteggio
    },
  };
}

function withEnv(name: string, value: string | undefined, fn: () => void) {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    fn();
  } finally {
    if (had) process.env[name] = prev;
    else delete process.env[name];
  }
}

describe('estimateRequestTokens — claude_cli conta lo schema che spedisce davvero', () => {
  it('la premessa: lo schema rilassato e quello grezzo hanno byte diversi', () => {
    const raw = JSON.stringify(schemaWithNullable()).length;
    const relaxed = JSON.stringify(relaxSchemaForClaudeCli(schemaWithNullable())).length;
    assert.ok(relaxed < raw, 'se coincidessero questo test non proverebbe niente sul rilassamento');
  });

  it('senza providerName (upper bound) lo schema grezzo conta per intero', () => {
    const withoutSchema = estimateRequestTokens(MESSAGES, {});
    const withSchema = estimateRequestTokens(MESSAGES, { jsonSchema: { schema: schemaWithNullable() } });
    const raw = JSON.stringify(schemaWithNullable()).length;
    assert.equal(withSchema - withoutSchema, Math.ceil(raw / 3.5));
  });

  it('per claude_cli la stima cresce quando c e uno schema (era 0 prima della fix)', () => {
    const withoutSchema = estimateRequestTokens(MESSAGES, {}, 'claude_cli', 'claude-cli/haiku');
    const withSchema = estimateRequestTokens(
      MESSAGES,
      { jsonSchema: { schema: schemaWithNullable() } },
      'claude_cli',
      'claude-cli/haiku',
    );
    assert.ok(
      withSchema > withoutSchema,
      'claude_cli spedisce lo schema via --json-schema (_callClaudeCli): la stima deve contarlo',
    );
  });

  it('claude_cli conta i byte RILASSATI, non quelli grezzi — la cifra esatta', () => {
    const schema = schemaWithNullable();
    const relaxedChars = JSON.stringify(relaxSchemaForClaudeCli(schema)).length;
    const rawChars = JSON.stringify(schema).length;
    assert.notEqual(relaxedChars, rawChars, 'precondizione: altrimenti la prossima asserzione non distingue niente');

    const withoutSchema = estimateRequestTokens(MESSAGES, {}, 'claude_cli', 'claude-cli/haiku');
    const withSchema = estimateRequestTokens(
      MESSAGES,
      { jsonSchema: { schema } },
      'claude_cli',
      'claude-cli/haiku',
    );
    assert.equal(withSchema - withoutSchema, Math.ceil(relaxedChars / 3.5), 'deve essere il conteggio RILASSATO');
    // E se invece contasse i byte grezzi (bug residuo: predicato giusto, ma
    // schema sbagliato) la cifra sarebbe diversa — lo dimostriamo per contrasto.
    assert.notEqual(withSchema - withoutSchema, Math.ceil(rawChars / 3.5));
  });

  it('MUTAZIONE: la formula pre-fix (gated solo da shouldUseSchemaMode) avrebbe dato un numero diverso', () => {
    // Riproduce esattamente la riga pre-fix di estimateRequestTokens:
    //   schemaIsSent = providerName === undefined || shouldUseSchemaMode(providerName, true, modelForTracking)
    // shouldUseSchemaMode('claude_cli', ...) risponde false (non OpenAI-compat, non in
    // PROVIDERS_WITH_STRICT_JSON_SCHEMA) — quindi la vecchia formula non avrebbe MAI
    // aggiunto i byte dello schema per questo provider, qualunque schema si passi.
    const schema = schemaWithNullable();
    const oldSchemaIsSent = shouldUseSchemaMode('claude_cli', true, 'claude-cli/haiku');
    assert.equal(oldSchemaIsSent, false, 'precondizione: e la ragione per cui la stima pre-fix era sotto-contata');
    const oldEstimate = (() => {
      let chars = MESSAGES.reduce((n, m) => n + m.content.length, 0);
      if (oldSchemaIsSent) chars += JSON.stringify(schema).length; // mai eseguito: oldSchemaIsSent e' false
      return Math.ceil(chars / 3.5) + 500;
    })();

    const newEstimate = estimateRequestTokens(MESSAGES, { jsonSchema: { schema } }, 'claude_cli', 'claude-cli/haiku');
    assert.ok(
      newEstimate > oldEstimate,
      `la fix deve dare una stima piu alta della formula pre-fix (nuova=${newEstimate}, vecchia=${oldEstimate}); ` +
        'se tornassero uguali, estimateRequestTokens e tornato a ignorare lo schema del CLI',
    );
  });

  it('AI_MODELS_SCHEMA_MODE=off spegne il conteggio anche per claude_cli (rispecchia _callClaudeCli)', () => {
    withEnv('AI_MODELS_SCHEMA_MODE', 'off', () => {
      const withoutSchema = estimateRequestTokens(MESSAGES, {}, 'claude_cli', 'claude-cli/haiku');
      const withSchema = estimateRequestTokens(
        MESSAGES,
        { jsonSchema: { schema: schemaWithNullable() } },
        'claude_cli',
        'claude-cli/haiku',
      );
      assert.equal(withSchema, withoutSchema, '--json-schema non parte quando getSchemaMode() === "off"');
    });
  });

  it('non tocca il comportamento esistente per un provider OpenAI-compat strict (GitHub)', () => {
    const withoutSchema = estimateRequestTokens(MESSAGES, {}, 'GitHub', 'gpt-4o-mini');
    const withSchema = estimateRequestTokens(
      MESSAGES,
      { jsonSchema: { schema: schemaWithNullable() } },
      'GitHub',
      'gpt-4o-mini',
    );
    const raw = JSON.stringify(schemaWithNullable()).length;
    assert.equal(withSchema - withoutSchema, Math.ceil(raw / 3.5), 'GitHub riceve lo schema grezzo, non rilassato');
  });

  it('non tocca il comportamento esistente per Groq (mai in PROVIDERS_WITH_STRICT_JSON_SCHEMA)', () => {
    const withoutSchema = estimateRequestTokens(MESSAGES, {}, 'Groq', 'llama');
    const withSchema = estimateRequestTokens(
      MESSAGES,
      { jsonSchema: { schema: schemaWithNullable() } },
      'Groq',
      'llama',
    );
    assert.equal(withSchema, withoutSchema, 'Groq non riceve mai lo schema: la stima non deve contarlo');
  });
});

describe('il cablaggio, che nessun import puo verificare', () => {
  it('estimateRequestTokens chiede a _schemaBytesWillBeSent, non solo a shouldUseSchemaMode', () => {
    assert.ok(
      SRC.includes('_schemaBytesWillBeSent(providerName, true, modelForTracking)'),
      'estimateRequestTokens e tornato a fidarsi solo di shouldUseSchemaMode(): claude_cli torna sotto-contato',
    );
  });

  it('la stima usa relaxSchemaForClaudeCli per il provider claude_cli', () => {
    assert.ok(
      SRC.includes('relaxSchemaForClaudeCli(opts.jsonSchema.schema)'),
      'la stima conta lo schema grezzo anche per claude_cli: e non e piu quello che _callClaudeCli spedisce',
    );
  });

  it('_schemaBytesWillBeSent rispecchia la condizione reale di _callClaudeCli', () => {
    assert.ok(
      SRC.includes("return getSchemaMode() !== 'off';"),
      '_schemaBytesWillBeSent non rispecchia piu la condizione di invio del CLI',
    );
  });
});
