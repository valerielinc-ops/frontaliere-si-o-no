/**
 * Only the source's own text is published (issue 5253, lot J): no sentence,
 * label, summary or company line written by the crawler in or in place of a
 * posting, and stored jobs built that way lose the translations of that text
 * before the locale-preserving merge keeps them.
 *
 * The Planzer fixture is a live detail page minimised on 2026-09-29 (contact
 * replaced); the stored records reproduce the shape of the rows on main.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { dropPlanzerFabricatedText, extractPlanzerDetailContent } from '../scripts/lib/planzer-job-parser.mjs';
import { buildHasDescription, dropHasFabricatedText } from '../scripts/lib/has-healthcare-description.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (...parts: string[]) => fs.readFileSync(path.join(__dirname, ...parts), 'utf8');

describe('Planzer (Solique) detail text', () => {
  const { description, locationText } = extractPlanzerDetailContent(read('fixtures', 'planzer-solique-detail.html'));

  it('keeps the page headings instead of crawler labels, and each benefit title', () => {
    const headings = description.split('\n\n').map((part) => part.split('\n')[0]);
    expect(headings.slice(1)).toEqual(['Was du bewegst', 'Weshalb es dir gelingt', 'Deine Benefits', 'Wer wir sind']);
    expect(description).toContain('• Attraktives Ferienreglement: Bei uns startest du mit 5 Wochen Ferien');
    expect(description).not.toMatch(/(^|\n)(Aufgaben|Profil|Benefits):\n|Marke der Planzer-Gruppe|Standort:|Familienunternehmen für Transport/);
  });

  it('never reads the named HR contact', () => {
    expect(description).not.toMatch(/Beispiel Person|Personalabteilung|Dein Kontakt/);
    expect(locationText).toBe('Brühlgasse 9\n3283 Kallnach');
  });

  it('drops the stored translations of crawler-written text, once', () => {
    const stored = {
      sourceLang: 'de',
      description: 'Marke der Planzer-Gruppe: Marti.\n\nAls fest verwurzeltes Unternehmen im Seeland …\n\nAufgaben:\n• Du sorgst für eine clevere Planung',
      descriptionByLocale: {
        de: 'Marke der Planzer-Gruppe: Marti.\n\nAls fest verwurzeltes Unternehmen im Seeland …\n\nAufgaben:\n• Du sorgst für eine clevere Planung',
        it: 'Marchio del Gruppo Planzer: Marti.\n\nCome azienda fortemente radicata …',
        en: 'Brand of the Planzer Group: Marti.\n\nAs a firmly rooted company …',
      },
    };
    expect(dropPlanzerFabricatedText(stored)).toBe(true);
    expect(Object.keys(stored.descriptionByLocale)).toEqual(['de']);
    expect(stored.descriptionByLocale.de.startsWith('Als fest verwurzeltes Unternehmen')).toBe(true);
    expect(stored.description.startsWith('Als fest verwurzeltes Unternehmen')).toBe(true);
    expect((stored as any).needsRetranslation).toBe(true);
    expect(dropPlanzerFabricatedText(stored)).toBe(false);
  });

  it('leaves a job with the page text alone', () => {
    const job = { sourceLang: 'de', description, descriptionByLocale: { de: description, it: 'Traduzione' } };
    expect(dropPlanzerFabricatedText(job)).toBe(false);
    expect(job.descriptionByLocale.it).toBe('Traduzione');
  });
});

describe('HAS Healthcare (e-lavoro.ch) description', () => {
  it('publishes the sections under the page headings, without the crawler lines', () => {
    const text = buildHasDescription({
      sections: { 'competenze richieste': 'Laurea in chimica o titolo equivalente.', 'che cosa offriamo': 'Un ambiente di lavoro dinamico.' },
      headings: { 'competenze richieste': 'Competenze richieste', 'che cosa offriamo': 'Che cosa offriamo' },
      language: 'Inglese professionale',
      education: '',
    });
    expect(text).toBe('Competenze richieste\nLaurea in chimica o titolo equivalente.\n\nChe cosa offriamo\nUn ambiente di lavoro dinamico.\n\nLingue richieste: Inglese professionale');
  });

  it('writes nothing when the page has no section', () => {
    expect(buildHasDescription({ sections: {}, headings: {}, language: 'Inglese', education: 'Scuole superiori' })).toBe('');
  });

  it('does not publish a stored job made only of crawler-written lines', () => {
    // The shape of all 4 has-healthcare rows on main (2026-09-29).
    const text = 'HAS Healthcare Advanced Synthesis, con sede a Biasca (TI), è alla ricerca di: Tecnica/o SSS.\n\n🗣️ Lingue richieste: Inglese professionale\n🎓 Titolo di studio: Scuole superiori\n\nSettore: Farmaceutico / API (Active Pharmaceutical Ingredients)\nSede: Via Industria 24, Biasca (TI), Svizzera';
    expect(dropHasFabricatedText({ sourceLang: 'it', description: text, descriptionByLocale: { it: text, en: 'HAS … based in Biasca' } })).toBeNull();
  });

  it('keeps the section text of a stored job and drops its translations', () => {
    const text = 'HAS Healthcare Advanced Synthesis, con sede a Biasca (TI), è alla ricerca di: Chimico.\n\n📋 Competenze richieste:\nLaurea in chimica.\n\nSettore: Farmaceutico / API (Active Pharmaceutical Ingredients)\nSede: Via Industria 24, Biasca (TI), Svizzera';
    const repaired = dropHasFabricatedText({ sourceLang: 'it', description: text, descriptionByLocale: { it: text, de: 'HAS … mit Sitz in Biasca' } });
    expect(repaired).toMatchObject({
      description: 'Competenze richieste:\nLaurea in chimica.',
      descriptionByLocale: { it: 'Competenze richieste:\nLaurea in chimica.' },
      needsRetranslation: true,
    });
  });
});

describe('no crawler-written stand-in in the parsers that build it inside their fetch loop', () => {
  it.each([
    ['lib/aarreha-schinznach-job-parser.mjs', /Zentrum für interdisziplinäre Rehabilitation|summaryPieces/],
    ['lib/victorinox-job-parser.mjs', /Schweizer Familienunternehmen, Hersteller|summaryPieces/],
    ['lib/zurich-insurance-job-parser.mjs', /Key details:|fallbackDescription/],
    ['lib/kispi-job-parser.mjs', /\$\{title\} — \$\{KISPI_COMPANY_NAME\}/],
    ['update-caseificio-gottardo-jobs.mjs', /Per maggiori dettagli|buildFallbackDescription|pubblica il seguente/],
    ['update-has-healthcare-jobs.mjs', /Settore: Farmaceutico|è alla ricerca di/],
  ])('%s', (file, pattern) => {
    expect(read('..', 'scripts', ...file.split('/'))).not.toMatch(pattern);
  });
});
