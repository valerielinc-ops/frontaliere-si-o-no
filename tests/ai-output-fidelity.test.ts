/**
 * AI output fidelity guards (scripts/lib/ai-output-fidelity.mjs).
 *
 * Incident: swiss-medical-network `montchoisi-motionlab` published, in all four
 * locales, the formatter model's reasoning («Here's a thinking process: 1.
 * Analyze User Input: - Role: Job listing formatter …») instead of the ad. The
 * formatter accepted any answer ≥ 70 % of the input length; the monologue also
 * quoted the whole input, so it was 2.8× longer and sailed through.
 *
 * Every fixture here is pinned real data from origin/main (2026-09-29), not
 * data/**: the formatter pairs are (record description, source-locale slot)
 * and the leaked slots are all 31 found by the census over 153,199 slots.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  assessComposedFromInputs,
  assessVerbatimRestructure,
  detectAiReasoningLeak,
  detectDegenerateRepetition,
  VERBATIM_RESTRUCTURE_MIN_PRECISION,
  VERBATIM_RESTRUCTURE_MIN_RECALL,
} from '../scripts/lib/ai-output-fidelity.mjs';
import { resolveLocalePromptContext } from '../scripts/lib/shared-jobs-crawler.mjs';
import { isAcceptableTranslation } from '../scripts/lib/translation-quality.mjs';
import { isIncomplete } from '../scripts/relocalize-pending-jobs.mjs';

const FIXTURES = path.join(__dirname, 'fixtures', 'ai-output-fidelity');
const pairs = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'formatter-pairs.json'), 'utf8'));
const leaked = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'leaked-slots.json'), 'utf8'));
const degeneration = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'degenerate-slots.json'), 'utf8'));

// The same vocabulary shared-jobs-crawler passes: every localized heading.
const HEADINGS = [...new Set(['it', 'de', 'fr', 'en'].flatMap((l) => Object.values(resolveLocalePromptContext(l).headings)))];
const assess = (input: string, output: string) => assessVerbatimRestructure(input, output, { headingVocabulary: HEADINGS });

describe('detectAiReasoningLeak', () => {
  it('flags every leaked slot published on origin/main (31 slots, 6 crawlers, 4 languages, MT-garbled variants included)', () => {
    // 29 are the formatter's leak and its translations; 2 (ems-chemie `en`)
    // were born in the translation step itself («I'll translate this job
    // description from Italian to English. Let me first read … [{"tool_name": …»).
    expect(leaked.slots).toHaveLength(31);
    const missed = leaked.slots.filter((s: { text: string }) => !detectAiReasoningLeak(s.text));
    expect(missed.map((s: { crawler: string; slot: string }) => `${s.crawler}:${s.slot}`)).toEqual([]);
  });

  it('does not flag real ad text that shares words with the markers', () => {
    const realAdSentences = [
      // Real bullets that the first, naive census regex matched (fachkraft, sta, relewant, usz).
      'Systematisch und lösungsorientiert mit vernetztem Denkansatz Teamfähig, durchsetzungsstark, flexibel und bereit für Pikettdienst',
      '• Selbständige und strukturierte Arbeitsweise, lösungsorientierter Denkansatz, Autodidakt',
      'If you enjoy rethinking processes, taking responsibility and actively driving change, we look forward to getting to know you.',
      // Plausible ad openers built on the same words.
      'Ecco il processo di selezione: colloquio conoscitivo, prova pratica e incontro con il team.',
      'Vous participerez au processus de réflexion stratégique de la direction.',
      'Hier ist deine Chance: Wir suchen eine Pflegefachperson HF (80-100%).',
    ];
    for (const text of realAdSentences) expect(detectAiReasoningLeak(text), text).toBeNull();
  });

  it('does not flag the real, faithful formatter answers', () => {
    for (const p of pairs.accepted) expect(detectAiReasoningLeak(p.output), p.slug).toBeNull();
  });
});

describe('assessVerbatimRestructure — calibrated on real formatter answers', () => {
  it('accepts every faithful restructuring, with margin on both thresholds', () => {
    for (const p of pairs.accepted) {
      const verdict = assess(p.input, p.output);
      expect(verdict.ok, `${p.slug}: ${verdict.reason}`).toBe(true);
      expect(verdict.precision).toBeGreaterThanOrEqual(VERBATIM_RESTRUCTURE_MIN_PRECISION);
      expect(verdict.recall).toBeGreaterThanOrEqual(VERBATIM_RESTRUCTURE_MIN_RECALL);
    }
  });

  it('rejects the swiss-medical-network reasoning monologue even though it quotes the whole input', () => {
    const smn = pairs.rejected.find((p: { crawler: string }) => p.crawler === 'swiss-medical-network');
    // The old guard: output ≥ 70 % of the input length. The monologue passes it.
    expect(smn.output.length).toBeGreaterThanOrEqual(smn.input.length * 0.7);
    const verdict = assess(smn.input, smn.output);
    expect(verdict.ok).toBe(false);
    expect(verdict.recall).toBeGreaterThan(0.95); // it does carry the ad …
    // … buried in 2.8× as much commentary: the token invariant rejects it on
    // its own, independently of the marker list.
    expect(verdict.precision).toBeLessThan(0.5);
  });

  it('rejects a chatty preamble in front of a paraphrased formatting (ems-chemie)', () => {
    const ems = pairs.rejected.find((p: { crawler: string }) => p.crawler === 'ems-chemie');
    const verdict = assess(ems.input, ems.output);
    expect(verdict.ok).toBe(false);
    expect(verdict.precision).toBeLessThan(VERBATIM_RESTRUCTURE_MIN_PRECISION);
  });

  it('rejects a truncated answer (what the 70 % length check was for) and a duplicated one', () => {
    const eta = pairs.accepted.find((p: { crawler: string }) => p.crawler === 'eta-sa-swatch-group');
    const truncated = eta.output.slice(0, Math.floor(eta.output.length * 0.75));
    expect(assess(eta.input, truncated).reason).toMatch(/^dropped-content/);
    expect(assess(eta.input, `${eta.output}\n\n${eta.output}`).reason).toMatch(/^added-content/);
  });

  it('treats the prompt-suggested headings as structure, not as added content', () => {
    const input = 'Wir suchen eine Pflegefachperson HF mit Freude an der Arbeit im Team. Sie betreuen Patientinnen und Patienten auf der Station und arbeiten eng mit der Ärzteschaft zusammen.';
    const output = '## Beschreibung\nWir suchen eine Pflegefachperson HF mit Freude an der Arbeit im Team.\n\n## Aufgaben\n- Sie betreuen Patientinnen und Patienten auf der Station und arbeiten eng mit der Ärzteschaft zusammen.';
    const verdict = assess(input, output);
    expect(verdict).toMatchObject({ ok: true, precision: 1, recall: 1 });
  });
});

describe('assessComposedFromInputs — the thin-description composer', () => {
  // Inputs are real fields of a live Galaxus ad (migros-ticino slice); the
  // composed answers are written the way the prompt asks for them.
  const inputs = [
    'Fachkraft für Entsorgung & Recycling (w/m/d)', 'Galaxus', 'Neuenburg am Rhein', '',
    'Für unser Entsorgungs- und Recycling-Team am Standort Neuenburg am Rhein suchen wir Verstärkung. Du packst gerne mit an, arbeitest zuverlässig und qualitätsbewusst und behältst auch in einem dynamischen Logistikumfeld den Überblick? Dann bist du bei uns genau richtig.',
    'Sachgerechte Handhabung und Entsorgung von Sonderabfällen',
    'Dokumentation der Spezialentsorgungen gemäß internen Richtlinien',
    'Technisches Verständnis und ein sicherer Umgang mit Maschinen und Arbeitsmitteln',
    'Ausgeprägtes Sicherheits- und Verantwortungsbewusstsein',
    'Weitere Benefits Deutschland: Profitiere von 28 Tagen Ferien, exklusiven Mitarbeiterpreisen im Shop und weiteren Vorteilen.',
    '100%',
  ];
  const good = [
    '## Beschreibung',
    'Galaxus sucht für das Entsorgungs- und Recycling-Team am Standort Neuenburg am Rhein eine Fachkraft für Entsorgung & Recycling (w/m/d). Du packst gerne mit an, arbeitest zuverlässig und qualitätsbewusst und behältst auch in einem dynamischen Logistikumfeld den Überblick.',
    '',
    '## Aufgaben',
    '- Sachgerechte Handhabung und Entsorgung von Sonderabfällen',
    '- Dokumentation der Spezialentsorgungen gemäß internen Richtlinien',
    '',
    '## Anforderungen',
    '- Technisches Verständnis und ein sicherer Umgang mit Maschinen und Arbeitsmitteln',
    '- Ausgeprägtes Sicherheits- und Verantwortungsbewusstsein',
    '',
    '## Wir bieten',
    '- 28 Tage Ferien, exklusive Mitarbeiterpreise im Shop und weitere Vorteile',
    '',
    '**Beschäftigungsgrad: 100%**',
  ].join('\n');
  const opts = { allowedWords: HEADINGS };

  it('accepts a composition anchored in the data, re-inflected words included', () => {
    expect(assessComposedFromInputs(inputs, good, opts)).toMatchObject({ ok: true, unsupported: [] });
  });

  it('rejects an invented benefit and an invented intro sentence', () => {
    const inventedBenefit = good.replace('## Wir bieten\n', '## Wir bieten\n- Ein attraktives Gehalt, eine moderne Kantine und flexible Arbeitszeiten\n');
    expect(assessComposedFromInputs(inputs, inventedBenefit, opts).reason).toMatch(/^unsupported-sentence:Ein attraktives Gehalt/);
    const inventedIntro = good.replace('den Überblick.', 'den Überblick. Es erwartet dich ein internationales, junges und hochmotiviertes Umfeld mit spannenden Karrierechancen.');
    expect(assessComposedFromInputs(inputs, inventedIntro, opts).ok).toBe(false);
  });

  it('rejects a reasoning/chatter preamble', () => {
    const verdict = assessComposedFromInputs(inputs, `Here is the composed job description based on the data provided:\n\n${good}`, opts);
    expect(verdict.reason).toMatch(/^reasoning-leak/);
  });
});

const slotText = (crawler: string, slot: string) =>
  leaked.slots.find((s: { crawler: string; slot: string }) => s.crawler === crawler && s.slot === slot).text as string;

describe('translation steps reject a leaked answer (isAcceptableTranslation)', () => {
  const emsSource = pairs.rejected.find((p: { crawler: string }) => p.crawler === 'ems-chemie').input as string;

  it('rejects a translation-born leak that length and structure alone would accept', () => {
    // ems-chemie `en`: the translator narrated its own tool calls. Long enough,
    // no bullets to lose — only the leak check stops it.
    const leakedEn = leaked.slots.find((s: { crawler: string; slot: string; text: string }) => s.crawler === 'ems-chemie'
      && s.slot === 'dbl.en' && /translate this job description/i.test(s.text)).text;
    expect(leakedEn.length).toBeGreaterThan(emsSource.length * 0.6);
    expect(isAcceptableTranslation(emsSource, leakedEn)).toBe(false);
  });

  it('still accepts a real translation', () => {
    const english = 'Laboratory manager for fibre and yarn quality control (m/f/d) 100% at EMS-Chemie AG, a leading company in specialty polymers and fine chemicals based in Domat/Ems (Grisons). EMS-Chemie is the world\'s largest producer of high-performance polyamides, with about 3000 employees worldwide. Place of work: Domat/Ems.';
    expect(isAcceptableTranslation(emsSource, english)).toBe(true);
  });
});

describe('relocalize-pending isIncomplete — the repair queue sees leaked slots', () => {
  // pfister: source `de` clean, `en` a machine translation of a leaked source.
  // Long, English, not a copy: before the leak check the job counted as complete
  // and was never selected (needsRetranslation=false on main).
  const de = 'Du berätst unsere Kundinnen und Kunden bei der Auswahl von Vorhängen direkt bei ihnen zu Hause, nimmst Masse und erstellst Offerten. Du arbeitest selbständig und planst deine Termine im Aussendienst.';
  const job = {
    title: 'Verkäuferin für Vorhänge im Aussendienst (m/w/d)',
    sourceLang: 'de',
    description: de,
    titleByLocale: {
      de: 'Verkäuferin für Vorhänge im Aussendienst (m/w/d)',
      it: 'Venditrice di tende nel servizio esterno (m/f/d)',
      en: 'Curtain sales consultant, field service (m/f/d)',
      fr: 'Vendeuse de rideaux en service externe (h/f/d)',
    },
    descriptionByLocale: {
      de,
      it: 'Consigli le nostre clienti e i nostri clienti nella scelta delle tende direttamente a casa loro, prendi le misure e prepari le offerte. Lavori in modo autonomo e pianifichi i tuoi appuntamenti nel servizio esterno.',
      en: 'You advise our customers on choosing curtains directly in their homes, take measurements and prepare quotes. You work independently and plan your own appointments in the field service.',
      fr: 'Tu conseilles nos clientes et nos clients dans le choix des rideaux directement à leur domicile, tu prends les mesures et tu prépares les offres. Tu travailles de manière autonome et tu planifies tes rendez-vous.',
    },
  };

  it('a clean, fully translated job is complete', () => {
    expect(isIncomplete(job)).toBe(false);
  });

  it('a leaked translation slot makes it incomplete', () => {
    expect(isIncomplete({ ...job, descriptionByLocale: { ...job.descriptionByLocale, en: slotText('pfister', 'dbl.en') } })).toBe(true);
  });

  it('a leaked SOURCE slot makes it incomplete too (the forced relocalization resets it from the description)', () => {
    const leakedSource = `${slotText('burkhalter-group', 'dbl.de')} ${de}`;
    expect(isIncomplete({ ...job, descriptionByLocale: { ...job.descriptionByLocale, de: leakedSource } })).toBe(true);
  });
});

type SlotFixture = { crawler: string; slot: string; text: string; sourceSlot: string; description: string };
// The references isIncomplete uses: a translation is compared with the source
// slot and the crawled description, the source slot with the description.
const referencesOf = (e: SlotFixture) => (e.sourceSlot ? [e.sourceSlot, e.description] : [e.description]);

describe('detectDegenerateRepetition — translator loops (pkb-private-bank «Risk-Lights-Lights-…»)', () => {
  it('flags every pinned degenerate slot: loops of a word, a glyph, a bigram, a phrase, a URL segment, and a collapse', () => {
    const verdicts = degeneration.degenerate.map((e: SlotFixture) => [e.crawler, e.slot, detectDegenerateRepetition(e.text, { references: referencesOf(e) })?.kind ?? null]);
    expect(verdicts.filter(([, , kind]: unknown[]) => kind === null)).toEqual([]);
    expect(verdicts.find(([c]: unknown[]) => c === 'tertianum')?.[2]).toBe('collapse');
  });

  it('does not flag repetition that is faithful to what was translated', () => {
    // «Macellaio - Macellaio / …» (4 repeats of distinct French gender forms),
    // a CSS dump the source carries too, mojibake in the crawled description
    // itself, and the least diverse legitimate translation of the census.
    for (const e of degeneration.legit as SlotFixture[]) {
      expect(detectDegenerateRepetition(e.text, { references: referencesOf(e) }), `${e.crawler} ${e.slot}`).toBeNull();
    }
  });

  it('judges a loop against its reference: the same text is fine when the source loops the same way', () => {
    const loop = `Wir bieten ${'Licht-'.repeat(6)}Licht und mehr.`;
    expect(detectDegenerateRepetition(loop, { references: ['Wir bieten Licht und mehr.'] })?.kind).toBe('loop');
    expect(detectDegenerateRepetition(loop, { references: [loop] })).toBeNull();
    // The cleaner reference decides: a looping source slot does not excuse a
    // looping translation when the crawled description is clean.
    expect(detectDegenerateRepetition(loop, { references: [loop, 'Wir bieten Licht und mehr.'] })?.kind).toBe('loop');
  });

  it('isAcceptableTranslation rejects the degenerate slots and keeps the legitimate ones', () => {
    for (const e of degeneration.degenerate as SlotFixture[]) {
      expect(isAcceptableTranslation(e.sourceSlot || e.description, e.text), `${e.crawler} ${e.slot}`).toBe(false);
    }
    for (const e of degeneration.legit as SlotFixture[]) {
      expect(isAcceptableTranslation(e.sourceSlot || e.description, e.text), `${e.crawler} ${e.slot}`).toBe(true);
    }
  });

  it('isIncomplete queues a job whose translation loops, so the published pkb record enters repair', () => {
    const pkbEn = (degeneration.degenerate as SlotFixture[]).find((e) => e.crawler === 'pkb-private-bank' && e.slot === 'dbl.en')!;
    const de = 'Du berätst unsere Kundinnen und Kunden bei der Auswahl von Vorhängen direkt bei ihnen zu Hause, nimmst Masse und erstellst Offerten. Du arbeitest selbständig und planst deine Termine im Aussendienst.';
    const job = {
      title: 'Verkäuferin für Vorhänge im Aussendienst (m/w/d)',
      sourceLang: 'de',
      description: de,
      titleByLocale: {
        de: 'Verkäuferin für Vorhänge im Aussendienst (m/w/d)',
        it: 'Venditrice di tende nel servizio esterno (m/f/d)',
        en: 'Curtain sales consultant, field service (m/f/d)',
        fr: 'Vendeuse de rideaux en service externe (h/f/d)',
      },
      descriptionByLocale: {
        de,
        it: 'Consigli le nostre clienti e i nostri clienti nella scelta delle tende direttamente a casa loro, prendi le misure e prepari le offerte. Lavori in modo autonomo e pianifichi i tuoi appuntamenti nel servizio esterno.',
        en: 'You advise our customers on choosing curtains directly in their homes, take measurements and prepare quotes. You work independently and plan your own appointments in the field service.',
        fr: 'Tu conseilles nos clientes et nos clients dans le choix des rideaux directement à leur domicile, tu prends les mesures et tu prépares les offres. Tu travailles de manière autonome et tu planifies tes rendez-vous.',
      },
    };
    expect(isIncomplete(job)).toBe(false);
    expect(isIncomplete({ ...job, descriptionByLocale: { ...job.descriptionByLocale, en: pkbEn.text } })).toBe(true);
  });
});

describe('review #10339 — numbered openers, and loops the token invariants miss', () => {
  const input = 'Wir suchen eine Pflegefachperson HF mit Freude an der Arbeit im Team. Sie betreuen Patientinnen und Patienten auf der Station, arbeiten eng mit der Ärzteschaft zusammen und übernehmen Verantwortung für die Pflegeplanung, die Dokumentation und die Anleitung von Lernenden in einem modernen Spital.';

  it('rejects a numbered/chatty opener in front of a verbatim body («1. Let\'s think:»)', () => {
    expect(input.split(/\s+/).length).toBeGreaterThanOrEqual(40);
    const verdict = assess(input, `1. Let's think:\n${input}`);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/^reasoning-leak/);
    for (const opener of ["1) Let me analyze the text.", '2. Lass uns überlegen, wie', 'Ragioniamo:', '- Let us break it down:']) {
      expect(detectAiReasoningLeak(`${opener}\n${input}`), opener).not.toBeNull();
    }
    // Real openers that share the words stay clean.
    for (const opener of ['1. Deine Aufgaben', 'Pensiamo in grande: entra nel nostro team.', 'Let us welcome you to our team in Lugano.']) {
      expect(detectAiReasoningLeak(`${opener}\n${input}`), opener).toBeNull();
    }
  });

  it('rejects a formatter answer that is verbatim except for a short loop', () => {
    // A real faithful answer (ETA) plus five repeats of one word: the token
    // invariants alone would pass it.
    const eta = pairs.accepted.find((p: { crawler: string }) => p.crawler === 'eta-sa-swatch-group');
    const verdict = assess(eta.input, `${eta.output}\nLights Lights Lights Lights Lights`);
    expect(verdict.precision).toBeGreaterThanOrEqual(0.9);
    expect(verdict.recall).toBeGreaterThanOrEqual(0.9);
    expect(verdict.reason).toBe('degenerate-repetition:loop');
  });

  it('rejects a composition made of one anchored sentence repeated five times', () => {
    const sentence = 'Sachgerechte Handhabung und Entsorgung von Sonderabfällen.';
    const looped = Array.from({ length: 5 }, () => sentence).join(' ');
    expect(looped.length).toBeGreaterThanOrEqual(200);
    const verdict = assessComposedFromInputs(
      ['Fachkraft für Entsorgung & Recycling (w/m/d)', 'Galaxus', 'Neuenburg am Rhein', 'Für unser Entsorgungs-Team suchen wir Verstärkung.', sentence],
      looped,
      { allowedWords: HEADINGS, references: ['Für unser Entsorgungs-Team suchen wir Verstärkung.'] },
    );
    expect(verdict.reason).toBe('degenerate-repetition:loop');
  });
});
