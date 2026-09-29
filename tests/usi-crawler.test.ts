import { describe, expect, it } from 'vitest';
import {
  buildUsiSourceDescription,
  dropUsiFabricatedText,
  stripUsiWrapper,
} from '../scripts/update-usi-jobs.mjs';

// Minimized from the stored job of
// content.usi.ch/…/hru-docenza-economics-market-design.pdf (slice of
// 2026-09-29): an English call wrapped by the former Italian header/footer,
// stored as the `it` source, with an English and a German copy of the wrapper.
const CALL_TEXT = 'The Università della Svizzera italiana (USI) is a young and dynamic institution, continuously evolving and embracing new challenges, guided by its three core values: quality, openness, and responsibility.\n\nFor information: Prof. Raphael Parchet (raphael.parchet@usi.ch) Director of the Bachelor program in Economics Lugano, 23 March 2026';
const WRAPPED_IT = [
  'Posizione aperta presso Università della Svizzera italiana.',
  'Dipartimento/Istituto: Faculty of Economics.',
  'Ruolo: Call for Applications for a Contract Lecturer Position in Economics and Market Design.',
  'Sede: Lugano, Svizzera (Canton Ticino).',
  CALL_TEXT,
  'Bando ufficiale disponibile in PDF.',
].join('\n\n');
const WRAPPED_EN = [
  'Open position at Università della Svizzera italiana.',
  'Department/Institute: Faculty of Economics.',
  'Role: Call for Applications for a Contract Lecturer Position in Economics and Market Design.',
  'Location: Lugano, Switzerland (Canton Ticino).',
  CALL_TEXT,
  'Official call available as PDF.',
].join('\n\n');

describe('buildUsiSourceDescription', () => {
  it('publishes the call text only, without the former header/footer', () => {
    const description = buildUsiSourceDescription(CALL_TEXT);
    expect(description).toContain('guided by its three core values');
    expect(description).not.toMatch(/Posizione aperta|Open position|Ruolo:|Bando ufficiale disponibile/);
  });

  it('gives a call without text no description instead of a paragraph about USI', () => {
    expect(buildUsiSourceDescription('')).toBe('');
  });
});

describe('stripUsiWrapper', () => {
  it('recovers the call text from a wrapped description', () => {
    expect(stripUsiWrapper(WRAPPED_IT)).toBe(CALL_TEXT);
    expect(stripUsiWrapper(WRAPPED_EN)).toBe(CALL_TEXT);
  });

  it('leaves an unwrapped call untouched', () => {
    expect(stripUsiWrapper(CALL_TEXT)).toBe(CALL_TEXT);
  });
});

describe('dropUsiFabricatedText', () => {
  it('drops every slot built from the wrapper and keys the call by its language', () => {
    const job: any = {
      sourceLang: 'it',
      description: WRAPPED_IT,
      descriptionByLocale: {
        it: WRAPPED_IT,
        en: WRAPPED_EN,
        de: 'Posizione aperta presso Università della Svizzera italiana. Dipartimento/Istituto: Fakultät für Wirtschaftswissenschaften.',
      },
    };
    expect(dropUsiFabricatedText(job)).toBe(true);
    expect(job.description).toBe(CALL_TEXT);
    expect(job.sourceLang).toBe('en');
    expect(job.descriptionByLocale).toEqual({ en: CALL_TEXT });
    expect(job.needsRetranslation).toBe(true);
  });

  it('leaves a clean job alone', () => {
    const job: any = { sourceLang: 'en', description: CALL_TEXT, descriptionByLocale: { en: CALL_TEXT, it: 'Testo tradotto.' } };
    expect(dropUsiFabricatedText(job)).toBe(false);
    expect(job.descriptionByLocale.it).toBe('Testo tradotto.');
    expect(job.needsRetranslation).toBeUndefined();
  });
});
