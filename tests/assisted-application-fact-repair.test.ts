import { describe, expect, it } from 'vitest';
import { repairApplicationDocuments } from '../scripts/assisted-application/lib/fact-repair.mjs';

const sources = { text: 'Infermiera di reparto dal 2018 al 2023. Reparto da 24 letti.', order: 'Infermiera\nOspedale\nCandidata', posting: 'Requisito Kubernetes; azienda attiva da 50 anni.' };
const backed = 'Dal 2018 al 2023 ho lavorato in un reparto da 24 letti.';
const documents = {
  coverLetter: { salutation: 'Gentili signore e signori,', paragraphs: [backed, 'Ho 99 anni di esperienza con Kubernetes.'], closing: 'Cordiali saluti' },
  emailSubject: 'Candidatura', emailBody: 'Ho gestito 99 colleghi.', motivationShort: 'Uso Kubernetes.', whyCompany: '',
};

describe('autonomous correction of generated application facts', () => {
  it('preserves verified paragraphs and removes unsupported candidate claims without acknowledging them', () => {
    const repaired = repairApplicationDocuments(documents, sources, { language: 'it' });
    expect(repaired.factCheck).toMatchObject({ ok: true, unsupported: [] });
    expect(repaired.letterBody).toContain(backed);
    expect(repaired.letterBody).not.toContain('99');
    expect(repaired.letterBody).not.toContain('Kubernetes');
    expect(repaired.documents.emailBody).not.toContain('99');
    expect(repaired.documents.motivationShort).not.toContain('Kubernetes');
    expect(documents.coverLetter.paragraphs).toHaveLength(2);
    expect(sources.text).not.toContain('99');
  });
  it.each(['it', 'de', 'fr', 'en'])('uses a checked neutral fallback in %s when no paragraph can be retained', (language) => {
    const repaired = repairApplicationDocuments({ ...documents, coverLetter: { ...documents.coverLetter, paragraphs: ['Ho 99 anni di esperienza con Kubernetes.'] } }, sources, { language });
    expect(repaired.factCheck).toMatchObject({ ok: true, unsupported: [] });
    expect(repaired.documents.coverLetter.paragraphs.length).toBeGreaterThan(0);
    expect(repaired.letterBody).not.toContain('99');
  });
  it('replaces a subject the fact gate rejects, without using the posting as proof of candidate experience', () => {
    const repaired = repairApplicationDocuments(documents, sources, { language: 'it', emailSubject: 'Candidata con 50 anni di esperienza' });
    expect(repaired.emailSubject).toBe('Candidatura');
    expect(repaired.factCheck.ok).toBe(true);
  });
});
