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

  it('honors an explicit publisher source-language pin', () => {
    const title = 'Project Manager';
    expect(getItalianJobTitle({
      source: 'publisher-submitted',
      sourceLang: 'it',
      title,
      titleByLocale: { it: title },
    })).toBe(title);
  });
});
