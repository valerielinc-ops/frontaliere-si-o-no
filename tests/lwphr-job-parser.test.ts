import { describe, expect, it } from 'vitest';
import { parseLwphrOpenJobs, inferLwphrLocation, buildLwphrLocalizedPayload } from '../scripts/lib/lwphr-job-parser.mjs';

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

describe('lwphr-job-parser', () => {
  it('extracts only open pdf jobs from the current accordion', () => {
    const jobs = parseLwphrOpenJobs(HTML);
    expect(jobs).toHaveLength(2);
    expect(jobs[0].pdfUrl).toContain('lwphr.ch/uploads/');
  });

  it('infers Swiss locations from PDF text without inventing a city', () => {
    expect(inferLwphrLocation('Consulente', 'Sede di lavoro: Luganese')).toBe('Lugano');
    expect(inferLwphrLocation('Marketing Manager', 'Sede di lavoro Ticino')).toBe('');
    expect(inferLwphrLocation('Marketing Manager', 'Sede di lavoro Zürich, Switzerland')).toBe('Zürich');
  });

  it('rejects ordinary aliases and builds localized wrappers', () => {
    expect(inferLwphrLocation('Consulente', 'Per importante società finanziaria nel Luganese')).toBe('');
    const localized = buildLwphrLocalizedPayload({
      title: 'HR SPECIALIST',
      location: 'Lugano',
      pdfUrl: 'https://www.lwphr.ch/uploads/hr_specialist.pdf',
      pdfText: 'HR Specialist Main Duties: Manage employee documentation.',
    });
    expect(localized.descriptions.it).toContain('PDF ufficiale');
    expect(localized.descriptions.en).toContain('official PDF');
  });

  it('recovers an explicit narrative workplace from LWP PDFs', () => {
    expect(inferLwphrLocation(
      'Segretaria legale',
      'Studio legale e notarile con sede nel Luganese, ci ha incaricati di ricercare una/un candidata/o.',
    )).toBe('Lugano');
    expect(inferLwphrLocation(
      'Consulente patrimoniale',
      'Il nostro cliente è una banca svizzera sita nel luganese, ci ha incaricato di selezionare la seguente figura professionale.',
    )).toBe('Lugano');
  });

  it('does not promote an employer seat without a mandate lead to a work location', () => {
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
