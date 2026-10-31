import { describe, expect, it, vi } from 'vitest';
import {
  articleBodyApiPath,
  buildAnswerCaption,
  buildAnswerCards,
  buildAnswerVoiceScript,
  parseArticleFaq,
  pcmToWav,
  planAnswerTimeline,
  selectAnswerFaq,
  synthesizeAnswerVoice,
  trimAnswer,
} from '../scripts/lib/tiktok-answer-format.mjs';
import { buildAnswerVideoFfmpegArgs } from '../scripts/lib/social-carousel-video.mjs';
import { answerCardFontSize } from '../scripts/lib/social-carousel-image.mjs';
import { TIKTOK_VIDEO_CREATIVE_VARIANTS, isTikTokAnswerFormatAssigned, tiktokVideoCreativeLedgerFields } from '../scripts/lib/tiktok-video-creative.mjs';

const ANSWER = "Il reddito è tassato esclusivamente in Svizzera con una trattenuta alla fonte. In Italia si evita la doppia imposizione con il credito d'imposta. Per i vecchi frontalieri l'esenzione è di €7'500.";

describe('published article FAQ', () => {
  it('maps only the two Italian article hubs to the API', () => {
    expect(articleBodyApiPath('/articoli-svizzera/costo-vita-svizzera-2026')).toBe('bodies/svizzera/it/costo-vita-svizzera-2026.json');
    expect(articleBodyApiPath('/articoli-frontaliere/permesso-g/')).toBe('bodies/frontaliere/it/permesso-g.json');
    expect(articleBodyApiPath('/cerca-lavoro-ticino/ruolo')).toBeNull();
  });

  it('reads the FAQ string of the payload and survives a broken one', () => {
    const faq = JSON.stringify([{ q: 'Come funziona?', a: 'Così  e basta.' }, { q: '', a: 'orfana' }]);
    expect(parseArticleFaq({ translations: { faq } })).toEqual([{ question: 'Come funziona?', answer: 'Così e basta.' }]);
    expect(parseArticleFaq({ translations: { faq: '{broken' } })).toEqual([]);
    expect(parseArticleFaq({})).toEqual([]);
  });
});

describe('selectAnswerFaq', () => {
  const question = 'Come viene tassato il reddito dei frontalieri oltre 20 km?';

  it('takes the first searched question that fits the spoken budget', () => {
    const faq = selectAnswerFaq([
      { question: 'Dove si è svolta la manifestazione di sabato a Como?', answer: ANSWER },
      { question, answer: ANSWER },
    ]);
    expect(faq).toEqual({ question, answer: ANSWER });
  });

  it('refuses statements, thin answers and an answer without a whole sentence in budget', () => {
    expect(selectAnswerFaq([{ question: 'Come viene tassato il reddito dei frontalieri.', answer: ANSWER }])).toBeNull();
    expect(selectAnswerFaq([{ question, answer: 'Dipende dal caso.' }])).toBeNull();
    expect(selectAnswerFaq([{ question, answer: `${'parola '.repeat(80)}fine.` }])).toBeNull();
  });

  it('cuts only at a sentence boundary and keeps the words unchanged', () => {
    const long = `${ANSWER} ${'Questa frase in più resta oltre il limite di lettura del video verticale. '.repeat(5)}`;
    const trimmed = trimAnswer(long);
    expect(long.startsWith(trimmed)).toBe(true);
    expect(trimmed.endsWith('.')).toBe(true);
    expect(trimmed.length).toBeLessThanOrEqual(420);
  });
});

describe('answer video plan', () => {
  const cards = buildAnswerCards({ question: 'Come viene tassato un frontaliere?', answer: ANSWER });

  it('opens on the question and ends on the save prompt', () => {
    expect(cards[0].text).toBe('Come viene tassato un frontaliere?');
    expect(cards.at(-1).kicker).toBe('SALVA QUESTO VIDEO');
    expect(cards.length).toBe(5);
  });

  it('speaks the on-screen words, without the Swiss thousands apostrophe', () => {
    const script = buildAnswerVoiceScript(cards);
    expect(script).toContain('€7500');
    expect(script).toContain('Come viene tassato un frontaliere?');
  });

  it('spends exactly the voice length, with a minimum per card', () => {
    const timeline = planAnswerTimeline(cards, 30);
    expect(timeline.reduce((a, b) => a + b, 0)).toBeCloseTo(30, 6);
    expect(Math.min(...timeline)).toBeGreaterThanOrEqual(1.4);
    expect(() => planAnswerTimeline(cards, 2)).toThrow(/too short/);
    expect(() => planAnswerTimeline(cards, Number.NaN)).toThrow(/too short/);
  });

  it('keeps the voice as the only audio track of the video', () => {
    const args = buildAnswerVideoFfmpegArgs(['a.jpg', 'b.jpg'], [1.5, 2.25], 'voice.wav', 'out.mp4');
    expect(args).toContain('2:a:0');
    expect(args.join(' ')).not.toContain('anullsrc');
    expect(args.join(' ')).toContain('concat=n=2:v=1:a=0[video]');
    expect(() => buildAnswerVideoFfmpegArgs(['a.jpg'], [1, 2], 'v.wav', 'o.mp4')).toThrow(/one duration per card/);
  });

  it('shrinks long sentences on screen', () => {
    expect(answerCardFontSize('a'.repeat(50))).toBeGreaterThan(answerCardFontSize('a'.repeat(120)));
  });
});

describe('buildAnswerCaption', () => {
  it('leads with the question and discloses the synthetic voice', () => {
    const caption = buildAnswerCaption({ question: 'Quanto resta da 5000 franchi?', answer: ANSWER });
    expect(caption.split('\n')[0]).toBe('Quanto resta da 5000 franchi?');
    expect(caption).toContain('voce sintetica');
    expect(caption).not.toContain('visualizzazioni');
    expect(caption.match(/#\w+/g)).toHaveLength(4);
  });
});

describe('voice', () => {
  it('wraps PCM in a WAV header ffmpeg can read', () => {
    const wav = pcmToWav(Buffer.alloc(48_000));
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(24)).toBe(24_000);
    expect(wav.readUInt32LE(40)).toBe(48_000);
  });

  it('measures the voice from the PCM length', async () => {
    const data = Buffer.alloc(240_000).toString('base64');
    const fetchImpl = async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { data } }] } }] }));
    const { seconds } = await synthesizeAnswerVoice('ciao', { apiKey: 'k', fetchImpl });
    expect(seconds).toBe(5);
  });

  it('fails on a missing key or an empty answer, so the post falls back to slides', async () => {
    await expect(synthesizeAnswerVoice('ciao', { apiKey: '' })).rejects.toThrow(/GEMINI_API_KEY/);
    const fetchImpl = async () => new Response('{}');
    await expect(synthesizeAnswerVoice('ciao', { apiKey: 'k', fetchImpl })).rejects.toThrow(/no audio/);
  });
});

describe('answer format assignment', () => {
  it('stays off by default and is stable for a queue id', () => {
    expect(isTikTokAnswerFormatAssigned({ queueId: 'article-2026-11-01', env: {} })).toBe(false);
    const env = { TIKTOK_ANSWER_FORMAT_ROLLOUT_PERCENT: '100' };
    expect(isTikTokAnswerFormatAssigned({ queueId: 'article-2026-11-01', env })).toBe(true);
    expect(isTikTokAnswerFormatAssigned({ queueId: '', env })).toBe(false);
  });

  it('records the spoken variant in the ledger fields', () => {
    expect(tiktokVideoCreativeLedgerFields(TIKTOK_VIDEO_CREATIVE_VARIANTS.ANSWER).creativeVariant).toBe('answer-voice-v1');
  });
});

describe('loadJobIndex', () => {
  it('reaches the dataset instead of dying on a missing fs import', async () => {
    const { loadJobIndex } = await import('../scripts/lib/social-post-utils.mjs');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadJobIndex();
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('could not build the job index'));
    warn.mockRestore();
  });
});
