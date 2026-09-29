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
 * and the leaked slots are all 29 found by the census over 151,987 slots.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  assessComposedFromInputs,
  assessVerbatimRestructure,
  detectAiReasoningLeak,
  VERBATIM_RESTRUCTURE_MIN_PRECISION,
  VERBATIM_RESTRUCTURE_MIN_RECALL,
} from '../scripts/lib/ai-output-fidelity.mjs';
import { resolveLocalePromptContext } from '../scripts/lib/shared-jobs-crawler.mjs';

const FIXTURES = path.join(__dirname, 'fixtures', 'ai-output-fidelity');
const pairs = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'formatter-pairs.json'), 'utf8'));
const leaked = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'leaked-slots.json'), 'utf8'));

// The same vocabulary shared-jobs-crawler passes: every localized heading.
const HEADINGS = [...new Set(['it', 'de', 'fr', 'en'].flatMap((l) => Object.values(resolveLocalePromptContext(l).headings)))];
const assess = (input: string, output: string) => assessVerbatimRestructure(input, output, { headingVocabulary: HEADINGS });

describe('detectAiReasoningLeak', () => {
  it('flags every leaked slot published on origin/main (29 slots, 6 crawlers, 4 languages, MT-garbled variants included)', () => {
    expect(leaked.slots).toHaveLength(29);
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
