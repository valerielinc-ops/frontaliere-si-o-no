/**
 * Issue 5253, Yellowshark family: an application form is not the vacancy.
 *
 * jobs.yellowshark.com renders a Gravity Forms application form (contact
 * fields, document upload, privacy consent) inside the vacancy's `<article>`.
 * Its field wrappers carry classes such as `gfield--has-description` and
 * `description_below`, so `extractDetailFields` took them for vacancy-body
 * containers: the published description started with «Anrede (erforderlich)
 * Frau Herr Vorname (erforderlich) …» and the ad itself only followed as the
 * appended JSON-LD body (slice of 2026-10-03: 629 of 886 rows). The fixture is
 * the recorded `<main>` of a real detail page plus its JobPosting JSON-LD
 * (scripts, styles and SVG removed, consultant name replaced).
 *
 * The form is cut by structure — the `<form>` element — not by its wording,
 * and the ad's bullet lists must stay one item per line.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractDetailFields } from '../scripts/lib/prospector/extract.mjs';
import { stripHtml } from '../scripts/lib/crawler-template.mjs';

const FIXTURE = path.join(__dirname, 'fixtures', 'yellowshark', 'detail-application-form.html');
const URL = 'https://jobs.yellowshark.com/job/sa063454/';

/** Labels and controls of the recorded application form. */
const FORM_TEXT = [
  'Anrede (erforderlich)',
  'Vorname (erforderlich)',
  'Lebenslauf (erforderlich)',
  'Ich akzeptiere die Datenschutzerklärung',
  'Wähle Dateien aus',
  'Akzeptierte Dateitypen',
  'Hier sind Sie richtig',
];

/** The «Ihre Aufgabe» bullet list of the recorded ad. */
const TASKS = [
  'Gesamtverantwortung für Elektroplanungsprojekte',
  'Erarbeitung elektrotechnischer Konzepte',
  'Führung und Koordination von Projektteams',
  'Termin-, Kosten- und Qualitätskontrolle',
  'Ansprechperson für Bauherrschaft',
];

function publishedDescription(html: string, url = URL) {
  // The Yellowshark parser publishes `stripHtml(detail.description)`.
  return stripHtml(extractDetailFields(html, url).description);
}

describe('Yellowshark detail page with an embedded application form', () => {
  const description = publishedDescription(fs.readFileSync(FIXTURE, 'utf8'));
  const lines = description.split('\n').map((line) => line.trim());

  it('does not publish the application form', () => {
    for (const text of FORM_TEXT) expect(description).not.toContain(text);
  });

  it('publishes the vacancy itself', () => {
    expect(description).toContain('Für unsere Kunden im Raum Basel');
    expect(description).toContain('Fliessende Deutschkenntnisse');
  });

  it('keeps every list item on its own line', () => {
    for (const task of TASKS) {
      const owning = lines.filter((line) => line.includes(task));
      expect(owning.length, task).toBeGreaterThan(0);
      for (const line of owning) {
        expect(line, task).toMatch(/^[-–•]\s/);
        expect(TASKS.filter((other) => line.includes(other)), line).toEqual([task]);
      }
    }
  });
});

describe('only the vacancy title exempts a form', () => {
  // No named body container: the <main>/<article> fallback reads the region,
  // so the form's text is published unless the form is cut as chrome.
  const BODY = '<p>Sie betreuen unsere Kundschaft am Schalter und beraten sie zu allen Produkten und Dienstleistungen der Filiale.</p>';

  it('cuts an application form with its own h1 (review of PR 11718, acceptance input)', () => {
    const html = '<article><h1>Job X</h1><form><h1>Bewerbungsformular</h1><label>Vorname</label></form></article>';
    const description = extractDetailFields(html, 'https://jobs.example.ch/job/x/').description;
    expect(description).not.toContain('Vorname');
    expect(description).not.toContain('Bewerbungsformular');
  });

  it('cuts an application form with its own h1 next to the ad', () => {
    const html = `<html><body><article><h1>Job X</h1>${BODY}
      <form><h1>Bewerbungsformular</h1><label>Vorname</label><input name="firstname"></form>
    </article></body></html>`;
    const text = publishedDescription(html, 'https://jobs.example.ch/job/x/');
    expect(text).toContain('beraten sie zu allen Produkten');
    expect(text).not.toContain('Vorname');
  });

  it('cuts an application form that carries its own article container', () => {
    const html = `<html><body><main><h1>Job X</h1>${BODY}
      <form><article><h2>Jetzt bewerben</h2><label>Vorname</label><input name="firstname"></article></form>
    </main></body></html>`;
    const text = publishedDescription(html, 'https://jobs.example.ch/job/x/');
    expect(text).toContain('beraten sie zu allen Produkten');
    expect(text).not.toContain('Vorname');
  });
});

describe('a form that wraps the whole page is not cut', () => {
  it('keeps the vacancy of a page rendered inside one page-level form (ASP.NET WebForms shape)', () => {
    const html = `<html><body><form method="post" action="./Stelle.aspx?id=7" id="aspnetForm">
      <input type="hidden" name="__VIEWSTATE" value="abc">
      <h1>Sachbearbeiterin Finanzen 80-100%</h1>
      <div class="job-description"><p>Sie führen die Kreditorenbuchhaltung und unterstützen den Monatsabschluss des Konzerns.</p>
        <ul><li>Kreditorenbuchhaltung mit Zahlungsverkehr</li><li>Mitarbeit beim Monats- und Jahresabschluss</li></ul></div>
      <input type="submit" value="Suchen">
    </form></body></html>`;
    const text = publishedDescription(html, 'https://jobs.example.ch/Stelle.aspx?id=7');
    expect(text).toContain('Kreditorenbuchhaltung und unterstützen');
    expect(text).toContain('Mitarbeit beim Monats- und Jahresabschluss');
  });

  it('cuts an application form with its own unrelated heading', () => {
    const html = `<article><h1>Job X</h1>
      <form><h1>Bewerbungsformular</h1><label>Vorname</label></form>
    </article>`;
    const text = publishedDescription(html, 'https://jobs.example.ch/job/job-x/');
    expect(text).not.toContain('Vorname');
  });
});
