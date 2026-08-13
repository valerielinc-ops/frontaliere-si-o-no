import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import {
  maskProtectedTokens,
  restoreProtectedTokens,
  localizeGenderTrigraphs,
  genderTrigraphForLocale,
  hasGenderTrigraph,
  stripPlaceholderTokens,
  finalizeTranslatedText,
} from '@/scripts/lib/translation-glossary.mjs';

// Set BEFORE anything pulls in free-translate.mjs: the module reads this env
// var once, at load time. `dedicated-crawler-common.mjs` imports the cascade at
// its own module scope, so it must be imported dynamically (below) rather than
// statically here — a static import would be hoisted above this assignment and
// freeze the self-hosted URL to ''.
const LT_URL = 'http://libretranslate.test';
process.env.LIBRETRANSLATE_SELF_HOSTED_URL = LT_URL;

/**
 * Regression guard for the two defect families observed in a 900-page live
 * sample of rendered job titles.
 *
 * FAMILY 1 — a DACH gender code handed to a machine translator comes back as
 * WEEKDAYS, because "m/w/d" is three letters and the translator is free to
 * expand them:
 *   "Responsabile del Laboratorio Ambientale (lunedì/mercoledì/d)"  (m→Monday,
 *   "Responsabile Installazioni Nuovi Sistemi (lunedì/meredì)"       w→Wednesday)
 * and, 18 times in a 179-entry sample, the German "(m/w/d)" simply survived
 * verbatim into Italian and French titles.
 *
 * The fix masks the code before translation and restores a locale-appropriate
 * form after. Nothing in the SLUG path changes — see the slug-stability block
 * at the bottom, which pins the property the whole design rests on.
 */

const WEEKDAY_RE = /luned[ìi]|marted[ìi]|mercoled[ìi]|gioved[ìi]|venerd[ìi]|meredì|monday|tuesday|wednesday|montag|mittwoch|lundi|mercredi/i;

describe('gender trigraph masking — pre-translation protection', () => {
  it('masks every documented bracketed variant into an opaque sentinel', () => {
    const variants = [
      '(m/w/d)', '(w/m/d)', '(m/f/d)', '(f/m/d)', '(h/f/d)', '(f/h/d)',
      '(m/f/x)', '(f/m/x)', '(m/w/x)', '(m/p/g)', '(l/w/d)',
      '(m/w)', '(w/m)', '(m/f)', '(f/m)', '(h/f)', '(f/h)',
      '[m/w/d]', '(M/W/D)', '( m / w / d )',
    ];
    for (const v of variants) {
      const { text, tokens } = maskProtectedTokens(`Fachspezialist ${v} Umweltlabor`);
      expect(tokens, `variant ${v} was not masked`).toHaveLength(1);
      expect(text).toBe('Fachspezialist ZQX0XQZ Umweltlabor');
    }
  });

  it('masks bare (unbracketed) trigraphs and the six documented bigraphs', () => {
    for (const v of ['m/w/d', 'M/W/D', 'w/m/d', 'm/f/d', 'h/f/d', 'm/w', 'w/m', 'm/f', 'f/m', 'h/f', 'f/h']) {
      const { tokens } = maskProtectedTokens(`Techniker ${v} gesucht`);
      expect(tokens, `bare variant ${v} was not masked`).toHaveLength(1);
    }
  });

  it('does NOT mask unit notation that shares the letter class (l/h, p/h, km/h)', () => {
    // The bare form is deliberately stricter than canonicalizeGenderTrigraph's:
    // "100 l/h" is litres per hour, not a gender code.
    for (const s of ['Durchfluss 100 l/h im Betrieb', 'Lohn CHF 25 p/h', 'Geschwindigkeit 50 km/h', 'Pflegefachfrau HF/FH']) {
      const { text, tokens } = maskProtectedTokens(s);
      expect(tokens, `wrongly masked in: ${s}`).toHaveLength(0);
      expect(text).toBe(s);
    }
  });

  it('returns the input byte-identical when there is nothing to protect', () => {
    const s = 'Dipl. Pflegefachperson HF Neurologie 60-100 %';
    const { text, tokens } = maskProtectedTokens(s);
    expect(tokens).toHaveLength(0);
    expect(text).toBe(s);
  });
});

describe('gender trigraph restore — locale-appropriate display form', () => {
  const SOURCE = 'Leiter Umweltlabor (m/w/d)';
  const EXPECTED: Record<string, string> = {
    de: '(m/w/d)',
    fr: '(h/f/d)',
    it: '(m/f/d)',
    en: '(m/f/d)',
  };

  it('restores the sentinel as the target locale form, never as weekdays', () => {
    const { text: masked, tokens } = maskProtectedTokens(SOURCE);
    for (const [locale, form] of Object.entries(EXPECTED)) {
      const mt = masked.replace('Leiter Umweltlabor', 'Responsabile del Laboratorio Ambientale');
      const out = restoreProtectedTokens(mt, tokens, locale);
      expect(out).toBe(`Responsabile del Laboratorio Ambientale ${form}`);
      expect(out).not.toMatch(WEEKDAY_RE);
    }
  });

  it('survives a translator that lower-cases or pads the sentinel', () => {
    const { tokens } = maskProtectedTokens(SOURCE);
    for (const mangled of ['zqx0xqz', 'ZQX 0 XQZ', 'zqx-0-xqz', 'ZQX.0.XQZ']) {
      const out = restoreProtectedTokens(`Responsabile Laboratorio ${mangled}`, tokens, 'it');
      expect(out).toBe('Responsabile Laboratorio (m/f/d)');
    }
  });

  it('re-appends the correct form on a TITLE when the translator drops the sentinel', () => {
    const { tokens } = maskProtectedTokens(SOURCE);
    const out = restoreProtectedTokens('Responsabile del Laboratorio Ambientale', tokens, 'it', { fieldType: 'title' });
    expect(out).toBe('Responsabile del Laboratorio Ambientale (m/f/d)');
  });

  it('scrubs an unrecognisable sentinel instead of emitting debris', () => {
    const { tokens } = maskProtectedTokens(SOURCE);
    // Digit read as a letter — past the tolerant index match, so it is removed
    // and the dropped-token fallback supplies the code.
    const out = restoreProtectedTokens('Responsabile ZQXOXQZ Laboratorio', tokens, 'it', { fieldType: 'title' });
    expect(out).not.toMatch(/zqx/i);
    expect(out).toBe('Responsabile Laboratorio (m/f/d)');
  });

  it('does NOT re-append into a description body when the sentinel is dropped', () => {
    const { tokens } = maskProtectedTokens('Wir suchen eine Pflegefachperson (m/w/d) für unser Team.');
    const body = 'Cerchiamo una persona per il nostro reparto di neurologia.';
    const out = restoreProtectedTokens(body, tokens, 'it', { fieldType: 'description' });
    expect(out).toBe(body);
  });

  it('preserves arity and case of the original (bigraph stays a bigraph)', () => {
    const bigraph = maskProtectedTokens('Chef (m/w) Team');
    expect(restoreProtectedTokens(bigraph.text, bigraph.tokens, 'it')).toBe('Chef (m/f) Team');
    const upper = maskProtectedTokens('Chef (M/W/D)');
    expect(restoreProtectedTokens(upper.text, upper.tokens, 'fr')).toBe('Chef (H/F/D)');
    const bare = maskProtectedTokens('Chef m/w/d gesucht');
    expect(restoreProtectedTokens(bare.text, bare.tokens, 'it')).toBe('Chef m/f/d gesucht');
  });

  it('keeps the non-binary "x" marker, normalises the "g"/"d" variants to "d"', () => {
    const nonBinary = maskProtectedTokens('Chef (m/w/x)');
    expect(restoreProtectedTokens(nonBinary.text, nonBinary.tokens, 'it')).toBe('Chef (m/f/x)');
    const gVariant = maskProtectedTokens('Chef (m/p/g)');
    expect(restoreProtectedTokens(gVariant.text, gVariant.tokens, 'it')).toBe('Chef (m/f/d)');
  });

  it('localizes a raw trigraph the translator copied through verbatim', () => {
    // The 18-in-179 case: German "(m/w/d)" surviving into an Italian title.
    expect(localizeGenderTrigraphs('Collaboratore/trice Warenverräumung (m/w/d)', 'it'))
      .toBe('Collaboratore/trice Warenverräumung (m/f/d)');
    expect(localizeGenderTrigraphs('Responsabile IT Division Hydroenergie (w/m/d)', 'it'))
      .toBe('Responsabile IT Division Hydroenergie (m/f/d)');
    expect(localizeGenderTrigraphs('Responsable IT (m/w/d)', 'fr'))
      .toBe('Responsable IT (h/f/d)');
  });

  it('is idempotent — re-running the localizer does not churn the form', () => {
    const once = localizeGenderTrigraphs('Collaboratore (m/w/d)', 'it');
    expect(localizeGenderTrigraphs(once, 'it')).toBe(once);
  });

  it('never produces a weekday name where a gender code was, for any variant', () => {
    const variants = ['(m/w/d)', '(w/m/d)', '(m/f/d)', '(h/f/d)', '(m/w/x)', '(m/w)', 'm/w/d', 'M/W/D'];
    for (const v of variants) {
      for (const locale of ['it', 'en', 'de', 'fr']) {
        const src = `Sachbearbeiter Umweltlabor ${v}`;
        const { text: masked, tokens } = maskProtectedTokens(src);
        // A translator that WOULD have expanded the letters: it never sees them.
        const mt = masked
          .replace('Sachbearbeiter Umweltlabor', 'Responsabile Laboratorio')
          .replace(/m\s*\/\s*w\s*\/\s*d/gi, 'lunedì/mercoledì/d');
        const out = restoreProtectedTokens(mt, tokens, locale);
        expect(out, `${v} → ${locale}`).not.toMatch(WEEKDAY_RE);
        expect(hasGenderTrigraph(out), `${v} → ${locale} lost its gender code`).toBe(true);
      }
    }
  });

  it('exposes the locale forms required by the brief', () => {
    expect(genderTrigraphForLocale('de')).toBe('(m/w/d)');
    expect(genderTrigraphForLocale('fr')).toBe('(h/f/d)');
    expect(genderTrigraphForLocale('it')).toBe('(m/f/d)');
    expect(genderTrigraphForLocale('en')).toBe('(m/f/d)');
    // Unknown locale falls back to the neutral m/f pair instead of throwing.
    expect(genderTrigraphForLocale('rm')).toBe('(m/f/d)');
  });
});

describe('gender trigraph — slug stability is untouched', () => {
  /**
   * The whole design depends on this: the DISPLAY form is localized, the SLUG
   * form is not, because `slugify` canonicalizes every variant to "m/w/d"
   * before slugifying (dedicated-crawler-common.mjs:5191 → canonicalize at
   * :161). If this test ever fails, localizing the display form starts
   * regenerating slugs site-wide.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let slugify: any;
  beforeAll(async () => {
    ({ slugify } = await import('@/scripts/lib/dedicated-crawler-common.mjs'));
  });

  it('every display variant produces exactly ONE slug', () => {
    const variants = [
      '(m/w/d)', '(w/m/d)', '(m/f/d)', '(f/m/d)', '(h/f/d)', '(f/h/d)',
      '(m/f/x)', '(m/w/x)', '(m/p/g)', '(l/w/d)', '(m/w)', '(h/f)',
      'm/w/d', 'M/W/D',
    ];
    const slugs = new Set(
      variants.map((v) => slugify(`Collaboratore Warenverraeumung ${v} Migros Zurigo`)),
    );
    expect(slugs.size).toBe(1);
    expect([...slugs][0]).toBe('collaboratore-warenverraeumung-m-w-d-migros-zurigo');
  });

  it('the per-locale forms this PR emits all slugify identically', () => {
    const slugs = new Set(
      ['(m/w/d)', '(h/f/d)', '(m/f/d)'].map((v) => slugify(`Leiter Umweltlabor ${v}`)),
    );
    expect(slugs.size).toBe(1);
  });
});

describe('placeholder guard — a template token never reaches a published title', () => {
  it('strips the ALL-CAPS placeholder vocabulary observed live', () => {
    expect(stripPlaceholderTokens('Infermiere (ORGANIZZAZIONE) Lugano')).toBe('Infermiere Lugano');
    expect(stripPlaceholderTokens('Nurse (COMPANY NAME) Zurich')).toBe('Nurse Zurich');
    expect(stripPlaceholderTokens('Verkäufer (UNTERNEHMEN)')).toBe('Verkäufer');
    expect(stripPlaceholderTokens('Vendeur (ENTREPRISE) Genève')).toBe('Vendeur Genève');
  });

  it('strips template-delimiter placeholders regardless of vocabulary', () => {
    expect(stripPlaceholderTokens('Techniker {COMPANY} AG')).toBe('Techniker AG');
    expect(stripPlaceholderTokens('Techniker {{ company }} AG')).toBe('Techniker AG');
    expect(stripPlaceholderTokens('Job %COMPANY% Lugano')).toBe('Job Lugano');
    expect(stripPlaceholderTokens('Job __COMPANY__ Lugano')).toBe('Job Lugano');
    expect(stripPlaceholderTokens('Job ${company} Lugano')).toBe('Job Lugano');
  });

  it('NEVER strips legitimate acronym / company parentheticals', () => {
    for (const s of [
      'Med. Praxisassistent/in CFC — Kantonsspital Aarau (KSA)',
      'Verkäufer (MIGROS)',
      'Pflegefachperson (EFZ) 80-100%',
      'Infermiere (SPITEX ZOFINGEN)',
      'Responsabile (IT) Divisione Hydro',
      'Collaboratore (m/f/d) Lugano',
      'Addetto (settore azienda) alle vendite',
    ]) {
      expect(stripPlaceholderTokens(s), `wrongly stripped: ${s}`).toBe(s);
    }
  });

  it('is case-sensitive — lowercase prose in parentheses is untouched', () => {
    const s = 'Lavorerai con la nostra azienda (azienda familiare) da 30 anni.';
    expect(stripPlaceholderTokens(s)).toBe(s);
  });

  it('rejects (returns "") a translation that is NOTHING but a placeholder', () => {
    expect(finalizeTranslatedText({
      sourceText: 'Mitarbeiter Verkauf',
      translatedText: '(ORGANIZZAZIONE)',
      targetLang: 'it',
    })).toBe('');
  });

  it('keeps the rest of the title when a placeholder is stripped (strip, not reject)', () => {
    expect(finalizeTranslatedText({
      sourceText: 'Pflegefachperson Nachtdienst',
      translatedText: 'Infermiere (ORGANIZZAZIONE) turno notturno',
      targetLang: 'it',
    })).toBe('Infermiere turno notturno');
  });
});

describe('finalizeTranslatedText — the shared exit transform', () => {
  it('restores tokens, applies the glossary and strips placeholders in one pass', () => {
    const source = 'Pflegefachperson Nachtwache (m/w/d)';
    const { tokens } = maskProtectedTokens(source);
    const out = finalizeTranslatedText({
      sourceText: source,
      translatedText: "Persona per l'orologio notturno ZQX0XQZ (ORGANIZZAZIONE)",
      targetLang: 'it',
      fieldType: 'title',
      protectedTokens: tokens,
    });
    expect(out).toBe('Persona per la guardia notturna (m/f/d)');
  });

  it('is a no-op passthrough for text with nothing to fix', () => {
    const s = 'Ingegnere civile 80-100% — Lugano';
    expect(finalizeTranslatedText({
      sourceText: 'Bauingenieur 80-100% — Lugano',
      translatedText: s,
      targetLang: 'it',
    })).toBe(s);
  });
});

/**
 * Integration: the guard has to be wired into the cascade, not just exported.
 * The fake translator below does exactly what the live one did — expands
 * "m/w/d" into weekday names — and the assertion is that it never gets the
 * chance, because the cascade masks the code before the request.
 */
describe('freeTranslate cascade — gender codes never reach a translator', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let freeTranslate: any;

  const install = (translate: (q: string) => string) => {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init: unknown) => {
      const u = String(url);
      if (u.startsWith(LT_URL)) {
        const body = JSON.parse(String((init as { body?: string })?.body || '{}'));
        return {
          ok: true,
          status: 200,
          json: async () => ({ translatedText: translate(String(body.q || '')) }),
        };
      }
      // Every other tier's endpoint fails, so the cascade lands on the fake.
      return { ok: false, status: 503, text: async () => '', json: async () => ({}) };
    }));
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // A translator that expands the German gender code as weekdays — the exact
  // live failure ("Responsabile del Laboratorio Ambientale (lunedì/mercoledì/d)").
  const weekdayTranslator = (q: string) => q
    .replace(/Leiter/g, 'Responsabile')
    .replace(/Umweltlabor/g, 'del Laboratorio Ambientale')
    .replace(/\(\s*m\s*\/\s*w\s*\/\s*d\s*\)/gi, '(lunedì/mercoledì/d)');

  it('emits the locale form instead of weekday names (en target)', async () => {
    if (!freeTranslate) ({ freeTranslate } = await import('@/scripts/lib/free-translate.mjs'));
    install(weekdayTranslator);
    const out = await freeTranslate({
      text: 'Leiter Umweltlabor (m/w/d)',
      sourceLang: 'de',
      targetLang: 'en',
      fieldType: 'title',
    });
    expect(out).not.toMatch(WEEKDAY_RE);
    expect(out).toContain('(m/f/d)');
  });

  it('emits the French form for a French target', async () => {
    if (!freeTranslate) ({ freeTranslate } = await import('@/scripts/lib/free-translate.mjs'));
    install(weekdayTranslator);
    const out = await freeTranslate({
      text: 'Leiter Umweltlabor (m/w/d)',
      sourceLang: 'de',
      targetLang: 'fr',
      fieldType: 'title',
    });
    expect(out).not.toMatch(WEEKDAY_RE);
    expect(out).toContain('(h/f/d)');
  });

  it('re-appends the code when the translator swallows the sentinel', async () => {
    if (!freeTranslate) ({ freeTranslate } = await import('@/scripts/lib/free-translate.mjs'));
    install((q) => q.replace(/ZQX\d+XQZ/gi, '').replace(/Leiter Umweltlabor/g, 'Environmental Lab Manager').trim());
    const out = await freeTranslate({
      text: 'Leiter Umweltlabor (m/w/d)',
      sourceLang: 'de',
      targetLang: 'en',
      fieldType: 'title',
    });
    expect(out).toBe('Environmental Lab Manager (m/f/d)');
  });

  it('strips a placeholder token the translator leaked into a title', async () => {
    if (!freeTranslate) ({ freeTranslate } = await import('@/scripts/lib/free-translate.mjs'));
    install(() => 'Environmental Lab Manager (COMPANY)');
    const out = await freeTranslate({
      text: 'Leiter Umweltlabor',
      sourceLang: 'de',
      targetLang: 'en',
      fieldType: 'title',
    });
    expect(out).toBe('Environmental Lab Manager');
  });

  it('leaves text without a gender code byte-identical to the tier output', async () => {
    if (!freeTranslate) ({ freeTranslate } = await import('@/scripts/lib/free-translate.mjs'));
    install(() => 'Environmental Lab Manager 80-100%');
    const out = await freeTranslate({
      text: 'Leiter Umweltlabor 80-100%',
      sourceLang: 'de',
      targetLang: 'en',
      fieldType: 'title',
    });
    expect(out).toBe('Environmental Lab Manager 80-100%');
  });
});

/**
 * Integration: the THIRD writer — the Argos mop-up tier (local-mt-mopup.mjs).
 *
 * It is not "one more caller": its own header calls it the producer of the BULK
 * of the mop-up-translated corpus, and it writes straight into
 * data/jobs/by-crawler/*.json, the dataset assemble-jobs-dataset.mjs turns into
 * published SEO titles. Fixing only the HTTP cascade and the local pipeline
 * would have left the defect alive on the highest-volume path.
 *
 * The mop-up splits the guard across two loops (mask when the JSONL batch is
 * built, restore when the results are merged back), so both halves are exercised
 * here: mask → fake Argos → finalize.
 */
describe('local-mt mop-up (Argos tier) — the third writer uses the same exit point', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mopup: any;
  beforeAll(async () => {
    mopup = await import('@/scripts/local-mt-mopup.mjs');
  });

  // The Python/Argos engine, faked: it expands the gender code as weekdays
  // exactly like the live translators did.
  const argos = (q: string) => q
    .replace(/Leiter/g, 'Responsabile')
    .replace(/Umweltlabor/g, 'del Laboratorio Ambientale')
    .replace(/\(\s*m\s*\/\s*w\s*\/\s*d\s*\)/gi, '(lunedì/mercoledì/d)');

  const roundTrip = (
    source: string,
    engine: (q: string) => string,
    targetLang: string,
    fieldType: 'title' | 'description' = 'title',
  ) => {
    const { request, protectedTokens } = mopup.buildMopupRequest({
      id: 'r0', text: source, from: 'de', to: targetLang,
    });
    return {
      sentToArgos: request.text,
      out: mopup.finalizeMopupTranslation({
        sourceText: source,
        rawText: engine(request.text),
        targetLang,
        fieldType,
        protectedTokens,
      }),
    };
  };

  it('never hands the raw gender code to the Python engine', () => {
    const { request, protectedTokens } = mopup.buildMopupRequest({
      id: 'r0', text: 'Leiter Umweltlabor (m/w/d)', from: 'de', to: 'it',
    });
    expect(request.text).toBe('Leiter Umweltlabor ZQX0XQZ');
    expect(request.text).not.toContain('m/w/d');
    expect(protectedTokens).toHaveLength(1);
    // The rest of the request envelope is untouched — the Python worker still
    // reads the same JSONL shape.
    expect(request.id).toBe('r0');
    expect(request.from).toBe('de');
    expect(request.to).toBe('it');
  });

  it('emits the locale form instead of weekday names (it target)', () => {
    const { out } = roundTrip('Leiter Umweltlabor (m/w/d)', argos, 'it');
    expect(out).not.toMatch(WEEKDAY_RE);
    expect(out).toBe('Responsabile del Laboratorio Ambientale (m/f/d)');
  });

  it('emits the French form for a French target', () => {
    const { out } = roundTrip('Leiter Umweltlabor (m/w/d)', argos, 'fr');
    expect(out).not.toMatch(WEEKDAY_RE);
    expect(out).toContain('(h/f/d)');
  });

  it('localizes a raw (m/w/d) Argos copied through verbatim — the 18/179 case', () => {
    // Engine returns the German code untouched: no sentinel involved, the
    // restore ladder's raw-trigraph step has to catch it.
    const { out } = roundTrip('Leiter Umweltlabor (m/w/d)', (q) => q.replace(/ZQX\d+XQZ/g, '(m/w/d)').replace(/Leiter Umweltlabor/, 'Responsabile del Laboratorio Ambientale'), 'it');
    expect(out).toBe('Responsabile del Laboratorio Ambientale (m/f/d)');
  });

  it('re-appends the code when the engine swallows the sentinel (title)', () => {
    const { out } = roundTrip(
      'Leiter Umweltlabor (m/w/d)',
      (q) => q.replace(/ZQX\d+XQZ/g, '').replace(/Leiter Umweltlabor/, 'Responsabile del Laboratorio Ambientale').trim(),
      'it',
    );
    expect(out).toBe('Responsabile del Laboratorio Ambientale (m/f/d)');
  });

  it('does NOT re-append into a description body when the sentinel is dropped', () => {
    const { out } = roundTrip(
      'Leiter Umweltlabor (m/w/d) gesucht',
      (q) => q.replace(/ZQX\d+XQZ/g, '').replace(/Leiter Umweltlabor/, 'Cerchiamo un responsabile del laboratorio ambientale').replace(/gesucht/, '').trim(),
      'it',
      'description',
    );
    expect(out).not.toMatch(/\(m\/f\/d\)/);
    expect(out).not.toMatch(WEEKDAY_RE);
  });

  it('applies the protected-term glossary to the Argos output', () => {
    const { out } = roundTrip(
      'Pflegefachperson Nachtwache',
      () => "Persona per l'orologio notturno",
      'it',
    );
    expect(out).toBe('Persona per la guardia notturna');
  });

  it('strips a template placeholder the engine leaked into a title', () => {
    const { out } = roundTrip('Leiter Umweltlabor', () => 'Responsabile Laboratorio (ORGANIZZAZIONE)', 'it');
    expect(out).toBe('Responsabile Laboratorio');
  });

  it('returns "" when nothing meaningful survives, so the caller skips the write', () => {
    const { out } = roundTrip('Mitarbeiter Verkauf', () => '(ORGANIZZAZIONE)', 'it');
    expect(out).toBe('');
  });

  it('sends the source byte-identical when there is nothing to protect', () => {
    const source = 'Bauingenieur 80-100% — Lugano';
    const { sentToArgos, out } = roundTrip(source, () => 'Ingegnere civile 80-100% — Lugano', 'it');
    expect(sentToArgos).toBe(source);
    expect(out).toBe('Ingegnere civile 80-100% — Lugano');
  });

  it('importing the module does not run the mop-up (no scan, no Python spawn)', () => {
    // main() sits behind a direct-invocation guard: without it, importing the
    // module would scan data/jobs/by-crawler, seed the shared run clock, and
    // spawn the Python worker.
    expect(Object.keys(mopup).sort()).toEqual(['buildMopupRequest', 'finalizeMopupTranslation']);
  });
});

/**
 * Drift guard for the property the PR body claims: the corpus has THREE
 * translation writers, and all three reach the glossary through the single
 * shared exit point. A fourth writer that imports `applyGlossaryCorrections`
 * directly would silently skip the token restore and the placeholder strip —
 * which is exactly how local-mt-mopup.mjs came to be the odd one out.
 */
describe('translation writers — every scripts/ caller routes through finalizeTranslatedText', () => {
  const SCRIPTS_DIR = path.join(process.cwd(), 'scripts');

  const walk = (dir: string, acc: string[] = []): string[] => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, acc);
      else if (entry.name.endsWith('.mjs') && entry.name !== 'translation-glossary.mjs') acc.push(full);
    }
    return acc;
  };

  const importers = walk(SCRIPTS_DIR)
    .map((file) => ({ file, src: fs.readFileSync(file, 'utf-8') }))
    .filter(({ src }) => /from\s+['"][^'"]*translation-glossary\.mjs['"]/.test(src));

  // A WRITER persists translated output and must therefore mask before the
  // translation call and restore/finalize after (both halves of the guard).
  // A READER only calls a pure detection/localization helper on already-
  // stored text (e.g. an audit counting how many titles still carry a raw
  // gender code) — it never sends anything to a translator, so requiring it
  // to import mask/finalize would be a false demand. The split is by import,
  // not by guesswork: a writer is exactly one that imports either half.
  const writers = importers.filter(({ src }) => /maskProtectedTokens|finalizeTranslatedText/.test(src));
  const readers = importers.filter(({ src }) => !/maskProtectedTokens|finalizeTranslatedText/.test(src));

  it('finds every known writer (and notices a new one)', () => {
    const rel = writers.map(({ file }) => path.relative(SCRIPTS_DIR, file)).sort();
    expect(rel).toEqual([
      'lib/free-translate.mjs',
      'lib/job-localization-pipeline.mjs',
      'local-mt-mopup.mjs',
    ]);
  });

  it('finds every known read-only reader of the glossary (and notices a new one)', () => {
    // #5587 item2: audit-job-title-locale.mjs reads localizeGenderTrigraphs to
    // COUNT unlocalized trigraphs — it never writes a translation, so it is
    // deliberately not held to the writer contract below.
    const rel = readers.map(({ file }) => path.relative(SCRIPTS_DIR, file)).sort();
    expect(rel).toEqual(['audit-job-title-locale.mjs']);
  });

  it('none of them calls applyGlossaryCorrections directly', () => {
    for (const { file, src } of importers) {
      expect(src, `${path.relative(SCRIPTS_DIR, file)} bypasses the shared exit point`)
        .not.toMatch(/applyGlossaryCorrections/);
    }
  });

  it('each WRITER imports BOTH halves of the guard (mask + finalize)', () => {
    for (const { file, src } of writers) {
      const name = path.relative(SCRIPTS_DIR, file);
      expect(src, `${name} does not import maskProtectedTokens`).toMatch(/maskProtectedTokens/);
      expect(src, `${name} does not import finalizeTranslatedText`).toMatch(/finalizeTranslatedText/);
    }
  });
});
