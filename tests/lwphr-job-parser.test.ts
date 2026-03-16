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

  it('infers Lugano/Ticino locations from PDF text', () => {
    expect(inferLwphrLocation('Consulente', 'Per importante società finanziaria nel Luganese')).toBe('Lugano');
    expect(inferLwphrLocation('Marketing Manager', 'Sede di lavoro Ticino')).toBe('Ticino');
  });

  it('builds localized wrappers around pdf descriptions', () => {
    const localized = buildLwphrLocalizedPayload({
      title: 'HR SPECIALIST',
      location: 'Lugano',
      pdfUrl: 'https://www.lwphr.ch/uploads/hr_specialist.pdf',
      pdfText: 'HR Specialist Main Duties: Manage employee documentation.',
    });
    expect(localized.descriptions.it).toContain('PDF ufficiale');
    expect(localized.descriptions.en).toContain('official PDF');
  });
});
