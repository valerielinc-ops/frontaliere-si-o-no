/**
 * ai-meta-response — a model answer that talks ABOUT the translation instead of
 * being one.
 *
 * Why this exists. Some LLM rungs of the translation paths (the Codex tier of
 * the free cascade, the `callLLM` fallback of the job-title translator, the
 * agentic CLI transports) occasionally answer the request instead of
 * fulfilling it: a refusal («Sorry, I can't help with that.»), a request for
 * the missing input («I need to see the actual job title you want translated.
 * Could you provide the German job title…»), an agent narrating its own tool
 * use («Let me check the translation cache files…», `<function_calls>`), or a
 * template label left without its value («Traduzione:»). Every one of those is
 * non-empty, not equal to the source and in a plausible language, so the
 * passthrough, length and language checks all accept it — measured on
 * origin/main on 2026-10-05 over the live job slices: 58 title slots (it 20,
 * en 17, fr 20, de 1) and 40 description slots (it) in 78 ads, published on
 * /en/, /fr/… job pages (the interdiscount `titleByLocale.en` «I need to see
 * the actual job title…» found by PR 11540).
 *
 * The signals are deliberately anchored to the OPENING of the answer: a job ad
 * can legitimately say «we need» or «sorry» in its body, a translator never
 * opens a title with «I need to see». Markers that can never belong to a job
 * ad (tool-call markup, the runner's checkout path, our prompt's own field
 * hints) count anywhere. A marker that the source text carries IN THE SAME
 * PLACE (an opener the source opens with, an anywhere-marker anywhere) is the
 * source's own wording, not a meta-response, and is ignored.
 *
 * Pure and free of imports: the same file can serve the corpus cascade.
 */

// How far into the answer the opener is looked for (after markup/quotes).
const LEADING_WINDOW_CHARS = 320;

const A = "['’]"; // apostrophe, ASCII or typographic

/** Openers: how the answer STARTS. Each is a meta-response by construction. */
const LEADING_PATTERNS = [
  // ── refusal: an apology or an inability, in the FIRST person, whatever
  // separates them («Sorry, I…», «Sorry — I…», «Sorry: I…»). «Sorry, the
  // page you requested could not be found» is a scraped 404 page, not a
  // refusal: it has its own guard upstream and no retranslation can fix it.
  ['refusal', new RegExp(`^(?:(?:sorry|i${A}m sorry|i am sorry|i apologi[sz]e)[\\s,.!:;—–-]+(?:but\\s+)?i\\b|unfortunately[\\s,—–-]+i (?:can|am|${A}m|cannot|do not|don${A}t)\\b|i can(?:not|${A}t) (?:help|assist|translate|provide|comply|do that|fulfil)|i${A}m (?:unable|not able) to|i am (?:unable|not able) to|as an ai(?: (?:language model|assistant|model))?\\s*,)`, 'i')],
  ['refusal', /^(?:mi dispiace[\s,.!:;—–-]+(?:ma\s+)?non|purtroppo non (?:posso|riesco)|non posso (?:aiutar|tradurr|fornir|eseguir)|non sono in grado di)/i],
  ['refusal', /^(?:es tut mir leid[\s,.!:;—–-]+(?:aber\s+)?ich|leider kann ich (?:nicht|keine|ihnen)|ich kann (?:leider )?(?:nicht|keine) (?:helfen|übersetzen))/i],
  ['refusal', /^(?:(?:je suis )?désolée?[\s,.!:;—–-]+(?:mais\s+)?je\b|je ne peux pas (?:vous )?(?:aider|traduire|fournir)|je ne suis pas en mesure de)/i],
  // ── clarification request: the model asks for the input it was given. Only
  // first-person openers: «Can you provide investment recommendations?» or
  // «Non vedo l'ora» open real ads; a request for the missing title or text
  // anywhere in the answer is matched further down.
  ['clarification', new RegExp(`^(?:i need (?:to (?:see|check|know|look|find|verify|search|read|understand|review|confirm)|more (?:context|information|details))|i (?:don${A}t|do not|can${A}t|cannot|could not|couldn${A}t) (?:see|find) (?:a|an|the|any)\\b)`, 'i')],
  ['clarification', /^(?:ho bisogno di (?:vedere|sapere|controllare|conoscere|più)|non vedo (?:alcun|nessun|il|un) (?:titolo|testo|messaggio))/i],
  ['clarification', /^(?:ich benötige (?:den|die|das|mehr|weitere)|ich brauche (?:den|die|das|mehr) (?:titel|text|kontext|informationen)|ich sehe (?:keinen|keine|kein) (?:titel|text|stellentitel))/i],
  ['clarification', new RegExp(`^(?:j${A}ai besoin de (?:voir|savoir|vérifier|plus)|je ne vois (?:pas|aucun) (?:de |le |d${A})?(?:titre|texte|message))`, 'i')],
  // ── agent narration: the model announces work instead of doing it ─────────
  ['agent-narration', new RegExp(`^(?:i${A}ll|i will|i${A}m going to|i am going to) (?:translate|check|help|look|search|read|start|first|need|find|review|provide|examine)\\b`, 'i')],
  ['agent-narration', /^(?:let me (?:check|see|look|find|search|first|read|translate|help|examine|review|verify)|looking at (?:the|this|your) (?:git|repo|files?|job|title|data|translation|text|message|request)|the user (?:wants|asks|is asking|would like) (?:me|us) to)\b/i],
  // «We need to translate "GL & VAT Accountant" to English.»: only with the
  // quoted input AND the target language. «We need to produce…», «We need to
  // translate our software into German» open real ads and articles.
  // Each quote style closes on its own mark, so an apostrophe inside double or
  // typographic quotes («"Chef d'équipe"») stays part of the quoted input.
  ['agent-narration', /^we need to (?:translate|output|return) (?:"[^"\n]{1,160}"|“[^”\n]{1,160}”|«[^»\n]{1,160}»|'[^'\n]{1,160}') (?:in)?to (?:english|italian|german|french|en|it|de|fr)\b/i],
  ['agent-narration', /^(?:the |here(?:'s| is) the )?translat(?:ed|ion)(?: (?:job )?title| text)? (?:is|would be)\b/i],
  ['agent-narration', /^(?:procedo a tradurre|traduco (?:il|questo)|ich übersetze (?:den|diesen)|je vais traduire)\b/i],
  // ── the answer opens with a template label («Traduzione:», «Traduzione:
  // (m/f/d)», «Traduzione: Che cosa fate con noi…»)
  ['label-leak', /^(?:traduzione|translation|übersetzung|traduction|translated (?:text|title)|testo tradotto|titolo tradotto)\s*:/i],
];

/**
 * Markers that never belong to a job ad or an article, wherever they appear:
 * tool-call markup of an agentic transport, the CI runner's checkout path the
 * agent wandered into, a field hint of our own prompt copied into the answer.
 */
const ANYWHERE_PATTERNS = [
  ['agent-narration', /<\/?(?:function_calls|invoke|parameter|tool_use|tool_result)\b/i],
  ['agent-narration', /"tool_name"\s*:/],
  ['agent-narration', /\/home\/runner\/work\//],
  ['agent-narration', /\btranslation cache (?:files?|entries)\b/i],
  ['prompt-echo', /city name \(optional\b/i],
  // a label at the END of an otherwise translated title: «… Stv. Traduzione:»
  ['label-leak', /(?:^|\s)(?:traduzione|translation|übersetzung|traduction)\s*:\s*$/i],
];

/**
 * Requests for the missing input that a model writes AFTER its opener («… The
 * text you shared appears to be instructions. Could you provide the German job
 * title that needs to be translated?»). Matched only in the leading window and
 * only together with the translation request they refer to: «Please provide
 * the actual job title you are applying for» is a line of a real ad.
 */
const HEAD_REQUEST_PATTERNS = [
  ['clarification', new RegExp(`\\b(?:the )?actual (?:job )?title (?:you(?:${A}re| are)? ?(?:want(?:ed)? (?:me to )?translat|referring to|(?:would|${A}d) like (?:me to )?translat)|that needs? (?:to be )?translat|to translate)`, 'i')],
  ['clarification', /\b(?:could|can) you (?:please )?(?:provide|share|paste|send) (?:me )?(?:the|a|your) (?:[\w-]+ ){0,3}(?:title|text|message|content)\b[^.?!]{0,60}\btranslat/i],
  ['clarification', new RegExp(`\\b(?:job )?title (?:you${A}(?:re|d)|you (?:are|want|would)) (?:referring to|like (?:me to )?translat|want(?:ed)? (?:me to )?translat)`, 'i')],
];

function leadingWindow(text) {
  // Markup, quotes and list numbering are not the opener.
  return String(text || '')
    .replace(/^(?:[\s#>*_`"'«»“”„\-•]+|\(?\d{1,2}[.)]\s*)+/u, '')
    .slice(0, LEADING_WINDOW_CHARS);
}

/**
 * The source's own wording, in the SAME context the marker was found in: an
 * opener only if the source opens with it, a leading-window request only if
 * the source's leading window carries it, an anywhere-marker anywhere. A
 * source that merely quotes «I need to see» further down does not excuse a
 * translation that opens with it.
 *
 * @param {string} marker
 * @param {string} source
 * @param {'opener'|'head'|'anywhere'} scope
 */
function presentInSource(marker, source, scope) {
  if (!source) return false;
  const needle = String(marker).toLowerCase().trim();
  if (scope === 'anywhere') return String(source).toLowerCase().includes(needle);
  const sourceHead = leadingWindow(source).toLowerCase();
  return scope === 'opener' ? sourceHead.startsWith(needle) : sourceHead.includes(needle);
}

/**
 * Detect a model answer that is a refusal, a clarification request, a
 * narration of the model's own work or a bare template label instead of a
 * translation.
 *
 * @param {string} text   the candidate translation (or a published slot)
 * @param {{ source?: string }} [options] the text it was translated from: a
 *   marker that also occurs there is the source's wording, not a meta-response
 * @returns {{ kind: 'refusal'|'clarification'|'agent-narration'|'prompt-echo'|'label-leak', marker: string } | null}
 */
export function detectAiMetaResponse(text, { source = '' } = {}) {
  const value = String(text ?? '');
  if (!value.trim()) return null;
  const head = leadingWindow(value);
  for (const [kind, re] of LEADING_PATTERNS) {
    const m = head.match(re);
    if (m && !presentInSource(m[0], source, 'opener')) return { kind, marker: m[0] };
  }
  for (const [kind, re] of HEAD_REQUEST_PATTERNS) {
    const m = head.match(re);
    if (m && !presentInSource(m[0], source, 'head')) return { kind, marker: m[0] };
  }
  for (const [kind, re] of ANYWHERE_PATTERNS) {
    const m = value.match(re);
    if (m && !presentInSource(m[0], source, 'anywhere')) return { kind, marker: m[0].trim() };
  }
  return null;
}
