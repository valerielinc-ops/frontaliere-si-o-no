/**
 * The spoken TikTok answer: one real question from a published article's FAQ,
 * read aloud in about 30 seconds with the same words on screen.
 *
 * Why this shape, measured on 2026-10-31 on 61 videos ranking for our TikTok
 * keywords: none is a slideshow, the median is 55 s with a voice, and the best
 * small accounts answer one precise question. Our daily rankings stop at about
 * 250 views with no share, save or comment, and get 0% of their traffic from
 * search.
 *
 * The words are the site's FAQ, cut at a sentence boundary and never rewritten:
 * tax and salary answers must stay the ones the editorial pipeline published.
 */

const QUESTION_MIN_CHARS = 25;
const QUESTION_MAX_CHARS = 110;
const ANSWER_MIN_CHARS = 90;
const ANSWER_MAX_CHARS = 420;
const CARD_MAX_CHARS = 130;
const MIN_CARD_SECONDS = 1.4;
const GEMINI_TTS_MODEL = 'gemini-2.5-flash-preview-tts';
const GEMINI_TTS_VOICE = 'Kore';
const GEMINI_PCM_SAMPLE_RATE = 24_000;
const TTS_TIMEOUT_MS = 60_000;

/** Evergreen money and work topics: the questions people search and save. */
const SEARCHED_TOPIC = /\b(tass|impost|irpef|stipend|salari|guadagn|busta paga|permesso|contribut|pension|avs|lpp|lamal|malattia|disoccupazion|franchigi|ristorn|contratt|licenziament|ferie|assunzion|frontalier)/i;

const HASHTAGS = Object.freeze(['#frontalieri', '#lavoroinsvizzera', '#ticino', '#svizzera']);

const API_SECTION_BY_HUB = Object.freeze({
  'articoli-frontaliere': 'frontaliere',
  'articoli-svizzera': 'svizzera',
});

/** Published payload of an Italian article page, or null for other pages. */
export function articleBodyApiPath(pagePath) {
  const [hub, id] = String(pagePath || '').split('/').filter(Boolean);
  const section = API_SECTION_BY_HUB[hub];
  return section && id ? `bodies/${section}/it/${id}.json` : null;
}

/** Question/answer pairs of a published article, in page order. */
export function parseArticleFaq(payload) {
  let items;
  try {
    items = JSON.parse(payload?.translations?.faq || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => ({ question: String(item?.q || '').trim(), answer: String(item?.a || '').replace(/\s+/g, ' ').trim() }))
    .filter((item) => item.question && item.answer);
}

/** Sentence ends, but neither "1.200" nor an abbreviation before a lowercase word. */
function splitSentences(text) {
  return String(text || '').split(/(?<=[.!?])\s+(?=[A-ZÀ-Ý€0-9])/u).map((s) => s.trim()).filter(Boolean);
}

/** Whole sentences up to the spoken budget; null when the first alone exceeds it. */
export function trimAnswer(answer) {
  const kept = [];
  let length = 0;
  for (const sentence of splitSentences(answer)) {
    if (length + sentence.length > ANSWER_MAX_CHARS) break;
    kept.push(sentence);
    length += sentence.length + 1;
  }
  return kept.length ? kept.join(' ') : null;
}

/** The first FAQ with a searched topic that fits in a 30-second answer. */
export function selectAnswerFaq(faqs) {
  for (const { question, answer } of faqs || []) {
    if (!question.endsWith('?') || question.length < QUESTION_MIN_CHARS || question.length > QUESTION_MAX_CHARS) continue;
    if (!SEARCHED_TOPIC.test(question)) continue;
    const trimmed = trimAnswer(answer);
    if (trimmed && trimmed.length >= ANSWER_MIN_CHARS) return { question, answer: trimmed };
  }
  return null;
}

function joinClauses(clauses) {
  const parts = [];
  let current = '';
  for (const clause of clauses) {
    if (current && current.length + clause.length + 1 > CARD_MAX_CHARS) {
      parts.push(current);
      current = clause;
    } else {
      current = current ? `${current} ${clause}` : clause;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/** A semicolon is the natural pause; a comma only breaks what is still too long. */
function splitLongSentence(sentence) {
  if (sentence.length <= CARD_MAX_CHARS) return [sentence];
  return sentence.split(/(?<=;)\s+/u).flatMap((part) => (
    part.length <= CARD_MAX_CHARS ? [part] : joinClauses(part.split(/(?<=[,:])\s+/u))
  ));
}

/** Question card, then one card per spoken line, then the save prompt. */
export function buildAnswerCards({ question, answer }) {
  return [
    { kicker: 'FRONTALIERI · LA RISPOSTA', text: question },
    ...splitSentences(answer).flatMap(splitLongSentence).map((text) => ({ kicker: 'IN BREVE', text })),
    { kicker: 'SALVA QUESTO VIDEO', text: 'Il tuo caso può cambiare: verifica i dettagli su frontaliereticino.ch' },
  ];
}

/** Written numbers read better without the Swiss thousands apostrophe. */
function spokenText(text) {
  return String(text).replace(/(\d)['’](\d{3})/g, '$1$2');
}

export function buildAnswerVoiceScript(cards) {
  return spokenText(cards.map((card) => card.text).join(' '));
}

/** Seconds per card, proportional to its text and summing to the voice length. */
export function planAnswerTimeline(cards, totalSeconds) {
  const available = totalSeconds - MIN_CARD_SECONDS * cards.length;
  if (available < 0) throw new Error('the voice track is too short for its cards');
  const chars = cards.reduce((sum, card) => sum + card.text.length, 0);
  return cards.map((card) => MIN_CARD_SECONDS + (available * card.text.length) / chars);
}

/** The question stays the first line: it is what search and Google read first. */
export function buildAnswerCaption({ question, answer }) {
  return [
    question,
    '',
    answer,
    '',
    'Ti è capitato? Scrivilo nei commenti e salva il video per quando ti servirà.',
    '',
    'Informazione generale, voce sintetica. Approfondimento completo: link in bio, frontaliereticino.ch',
    '',
    HASHTAGS.join(' '),
  ].join('\n');
}

/** Wrap Gemini's raw 16-bit mono PCM so ffmpeg can read it without flags. */
export function pcmToWav(pcm, sampleRate = GEMINI_PCM_SAMPLE_RATE) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * @returns {Promise<{ wav: Buffer, seconds: number }>}
 */
export async function synthesizeAnswerVoice(text, { apiKey = process.env.GEMINI_API_KEY, fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error('GEMINI_API_KEY is missing');
  const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TTS_MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: GEMINI_TTS_VOICE } } },
      },
    }),
  });
  if (!response.ok) throw new Error(`Gemini TTS answered ${response.status}`);
  const payload = await response.json();
  const data = payload?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!data) throw new Error('Gemini TTS returned no audio');
  const pcm = Buffer.from(data, 'base64');
  return { wav: pcmToWav(pcm), seconds: pcm.length / (GEMINI_PCM_SAMPLE_RATE * 2) };
}
