/**
 * Detail parsers whose character cap was the only bound on a page sweep, and
 * parsers with a latent cap on an already delimited block (issue 5253, lot J
 * of the crawler-quality fleet). The sweeps now read the vacancy container,
 * so the text is whole and carries no page chrome.
 *
 * Fixtures are live detail pages minimised on 2026-09-29 (contacts replaced).
 * No live posting of the latent-cap parsers reaches their old cap today, so
 * those cases lengthen a minimal page of the same shape.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractPublicjobsDetailDescription } from '../scripts/lib/publicjobs-detail-description.mjs';
import { extractKlinikBarmelweidDetailDescription } from '../scripts/lib/klinik-barmelweid-job-parser.mjs';
import { extractSpitalAffolternDetailDescription } from '../scripts/lib/spital-affoltern-job-parser.mjs';
import { extractChuvDetailDescription } from '../scripts/lib/chuv-job-parser.mjs';
import { parseDetailDescription as parsePlaineDetail } from '../scripts/lib/clinique-de-la-plaine-job-parser.mjs';
import { parseDetailDescription as parseDiaconisDetail } from '../scripts/lib/stiftung-diaconis-job-parser.mjs';
import { extractDetailBody as extractArsanteDetailBody } from '../scripts/lib/arsante-clinique-de-carouge-job-parser.mjs';
import { parseDetail as parseRfsmDetail } from '../scripts/lib/rfsm-fribourg-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

describe('publicjobs.ch detail (GZO Spital Wetzikon, igs Bern)', () => {
  const text = extractPublicjobsDetailDescription(fixture('publicjobs-gzo-wetzikon-detail.html'));

  it('publishes the lead paragraph and the whole description block', () => {
    expect(text.startsWith('Unser Institut für Radiologie und Nuklearmedizin')).toBe(true);
    expect(text).toContain('Aufgaben • Sie führen sämtliche radiologischen Untersuchungsmethoden');
    expect(text).toContain('Über das GZO Spital Wetzikon');
    expect(text).toMatch(/Wir freuen uns auf Ihre Bewerbung über unser Online-Bewerbungsportal\.$/);
  });

  it('leaves out the print bar, the metadata card and the contact card', () => {
    expect(text).not.toMatch(/Drucken|Arbeitgeber\*in|Karrierelevel|Kontaktadresse/);
    expect(text).not.toContain('Leitende Ärztin / Leitender Arzt Radiologie 100%');
  });

  it('returns an empty string for a page without the template blocks', () => {
    expect(extractPublicjobsDetailDescription('<html><body><div class="job-content"><p>Menu</p></div></body></html>')).toBe('');
  });
});

describe('Klinik Barmelweid TYPO3 detail', () => {
  const text = extractKlinikBarmelweidDetailDescription(fixture('klinik-barmelweid-detail.html'));

  it('keeps the header subtitles and every jobinfo section', () => {
    expect(text).toContain('Beschäftigungsgrad: 50–100% Eintritt nach Vereinbarung');
    for (const heading of ['So ticken wir', 'Das bewegst du bei uns', 'Du begeisterst uns…', 'Über uns']) {
      expect(text).toContain(heading);
    }
    expect(text).toMatch(/psychopathologischen Störungen zu behandeln\.$/);
  });

  it('drops skip links, quote slider, link buttons, recruiter card, share bar, footer and cookie dialog', () => {
    expect(text).not.toMatch(/Weiter zur Navigation|HR-Team Barmelweid|Lerne uns kennen|Jetzt bewerben|Mein Team sucht dich|Teile die ausgeschriebene Stelle|zurück zur Übersicht|Impressum|Cookie/);
  });
});

describe('Dualoo detail (Spital Affoltern)', () => {
  const text = extractSpitalAffolternDetailDescription(fixture('dualoo-spital-affoltern-detail.html'));

  it('reads the advertisement block: intro, tasks, profile, benefits, about us and contacts', () => {
    expect(text.startsWith('In unserer Alterspsychiatrie mit aktuell 16 Betten')).toBe(true);
    for (const heading of ['Ihr Aufgabengebiet', 'Ihr Profil', 'Unsere Kultur – Ihre Benefits', 'Über uns', 'Kontakt Personalabteilung']) {
      expect(text).toContain(heading);
    }
  });

  it('leaves out the back/apply header, the title badges and the apply footer', () => {
    expect(text).not.toMatch(/Zur Stellenübersicht|Bewerben$|Dipl\. Pflegefachperson HF\/FH Alterspsychiatrie 50-100%/);
  });
});

describe('CHUV Hireserve detail', () => {
  const text = extractChuvDetailDescription(fixture('hireserve-chuv-detail.html'));

  it('reads the job_description block with decoded entities', () => {
    expect(text.startsWith('La Direction des constructions, ingénierie, technique et sécurité du CHUV')).toBe(true);
    for (const heading of ['Contexte', 'Mission', 'Profil', 'Nous offrons', 'Contact et envoi de candidature']) {
      expect(text).toContain(heading);
    }
    expect(text).toMatch(/Merci de votre compréhension\.$/);
  });

  it('leaves out the login toolbar, the mis-encoded classification table, the share link and the application modal', () => {
    expect(text).not.toMatch(/Se connecter|Partager|Avez-vous|Code emploi|�|&eacute;/);
  });
});

describe('latent caps on delimited blocks', () => {
  const items = (n: number, label: string) => Array.from({ length: n }, (_, i) => `<li>${label} ${i + 1}: Betreuung und Begleitung der Patientinnen und Patienten im Alltag der Station</li>`).join('');

  it('Clinique de la Plaine: every et_pb_text_inner block, beyond 6000 characters', () => {
    const html = `<div class="et_pb_text_inner"><h1>Infirmier</h1></div><div class="et_pb_text_inner"><h2>Mission</h2><ul>${items(80, 'Tâche')}</ul></div><div class="et_pb_text_inner"><p>Dernier paragraphe de l'annonce.</p></div>`;
    const text = parsePlaineDetail(html);
    expect(text.length).toBeGreaterThan(6000);
    expect(text).toMatch(/Dernier paragraphe de l'annonce\.$/);
  });

  it('Stiftung Diaconis: every section block, beyond 6000 characters', () => {
    const html = `<div class="col-xs-12 introduction"><p>Einleitung</p></div><div class="col-xs-12 tasks"><ul>${items(80, 'Aufgabe')}</ul></div><div class="col-xs-12 closure"><p>Schlusssatz der Ausschreibung.</p></div>`;
    const text = parseDiaconisDetail(html);
    expect(text.length).toBeGreaterThan(6000);
    expect(text).toMatch(/Schlusssatz der Ausschreibung\.$/);
  });

  it('Arsanté: the microdata description block, beyond 6000 characters', () => {
    const html = `<div itemscope itemtype="https://schema.org/JobPosting"><h1 itemprop="title">Assistant·e</h1><div itemprop="description"><div><p>Introduction</p><ul>${items(80, 'Tâche')}</ul><p>Dernière phrase.</p></div></div></div>`;
    const text = extractArsanteDetailBody(html);
    expect(text.length).toBeGreaterThan(6000);
    expect(text).toMatch(/Dernière phrase\.$/);
  });

  it('RFSM Fribourg: the balanced jobdescription span, beyond 7000 characters', () => {
    const html = `<span class="jobdescription"><p>Introduction</p><ul>${items(90, 'Tâche')}</ul><p><span>Dernière phrase.</span></p></span><div class="row apply"></div>`;
    const { description } = parseRfsmDetail(html);
    expect(description.length).toBeGreaterThan(7000);
    expect(description).toMatch(/Dernière phrase\.$/);
  });

  // The remaining parsers build the text inside their fetch loop; guard the
  // removed construct instead.
  const PARSERS = [
    'evam-vaud', 'clinique-cic', 'crr-suva-sion', 'rennbahnklinik', 'spital-sts',
    'privatklinik-wyss', 'suedhang', 'sonova', 'sonnweid', 'gzo-wetzikon', 'igs-bern',
    'entero', 'lhm-luzerner-hohenklinik-montana', 'klinik-schuetzen',
  ];
  it.each(PARSERS)('%s publishes the detail text without a character cap', (key) => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'lib', `${key}-job-parser.mjs`), 'utf8');
    expect(source).not.toMatch(/\.slice\(0,\s*[2-9]\d{3}\)/);
  });
});
