/**
 * headline-selection-protocol.mjs — il PROTOCOLLO di riferimento fra il prompt
 * di selezione headline e la risposta del modello.
 *
 * ## Il difetto che chiude (issue #188)
 *
 * `HEADLINE_SELECTION_PROMPT` riceve DUE liste e le marcava allo stesso modo:
 *
 *   HEADLINE DISPONIBILI:
 *     [0] (tio.ch) Locarno Film Festival, il programma
 *     [1] (rsi.ch) Ristorni, Berna deplora lo stop
 *   ARTICOLI GIÀ PUBBLICATI:
 *     • [trasferirsi-a-maccagno-…] Trasferirsi a Maccagno… — excerpt
 *
 * Stesse parentesi quadre, due semantiche opposte: nella prima lista il campo
 * fra quadre è una POSIZIONE nel pool candidato, nella seconda è l'**id** di un
 * articolo già pubblicato, che non è selezionabile per costruzione. Il modello
 * non ha modo di distinguerle e il parsing a valle non disambiguava.
 *
 * MISURATO nel run 31402084443, due prove dallo stesso run:
 *
 *   ⚠️  Indice 3 fuori range (0-1), clamp a 0
 *
 * (pool di 2 headline, risposta `3`), e nello stesso run
 *
 *   🎯 Articolo selezionato: "Errare humanum est"
 *      Motivo: L'articolo 'Trasferirsi a Maccagno con Pino e Veddasca da
 *              frontaliere: pro e contro' è rilevante per i frontalieri…
 *
 * cioè una `reason` che motiva un articolo DEL CORPUS mentre la headline
 * pubblicata veniva da `laregione.ch/culture/locarno-film-festival`.
 *
 * ## Perché il clamp era la metà sbagliata da toccare per prima
 *
 * Il clamp riportava a 0 l'indice fuori range, quindi si pubblicava una
 * headline DIVERSA da quella motivata: la `reason` registrata nel run report
 * non descriveva l'articolo scelto. Toccare il clamp per primo (allargarlo,
 * validarlo, loggarlo meglio) avrebbe MASCHERATO l'ambiguità invece di
 * toglierla — l'ordine è: prima il formato del prompt, poi il parsing.
 *
 * ## Le due metà della fix
 *
 * 1. **Sintassi disgiunte.** Le candidate hanno una CHIAVE NOMINATA `H<n>`
 *    (1-based) e un separatore `»`; il digest del corpus non ha più né chiavi
 *    né id né parentesi quadre — solo `• <titolo> — <excerpt>`, che è tutto
 *    ciò che serve al modello per sapere di cosa si è già parlato. Le due liste
 *    non condividono più nessun marcatore, quindi un riferimento non può più
 *    essere letto in due modi.
 *
 * 2. **Il parsing RIFIUTA, non indovina.** Un numero nudo (`selectedIndex: 3`,
 *    `selectedId: "3"`) è esattamente il riferimento ambiguo che la fix toglie:
 *    viene rigettato con `ambiguous_reference`, non risolto a una posizione.
 *    Una chiave fuori dall'intervallo `H1..H<n>` è `out_of_range`: nessun
 *    clamp. Il chiamante ritenta con {@link selectionCorrectionNote}, e se il
 *    modello non si corregge la selezione FALLISCE — non pubblica una headline
 *    diversa da quella motivata.
 *
 * Il modulo è puro (nessun I/O, nessun import) proprio perché
 * `create-article.mjs` non è importabile in test senza `node_modules` e senza
 * far partire il suo `main()`: la logica che decide cosa viene pubblicato deve
 * stare da questa parte del confine. Vedi
 * `generator/tests/headline-selection-protocol.test.mjs`.
 */

/** Prefisso della chiave delle candidate. Una LETTERA, così un numero nudo non può somigliarle. */
export const CANDIDATE_KEY_PREFIX = 'H';

/** Separatore della lista candidate. Non compare nel digest del corpus (che usa `•` e `—`). */
export const CANDIDATE_KEY_SEPARATOR = '»';

/** Le ragioni per cui una risposta di selezione viene RIGETTATA. Nessuna di queste è recuperabile indovinando. */
export const SELECTION_REJECTION = {
  /** Non è JSON e non contiene nemmeno un campo riconoscibile. */
  UNPARSEABLE: 'unparseable',
  /** JSON valido ma senza `selectedId`. */
  MISSING_REFERENCE: 'missing_reference',
  /** Numero nudo: il difetto di #188. Può nominare una posizione candidata o un articolo del corpus — indecidibile. */
  AMBIGUOUS_REFERENCE: 'ambiguous_reference',
  /** Stringa che non è una chiave `H<n>` (p.es. lo slug di un articolo pubblicato). */
  UNKNOWN_KEY: 'unknown_key',
  /** Chiave ben formata ma fuori da `H1..H<candidateCount>`. Qui stava il clamp. */
  OUT_OF_RANGE: 'out_of_range',
};

/** La chiave della i-esima candidata (i è 0-based, la chiave è 1-based: `H1` è la prima). */
export function candidateKey(i) {
  return `${CANDIDATE_KEY_PREFIX}${Number(i) + 1}`;
}

/**
 * La lista delle headline CANDIDATE, l'unica selezionabile.
 *
 * Forma: `H1 » (fonte ⭐FRONTALIERI ⏳UNDATED) titolo`. Niente parentesi quadre:
 * sono il marcatore che il digest del corpus usava per gli id.
 */
export function formatCandidateList(headlines) {
  return (Array.isArray(headlines) ? headlines : [])
    .map((h, i) => {
      const tag = h?._frontalieriBoosted ? ' ⭐FRONTALIERI' : '';
      const recencyTag = h?._undatedFallback ? ' ⏳UNDATED' : '';
      return `${candidateKey(i)} ${CANDIDATE_KEY_SEPARATOR} (${h?.source ?? ''}${tag}${recencyTag}) ${h?.headline ?? ''}`;
    })
    .join('\n');
}

/**
 * Il digest degli articoli GIÀ PUBBLICATI, che serve solo a dire di cosa si è
 * già parlato.
 *
 * Nessun id, nessuna chiave, nessuna parentesi quadra: al modello l'id non
 * serve (non può sceglierlo) e la sua sola presenza era metà del difetto.
 */
export function formatPublishedDigest(entries, { excerptChars = 100 } = {}) {
  return (Array.isArray(entries) ? entries : [])
    .map((e) => {
      const title = String(e?.title ?? '').trim();
      const excerpt = String(e?.excerpt ?? '').trim();
      return excerpt ? `• ${title} — ${excerpt.slice(0, excerptChars)}` : `• ${title}`;
    })
    .join('\n');
}

const CANDIDATE_KEY_RE = new RegExp(`^\\s*${CANDIDATE_KEY_PREFIX}\\s*(\\d+)\\s*$`, 'i');
const BARE_NUMBER_RE = /^\s*[+-]?\d+\s*$/;

function reject(rejection, detail) {
  return { ok: false, rejection, detail: String(detail || '') };
}

/**
 * Interpreta la risposta del modello. **Rifiuta invece di indovinare.**
 *
 * @param {string} rawText risposta grezza del modello (può avere code fence).
 * @param {number} candidateCount quante candidate sono state mostrate.
 * @returns {{ok: true, key: string, index: number, reason: string}
 *          |{ok: false, rejection: string, detail: string}}
 */
export function parseHeadlineSelection(rawText, candidateCount) {
  if (!Number.isInteger(candidateCount) || candidateCount < 1) {
    return reject(SELECTION_REJECTION.OUT_OF_RANGE, `nessuna candidata da selezionare (count=${candidateCount})`);
  }
  const cleaned = String(rawText ?? '')
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();
  if (!cleaned) return reject(SELECTION_REJECTION.UNPARSEABLE, 'risposta vuota');

  let obj = null;
  try {
    const p = JSON.parse(cleaned);
    if (p && typeof p === 'object' && !Array.isArray(p)) obj = p;
  } catch { /* JSON troncato: sotto c'è il recupero a regex */ }

  let rawRef;
  let reason = '';
  if (obj) {
    rawRef = obj.selectedId ?? obj.selected_id;
    reason = typeof obj.reason === 'string' ? obj.reason : '';
    if (rawRef === undefined || rawRef === null) {
      // Un `selectedIndex` è precisamente il riferimento che #188 toglie: un
      // numero nudo non dice a QUALE delle due liste appartiene.
      if ('selectedIndex' in obj || 'selected_index' in obj || 'index' in obj) {
        return reject(
          SELECTION_REJECTION.AMBIGUOUS_REFERENCE,
          'risposta con indice nudo (`selectedIndex`) invece della chiave `selectedId: "H<n>"`',
        );
      }
      return reject(SELECTION_REJECTION.MISSING_REFERENCE, 'campo `selectedId` assente');
    }
  } else {
    // Recupero da JSON troncato — sulla CHIAVE NOMINATA soltanto. Il vecchio
    // recupero leggeva `"selectedIndex": (\d+)` e lo trattava come una scelta
    // valida: era la porta secondaria da cui rientrava lo stesso difetto.
    const idM = cleaned.match(/"selected_?[iI]d"\s*:\s*"([^"]*)"/);
    if (!idM) {
      if (/"selected_?[iI]ndex"\s*:\s*[+-]?\d+/.test(cleaned)) {
        return reject(
          SELECTION_REJECTION.AMBIGUOUS_REFERENCE,
          'risposta troncata con indice nudo (`selectedIndex`) invece della chiave `selectedId`',
        );
      }
      return reject(SELECTION_REJECTION.UNPARSEABLE, cleaned.slice(0, 160));
    }
    rawRef = idM[1];
    const reasonM = cleaned.match(/"reason"\s*:\s*"([^"]*)/);
    reason = reasonM ? reasonM[1] : '(reason troncata)';
  }

  if (typeof rawRef === 'number' || BARE_NUMBER_RE.test(String(rawRef))) {
    return reject(
      SELECTION_REJECTION.AMBIGUOUS_REFERENCE,
      `riferimento numerico nudo "${rawRef}": non identifica né una candidata né altro`,
    );
  }
  const ref = String(rawRef).trim();
  if (!ref) return reject(SELECTION_REJECTION.MISSING_REFERENCE, '`selectedId` vuoto');

  const m = CANDIDATE_KEY_RE.exec(ref);
  if (!m) {
    return reject(
      SELECTION_REJECTION.UNKNOWN_KEY,
      `"${ref.slice(0, 80)}" non è una chiave candidata ${CANDIDATE_KEY_PREFIX}1..${CANDIDATE_KEY_PREFIX}${candidateCount}`,
    );
  }
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n < 1 || n > candidateCount) {
    // Qui stava il clamp a 0. Un riferimento fuori range non è una scelta da
    // salvare: è una risposta da rigettare.
    return reject(
      SELECTION_REJECTION.OUT_OF_RANGE,
      `${CANDIDATE_KEY_PREFIX}${n} fuori da ${CANDIDATE_KEY_PREFIX}1..${CANDIDATE_KEY_PREFIX}${candidateCount}`,
    );
  }
  return { ok: true, key: candidateKey(n - 1), index: n - 1, reason };
}

/** Il promemoria da appendere al prompt al ritentativo dopo un rigetto. */
export function selectionCorrectionNote(rejection, candidateCount) {
  const why = rejection === SELECTION_REJECTION.AMBIGUOUS_REFERENCE
    ? 'Hai risposto con un NUMERO NUDO. Un numero non identifica niente in questo prompt: gli articoli già pubblicati non hanno chiavi e non sono selezionabili.'
    : 'Il riferimento della risposta precedente non corrisponde a nessuna headline disponibile.';
  return [
    '⚠️ LA RISPOSTA PRECEDENTE È STATA RIGETTATA.',
    why,
    `Rispondi SOLO con la chiave di una headline dell'elenco «HEADLINE DISPONIBILI», nella forma esatta "${CANDIDATE_KEY_PREFIX}<n>", con n intero fra 1 e ${candidateCount}.`,
    `Esempio: {"selectedId": "${CANDIDATE_KEY_PREFIX}1", "reason": "…"}`,
  ].join('\n');
}

/**
 * Le due liste condividono ancora un marcatore?
 *
 * È la domanda di #188 resa misurabile: `ok: false` significa che un
 * riferimento del modello potrebbe di nuovo essere letto in due modi.
 */
export function referenceSyntaxOverlap(candidateList, publishedDigest) {
  const problems = [];
  const cand = String(candidateList ?? '');
  const pub = String(publishedDigest ?? '');
  if (/\[[^\]\n]*\]/.test(cand)) problems.push('la lista candidate usa parentesi quadre');
  if (/\[[^\]\n]*\]/.test(pub)) problems.push('il digest del corpus usa parentesi quadre');
  const keyRe = new RegExp(`(^|\\s)${CANDIDATE_KEY_PREFIX}\\d+(\\s|$)`, 'm');
  if (cand && !keyRe.test(cand)) problems.push(`la lista candidate non usa la chiave ${CANDIDATE_KEY_PREFIX}<n>`);
  if (keyRe.test(pub)) problems.push(`il digest del corpus usa la chiave ${CANDIDATE_KEY_PREFIX}<n> delle candidate`);
  return { ok: problems.length === 0, problems };
}
