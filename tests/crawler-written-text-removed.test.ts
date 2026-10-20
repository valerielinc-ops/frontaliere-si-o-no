/**
 * Only the source's own text is published (issue 5253, lot J2): no sentence,
 * label, summary or company paragraph written by the crawler in or in place
 * of a posting, and a body under the common 50-word floor gives no
 * description. The stored rows built the old way lose that text — and the
 * translations made from it — before the locale-preserving merge keeps them
 * (`prepareExistingJobs` + `dropFabricatedDescriptions`).
 *
 * The stored records reproduce the shape of the rows on main (2026-09-29).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { dropFabricatedDescription, dropFabricatedDescriptions } from '../scripts/lib/drop-fabricated-description.mjs';
import { rewritePreparedStoredJobs } from '../scripts/lib/stored-jobs-soft-exit.mjs';
import {
  buildDescription as buildHasDescription,
  HAS_FABRICATED_DESCRIPTION_RE,
  stripHasFabricatedDescription,
} from '../scripts/update-has-healthcare-jobs.mjs';
import {
  SOLINA_FABRICATED_DESCRIPTION_RE,
  stripSolinaFabricatedDescription,
} from '../scripts/lib/solina-job-parser.mjs';
import {
  KLINIK_ADELHEID_FABRICATED_DESCRIPTION_RE,
  stripKlinikAdelheidFabricatedDescription,
} from '../scripts/lib/klinik-adelheid-job-parser.mjs';
import { PRIVATKLINIK_HOHENEGG_FABRICATED_DESCRIPTION_RE } from '../scripts/lib/privatklinik-hohenegg-job-parser.mjs';
import { REFLINE_FABRICATED_DESCRIPTION_RE } from '../scripts/lib/refline-common.mjs';
import { CDS_SAVOGNIN_FABRICATED_DESCRIPTION_RE } from '../scripts/lib/cds-savognin-job-parser.mjs';
import {
  extractPlanzerDetailContent,
  PLANZER_FABRICATED_DESCRIPTION_RE,
  stripPlanzerFabricatedDescription,
} from '../scripts/lib/planzer-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = (file: string) => fs.readFileSync(path.join(__dirname, '..', 'scripts', ...file.split('/')), 'utf8');
const words = (n: number, word = 'Aufgabe') => Array.from({ length: n }, (_, i) => `${word}${i}`).join(' ');

describe('HAS Healthcare (e-lavoro.ch) description', () => {
  it('publishes the sections under the page headings, without the crawler lines', () => {
    const text = buildHasDescription({
      sections: { 'competenze richieste': `Laurea in chimica. ${words(30, 'competenza')}`, 'che cosa offriamo': `Un ambiente dinamico. ${words(25, 'vantaggio')}` },
      headings: { 'competenze richieste': 'Competenze richieste', 'che cosa offriamo': 'Che cosa offriamo' },
      language: 'Inglese professionale',
      education: '',
    });
    expect(text.startsWith('Competenze richieste\nLaurea in chimica.')).toBe(true);
    expect(text).toContain('\n\nChe cosa offriamo\nUn ambiente dinamico.');
    expect(text.endsWith('Lingue richieste: Inglese professionale')).toBe(true);
    expect(text).not.toMatch(/con sede a Biasca|Settore:|Sede:|📋|🎯|🎁/);
  });

  it('writes nothing without a section, or under the 50-word floor', () => {
    expect(buildHasDescription({ sections: {}, headings: {}, language: 'Inglese', education: 'Scuole superiori' })).toBe('');
    expect(buildHasDescription({ sections: { 'competenze richieste': 'Laurea in chimica.' }, headings: {}, language: '', education: '' })).toBe('');
  });

  it('keeps the shared 50-word boundary for a discovered body', () => {
    const body35 = words(35, 'source');
    const body60 = words(60, 'source');
    expect(buildHasDescription({ sections: { 'competenze richieste': body35 }, headings: { 'competenze richieste': 'Competenze richieste' }, language: '', education: '' })).toBe('');
    expect(buildHasDescription({ sections: { 'competenze richieste': body60 }, headings: { 'competenze richieste': 'Competenze richieste' }, language: '', education: '' })).toContain(body60);
  });

  it('keeps real sections while removing the crawler lines and translations', () => {
    const text = [
      'HAS Healthcare Advanced Synthesis, con sede a Biasca (TI), è alla ricerca di: Tecnica/o SSS.',
      '🗣️ Lingue richieste: Inglese professionale',
      '🎓 Titolo di studio: Scuole superiori',
      '📋 Competenze richieste:',
      'Laurea in chimica o titolo equivalente.',
      '🎯 Mansioni principali:',
      'Gestione delle attività di laboratorio e controllo della qualità.',
      '🎁 Cosa offriamo:',
      'Un ambiente di lavoro dinamico e collaborativo.',
      'Settore: Farmaceutico / API (Active Pharmaceutical Ingredients)',
      'Sede: Via Industria 24, Biasca (TI), Svizzera',
    ].join('\n\n');
    const job = { sourceLang: 'it', description: text, descriptionByLocale: { it: text, en: 'HAS … based in Biasca (TI)' } };
    expect(dropFabricatedDescription(job, HAS_FABRICATED_DESCRIPTION_RE, { strip: stripHasFabricatedDescription })).toBe(true);
    expect(job.description).toBe([
      'Laurea in chimica o titolo equivalente.',
      'Gestione delle attività di laboratorio e controllo della qualità.',
      'Un ambiente di lavoro dinamico e collaborativo.',
    ].join('\n\n'));
    expect(job.descriptionByLocale).toEqual({ it: job.description });
    expect((job as any).needsRetranslation).toBe(true);
  });

  it('clears a stored job made only of crawler-written lines, translations included', () => {
    // The shape of all 4 has-healthcare rows on main.
    const text = 'HAS Healthcare Advanced Synthesis, con sede a Biasca (TI), è alla ricerca di: Tecnica/o SSS.\n\n🗣️ Lingue richieste: Inglese professionale\n\nSettore: Farmaceutico / API (Active Pharmaceutical Ingredients)\nSede: Via Industria 24, Biasca (TI), Svizzera';
    const job = { sourceLang: 'en', description: text, descriptionByLocale: { en: '## Descrizione HAS Healthcare Advanced Synthesis, con sede a Biasca (TI), è alla ricerca di: Tecnica/o SSS. ##', it: 'Traduzione derivata dal testo sporco' } };
    expect(dropFabricatedDescription(job, HAS_FABRICATED_DESCRIPTION_RE, { strip: stripHasFabricatedDescription })).toBe(true);
    expect(job.description).toBe('');
    expect(job.descriptionByLocale).toEqual({});
  });
});

describe('Planzer (Solique) detail', () => {
  // Minimised live page, contact replaced.
  const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'planzer-solique-detail.html'), 'utf8');
  const { description, locationText } = extractPlanzerDetailContent(html);

  it('keeps the page headings and benefit titles instead of the crawler labels', () => {
    expect(description.startsWith('Als fest verwurzeltes Unternehmen im Seeland')).toBe(true);
    expect(description).toContain('\n\nWas du bewegst\n• Du sorgst für eine clevere Planung');
    expect(description).toContain('\n\nWeshalb es dir gelingt\n');
    expect(description).toContain('\n\nDeine Benefits\n• Weiterbildungs- und Entwicklungsmöglichkeiten: Bei uns kannst du dich entwickeln');
    expect(description).toContain('\n\nWer wir sind\nFür uns als Unternehmen');
    expect(description).not.toMatch(/^(Aufgaben|Profil|Benefits):$|Marke der Planzer-Gruppe/m);
    expect(locationText).toBe('Brühlgasse 9\n3283 Kallnach');
  });

  it('never reads the HR contact block', () => {
    expect(description).not.toMatch(/Beispiel Person|Personalabteilung|\+41 00/);
  });

  it('is not taken for the old builder text by the stored-row purge', () => {
    expect(PLANZER_FABRICATED_DESCRIPTION_RE.test(description)).toBe(false);
  });
});

describe('stored rows with crawler-written text are repaired before the merge', () => {
  it('Planzer: removes the brand and labels but keeps the real body', () => {
    const text = [
      'Marke der Planzer-Gruppe: Marti.',
      'Planzer Transport AG — Schweizer Familienunternehmen für Transport- und Lagerlogistik seit 1936 (HQ Dietikon, ZH).',
      'Als fest verwurzeltes Unternehmen im Seeland bieten wir echte Aufgaben.',
      'Aufgaben:',
      '• Du sorgst für eine clevere Planung',
      'Profil:',
      '• Erste Erfahrung als Disponent',
      'Benefits:',
      '• 5 Wochen Ferien',
    ].join('\n\n');
    const job = { sourceLang: 'de', description: text, descriptionByLocale: { de: text, it: 'Marchio del Gruppo Planzer: Marti.' } };
    expect(dropFabricatedDescription(job, PLANZER_FABRICATED_DESCRIPTION_RE, { strip: stripPlanzerFabricatedDescription })).toBe(true);
    expect(job.description).toBe([
      'Als fest verwurzeltes Unternehmen im Seeland bieten wir echte Aufgaben.',
      '• Du sorgst für eine clevere Planung',
      '• Erste Erfahrung als Disponent',
      '• 5 Wochen Ferien',
    ].join('\n\n'));
    expect(job.descriptionByLocale).toEqual({ de: job.description });
    expect((job as any).needsRetranslation).toBe(true);
  });

  it('Planzer: recognises old descriptions containing only Profil/Benefits labels', () => {
    const text = 'Echter Beschreibungstext.\n\nProfil:\n• Führerausweis Kat. C\n\nBenefits:\n• 5 Wochen Ferien';
    const job = { sourceLang: 'de', description: text, descriptionByLocale: { de: text, fr: 'Ancienne traduction' } };
    expect(dropFabricatedDescription(job, PLANZER_FABRICATED_DESCRIPTION_RE, { strip: stripPlanzerFabricatedDescription })).toBe(true);
    expect(job.description).toBe('Echter Beschreibungstext.\n\n• Führerausweis Kat. C\n\n• 5 Wochen Ferien');
    expect(job.descriptionByLocale).toEqual({ de: job.description });
  });

  it('Solina: removes the Pensum / Standort wrapper and company paragraph', () => {
    const text = 'Praktikant:in\n\nPensum / Standort: 100%, Standortübergreifend\n\n## Mehr als Theorie Deine Zukunft beginnt hier\nBei Solina lernst du den Beruf dort, wo er zählt.\n\nDie Stiftung Solina betreibt mehrere Pflege- und Rehabilitationsstandorte im Berner Oberland, darunter Solina Heiligenschwendi und Solina Spiez.';
    const job = { sourceLang: 'de', description: text, descriptionByLocale: { de: text, it: 'Interno: testo tradotto' } };
    expect(dropFabricatedDescription(job, SOLINA_FABRICATED_DESCRIPTION_RE, { strip: stripSolinaFabricatedDescription })).toBe(true);
    expect(job.description).toBe('Praktikant:in\n\n## Mehr als Theorie Deine Zukunft beginnt hier\nBei Solina lernst du den Beruf dort, wo er zählt.');
    expect(job.descriptionByLocale).toEqual({ de: job.description });
  });

  it('Klinik Adelheid: removes Bereich and fallback company text while keeping the source', () => {
    const text = 'Lernende Köchin / Koch EFZ — Klinik Adelheid, Unterägeri (ZG).\n\nBereich: Offene Lehrstellen.\n\nDie Klinik Adelheid ist eine 140-Betten Rehabilitationsklinik der Zentralschweiz mit Spezialisierung in muskuloskelettaler, neurologischer, internistisch-onkologischer und geriatrischer Rehabilitation.\n\nWir suchen per 1. August 2027 eine / einen\nLernende/n als Köchin / Koch EFZ';
    const job = { sourceLang: 'de', description: text, descriptionByLocale: { de: text, fr: 'Domaine : …' } };
    expect(dropFabricatedDescription(job, KLINIK_ADELHEID_FABRICATED_DESCRIPTION_RE, { strip: stripKlinikAdelheidFabricatedDescription })).toBe(true);
    expect(job.description).toBe('Wir suchen per 1. August 2027 eine / einen\nLernende/n als Köchin / Koch EFZ');
    expect(job.descriptionByLocale).toEqual({ de: job.description });
  });

  it('applies the shared 50-word floor after repairing a stored description', async () => {
    const source = `Marke der Planzer-Gruppe: Marti.\n\n${Array.from({ length: 40 }, (_, i) => `Quelle${i}`).join(' ')}`;
    const job = { sourceLang: 'de', description: source, descriptionByLocale: { de: source, it: 'Traduzione derivata' } };
    const write = vi.fn();
    const rewritten = await rewritePreparedStoredJobs({
      prepare: (jobs) => dropFabricatedDescriptions(
        jobs,
        PLANZER_FABRICATED_DESCRIPTION_RE,
        'Planzer',
        { strip: stripPlanzerFabricatedDescription },
      ),
      storedJobs: [job],
      companyKey: 'planzer',
      companyLabel: 'Planzer',
      write,
    });
    expect(rewritten).toBe(true);
    expect(write).toHaveBeenCalledWith([], {
      housekeepingProof: [{
        job: expect.objectContaining({ description: expect.stringContaining('Quelle0') }),
        reason: 'thin-source-quarantine',
        definitive: true,
      }],
    });
  });

  it.each([
    ['privatklinik-hohenegg (3/4 rows)', PRIVATKLINIK_HOHENEGG_FABRICATED_DESCRIPTION_RE, 'Mitarbeiter/-in Hotellerie bei der Privatklinik Hohenegg in Meilen, Kanton Zürich.\n\nDie Privatklinik Hohenegg AG ist ein modernes Kompetenzzentrum.\n\nWas die Hohenegg bietet:\n• Modernes Klinikumfeld mit hoher fachlicher Qualität'],
    ['cds-savognin (5/5 rows, paragraph appended under 80 words)', CDS_SAVOGNIN_FABRICATED_DESCRIPTION_RE, 'Med. Praxisassistentin\n\nMed. Praxisassistentin beim Center da Sanadad Savognin in Savognin, Kanton Graubünden.\n\nDas Center da Sanadad Savognin (CDS) ist das regionale Gesundheitszentrum für Surses und Umgebung mit Akut-, Reha- und Pflegeabteilung. \n• Wir bieten medizinische Grundversorgung in einem alpinen Umfeld'],
    ['puk-zuerich, Refline factory (2/70 rows)', REFLINE_FABRICATED_DESCRIPTION_RE, 'Unterassistentinnen / Unterassistenten bei Psychiatrische Universitätsklinik Zürich in Zürich.\n\nPsychiatrische Universitätsklinik Zürich bietet eine sinnstiftende Tätigkeit in einem engagierten Team.\n• Vielfältige Aus- und Weiterbildungsmöglichkeiten\n• Faire Anstellungsbedingungen'],
  ])('%s', (_label, pattern, text) => {
    const job = { sourceLang: 'de', description: text, descriptionByLocale: { de: text, it: 'Traduzione del testo del crawler' } };
    expect(dropFabricatedDescription(job, pattern)).toBe(true);
    expect(job.description).toBe('');
    expect(job.descriptionByLocale).toEqual({});
    expect((job as any).needsRetranslation).toBe(true);
  });

  it('leaves a job with the page text alone', () => {
    const text = `Wir suchen per sofort eine Pflegefachperson HF. ${words(60)}`;
    const job = { sourceLang: 'de', description: text, descriptionByLocale: { de: text, it: 'Traduzione' } };
    for (const pattern of [SOLINA_FABRICATED_DESCRIPTION_RE, KLINIK_ADELHEID_FABRICATED_DESCRIPTION_RE, PRIVATKLINIK_HOHENEGG_FABRICATED_DESCRIPTION_RE, REFLINE_FABRICATED_DESCRIPTION_RE, HAS_FABRICATED_DESCRIPTION_RE, CDS_SAVOGNIN_FABRICATED_DESCRIPTION_RE, PLANZER_FABRICATED_DESCRIPTION_RE]) {
      expect(dropFabricatedDescription(job, pattern)).toBe(false);
    }
    expect(job.descriptionByLocale.it).toBe('Traduzione');
  });
});

// The parsers build the description inside their fetch loop: guard the
// removed constructs and the shared floor on the source body.
describe('no crawler-written stand-in, and the common 50-word floor', () => {
  it.each([
    ['lib/caritas-schweiz-job-parser.mjs', /buildFallbackDescription|Was Caritas bietet/],
    ['lib/pigna-job-parser.mjs', /buildFallbackDescription|Was Pigna bietet/],
    ['lib/privatklinik-hohenegg-job-parser.mjs', /buildFallbackDescription|Wunderschöne Lage am Zürichsee/],
    ['lib/spital-limmattal-job-parser.mjs', /buildFallbackDescription|bietet «Limmi»/],
    ['lib/wagerenhof-job-parser.mjs', /buildFallbackDescription|Was der Wagerenhof bietet/],
    ['lib/refline-common.mjs', /buildFallbackDescription|'• Moderne Arbeitsumgebung'/],
    ['lib/klinik-adelheid-job-parser.mjs', /`Bereich: \$\{row\.bereich\}|Unterägeri \(ZG\)\.`/],
    ['lib/solina-job-parser.mjs', /`Pensum \/ Standort: \$\{|SOLINA_CONTEXT/],
    ['update-has-healthcare-jobs.mjs', /`Settore: Farmaceutico|è alla ricerca di: \$\{title\}/],
    ['lib/cds-savognin-job-parser.mjs', /buildFallbackDescription|beim Center da Sanadad Savognin in Savognin/],
    ['lib/klinik-gut-job-parser.mjs', /buildFallbackDescription|bei der Klinik Gut AG am Standort/],
    ['lib/canton-ticino-osc-job-parser.mjs', /buildFallbackDescription|Il concorso è pubblicato dalla Sezione delle risorse umane/],
    ['lib/aarreha-schinznach-job-parser.mjs', /summaryPieces|Zentrum für interdisziplinäre Rehabilitation in Schinznach-Bad/],
    ['lib/victorinox-job-parser.mjs', /summaryPieces|Hersteller des Original Schweizer Offiziersmessers/],
    ['lib/molecular-partners-job-parser.mjs', /summaryPieces|clinical-stage biotech company developing DARPin therapeutics/],
    ['lib/kispi-job-parser.mjs', /`\$\{title\} — \$\{KISPI_COMPANY_NAME\}/],
    ['lib/kispi-sg-job-parser.mjs', /Synthesise boilerplate|Bewerbung über das Karriereportal des Ostschweizer Kinderspitals/],
    ['lib/planzer-job-parser.mjs', /`Marke der Planzer-Gruppe: |`(Aufgaben|Profil|Benefits):\\n|summaryPieces/],
    ['lib/klinik-barmelweid-job-parser.mjs', /Akutspital für Psychiatrie, Psychosomatik und somatische Rehabilitation/],
    ['lib/gzo-wetzikon-job-parser.mjs', /fallbackDesc/],
    ['lib/igs-bern-job-parser.mjs', /fallbackDesc|Soteria Bern und weitere Angebote/],
    ['lib/privatklinik-wyss-job-parser.mjs', /fallbackDesc/],
    ['lib/suedhang-job-parser.mjs', /fallbackDesc|Klinik für Suchttherapien\./],
    ['lib/sonnweid-job-parser.mjs', /\[fallback, detail\.body\]|` Eintritt: \$\{r\.eintritt\}\.`/],
    ['lib/arsante-clinique-de-carouge-job-parser.mjs', /\[fallback, detail\.body\]|\(groupe Arsanté\), \$\{loc\.city\} \(GE\)/],
    ['lib/crr-suva-sion-job-parser.mjs', /\[fallback, detail\.body\]|Institution de référence en réadaptation et réinsertion/],
  ])('%s', (file, pattern) => {
    const text = source(file);
    expect(text).not.toMatch(pattern);
    expect(text).toMatch(/meetsSourceBodyFloor\(/);
  });
});
