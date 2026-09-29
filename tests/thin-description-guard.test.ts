/**
 * Thin Description Guard — Tests for crawler description minimum word count.
 *
 * Verifies that the crawlers that had thin description issues produce
 * descriptions with >= 50 words when detail pages return empty/thin content
 * (mks-pamp: returns none instead — source-only rule, see its section).
 *
 * Crawlers tested:
 *  1. grand-hotel-kronenhof (no fallback body since issue 5253: see grand-hotel-kronenhof-crawler.test.ts)
 *  2. afry — no longer padded: see its section
 *  3. volg-fenaco
 *  4. agie-charmilles (GF Machining Solutions) — no longer padded: see its section
 *  5. mks-pamp
 *  6. centiel
 *  7. confederazione-ticino
 *  8. usi (via ensureMinimumDescriptionWordCount)
 */

import { describe, it, expect } from 'vitest';

// Import parser/builder functions from each crawler
import {
  buildAfryLocalizedContent,
  parseSmartRecruitersPage,
} from '@/scripts/lib/afry-job-parser.mjs';

import {
  buildAgieCharmillesLocalizedContent,
  parseAgieCharmillesDetailPage,
} from '@/scripts/lib/agie-charmilles-job-parser.mjs';

import {
  buildMksPampLocalizedContent,
} from '@/scripts/lib/mkspamp-job-parser.mjs';

import {
  ensureMinimumDescriptionWordCount,
} from '@/scripts/lib/dedicated-crawler-common.mjs';

const MIN_WORDS = 50;

/** Count words in a string, stripping HTML first. */
function wordCount(s: string): number {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

// ─── 1. Grand Hotel Kronenhof ──────────────────────────────────────────────
// No fallback body any more: a vacancy without a detail body keeps the source
// text read before or is not published (tests/grand-hotel-kronenhof-crawler.test.ts,
// issue 5253).

// ─── 2. AFRY ───────────────────────────────────────────────────────────────
// No longer padded: a short posting keeps its own text and a posting without
// text gets NO description (the pipeline's thin-source path) instead of a
// paragraph about AFRY that the source never published.

describe('AFRY — the posting text, never a padded paragraph', () => {
  it('gives a posting without text no description', () => {
    const result = buildAfryLocalizedContent({
      title: 'Geologo Junior (f/m/d) 80-100%',
      location: 'Airolo',
      description: '',
      competenceArea: 'Civil & Structural Engineering',
    });
    expect(result.descriptionByLocale).toEqual({});
  });

  it('keeps a thin posting as it is', () => {
    const result = buildAfryLocalizedContent({
      title: 'Projektingenieur:in Kunstbauten 80-100%',
      location: 'Chur',
      description: 'Planning and execution of bridge construction projects.',
      competenceArea: 'Civil Engineering',
      sourceLang: 'en',
    });
    expect(result.descriptionByLocale).toEqual({ en: 'Planning and execution of bridge construction projects.' });
  });

  it('uses the original description when >= 50 words', () => {
    const richDesc = Array(60).fill('word').join(' ');
    const result = buildAfryLocalizedContent({
      title: 'Test Engineer',
      location: 'Bellinzona',
      description: richDesc,
      competenceArea: 'Testing',
      sourceLang: 'en',
    });
    expect(result.descriptionByLocale.en).toBe(richDesc);
  });
});

// ─── 3. Volg/fenaco ────────────────────────────────────────────────────────
// The buildJob function is not exported, so we replicate the logic.

describe('Volg/fenaco — fallback descriptions >= 50 words', () => {
  function getCompanyBoilerplate(company: string): string {
    const c = company.toLowerCase();
    if (c.includes('volg')) return [
      'Volg ist spezialisiert auf Dorfläden und kleine Verkaufsflächen in der Deutschschweiz und Romandie.',
      'Wir setzen auf Kundennähe und bieten bequeme Einkaufsmöglichkeiten mit persönlicher Interaktion.',
      'Unsere Mitarbeitenden sind das Herzstück des Ladens — unser Motto ist «frisch und fründlich».',
      'Als Tochterunternehmen der fenaco Genossenschaft gehören wir zu einem der grössten Arbeitgeber der Schweiz mit über 11.000 Mitarbeitenden.',
      '',
      'Wir bieten: Abwechslungsreiche Aufgaben, familiäres Arbeitsumfeld, direkten Kundenkontakt,',
      '6 Wochen Ferien, SBB-Vergünstigungen, Weiterbildung an der Volg Academy,',
      'ausgezeichnete Karrieremöglichkeiten und eine fundierte Berufsausbildung für Lernende.',
    ].join('\n');
    if (c.includes('landi')) return [
      'LANDI ist Teil der fenaco Genossenschaft, der grössten Agrargenossenschaft der Schweiz.',
      'Wir betreiben TopShop-Verkaufsstellen, Tankstellen und Fachgeschäfte in der ganzen Schweiz.',
      'Die fenaco Genossenschaft beschäftigt über 11.000 Mitarbeitende und ist einer der bedeutendsten Arbeitgeber im ländlichen Raum.',
      'Unsere LANDI-Läden bieten ein breites Sortiment an landwirtschaftlichen Produkten, Bau- und Gartenbedarf, Lebensmitteln und Treibstoffen.',
      '',
      'Wir bieten ein dynamisches Arbeitsumfeld mit direktem Kundenkontakt,',
      'umfassende Weiterbildungsmöglichkeiten, attraktive Anstellungsbedingungen im Detailhandel,',
      'mindestens 5 Wochen Ferien, Personalrabatte auf das gesamte Sortiment',
      'und eine praxisorientierte Berufsausbildung für Lernende.',
    ].join('\n');
    return [
      'fenaco Genossenschaft ist die grösste Agrargenossenschaft der Schweiz mit über 11.000 Mitarbeitenden.',
      'Wir bieten vielfältige Karrieremöglichkeiten in Landwirtschaft, Detailhandel,',
      'Logistik und Lebensmittelproduktion mit attraktiven Anstellungsbedingungen,',
      'umfassenden Sozialleistungen und individuellen Weiterbildungsmöglichkeiten.',
      'Als genossenschaftliches Unternehmen im Besitz der Schweizer Landwirtschaft vereinen wir über 80 Tochtergesellschaften.',
      'Wir bieten sichere Arbeitsplätze, moderne Infrastruktur und die Möglichkeit, einen Beitrag zur Schweizer Landwirtschaft zu leisten.',
    ].join('\n');
  }

  it('Volg apprenticeship listing fallback is >= 50 words', () => {
    const metaLine = 'Lehrstelle als Detailhandelsfachmann/-frau — VOLG, Zuoz (Graubünden). Pensum: 100%. Bewerbung über https://jobs.fenaco.com';
    const desc = `${metaLine}\n\n${getCompanyBoilerplate('VOLG')}`;
    expect(wordCount(desc)).toBeGreaterThanOrEqual(MIN_WORDS);
  });

  it('LANDI apprenticeship listing fallback is >= 50 words', () => {
    const metaLine = 'Lehrstelle als Logistiker — LANDI, Chur (Graubünden). Pensum: 100%. Bewerbung über https://jobs.fenaco.com';
    const desc = `${metaLine}\n\n${getCompanyBoilerplate('LANDI')}`;
    expect(wordCount(desc)).toBeGreaterThanOrEqual(MIN_WORDS);
  });

  it('generic fenaco subsidiary fallback is >= 50 words', () => {
    const metaLine = 'Chauffeur — TRAVECO, Brig (Wallis). Pensum: 100%. Bewerbung über https://jobs.fenaco.com';
    const desc = `${metaLine}\n\n${getCompanyBoilerplate('UFA')}`;
    expect(wordCount(desc)).toBeGreaterThanOrEqual(MIN_WORDS);
  });
});

// ─── 4. AGIE Charmilles ────────────────────────────────────────────────────
// No longer padded: a posting without detail text gets NO description (the
// pipeline's thin-source path) instead of a company paragraph in four
// languages that the source never published.

describe('AGIE Charmilles — the detail text, never a padded paragraph', () => {
  it('gives a posting without detail text no description', () => {
    const result = buildAgieCharmillesLocalizedContent({
      title: 'Software Engineer Expert - R&D',
      city: 'Losone',
      detailDescription: '',
    });
    expect(result.description).toBe('');
    expect(result.descriptionByLocale).toEqual({});
  });

  it('uses the detail description whatever its length, in its own slot only', () => {
    const shortDesc = 'Wartung und Inbetriebnahme von Drahterodiermaschinen beim Kunden.';
    const result = buildAgieCharmillesLocalizedContent({
      title: 'Servicetechniker',
      city: 'Biel/Bienne',
      language: 'de',
      detailDescription: shortDesc,
    });
    expect(result.descriptionByLocale).toEqual({ de: shortDesc });
  });

  it('parseAgieCharmillesDetailPage returns empty for thin HTML', () => {
    const { description } = parseAgieCharmillesDetailPage('<html><body><p>Short text.</p></body></html>');
    expect(description).toBe('');
  });
});

// ─── 5. MKS PAMP ──────────────────────────────────────────────────────────

// Source-only rule (lot D, 2026-09-29): a thin or empty posting no longer gets
// a company paragraph padded to 50 words — the builder returns no description
// and the runner keeps the stored source text or does not publish the job
// (covered in tests/mks-pamp-crawler.test.ts).
describe('MKS PAMP — no padded fallback, source text only', () => {
  it('returns no description when detail and RSS descriptions are thin', () => {
    const result = buildMksPampLocalizedContent({
      title: 'HR Business Partner',
      city: 'Castel San Pietro',
      descriptionHtml: '<p>Manage HR functions.</p>',
      detailDescription: '',
    });
    expect(result.descriptionByLocale).toEqual({});
  });

  it('returns no description with empty descriptions', () => {
    const result = buildMksPampLocalizedContent({
      title: 'Metal & Inventory Controller',
      city: 'Castel San Pietro',
      descriptionHtml: '',
      detailDescription: '',
    });
    expect(result.descriptionByLocale).toEqual({});
  });

  it('counts words after stripping HTML: tag-heavy thin content is still thin', () => {
    const htmlDesc = '<p><strong>Some</strong> <em>HTML</em> content with <b>tags</b> but only a few real words.</p>';
    const result = buildMksPampLocalizedContent({
      title: 'Test Role',
      city: 'Castel San Pietro',
      descriptionHtml: htmlDesc,
      detailDescription: '',
    });
    expect(result.descriptionByLocale).toEqual({});
  });

  it('uses detail description when >= 50 words', () => {
    const richDesc = Array(60).fill('important').join(' ');
    const result = buildMksPampLocalizedContent({
      title: 'Test Role',
      city: 'Castel San Pietro',
      descriptionHtml: '',
      detailDescription: richDesc,
    });
    expect(result.description).toContain(richDesc);
    expect(result.descriptionByLocale[result.sourceLang]).toBe(result.description);
    expect(wordCount(result.description)).toBeGreaterThanOrEqual(MIN_WORDS);
  });
});

// ─── 6. Centiel ────────────────────────────────────────────────────────────
// A copy of the runner's padding used to be tested here ("<title> — Centiel,
// Cadro (Lugano)…", a paragraph about Centiel and "Apply via: …" below 50
// words): it tested the copy, not update-centiel-jobs.mjs, whose own tests
// are in tests/centiel-crawler.test.ts (issue 5253).

// ─── 7. Confederazione Ticino ──────────────────────────────────────────────
// Same: a copy of update-confederazione-jobs.mjs's padding ("Posizione
// nell'Amministrazione federale svizzera…", a paragraph about the federal
// administration, "Candidati online su jobs.admin.ch.") tested the copy,
// not the runner. The runner's padding is removed, with its tests, by lot D
// in #10333 (issue 5253).

// ─── 8. ensureMinimumDescriptionWordCount (volg, spruengli, empa; USI) ─────
// It no longer pads (issue 5253): below 50 words it used to append a company
// paragraph from COMPANY_BOILERPLATE_IT behind a "## title / **company** —
// place" header. The removal of those stored paragraphs is tested in
// tests/company-boilerplate-fossils.test.ts.

describe('ensureMinimumDescriptionWordCount — no padding', () => {
  it('leaves a thin description of a company that had a paragraph as the source wrote it', () => {
    const jobs = [{
      title: 'PhD Researcher',
      company: 'USI – Università della Svizzera italiana',
      location: 'Lugano',
      canton: 'TI',
      addressRegion: 'TI',
      description: 'Short description only.',
      titleByLocale: { it: 'PhD Researcher' },
      descriptionByLocale: { it: 'Short description only.' },
    }];
    const patched = ensureMinimumDescriptionWordCount(jobs, MIN_WORDS);
    expect(patched).toBe(0);
    expect(jobs[0].description).toBe('Short description only.');
    expect(jobs[0].descriptionByLocale).toEqual({ it: 'Short description only.' });
  });

  it('does not modify jobs already >= 50 words', () => {
    const richDesc = Array(60).fill('research').join(' ');
    const jobs = [{
      title: 'Test Professor',
      company: 'Test University',
      location: 'Lugano',
      description: richDesc,
      descriptionByLocale: { it: richDesc },
    }];
    const patched = ensureMinimumDescriptionWordCount(jobs, MIN_WORDS);
    expect(patched).toBe(0);
    expect(jobs[0].description).toBe(richDesc);
  });

  it('syncs from descriptionByLocale.it when richer than description', () => {
    const itDesc = Array(60).fill('ricerca').join(' ');
    const jobs = [{
      title: 'Test',
      company: 'Test',
      location: 'Lugano',
      description: 'Short.',
      descriptionByLocale: { it: itDesc },
    }];
    ensureMinimumDescriptionWordCount(jobs, MIN_WORDS);
    expect(jobs[0].description).toBe(itDesc);
  });
});

// ─── Cross-crawler: SmartRecruiters parser (AFRY) ──────────────────────────

describe('parseSmartRecruitersPage — extracts structured content', () => {
  it('extracts sections from h2-based layout', () => {
    const html = `
      <h2>Job Description</h2>
      <p>This is a detailed description of the position that contains many words about the role and responsibilities of the candidate who will be working in this position at our company in Switzerland.</p>
      <h2>Qualifications</h2>
      <ul>
        <li>Engineering degree required for this position</li>
        <li>5 years of experience in a similar role</li>
        <li>Fluent in German and English languages</li>
        <li>Strong analytical and problem-solving skills</li>
        <li>Ability to work independently and as part of a team</li>
      </ul>
      <h2>Apply Now</h2>
      <p>Click the button below to apply</p>
    `;
    const result = parseSmartRecruitersPage(html);
    expect(result).toContain('Job Description');
    expect(result).toContain('Qualifications');
    expect(result).not.toContain('Apply Now');
  });

  it('returns empty string for thin pages', () => {
    const result = parseSmartRecruitersPage('<html><body><p>Short.</p></body></html>');
    expect(result).toBe('');
  });
});
