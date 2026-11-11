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
  });
  it.each([
    { company: '' }, { title: '' }, { postingDateSource: 'unknown' },
    { datePosted: 'invalid' },
  ])('uses safe defaults for incomplete archive evidence %j', (change) => {
    const schema = buildArchivedJobPosting({ ...record, ...change }, 'Archived', options);
    expect(schema).toBeTruthy();
    expect(schema?.hiringOrganization.name).toBeTruthy();
    expect(Date.parse(schema?.validThrough || '')).toBeLessThan(Date.now());
  });
  it('rejects a reported publication date that is not before the archive cutoff', () => {
    expect(buildArchivedJobPosting({ ...record, datePosted: ago(1) }, 'Archived', options)).toBeNull();
  });
  it('does not invent a historical deadline when every supplied deadline is in the future', () => {
    expect(buildArchivedJobPosting({ ...record, expiredAt: ago(-3), datePosted: ago(-20) }, 'Archived', options)).toBeNull();
  });
  it('rejects future archive evidence even when an earlier cutoff exists', () => {
    const now = new Date('2026-11-05T00:00:00Z');
    expect(buildArchivedJobPosting(
      { expiredAt: '2026-11-01T00:00:00Z', crawledAt: '2026-11-06T00:00:00Z' },
      'Archived',
      { ...options, now },
    )).toBeNull();
  });
  it('takes validThrough from the archived record, byte-stable across build clocks', () => {
    const clock = new Date();
    const at = (offsetDays: number) => buildArchivedJobPosting(record, 'Archived', { ...options, now: new Date(clock.getTime() + offsetDays * 86400000) });
    expect(at(0)?.validThrough).toBe(new Date(record.expiredAt).toISOString());
    expect(JSON.stringify(at(3))).toBe(JSON.stringify(at(0)));
  });
  it('never dates validThrough after the recorded expiry', () => {
    const schema = buildArchivedJobPosting({ ...record, crawledAt: ago(2) }, 'Archived', options);
    expect(schema?.validThrough).toBe(new Date(record.expiredAt).toISOString());
  });
  it('bounds validThrough by the last observation when no expiry was recorded', () => {
    const crawledAt = ago(6);
    const schema = buildArchivedJobPosting({ ...record, postingDateSource: 'unknown', datePosted: undefined, expiredAt: undefined, crawledAt }, 'Archived', options);
    expect(schema?.validThrough).toBe(new Date(crawledAt).toISOString());
    const later = buildArchivedJobPosting({ ...record, postingDateSource: 'unknown', datePosted: undefined, expiredAt: undefined, crawledAt }, 'Archived', { ...options, now: new Date(Date.now() + 3 * 86400000) });
    expect(JSON.stringify(later)).toBe(JSON.stringify(schema));
  });
  it('emits no JobPosting, rather than a build-clock deadline, without any archive date', () => {
    expect(buildArchivedJobPosting({ ...record, datePosted: undefined, expiredAt: undefined }, 'Archived', options)).toBeNull();
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
