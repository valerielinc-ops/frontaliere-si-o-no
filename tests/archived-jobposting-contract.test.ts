import { describe, expect, it } from 'vitest';
import { buildArchivedJobPosting } from '../build-plugins/shared/archivedJobPosting';
import { buildJobPostingEditorialFields } from '../services/jobs/jobPostingEditorial';

const ago = (days: number) => new Date(Date.now() - days * 86400000).toISOString();
const record = {
  title: 'Specialista dati', company: 'Esempio SA',
  description: 'Una descrizione completa delle mansioni e dei requisiti del ruolo presso la sede di Lugano.',
  postingDateSource: 'reported', datePosted: ago(20), expiredAt: ago(3),
  addressLocality: 'Lugano', canton: 'TI',
};
const options = { locale: 'it', url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/specialista-dati/' };

describe('complete archived SEO without an active offer', () => {
  it.each(['it', 'en', 'de', 'fr'])('keeps all mandatory fields and the past deadline in %s', (locale) => {
    const schema = buildArchivedJobPosting(record, 'Offerta archiviata e non più disponibile.', { ...options, locale })!;
    expect(schema.description).toContain(record.description);
    expect(Date.parse(schema.validThrough)).toBeLessThan(Date.now());
    expect(schema.datePosted).toBe(record.datePosted);
    expect(schema.baseSalary).toBeTruthy();
    expect(schema.employmentType).toBeTruthy();
    expect(schema.jobLocation.address.postalCode).toBeTruthy();
    expect(schema.jobLocation.address.streetAddress).toBeTruthy();
  });
  it.each([
    { company: '' }, { title: '' }, { postingDateSource: 'unknown' },
    { datePosted: 'invalid' }, { datePosted: ago(1) },
    { expiredAt: ago(-3), datePosted: ago(-20) },
  ])('does not invent a historical JobPosting for incomplete evidence %j', (change) => {
    expect(buildArchivedJobPosting({ ...record, ...change }, 'Archived', options)).toBeNull();
  });
  it('uses archive facts rather than an invitation to apply when the original text is short', () => {
    const schema = buildArchivedJobPosting({ ...record, description: 'Reparto dati.' }, 'Offerta archiviata e non più disponibile.', options)!;
    expect(schema.description).toContain('Offerta archiviata');
    expect(schema.description).not.toMatch(/candidati|apply now/i);
  });
  it('keeps source responsibilities and qualifications independently of authentication', () => {
    const fields = buildJobPostingEditorialFields('## Mansioni\n- Gestire i dossier clinici\n\n## Requisiti\n- Laurea in infermieristica', [], 'it');
    expect(fields.responsibilities).toContain('Gestire i dossier clinici');
    expect(fields.qualifications).toContain('Laurea in infermieristica');
  });
});
