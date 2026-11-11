import { describe, expect, it } from 'vitest';
import { buildMeiliJobWireDocument } from '../scripts/lib/meili-wire-shape.mjs';

describe('buildMeiliJobWireDocument', () => {
  it('costruisce il documento compatto con il 100% dei dati necessari alla card', () => {
    const job = {
      id: 'job_42',
      slug: 'senior-fullstack-dev-zurigo',
      title: 'Senior Fullstack Dev',
      company: 'Novartis AG',
      location: 'Basel',
      canton: 'BS',
      salaryMin: 125000,
      salaryMax: 150000,
      salaryCurrency: 'CHF',
      publishedAt: '2026-11-01T10:00:00Z',
      skills: ['TypeScript', 'React', 'Go'],
      roleFingerprint: 'abcd1234ef',
      copies: [{ id: 'job_43', location: 'Zürich' }],
      descriptionHtml: '<p>Cerchiamo un ingegnere esperto.</p><script>alert(1)</script>'
    };

    const doc = buildMeiliJobWireDocument(job);
    expect(doc).not.toBeNull();
    expect(doc?.id).toBe('job_42');
    expect(doc?.slug).toBe('senior-fullstack-dev-zurigo');
    expect(doc?.company).toBe('Novartis AG');
    expect(doc?.company_slug).toBe('novartis-ag');
    expect(doc?.canton).toBe('BS');
    expect(doc?.salary_min).toBe(125000);
    expect(doc?.salary_max).toBe(150000);
    expect(doc?.salary_currency).toBe('CHF');
    expect(doc?.has_copies).toBe(true);
    expect(doc?.copies_count).toBe(1);
    expect(doc?.skills).toContain('Go');
    expect(doc?.description_excerpt).toBe('Cerchiamo un ingegnere esperto. alert(1)');
    expect(doc?.posted_ts).toBe(Math.floor(new Date('2026-11-01T10:00:00Z').getTime() / 1000));
  });

  it('tronca l excerpt a 1000 caratteri e pulisce tag HTML', () => {
    const longText = 'a'.repeat(2000);
    const job = { id: 'j1', description: `<p>${longText}</p>` };
    const doc = buildMeiliJobWireDocument(job);
    expect(doc?.description_excerpt.length).toBe(1000);
  });

  it('restituisce null per input non valido', () => {
    expect(buildMeiliJobWireDocument(null)).toBeNull();
    expect(buildMeiliJobWireDocument({})).toBeNull();
  });
});
