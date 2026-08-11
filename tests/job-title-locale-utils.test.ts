import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TITLE_OVERLAP_THRESHOLD,
  MIN_OVERLAP_TOKENS,
  TITLE_LANG_ADVISORY_CONFIDENCE,
  TITLE_LANG_CONFIDENCE_FLOOR,
  TITLE_LANG_DECISION_CONFIDENCE,
  detectJobTitleLang,
  detectJobTitleLocaleDetails,
  pinnedTitleSourceLang,
  titleLooksUntranslated,
  titleLooksUntranslatedFromSource,
} from '../scripts/lib/job-locale-utils.mjs';

describe('job title locale utils', () => {
  it('detects english titles even when the description source is different', () => {
    expect(detectJobTitleLang('Banking All-Rounder', 'it')).toBe('en');
    expect(detectJobTitleLang('Quality Technician (80-100%)', 'it')).toBe('en');
  });

  it('detects obvious german and italian job titles reliably', () => {
    expect(detectJobTitleLang('Arztsekretär:in Onkologie / Hämatologie', 'it')).toBe('de');
    expect(detectJobTitleLang('Tecnico/a di radiologia medica', 'en')).toBe('it');
  });

  it('returns confident locale details for titles with strong markers', () => {
    const detected = detectJobTitleLocaleDetails('Technicien Qualité (80-100%)', 'en');
    expect(detected.lang).toBe('fr');
    expect(detected.confidence).toBeGreaterThanOrEqual(0.55);
  });

  // Regression (2026-07-27 live bug): "Fachperson Gesundheit Universitäre Klinik
  // für Altersmedizin" (Stadtspital Zürich, DE-source) shipped completely
  // untranslated into an IT-locale subscriber's job-alert email. None of
  // fachperson/gesundheit/universitäre/klinik/altersmedizin had word-hint
  // support in TITLE_HINTS.de, so detection fell through to the weak
  // char-hint-only tier (0.45, driven solely by the "ä" diacritic) — under the
  // 0.55 needsRetranslation threshold in dedicated-crawler-common.mjs. Health-
  // sector vocabulary added to TITLE_HINTS.de now gives genuine word support.
  it('detects the Stadtspital Zürich leftover-German title as German with word support', () => {
    const detected = detectJobTitleLocaleDetails(
      'Fachperson Gesundheit Universitäre Klinik per Altersmedizin', 'it'
    );
    expect(detected.lang).toBe('de');
    expect(detected.confidence).toBeGreaterThanOrEqual(0.55);
    expect(detected.method).not.toBe('char-hint-only');
  });
});

describe('titleLooksUntranslatedFromSource (generic leftover-source-language check)', () => {
  it('flags DE-source titles left untranslated in the IT slot (klinik-lengg.json)', () => {
    expect(titleLooksUntranslatedFromSource(
      'Fachfrau / Fachmann Gesundheit Neurorehabilitation (a) im Früh- e Spätdienst', 'de', 'it'
    )).toBe(true);
  });

  it('does not flag same-locale or empty input', () => {
    expect(titleLooksUntranslatedFromSource('Infermiere', 'it', 'it')).toBe(false);
    expect(titleLooksUntranslatedFromSource('', 'de', 'it')).toBe(false);
  });

  // Regression (PR #4728 review): a correctly-translated title carrying a German
  // place name (e.g. "Zürich") must not be flagged as untranslated. The bare 'ü'
  // diacritic alone triggered TITLE_CHAR_HINTS.de with no actual German word-hint
  // match — detectJobTitleLocaleDetails now requires word-hint support before
  // granting the confident tiers, so a toponym alone can no longer cross the bar.
  it('does not flag an already-translated title that only contains a german toponym', () => {
    // real production record: data/jobs/by-crawler/banca-cler.json, job company-fje5to
    const detected = detectJobTitleLocaleDetails('Consulente clienti Individual Zürich (f/m) 80 - 100 %', 'it');
    expect(detected.method).toBe('char-hint-only');
    expect(detected.confidence).toBeLessThan(0.55);
    expect(titleLooksUntranslatedFromSource(
      'Consulente clienti Individual Zürich (f/m) 80 - 100 %', 'de', 'it'
    )).toBe(false);
    expect(titleLooksUntranslatedFromSource(
      'Customer consultant Individual Zürich (f/m) 80 - 100 %', 'de', 'en'
    )).toBe(false);
    expect(titleLooksUntranslatedFromSource(
      'Consultant client Zürich individuel (f/m) 80 - 100 %', 'de', 'fr'
    )).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// titleLooksUntranslated — the primitive PRs B/C/D consume.
//
// Live bug (2026-08-10): four Italian job pages under /cerca-lavoro-argovia/
// rendered German <h1>s while the translation-completeness gate reported 100%
// coverage. The strings below are verbatim from the live site, including the
// correctly-translated EN/FR sibling slots of the same four jobs — those are
// the false-positive traps, because they share brand tokens ("Toyota",
// "Lexus") and inclusive-gender punctuation with the German source.
// ─────────────────────────────────────────────────────────────────────────────

const SOURCE_TITLES = {
  zurzach: 'Physiotherapeut/in Stationär mit Fachverantwortung Neurologie 60-100 % — ZURZACH Care',
  ikea: 'Regionale:r Berufsbildungsverantwortliche:r 50% — IKEA',
  ksa: 'Med. Praxisassistent/in — Kantonsspital Aarau (KSA)',
  emilFrey: 'Kursleiter / Trainer für Toyota und Lexus — Emil Frey',
};

const flag = (title: string, targetLocale: string, sourceTitle = '', company = '') =>
  titleLooksUntranslated({ title, sourceTitle, sourceLang: 'de', targetLocale, company });

describe('titleLooksUntranslated — the four reported IT slots', () => {
  it('flags a title where only the function word was translated (mit → con)', () => {
    const res = flag(
      'Physiotherapeut/in Stationär con Fachverantwortung Neurologie 60-100 % — ZURZACH Care',
      'it', SOURCE_TITLES.zurzach, 'ZURZACH Care',
    );
    expect(res.untranslated).toBe(true);
    expect(res.overlap).toBeGreaterThanOrEqual(DEFAULT_TITLE_OVERLAP_THRESHOLD);
  });

  // The case content-token overlap alone cannot reach: the long German noun
  // really was translated and only the ":r" gender suffix survived, so overlap
  // is 0.50. Caught by the marker signal instead.
  it('flags the partially-translated IKEA title that scores only 0.50 overlap', () => {
    const res = flag('Regionale:r Responsabile VET:r 50% — IKEA', 'it', SOURCE_TITLES.ikea, 'IKEA');
    expect(res.untranslated).toBe(true);
    expect(res.reason).toBe('binnen-i');
    expect(res.overlap).toBeLessThan(DEFAULT_TITLE_OVERLAP_THRESHOLD);
  });

  it('flags the KSA title where only the diploma code was translated (EFZ → CFC)', () => {
    expect(flag('Med. Praxisassistent/in CFC — Kantonsspital Aarau (KSA)', 'it',
      SOURCE_TITLES.ksa, 'Kantonsspital Aarau (KSA)').untranslated).toBe(true);
  });

  it('flags the Emil Frey title where only für/und were translated', () => {
    expect(flag('Kursleiter / Trainer per Toyota e Lexus — Emil Frey', 'it',
      SOURCE_TITLES.emilFrey, 'Emil Frey').untranslated).toBe(true);
  });

  // D1: today's guard returns FALSE here. A 100% untranslated German title
  // lands in the char-hint-only tier at 0.45, structurally under the 0.55 bar
  // titleLooksUntranslatedFromSource compared it against.
  it('flags a 100%-untranslated German control, which the old guard passed', () => {
    const control = 'Physiotherapeut/in Stationär mit Fachverantwortung Neurologie';
    const res = flag(control, 'it', control);
    expect(res.untranslated).toBe(true);
    expect(res.reason).toBe('source-copy');
    expect(titleLooksUntranslatedFromSource(control, 'de', 'it')).toBe(true);
  });
});

describe('titleLooksUntranslated — correctly-translated sibling slots must stay clean', () => {
  const clean: Array<[string, string, string, string]> = [
    ['en', 'Physiotherapist/inpatient responsible neurology 60-100 % — ZURZACH Care', SOURCE_TITLES.zurzach, 'ZURZACH Care'],
    ['fr', 'Physiothérapeute/inpatient neurologie responsable 60-100 % — ZURZACH Care', SOURCE_TITLES.zurzach, 'ZURZACH Care'],
    ['en', 'Regional:r VET managers:r 50% — IKEA', SOURCE_TITLES.ikea, 'IKEA'],
    ['fr', 'Gestionnaires régionaux de la FEP: 50 % — IKEA', SOURCE_TITLES.ikea, 'IKEA'],
    ['en', 'Med. Practical assistant/EFZ — Kantonsspital Aarau (KSA)', SOURCE_TITLES.ksa, 'Kantonsspital Aarau (KSA)'],
    ['fr', 'Médicament. Assistant pratique/EFZ — Kantonsspital Aarau (KSA)', SOURCE_TITLES.ksa, 'Kantonsspital Aarau (KSA)'],
    ['en', 'Instructor / Trainer for Toyota and Lexus — Emil Frey', SOURCE_TITLES.emilFrey, 'Emil Frey'],
    ['fr', 'Instructeur / formateur pour Toyota et Lexus — Emil Frey', SOURCE_TITLES.emilFrey, 'Emil Frey'],
  ];

  for (const [locale, title, sourceTitle, company] of clean) {
    it(`does not flag the correct ${locale} slot: ${title.slice(0, 44)}…`, () => {
      const res = flag(title, locale, sourceTitle, company);
      expect(res.untranslated).toBe(false);
      expect(res.reason).toBe('ok');
    });
  }

  // Stripping the employer suffix is what makes this one pass: with " — Emil
  // Frey" left in, the shared brand tokens push the correct English title to
  // 0.83 overlap and it false-positives.
  it('keeps the Emil Frey EN trap under the overlap threshold only because the company is stripped', () => {
    const withCompany = flag('Instructor / Trainer for Toyota and Lexus — Emil Frey', 'en',
      SOURCE_TITLES.emilFrey, 'Emil Frey');
    expect(withCompany.overlap).toBeLessThan(DEFAULT_TITLE_OVERLAP_THRESHOLD);
  });

  it('does not flag a correct title carrying a German toponym', () => {
    expect(flag('Consulente clienti Individual Zürich (f/m) 80 - 100 %', 'it').untranslated).toBe(false);
  });
});

describe('titleLooksUntranslated — contract edges', () => {
  it('returns untranslated:false when sourceLang === targetLocale', () => {
    expect(titleLooksUntranslated({
      title: 'Pflegefachfrau Gesundheit', sourceLang: 'de', targetLocale: 'de',
    }).untranslated).toBe(false);
  });

  it('never throws on missing or empty sourceTitle and degrades to the marker signal', () => {
    expect(() => titleLooksUntranslated({ title: 'Lüftung Projektleiter', sourceLang: 'de', targetLocale: 'it' })).not.toThrow();
    expect(titleLooksUntranslated({ title: 'Lüftung Projektleiter', sourceLang: 'de', targetLocale: 'it' }).untranslated).toBe(true);
    expect(titleLooksUntranslated({ title: 'Infermiere di reparto', sourceTitle: '', sourceLang: 'de', targetLocale: 'it' }).untranslated).toBe(false);
    expect(titleLooksUntranslated({}).untranslated).toBe(false);
  });

  it('returns the documented shape', () => {
    const res = titleLooksUntranslated({ title: 'Lüftung', sourceLang: 'de', targetLocale: 'it' });
    expect(res).toMatchObject({
      untranslated: expect.any(Boolean),
      reason: expect.any(String),
      overlap: expect.any(Number),
      detected: { lang: expect.any(String), confidence: expect.any(Number) },
    });
  });

  // The overlap ratio has no resolution on two-token titles: one shared token
  // already scores 0.50. Measured false positives were exactly this shape.
  it('does not let the overlap signal decide below MIN_OVERLAP_TOKENS', () => {
    const res = titleLooksUntranslated({
      title: '2nd Level Support Ingénieur', sourceTitle: '2nd Level Support Ingenieur',
      sourceLang: 'de', targetLocale: 'fr',
    });
    expect(res.overlap).toBeGreaterThanOrEqual(DEFAULT_TITLE_OVERLAP_THRESHOLD);
    expect(res.untranslated).toBe(false);
    expect(MIN_OVERLAP_TOKENS).toBeGreaterThanOrEqual(4);
  });

  // A wrong-locale gender code is a locale inconsistency, not a wrong-language
  // title. 18 otherwise-correct titles in the calibration corpus carry one, so
  // folding it into the verdict would cost ~15% false positives on clean text.
  it('reports a wrong-locale gender code without flagging the title by default', () => {
    const args = { title: 'Responsabile IT Division Hydroenergie e Biomasse (w/m/d)', sourceLang: 'de', targetLocale: 'it' };
    expect(titleLooksUntranslated(args).untranslated).toBe(false);
    expect(titleLooksUntranslated(args).genderCode).toBe(true);
    expect(titleLooksUntranslated({ ...args, flagGenderCode: true })).toMatchObject({
      untranslated: true, reason: 'gender-code',
    });
  });
});

// The dominant real-world failure: one or two German words left inside an
// otherwise-Italian title. Verbatim IT slots from the live site; no sourceTitle
// is supplied, so every one of these must be caught by the marker signal alone.
describe('titleLooksUntranslated — partial German residue in IT slots (no sourceTitle)', () => {
  const partials: Array<[string, string]> = [
    ['Responsabile di progetto Lüftung 80 - 100%', 'source-orthography'],
    ['Responsabile di progetto Gebäudeautomation', 'source-orthography'],
    ['Responsabile Maschinen- e Transformatorentechnik (alle)', 'compound-residue'],
    ['Still- e Laktationsberater/in', 'compound-residue'],
    ['Sanitär-/Heizungsinstallateur/in (100%)', 'source-orthography'],
    ['Collaboratore/trice Warenverräumung (m/w/d)', 'source-orthography'],
    ['Collaboratore/trice Qualitätssicherung Wareneingang (m/w/d)', 'source-orthography'],
    ['MPA / Disposition 100% - Fachbereiche Endokrinologie e Stoffwechsel', 'compound-residue'],
    ['Apprendistato 2027 Automobil-Mechatronikerin / -Mechatroniker CFC Nutzfahrzeuge', 'compound-residue'],
    ['Pflegeexpertin / Pflegeexperte con übergeordneten Tätigkeiten', 'compound-residue'],
    ['Dipl. Expertin/Experte IPS NDS HF (bei Interesse con Fachverantwortung, 70-100%)', 'source-function-word'],
    ['1 Ausbildungsplatz come Informatiker/in CFC (specializzazione Plattformentwicklung)', 'compound-residue'],
    ['Responsabile di progetto Tief-, Strassen- e Bahnbau 80-100% - Brig', 'compound-residue'],
  ];

  for (const [title, reason] of partials) {
    it(`flags: ${title.slice(0, 52)}…`, () => {
      const res = titleLooksUntranslated({ title, sourceLang: 'de', targetLocale: 'it' });
      expect(res.untranslated).toBe(true);
      expect(res.reason).toBe(reason);
    });
  }

  // The translator emits German inclusive-gender forms with a space after the
  // separator ("Verkäufer:in" → "Consulente di vendita: in cosmetici"). Before
  // this was matched it was the single largest miss family in the corpus.
  it('flags the space-separated Binnen-I the translator produces', () => {
    for (const title of [
      'Consulente di vendita: in cosmetici',
      'Conduttore Rayon: in prodotti freschi',
      'Aiuto Venditore: in Food/Non-Food',
    ]) {
      expect(titleLooksUntranslated({ title, sourceLang: 'de', targetLocale: 'it' })).toMatchObject({
        untranslated: true, reason: 'binnen-i',
      });
    }
    expect(titleLooksUntranslated({
      title: 'Intern* in Controlling (1 year on a temporary basis)', sourceLang: 'de', targetLocale: 'en',
    }).untranslated).toBe(true);
  });

  // Follow-up of #5574 (item 2 of #5592): `/in` matched the plain slash form
  // but not the hyphenated translator artifact "Dipendente/-in" (source
  // "Mitarbeiter/-in") — 6 live slots slipped through undetected.
  it('flags the hyphenated slash Binnen-I artifact "Dipendente/-in"', () => {
    expect(titleLooksUntranslated({
      title: 'Dipendente/-in Vendita 80-100%', sourceLang: 'de', targetLocale: 'it',
    })).toMatchObject({ untranslated: true, reason: 'binnen-i' });
  });

  // Correct Italian that a looser German-morphology rule swallowed: "assistenza"
  // is not "Assistenz", "Socio-Sanitario" is not "Sanitär". These were measured
  // false positives.
  it('does not mistake Italian morphology for German compounds', () => {
    for (const title of [
      'Tecnico di assistenza (tutti)',
      'Senior medico / Senior medico / Assistenza sanitaria',
      'Operatore Socio-Sanitario (HF / FaGe / MPA)',
      'Addetto alle vendite Food/Non-Food',
      'Young Professional Controlling',
    ]) {
      expect(titleLooksUntranslated({ title, sourceLang: 'de', targetLocale: 'it' }).untranslated).toBe(false);
    }
  });

  // The orthography signal used to be case-sensitive (`/[äöüß]/` with no `i`
  // flag), so an all-caps German title slipped past it entirely — the umlaut
  // was there, just uppercase. Follow-up of #5574.
  it('catches uppercase umlaut orthography (all-caps German titles)', () => {
    expect(titleLooksUntranslated({
      title: 'GRÜEZI TEAM MITGLIED', sourceLang: 'de', targetLocale: 'it',
    })).toMatchObject({ untranslated: true, reason: 'source-orthography', evidence: 'GRÜEZI' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-language homographs in the marker lexicon.
//
// The 179-entry calibration corpus is too small to expose these: each family is
// a single lexicon entry that happens to be an ordinary word in one of the other
// three locales, so it only shows up at dataset scale. Measured over all 79,754
// non-source title slots in data/jobs/by-crawler (2026-08-10) BEFORE the fix:
//
//   marker                          flags   what it actually matched
//   de functionWords `des`          2,209   the French partitive article (2,192
//                                           of them in a correct FR slot)
//   DE_EXACT_TOKENS `installateur`    279   the identically-spelled French noun
//                                           (277 in a correct FR slot)
//   fr functionWords `sous`            19   "Sous Chef", a culinary borrowing
//                                           used verbatim in it/en/de (19 of 19)
//   DE_CLUSTER_RE on English roots    ~127  Switzerland, Watchmaker, Switchgear,
//                                           Benchmarking, Attachments, …
//   DE_PREFIX_RE `ober` on toponyms   ~110  Oberland, Oberwallis, Oberaargau, …
//
// Every string below is verbatim from that dataset or a minimal paraphrase of
// one, and every one of them flagged before the lexicon was corrected.
// ─────────────────────────────────────────────────────────────────────────────
describe('titleLooksUntranslated — cross-language homographs must not flag', () => {
  const cleanCases: Array<[string, string, string, string]> = [
    // `des` — the single largest false-positive family (8.2% of all flags).
    ['des: correct French, German article homograph', 'Directeur des ventes - constructeurs de panneaux (80-100%)', 'fr', 'de'],
    ['des: French apprenticeship title', 'Apprentissage 2027 comme spécialiste des restaurants EFZ', 'fr', 'de'],
    ['des: French HR title', 'Responsable des ressources humaines', 'fr', 'de'],
    // `installateur` — spelled identically in French and German.
    ['installateur: correct French trade title', 'Installateur sanitaire CFC (80-100%)', 'fr', 'de'],
    ['installateur: correct French compound', 'Installateur-électricien CFC', 'fr', 'de'],
    // DE_CLUSTER_RE `tz` / `chm` / `chg` / `chs` on English roots.
    ['tz: English "Switzerland"', 'Regional Sales Manager Cardiac Rhythm Management - Region Central Switzerland', 'en', 'de'],
    ['tz: English "Switzerland" again', 'Territory Manager Cardiology - Region German-speaking Switzerland', 'en', 'de'],
    ['chm: English "Watchmaker"', 'Watchmaker for high-end complications (100%)', 'en', 'de'],
    ['chg: English "Switchgear"', 'Project Engineer Switchgear Systems', 'en', 'de'],
    ['chm: English "Benchmarking"', 'Benchmarking Analyst Compensation', 'en', 'de'],
    // `sous` — "Sous Chef" is the same token in all four locales.
    ['sous: Italian kitchen brigade title', 'Sous Chef 100%', 'it', 'de'],
    ['sous: English kitchen brigade title', 'Junior Sous Chef 100%', 'en', 'de'],
    // DE_PREFIX_RE `ober` on Swiss place names.
    ['ober: Swiss toponym in an Italian title', 'Consulente clienti Oberland bernese 80%', 'it', 'de'],
    ['ober: Swiss toponym in an English title', 'Service Technician Oberwallis', 'en', 'de'],
  ];

  for (const [label, title, targetLocale, sourceLang] of cleanCases) {
    it(`stays clean — ${label}`, () => {
      const res = titleLooksUntranslated({ title, sourceLang, targetLocale });
      expect(res.reason).toBe('ok');
      expect(res.untranslated).toBe(false);
    });
  }

  // The homograph fixes must not cost recall on the German words that share the
  // rule. `tz` still has to reach "Metzger" (292 flags in the same sweep) and
  // `ober` still has to reach "Oberarzt" (173); `installateur` is still German
  // inside a compound; `des` is still German residue when anything else in the
  // title says so.
  const stillFlagged: Array<[string, string]> = [
    ['Aiuto Metzger 60-100%', 'compound-residue'],
    ['Apprendistato 2027 Automobil-Mechatroniker CFC Nutzfahrzeuge', 'compound-residue'],
    ['Oberarzt (m/w/d) Psychiatrie', 'compound-residue'],
    ['Oberärztin Anästhesie 80%', 'source-orthography'],
    ['Sanitärinstallateur/in (100%)', 'source-orthography'],
    ['Responsabile di progetto Heizungsinstallateur 80%', 'compound-residue'],
    ['Mitglied des Verwaltungsrates - Finanz- e Rechnungswesen', 'compound-residue'],
    ['Einrichter:in Spritzguss / Estrusione (80-100%)', 'compound-residue'],
  ];
  for (const [title, reason] of stillFlagged) {
    it(`still flags real German residue: ${title.slice(0, 46)}…`, () => {
      const res = titleLooksUntranslated({ title, sourceLang: 'de', targetLocale: 'it' });
      expect(res.untranslated).toBe(true);
      expect(res.reason).toBe(reason);
    });
  }

  // The reason `des` was removed rather than reclassified as a FRENCH marker
  // (which the ALWAYS_SCANNED_MARKER_LANGS mechanism would then keep out of the
  // FR slot by construction): the fr marker set IS scanned against `de` slots,
  // and 78 correct German titles in a non-source `de` slot carry the genitive
  // "des". Reclassifying would have swapped 2,192 French false positives for 78
  // German ones and bought only 3 extra true positives. Measured, not assumed.
  it('does not flag correct German carrying the genitive "des" in a de slot', () => {
    const res = titleLooksUntranslated({
      title: 'Leiter des Referats Gebaudemanagementsysteme', sourceLang: 'fr', targetLocale: 'de',
    });
    expect(res.untranslated).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Calibration corpus — 197 labelled title slots sampled from the live site.
// This is a RATCHET: raise the constants when a change improves the numbers,
// never lower them to make a regression pass. Rates, not counts, so the gate
// does not flicker if the fixture is ever resampled (see the workspace memory
// note on absolute-count ratchets).
//
// The fixture was revised on 2026-08-10 (see _meta.revisions): 8 entries were
// labelled broken:true on the strength of an ordinary word in their own locale
// — "des" in French, "alle" in Italian — because the labelling rule and the
// detector shared the same lexicon bug. Numbers measured before and after that
// revision are NOT comparable, so the honest comparison is both detectors
// against the corrected labels, on the ORIGINAL 179 entries only (i.e. with the
// 18 entries this PR added excluded, so curation cannot flatter the result):
//
//              precision   recall   fp-rate
//   before        88.14%   100.00%    5.51%
//   after         96.30%   100.00%    1.57%
//
// Recall cost of the false-positive fix: zero, on the corpus and on the full
// 79,754-slot dataset (there the flag rate moves 30.16% → 27.39%, and the only
// slots that stopped flagging for a defensible reason are ~13 whose sole marker
// was a Swiss toponym).
// ─────────────────────────────────────────────────────────────────────────────
describe('titleLooksUntranslated — calibration corpus ratchet', () => {
  const corpus = JSON.parse(
    readFileSync(new URL('./fixtures/title-locale-corpus.json', import.meta.url), 'utf8')
  ) as {
    _meta: Record<string, unknown>;
    entries: Array<{
      title: string; sourceTitle?: string; sourceLang: string; targetLocale: string;
      company?: string; location?: string; broken: boolean;
    }>;
  };

  const scored = corpus.entries.map((e) => ({
    broken: !!e.broken,
    predicted: titleLooksUntranslated({
      title: e.title,
      sourceTitle: e.sourceTitle || '',
      sourceLang: e.sourceLang,
      targetLocale: e.targetLocale,
      company: e.company || '',
      location: e.location || '',
    }).untranslated,
  }));

  const tp = scored.filter((r) => r.predicted && r.broken).length;
  const fp = scored.filter((r) => r.predicted && !r.broken).length;
  const fn = scored.filter((r) => !r.predicted && r.broken).length;
  const tn = scored.filter((r) => !r.predicted && !r.broken).length;

  it('keeps the fixture and its provenance intact', () => {
    expect(corpus.entries.length).toBeGreaterThanOrEqual(197);
    expect(corpus._meta).toHaveProperty('labellingRule');
    expect(corpus._meta).toHaveProperty('caveat');
    // Any future relabelling must leave the same audit trail this one did.
    expect(corpus._meta).toHaveProperty('revisions');
    expect(tp + fp + fn + tn).toBe(corpus.entries.length);
  });

  // Measured 96.77%. Deliberately NOT raised past 0.96 even though the number
  // improved: the 2026-08-10 label revision means the old 96.61% and this
  // 96.77% are computed against different ground truth, and 96.77% is two
  // entries of headroom on 62 positives. The fp-rate ratchet below is the one
  // that was tightened, because it is the number this detector's users feel.
  it('holds precision at or above 96% on the labelled corpus', () => {
    expect(tp / (tp + fp)).toBeGreaterThanOrEqual(0.96);
  });

  // Raised 0.95 → 0.98 (measured 100.00%). The false-positive pass cost no
  // recall at all, so the old floor no longer describes the detector.
  it('holds recall at or above 98% on the labelled corpus', () => {
    expect(tp / (tp + fn)).toBeGreaterThanOrEqual(0.98);
  });

  // The failure mode that would make this gate unusable is over-flagging
  // correct titles, so the false-positive rate is ratcheted hardest. Tightened
  // 2% → 1.8% (measured 1.46%): the repair queue is throughput-bound on a
  // quota-limited translation cascade, so every false positive here is a real
  // broken page that does not get repaired.
  it('holds the false-positive rate on correct titles at or below 1.8%', () => {
    expect(fp / (fp + tn)).toBeLessThanOrEqual(0.018);
  });

  it('never flags a source-language slot (guaranteed negatives)', () => {
    const sourceSlots = corpus.entries.filter((e) => e.sourceLang === e.targetLocale);
    expect(sourceSlots.length).toBeGreaterThan(0);
    for (const e of sourceSlots) {
      expect(titleLooksUntranslated({
        title: e.title, sourceTitle: e.sourceTitle || '', sourceLang: e.sourceLang,
        targetLocale: e.targetLocale, company: e.company || '', location: e.location || '',
      }).untranslated).toBe(false);
    }
  });
});

describe('detectJobTitleLocaleDetails confidence tiers (D1a)', () => {
  // The defect: `char-hint-only` was capped at 0.45 while every caller compared
  // it against 0.55, so the tier could not fire — a German title whose only
  // signal is an umlaut was structurally invisible. Asserting the relationship
  // rather than the numbers keeps a future re-tune honest.
  it('keeps the advisory ceiling below the decision threshold, and the supported tier above it', () => {
    expect(TITLE_LANG_ADVISORY_CONFIDENCE).toBeLessThan(TITLE_LANG_DECISION_CONFIDENCE);
    expect(TITLE_LANG_CONFIDENCE_FLOOR).toBeLessThan(TITLE_LANG_ADVISORY_CONFIDENCE);
    const supported = detectJobTitleLocaleDetails('Fachperson Gesundheit Universitäre Klinik per Altersmedizin', 'it');
    expect(supported.confidence).toBeGreaterThanOrEqual(TITLE_LANG_DECISION_CONFIDENCE);
  });

  it('marks the evidence-free tier advisory instead of pretending it is a verdict', () => {
    const detected = detectJobTitleLocaleDetails('Consulente clienti Individual Zürich (f/m) 80 - 100 %', 'it');
    expect(detected.method).toBe('char-hint-only');
    expect(detected.advisory).toBe(true);
    expect(detected.confidence).toBe(TITLE_LANG_ADVISORY_CONFIDENCE);
    // Still ≥ 0.35, the bar maybeRehomeLocalizedValue runs this detector against.
    expect(detected.confidence).toBeGreaterThanOrEqual(0.35);
  });

  // D1c: sub-floor confidence is absence of evidence. It must never be the
  // reason a title is treated as clean — the verdict is lexical.
  it('does not let garbage confidence clear an untranslated title', () => {
    // Measured: this German title detects as FRENCH at 0.07 confidence.
    const title = 'Med. Praxisassistent/in CFC — Kantonsspital Aarau (KSA)';
    const detected = detectJobTitleLocaleDetails(title, 'it');
    expect(detected.confidence).toBeLessThan(TITLE_LANG_CONFIDENCE_FLOOR);
    expect(detected.advisory).toBe(true);
    expect(titleLooksUntranslated({
      title, sourceLang: 'de', targetLocale: 'it', company: 'Kantonsspital Aarau (KSA)',
    }).untranslated).toBe(true);
  });
});

describe('pinnedTitleSourceLang (publisher-authored source-lang pin)', () => {
  // Regression: "Prompt engineer da remoto" (publisher-written ITALIAN title,
  // sourceLang:'it') is detected as EN by the title heuristics → the pipeline
  // "repaired" the IT slot to "Prompt Ingegnere da remoto", destroying the paid
  // copy on the live page. Publisher records pin their declared sourceLang.
  it('pins the declared sourceLang for publisher-submitted records', () => {
    const job = { source: 'publisher-submitted', sourceLang: 'it', title: 'Prompt engineer da remoto' };
    expect(pinnedTitleSourceLang(job)).toBe('it');
    // sanity: detection alone would have misclassified this title as EN
    expect(detectJobTitleLang(job.title, 'it')).toBe('en');
  });

  it('returns null for crawled jobs and invalid/missing sourceLang', () => {
    expect(pinnedTitleSourceLang({ source: 'lastminute', sourceLang: 'it' })).toBeNull();
    expect(pinnedTitleSourceLang({ source: 'publisher-submitted' })).toBeNull();
    expect(pinnedTitleSourceLang({ source: 'publisher-submitted', sourceLang: 'xx' })).toBeNull();
    expect(pinnedTitleSourceLang(null)).toBeNull();
  });
});
