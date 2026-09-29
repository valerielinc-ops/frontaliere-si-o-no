import { describe, it, expect } from 'vitest';
import { parseVistaOstendisJob } from '../scripts/lib/vista-job-parser.mjs';

// Only the posting's own text is published (issue 5253). A detail page without
// a body (under 30 characters) used to be replaced by a stub of metadata plus
// the company boilerplate ("{title} bei Vista. Abteilung: … Arbeitsort: …
// Vista Augenpraxen & Kliniken ist eine schweizweit tätige Gruppe …"); no job
// is built from it any more. Ostendis entry shape as served for the Vista
// tenant.
describe('parseVistaOstendisJob — vacancy text', () => {
  const entry = {
    id: 61001,
    title: 'Medizinische Praxisassistentin MPA 80-100%',
    city: 'Binningen',
    zip: '4102',
    department: 'Praxis',
    detail: 'https://link.ostendis.com/publication/mpa-binningen/abc123',
    action: 'https://link.ostendis.com/cvdropper/def456/DE?src=abc123',
  };

  it('builds the job from the detail body, without any boilerplate', () => {
    const body = 'Sie betreuen unsere Patientinnen und Patienten am Empfang und unterstützen das Ärzteteam bei Voruntersuchungen.';
    const job = parseVistaOstendisJob(entry, { description: body });
    expect(job).not.toBeNull();
    expect(job.description).toBe(body);
    expect(job.description).not.toMatch(/Vista Augenpraxen & Kliniken ist eine schweizweit/);
  });

  it('builds no job when the detail page has no vacancy text', () => {
    expect(parseVistaOstendisJob(entry, {})).toBeNull();
    expect(parseVistaOstendisJob(entry, { description: 'Kurz' })).toBeNull();
  });
});
