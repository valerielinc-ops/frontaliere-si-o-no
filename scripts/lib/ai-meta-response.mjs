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
 * hints) count anywhere. A marker that is also in the source text is the
 * source's own wording, not a meta-response, and is ignored.
 *
 * Pure and free of imports: the same file can serve the corpus cascade.
 */

// How far into the answer the opener is looked for (after markup/quotes).
const LEADING_WINDOW_CHARS = 320;

const A = "['’]"; // apostrophe, ASCII or typographic

/** Openers: how the answer STARTS. Each is a meta-response by construction. */
const LEADING_PATTERNS = [
  // ── refusal: an apology or an inability, in the FIRST person. «Sorry, the
  // page you requested could not be found» is a scraped 404 page, not a
  // refusal: it has its own guard upstream and no retranslation can fix it.
  ['refusal', new RegExp(`^(?:(?:sorry|i${A}m sorry|i am sorry|i apologi[sz]e)[,.!]?\\s+(?:but\\s+)?i\\b|unfortunately,? i (?:can|am|${A}m|cannot|do not|don${A}t)\\b|i can(?:not|${A}t) (?:help|assist|translate|provide|comply|do that|fulfil)|i${A}m (?:unable|not able) to|i am (?:unable|not able) to|as an ai(?: (?:language model|assistant|model))?\\s*,)`, 'i')],
  ['refusal', /^(?:mi dispiace,? (?:ma )?non|purtroppo non (?:posso|riesco)|non posso (?:aiutar|tradurr|fornir|eseguir)|non sono in grado di)/i],
  ['refusal', /^(?:es tut mir leid,? (?:aber )?ich|leider kann ich (?:nicht|keine|ihnen)|ich kann (?:leider )?(?:nicht|keine) (?:helfen|übersetzen))/i],
  ['refusal', /^(?:(?:je suis )?désolée?,? (?:mais )?je\b|je ne peux pas (?:vous )?(?:aider|traduire|fournir)|je ne suis pas en mesure de)/i],
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
  ['agent-narration', /^(?:let me (?:check|see|look|find|search|first|read|translate|help|examine|review|verify)|looking at (?:the|this|your) (?:git|repo|files?|job|title|data|translation|text|message|request)|we need to (?:translate|output|return|keep|produce)|the user (?:wants|asks|is asking|has|provided|gave))\b/i],
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
  ['clarification', /\b(?:the )?actual (?:job )?title (?:you|that|to)\b/i],
  ['clarification', /\b(?:could|can) you (?:please )?(?:provide|share|paste|send) (?:me )?(?:the|a|your) (?:[\w-]+ ){0,3}(?:title|text|message|content)\b/i],
  ['clarification', new RegExp(`\\b(?:job )?title (?:you${A}(?:re|d)|you (?:are|want|would)) (?:referring|want|like)`, 'i')],
  // «BarmanCity name (optional, …)»: glued to the title, so no word boundary.
  ['prompt-echo', /city name \(optional\b/i],
  // a label at the END of an otherwise translated title: «… Stv. Traduzione:»
  ['label-leak', /(?:^|\s)(?:traduzione|translation|übersetzung|traduction)\s*:\s*$/i],
];

function leadingWindow(text) {
  // Markup, quotes and list numbering are not the opener.
  return String(text || '')
    .replace(/^(?:[\s#>*_`"'«»“”„\-•]+|\(?\d{1,2}[.)]\s*)+/u, '')
    .slice(0, LEADING_WINDOW_CHARS);
}

function presentInSource(marker, source) {
  if (!source) return false;
  return String(source).toLowerCase().includes(String(marker).toLowerCase().trim());
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
    if (m && !presentInSource(m[0], source)) return { kind, marker: m[0] };
  }
  for (const [kind, re] of ANYWHERE_PATTERNS) {
    const m = value.match(re);
    if (m && !presentInSource(m[0], source)) return { kind, marker: m[0].trim() };
  }
  return null;
}
