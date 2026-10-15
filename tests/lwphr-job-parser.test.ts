import { describe, expect, it } from 'vitest';
import {
  parseLwphrOpenJobs,
  inferLwphrLocation,
  buildLwphrLocalizedPayload,
  isUsableLwphrPdf,
  LWPHR_FABRICATED_DESCRIPTION_RE,
} from '../scripts/lib/lwphr-job-parser.mjs';

const HTML = `
<div class="accordion__item">
  <div class="accordion__title">POSIZIONI APERTE</div>
  <div class="accordion__content">
    <a href="/uploads/1/4/6/5/146598773/hr_specialist.pdf">HR SPECIALIST</a><br />
    <a href="/uploads/1/4/6/5/146598773/it_security_architect.pdf">IT SECURITY ARCHITECT</a>
  </div>
</div>
<div class="accordion__item">
  <div class="accordion__title">POSIZIONI ARCHIVIATE</div>
  <div class="accordion__content">
    <a href="/uploads/1/4/6/5/146598773/software_engineer.pdf">SOFTWARE ENGINEER</a>
  </div>
</div>
`;

const CURRENT_SITE_HTML = `
<section class="opportunities">
  <h2>POsizioni aperte</h2>
  <div class="open-list">
    <a href="/uploads/1/4/6/5/146598773/planner.pdf">PLANNER</a>
    <a href="/uploads/1/4/6/5/146598773/sales_e_marketing_manager.pdf">SALES E MARKETING MANAGER</a>
  </div>
  <h2>POSIZIONI ARCHIVIATE</h2>
  <div class="archive-list">
    <a href="/uploads/1/4/6/5/146598773/software_engineer.pdf">SOFTWARE ENGINEER</a>
  </div>
</section>
`;

describe('lwphr-job-parser', () => {
  it('extracts only open pdf jobs from the current accordion', () => {
    const jobs = parseLwphrOpenJobs(HTML);
    expect(jobs).toHaveLength(2);
    expect(jobs[0].pdfUrl).toContain('lwphr.ch/uploads/');
  });

  it('extracts open PDF jobs when the site no longer uses accordion markup', () => {
    const jobs = parseLwphrOpenJobs(CURRENT_SITE_HTML);
    expect(jobs.map((job) => job.title)).toEqual([
      'PLANNER',
      'SALES E MARKETING MANAGER',
    ]);
  });

  it('rejects failed, thin, and empty PDF extractions before merge', () => {
    expect(isUsableLwphrPdf({ error: 'HTTP 404 while fetching PDF' })).toBe(false);
    expect(isUsableLwphrPdf({ thin: true, text: '' })).toBe(false);
    expect(isUsableLwphrPdf({ text: 'Role description and requirements.' })).toBe(true);
  });

  it('infers Swiss locations from PDF text without inventing a city', () => {
    expect(inferLwphrLocation('Consulente', 'Sede di lavoro: Luganese')).toBe('Lugano');
    expect(inferLwphrLocation('Marketing Manager', 'Sede di lavoro Ticino')).toBe('');
    expect(inferLwphrLocation('Marketing Manager', 'Sede di lavoro Zürich, Switzerland')).toBe('Zürich');
  });

  it('rejects ordinary aliases and builds titles and slugs, no description of its own', () => {
    expect(inferLwphrLocation('Consulente', 'Per importante società finanziaria nel Luganese')).toBe('');
    const localized = buildLwphrLocalizedPayload({
      title: 'HR SPECIALIST',
      location: 'Lugano',
    });
    expect(localized.titles.it).toBe('HR SPECIALIST');
    expect(localized.slugs.it).toBe(localized.slugs.en);
    expect(localized.slugs.it).toContain('lugano');
    // The PDF text is published alone by the runner, in its own language: the
    // payload no longer wraps it in four intros and a "PDF ufficiale" line.
    expect(localized).not.toHaveProperty('descriptions');
  });

  it('recognises the former wrappers in stored jobs', () => {
    expect(LWPHR_FABRICATED_DESCRIPTION_RE.test('LWP Ledermann Wieting & Partners pubblica questa opportunita sul proprio portale per il mercato svizzero.')).toBe(true);
    expect(LWPHR_FABRICATED_DESCRIPTION_RE.test('LWP Ledermann Wieting & Partners lists this role on its Swiss opportunities portal.')).toBe(true);
    expect(LWPHR_FABRICATED_DESCRIPTION_RE.test('HR Specialist\n\nMain Duties: Manage employee documentation.')).toBe(false);
  });

  it('recovers an explicit narrative workplace from LWP PDFs', () => {
    expect(inferLwphrLocation(
      'Relationship manager',
      'Per la sede prestigiosa di St. Moritz, siamo stati incaricati di selezionare il seguente profilo professionale.',
    )).toBe('St. Moritz');
    expect(inferLwphrLocation(
      'Consulente patrimoniale',
      'Per la sede operativa nel Luganese, ci ha incaricato di selezionare la seguente figura professionale.',
    )).toBe('Lugano');
  });

  it('accepts contracted and possessive worksite articles across PDF line wraps', () => {
    expect(inferLwphrLocation(
      'Consulente',
      "presso l'ufficio di Lugano,\nsiamo stati incaricati di selezionare il profilo.",
    )).toBe('Lugano');
    expect(inferLwphrLocation(
      'Consulente',
      'presso la nostra sede di Lugano,\nsiamo stati incaricati di selezionare il profilo.',
    )).toBe('Lugano');
    expect(inferLwphrLocation(
      'Consulente',
      "all'interno dell'ufficio di Lugano,\nsiamo stati incaricati di selezionare il profilo.",
    )).toBe('Lugano');
    expect(inferLwphrLocation(
      'Consulente',
      'nell’ufficio di Lugano, siamo stati incaricati di selezionare il profilo.',
    )).toBe('Lugano');
    expect(inferLwphrLocation(
      'Consulente',
      "all'ufficio di Lugano, siamo stati incaricati di selezionare il profilo.",
    )).toBe('Lugano');
  });

  it('removes PDF hyphenation before matching narrative worksite and mandate', () => {
    expect(inferLwphrLocation(
      'Relationship manager',
      'Per la sede presti-\ngiosa di St. Moritz, siamo stati incari-\ncati di selezionare il profilo.',
    )).toBe('St. Moritz');
  });

  it('does not promote an employer seat even when a broad mandate token shares the line', () => {
    expect(inferLwphrLocation(
      'Consulente',
      'Azienda con sede a Lugano ricerca una figura da inserire altrove.',
    )).toBe('');
    expect(inferLwphrLocation(
      'Consulente',
      'Il nostro cliente è una banca svizzera sita nel luganese, ci ha incaricato di selezionare la seguente figura professionale.',
    )).toBe('');
    expect(inferLwphrLocation(
      'Consulente',
      'La società ha sede nel Luganese e opera su tutto il territorio svizzero.',
    )).toBe('');
  });

  it('prefers an explicit worksite label when the client seat differs', () => {
    expect(inferLwphrLocation(
      'Consulente',
      'Il cliente ha sede nel Luganese. Sede di lavoro: Zürich.',
    )).toBe('Zürich');
  });
});
