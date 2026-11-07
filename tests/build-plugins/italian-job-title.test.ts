import { describe, expect, it } from 'vitest';
import { getItalianJobTitle } from '../../build-plugins/shared/italianJobTitle.mjs';

describe('getItalianJobTitle', () => {
  it('accepts a real Italian localization of the Döttingen Lidl example', () => {
    const job = {
      sourceLang: 'de',
      title: 'Verkäufer / Verkäuferin mit Schichtverantwortung (m/w/d) 60-80% 1 — Döttingen',
      titleByLocale: {
        it: 'Venditore / Venditrice con responsabilità di turno (m/f/d) 60-80% 1 — Döttingen',
      },
      company: 'Lidl Svizzera',
      location: 'Döttingen',
    };

    expect(getItalianJobTitle(job)).toBe(job.titleByLocale.it);
  });

  it('rejects a German title copied into the Italian slot', () => {
    const title = 'Verkäufer / Verkäuferin mit Schichtverantwortung (m/w/d) 60-80% 1 — Döttingen';
    expect(getItalianJobTitle({
      sourceLang: 'de',
      title,
      titleByLocale: { it: title },
      company: 'Lidl Svizzera',
      location: 'Döttingen',
    })).toBe('');
  });

  it('rejects German residue in a partially translated title', () => {
    expect(getItalianJobTitle({
      sourceLang: 'de',
      title: 'Verkäufer / Verkäuferin mit Schichtverantwortung (m/w/d) 60-80% 1 — Döttingen',
      titleByLocale: {
        it: 'Verkäufer / Verkäuferin con Schichtverantwortung (m/w/d) 60-80% 1 — Döttingen',
      },
      company: 'Lidl Svizzera',
      location: 'Döttingen',
    })).toBe('');
  });

  it('catches a foreign source title even when the record says Italian', () => {
    const title = 'Pharmaceutical Technology Technician';
    expect(getItalianJobTitle({
      sourceLang: 'it',
      title,
      titleByLocale: { it: title },
    })).toBe('');
  });

  it('catches German residue in a title mislabeled as Italian', () => {
    expect(getItalianJobTitle({
      sourceLang: 'it',
      title: 'Verkäufer mit Schichtverantwortung',
      titleByLocale: { it: 'Verkäufer con Schichtverantwortung' },
    })).toBe('');
  });

  it('does not fall back to the raw title when the Italian slot is missing', () => {
    expect(getItalianJobTitle({ title: 'Verkäufer / Verkäuferin' })).toBe('');
  });

  it('does not preserve a foreign application title for a publisher-pinned Italian slot', () => {
    const title = 'Project Manager';
    const job = {
      source: 'publisher-submitted',
      sourceLang: 'it',
      titleByLocale: { it: title },
    };
    expect(getItalianJobTitle({ ...job, title })).toBe('');
    expect(getItalianJobTitle(job)).toBe('');
  });

  it.each([
    ['de', 'Projektmanager'],
    ['en', 'Project Manager'],
    ['fr', 'Chef de projet'],
  ])('rejects a foreign Italian-slot title when the publisher source language is %s', (sourceLang, applicationTitle) => {
    const title = 'Project Manager';
    expect(getItalianJobTitle({
      source: 'publisher-submitted',
      sourceLang,
      title: applicationTitle,
      titleByLocale: {
        [sourceLang]: applicationTitle,
        it: title,
      },
    })).toBe('');
  });

  it('keeps a publisher-pinned title when its Italian text is already translated', () => {
    const title = 'Responsabile di progetto';
    expect(getItalianJobTitle({
      source: 'publisher-submitted',
      sourceLang: 'it',
      title: 'Project Manager',
      titleByLocale: { it: title },
    })).toBe(title);
  });
});
