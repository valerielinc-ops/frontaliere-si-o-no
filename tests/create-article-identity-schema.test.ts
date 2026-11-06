/**
 * Guard for issue #5544 / corpus #330: the JSON schema shown to the model must
 * never spell `id` and `slugs` with values that are themselves valid answers.
 *
 * Until 2026-08-14 it did:
 *
 *     "id": "kebab-case-3-5-words-max-40-chars",
 *     "slugs": { "it": "slug-it", "en": "slug-en", "de": "slug-de", "fr": "slug-fr" },
 *
 * A model that echoes those instead of replacing them hands back a string
 * `slugifySlugPart()` accepts without a line of log. Four reached production as
 * permanent public URLs through the `id`, and 24 more across 8 articles through
 * the locale slugs. An article's URL is the one part that cannot be corrected
 * afterwards without a redirect the shard renderer has no mechanism for.
 *
 * The schema now delimits both fields with `<<`/`>>`, which puts them outside
 * the slug alphabet — so an echo is DECIDABLE rather than merely suspicious.
 *
 * WHY THIS FILE HAS A SOURCE-SCANNING HALF AND NOT ONLY UNIT ASSERTIONS.
 * The defect does not live in a function, it lives in a string constant that a
 * later prompt reword can silently put back. Asserting only that
 * `parseArticleIdentityField()` rejects `<<SLUG:en>>` would stay green on the
 * day someone types `"slug-en"` back into the template — the guard would be
 * perfect and guarding nothing. So the LOCK block below re-extracts the two
 * schema lines from the source of `create-article.mjs` and asserts the template
 * interpolates the shared constants, and the WIRING block asserts `validate()`
 * still calls the parser on both fields.
 *
 * WHERE THIS TEST LIVES. On the SITE only. `scripts/create-article.mjs` is a
 * twin of `generator/scripts/create-article.mjs` in the corpus, registered
 * `adapted` in `scripts/ci/loop-sync-manifest.json` — the two sides are
 * different by construction and neither mirror covers `generator/`, so nothing
 * this file asserts protects the corpus copy, and nothing the corpus asserts
 * protects this one. The corpus has its own bench for its own half.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ID_PLACEHOLDER,
  IDENTITY_PLACEHOLDERS,
  IDENTITY_REJECTION,
  IDENTITY_TOKEN_CLOSE,
  IDENTITY_TOKEN_OPEN,
  parseArticleIdentityField,
  slugPlaceholder,
} from '../scripts/create-article.mjs';

const ROOT = resolve(__dirname, '..');
const CREATE_ARTICLE_PATH = resolve(ROOT, 'scripts/create-article.mjs');
const SOURCE = readFileSync(CREATE_ARTICLE_PATH, 'utf8');

/** A legitimate slug, i.e. what the model is being asked to produce. */
const VALID_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The exact literals the schema used to carry. These are the strings that
 * caused the incident, kept verbatim so a revert is recognised by shape and
 * not only by absence of the new form.
 */
const CONFUSABLE_LEGACY_LITERALS = [
  'kebab-case-3-5-words-max-40-chars',
  'slug-it',
  'slug-en',
  'slug-de',
  'slug-fr',
];

/**
 * The `{ … }` JSON block the prompt shows the model, sliced out of the source.
 * Anchored on the instruction line above it so a second schema block added
 * later cannot be silently skipped.
 */
function extractPromptSchemaBlock(): string {
  const anchor = 'Genera JSON (no markdown, no code fences):';
  const anchors = SOURCE.split(anchor).length - 1;
  expect(
    anchors,
    'il prompt deve mostrare esattamente UNO schema JSON: se ne compare un secondo questo test ne controllerebbe solo uno',
  ).toBe(1);
  const start = SOURCE.indexOf(anchor);
  // The identity fields are the first lines of the block; 4 000 chars covers
  // them with margin without dragging in the rest of the template.
  return SOURCE.slice(start, start + 4000);
}

describe('LOCK — lo schema del prompt non mostra valori confondibili', () => {
  it('la riga "id" interpola ID_PLACEHOLDER invece di un letterale', () => {
    const block = extractPromptSchemaBlock();
    const idLine = block.split('\n').find((l) => l.trimStart().startsWith('"id":'));
    expect(idLine, 'riga "id" non trovata nello schema del prompt').toBeDefined();
    // Il template porta il testo LETTERALE, non un'interpolazione: è ciò che
    // permette a tests/scripts/prompt-placeholder-guard.test.ts di
    // ri-estrarlo (il suo estrattore salta i valori che contengono `${`) e
    // quindi di pretendere che SCHEMA_PLACEHOLDER_LITERALS resti allineato.
    // L'uguaglianza col costante esportata è asserita qui.
    expect(
      idLine,
      'lo schema deve mostrare ID_PLACEHOLDER alla lettera: un valore diverso è esattamente il difetto di #5544',
    ).toContain(`"${ID_PLACEHOLDER}"`);
  });

  it('la riga "slugs" interpola slugPlaceholder() per tutti e quattro i locali', () => {
    const block = extractPromptSchemaBlock();
    const slugLine = block.split('\n').find((l) => l.trimStart().startsWith('"slugs":'));
    expect(slugLine, 'riga "slugs" non trovata nello schema del prompt').toBeDefined();
    for (const locale of ['it', 'en', 'de', 'fr']) {
      expect(
        slugLine,
        `lo schema deve mostrare slugPlaceholder('${locale}') alla lettera`,
      ).toContain(`"${slugPlaceholder(locale)}"`);
    }
  });

  it('nessuno dei letterali confondibili storici è tornato nello schema', () => {
    const block = extractPromptSchemaBlock();
    for (const literal of CONFUSABLE_LEGACY_LITERALS) {
      expect(
        block.includes(`"${literal}"`),
        `lo schema è tornato a mostrare "${literal}", che è anche una risposta valida`,
      ).toBe(false);
    }
  });
});

describe('OVERLAP — i segnaposto vivono fuori dallo spazio delle risposte', () => {
  it('nessun segnaposto d\'identità è a sua volta uno slug valido', () => {
    expect(IDENTITY_PLACEHOLDERS.length).toBe(5);
    for (const placeholder of IDENTITY_PLACEHOLDERS) {
      expect(
        VALID_SLUG_RE.test(placeholder),
        `il segnaposto "${placeholder}" è esso stesso uno slug valido: un'eco sarebbe indistinguibile da una risposta`,
      ).toBe(false);
    }
  });

  it('ogni segnaposto è delimitato da << >>', () => {
    for (const placeholder of IDENTITY_PLACEHOLDERS) {
      expect(placeholder.startsWith(IDENTITY_TOKEN_OPEN)).toBe(true);
      expect(placeholder.endsWith(IDENTITY_TOKEN_CLOSE)).toBe(true);
    }
  });

  it('i due campi non condividono il nome del token, così un\'eco è attribuibile', () => {
    // È ciò che rende visibile lo scambio fra `id` e `slugs`, cioè la
    // confusione che dà il titolo alla issue.
    expect(ID_PLACEHOLDER.toUpperCase()).not.toContain('SLUG');
    for (const locale of ['it', 'en', 'de', 'fr']) {
      expect(slugPlaceholder(locale).toUpperCase()).toContain('SLUG');
    }
  });

  it('il segnaposto IT dice che slugs.it È l\'id, invece di chiedere un secondo valore', () => {
    // `validate()` fa `data.slugs.it = data.id` sempre: chiedere un valore
    // indipendente significa chiederne due per un solo URL e buttarne via uno.
    expect(slugPlaceholder('it')).toContain('= ID');
  });
});

describe('PARSER — un\'eco viene rigettata, uno slug vero passa', () => {
  it('rigetta tutti e cinque i segnaposto dello schema', () => {
    for (const placeholder of IDENTITY_PLACEHOLDERS) {
      const field = placeholder.toUpperCase().includes('SLUG') ? 'slug' : 'id';
      const verdict = parseArticleIdentityField(placeholder, { field });
      expect(verdict.ok, `il segnaposto "${placeholder}" è passato come valore buono`).toBe(false);
    }
  });

  it('riconosce lo SCAMBIO dei due campi, in entrambe le direzioni', () => {
    expect(parseArticleIdentityField(slugPlaceholder('en'), { field: 'id' }).rejection)
      .toBe(IDENTITY_REJECTION.CROSS_FIELD_ECHO);
    expect(parseArticleIdentityField(ID_PLACEHOLDER, { field: 'slug', locale: 'en' }).rejection)
      .toBe(IDENTITY_REJECTION.CROSS_FIELD_ECHO);
  });

  it('un segnaposto RIFORMULATO resta rigettato — è la struttura a decidere, non il testo', () => {
    // Il classificatore storico aggancia le PAROLE del segnaposto
    // (`kebab-case`, `slug-<locale>`), quindi una riformulazione lo acceca:
    // `<<TRADUZIONE-SLUG:en>>` sanitizzato dà `traduzione-slug-en`, che nessuna
    // delle sue regole vede e che diventerebbe un URL. Qui a decidere sono i
    // delimitatori, che una riformulazione conserva.
    const reworded = `${IDENTITY_TOKEN_OPEN}TRADUZIONE-SLUG:en${IDENTITY_TOKEN_CLOSE}`;
    expect(parseArticleIdentityField(reworded, { field: 'slug', locale: 'en' }).ok).toBe(false);
  });

  it('un id assente è EMPTY, non un\'eco: chi chiama lo sintetizza dal titolo', () => {
    for (const empty of [undefined, null, '', '   ']) {
      const verdict = parseArticleIdentityField(empty, { field: 'id' });
      expect(verdict.ok).toBe(false);
      expect(verdict.rejection).toBe(IDENTITY_REJECTION.EMPTY);
    }
  });

  it('non rigetta slug legittimi, compresi quelli che contengono cifre e sigle', () => {
    const legitimate = [
      'permesso-g-2026',
      'gaggiolo-traffico-record',
      'terzo-pilastro-3a-vantaggi',
      'frontalieri-ticino-stipendi',
      'imposta-fonte-2026',
      'slug-gaggiolo-traffic', // forma storica: la classifica il guard storico, non questo
    ];
    for (const slug of legitimate) {
      expect(
        parseArticleIdentityField(slug, { field: 'id' }).ok,
        `falso positivo su "${slug}"`,
      ).toBe(true);
    }
  });
});

describe('WIRING — validate() chiama davvero il parser sui due campi', () => {
  // Un parser corretto che nessuno invoca è lo stesso difetto con un file in
  // più: è la lezione di blog-title-casing, dove `normalizeTitleCasing()`
  // esisteva completa e cablata su un percorso solo.
  it('l\'id passa dal parser PRIMA del classificatore storico', () => {
    const idCall = SOURCE.indexOf("parseArticleIdentityField(data.id, { field: 'id' })");
    expect(idCall, 'validate() non chiama più parseArticleIdentityField sull\'id').toBeGreaterThan(-1);
    const legacyCall = SOURCE.indexOf('const idLeak = data.id ? findSlugPromptLeak(data.id)');
    expect(legacyCall, 'il classificatore storico dell\'id è sparito').toBeGreaterThan(-1);
    expect(
      idCall,
      'il controllo decidibile deve precedere il classificatore storico: dopo la sanitizzazione i delimitatori non esistono più',
    ).toBeLessThan(legacyCall);
  });

  it('gli slug di locale passano dal parser PRIMA della sanitizzazione', () => {
    const localeCall = SOURCE.indexOf("parseArticleIdentityField(original, { field: 'slug', locale })");
    expect(localeCall, 'il loop en/de/fr non chiama parseArticleIdentityField').toBeGreaterThan(-1);
    // La catena di sanitizzazione cancella `<`, `>` e `:`, cioè la prova.
    const sanitizeCall = SOURCE.indexOf('.replace(/[^a-z0-9-]/g, \'-\')', localeCall - 2000);
    expect(sanitizeCall).toBeGreaterThan(-1);
    expect(
      localeCall,
      'sanitizzare per primi butta via i delimitatori su cui il rigetto si basa',
    ).toBeLessThan(SOURCE.indexOf('.replace(/[^a-z0-9-]/g, \'-\')', localeCall));
  });

  it('il rigetto dell\'id è qualityReject, cioè fa RIGENERARE invece di pubblicare', () => {
    const block = SOURCE.slice(
      SOURCE.indexOf("parseArticleIdentityField(data.id, { field: 'id' })"),
      SOURCE.indexOf('const idLeak = data.id ? findSlugPromptLeak(data.id)'),
    );
    expect(block).toContain('err.qualityReject = true');
    expect(block).toContain('throw err');
    // EMPTY non deve propagarsi: un id assente lo sintetizza il blocco sotto.
    expect(block).toContain('IDENTITY_REJECTION.EMPTY');
  });
});
