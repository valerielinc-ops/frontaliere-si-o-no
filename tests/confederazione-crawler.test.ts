/**
 * Confederazione — publish boundary floor (audit-parser-quality issue 5253,
 * NN #4). The padding that lifted a short federal body over 50 words is gone,
 * so the floor is enforced on SOURCE text only: a 1-49-word body is never
 * published, a stored source body that clears the floor is kept instead.
 */
import { describe, expect, it } from 'vitest';
import {
  confederazionePublishableBody,
  isRetiredFederalFiller,
} from '../scripts/update-confederazione-jobs.mjs';

// Real API wording (jobs.admin.ch, "Laborant/in EFZ Biologie"), repeated to
// reach an exact word count.
const SOURCE_WORDS = 'Sie unterstützen das Team bei Laborarbeiten in der Biologie und führen Analysen selbstständig durch'.split(' ');
const words = (n: number) => Array.from({ length: n }, (_, i) => SOURCE_WORDS[i % SOURCE_WORDS.length]).join(' ');
const job = (body: string, sourceLang = 'de') => ({ sourceLang, descriptionByLocale: { [sourceLang]: body } });

describe('Confederazione publish floor', () => {
  it('does not publish a non-empty 49-word body without a stored source body', () => {
    expect(confederazionePublishableBody(job(words(49)), null)).toBeNull();
  });

  it('publishes a 50-word body', () => {
    expect(confederazionePublishableBody(job(words(50)), null)).toEqual({ sourceLang: 'de', body: words(50) });
  });

  it('keeps the stored source body when this run reads only 49 words', () => {
    const stored = job(words(120));
    expect(confederazionePublishableBody(job(words(49)), stored)).toEqual({ sourceLang: 'de', body: words(120) });
  });

  it('never counts the retired padding as source text', () => {
    const padded = `${words(20)}\nStelle in der Schweizerischen Bundesverwaltung (Schweizerische Eidgenossenschaft).\n${words(40)}\nBewerben Sie sich online auf jobs.admin.ch.`;
    expect(isRetiredFederalFiller(padded)).toBe(true);
    expect(confederazionePublishableBody(job(padded), null)).toBeNull();
    expect(confederazionePublishableBody(job(words(49)), job(padded))).toBeNull();
  });
});
