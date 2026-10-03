/**
 * The next move on an assisted-application order, for the owner queue
 * (components/pages/AssistedApplicationAdmin.tsx). Owner request 2026-10-03:
 * every order read «Pronte», whether it waited for the candidate, for a new
 * draft, for Valerie's click through the extension, or for a fix the extension
 * cannot replace. One answer per order: whose move it is, and which.
 *
 * Pure: it reads only what the queue already has (the order, its flow and its
 * draft), so the page and the tests share it.
 */

export type NextStepGroup = 'owner' | 'candidate' | 'fix' | 'robot' | 'done';

export interface NextStep {
  group: NextStepGroup;
  /** Stable code of the case (tests, filters). */
  code: string;
  /** Short, shown as the order's badge. */
  label: string;
  /** What to do, or what is being waited for. */
  detail: string;
}

export interface NextStepOrder {
  submissionStatus: string;
  hasCv: boolean;
  paidAt?: string | null;
  automation?: {
    flow: {
      state: string | null;
      heldBy: string[];
      deadlineAt: number | null;
      reminderAt?: number | null;
      dispatch?: { requestedAt: number; mode?: string } | null;
      history?: Array<{ at: number; event: string; state: string }>;
    } | null;
  } | null;
}

export const NEXT_STEP_GROUP_LABELS: Record<NextStepGroup, string> = {
  owner: 'Tocca a te',
  candidate: 'Aspetta il candidato',
  fix: 'Bloccate: serve una correzione',
  robot: 'Robot al lavoro',
  done: 'Concluse',
};

// What the fill extension completes: the form is fine and nothing was sent (a CAPTCHA before the
// send, or the portal's own word that it did not send), only a human may press send.
const EXTENSION_HOLDS = new Set(['portal:captcha', 'portal:rejected', 'portal_refused']);
// A send that may have reached the employer (the flow's AMBIGUOUS_SUBMIT_HOLDS, review of #11016):
// checked before anything is sent again, never straight to a second send.
const AMBIGUOUS_HOLDS = new Set(['portal_ambiguous', 'portal_antibot_ambiguous', 'email_ambiguous']);
// The robot could not get past the portal's account: the extension types a form, it never creates an account.
const ACCOUNT_HOLD_RE = /^portal:account(_|$)/;

const DAY_MS = 24 * 60 * 60 * 1000;

function clock(ms: number | null | undefined): string {
  if (!ms) return '';
  return new Date(ms).toLocaleString('it-IT', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function since(ms: number | null | undefined, nowMs: number): string {
  if (!ms) return '';
  const hours = Math.max(0, Math.round((nowMs - ms) / (60 * 60 * 1000)));
  if (hours < 1) return 'da meno di un’ora';
  if (hours < 48) return `da ${hours} ${hours === 1 ? 'ora' : 'ore'}`;
  return `da ${Math.round(hours / 24)} giorni`;
}

/** When the flow entered its current state. */
function enteredAt(flow: NonNullable<NonNullable<NextStepOrder['automation']>['flow']>): number | null {
  const history = flow.history || [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index].state !== flow.state) return history[index + 1]?.at ?? null;
  }
  return history[0]?.at ?? null;
}

function countHeld(heldBy: string[]): string {
  const questions = heldBy.filter((held) => held.startsWith('question:')).length;
  const documents = heldBy.filter((held) => held.startsWith('document:')).length;
  const parts = [
    questions ? `${questions} ${questions === 1 ? 'risposta' : 'risposte'}` : '',
    documents ? `${documents} ${documents === 1 ? 'documento' : 'documenti'}` : '',
  ].filter(Boolean);
  return parts.join(' e ');
}

function takeoverStep(heldBy: string[]): NextStep {
  const held = heldBy[0] || '';
  if (held === 'owner') {
    return {
      group: 'owner', code: 'owner_took_over', label: 'Presa in carico da te',
      detail: 'L’hai fermata tu. «Rigenera» per una nuova bozza (rilegge l’annuncio, compresi i documenti che richiede), «Riprendi automazione» per rimandarla in revisione così com’è, oppure completala tu.',
    };
  }
  if (EXTENSION_HOLDS.has(held)) {
    return {
      group: 'owner', code: 'complete_with_extension', label: 'Completa con l’estensione',
      detail: 'Il portale ha fermato il robot con un controllo anti-robot, il modulo è a posto. «Compila con l’estensione» lo riempie nel tuo Chrome e tu premi l’invio.',
    };
  }
  if (AMBIGUOUS_HOLDS.has(held)) {
    return {
      group: 'owner', code: 'check_if_received', label: 'Verifica se è arrivata',
      detail: 'L’invio ha un esito incerto. Controlla se il datore l’ha ricevuta (conferma sull’alias o sul portale): se sì «Segna come inviata», altrimenti completala con l’estensione.',
    };
  }
  if (ACCOUNT_HOLD_RE.test(held)) {
    return {
      group: 'fix', code: 'portal_account', label: 'Bloccata: account sul portale',
      detail: 'Il robot non è riuscito a creare o a usare l’account sul portale. L’estensione compila i moduli ma non crea account: serve una correzione del robot, poi «Riprova l’invio automatico». In alternativa crei tu l’account a mano e completi l’invio.',
    };
  }
  if (held === 'portal:posting_mismatch') {
    return {
      group: 'owner', code: 'check_form', label: 'Controlla il modulo',
      detail: 'Il modulo aperto non nomina l’azienda o il ruolo dell’annuncio. Se è quello giusto, «Riprova l’invio automatico» va avanti.',
    };
  }
  if (held === 'portal_validation' || held.startsWith('portal:')) {
    return {
      group: 'fix', code: 'portal_page', label: 'Bloccata: pagina del portale',
      detail: 'Il robot non ha completato una pagina del portale. Prova «Compila con l’estensione»: se si ferma sullo stesso punto, serve una correzione del robot prima di «Riprova l’invio automatico».',
    };
  }
  if (held === 'draft_failed' || held === 'runner_timeout') {
    return {
      group: 'owner', code: 'regenerate', label: 'Da rigenerare',
      detail: 'La bozza non è uscita. «Rigenera» la riscrive nello stesso giro: il candidato non perde nessuna delle sue revisioni.',
    };
  }
  if (held === 'max_rounds') {
    return {
      group: 'owner', code: 'contact_candidate', label: 'Contatta il candidato',
      detail: 'Ha rifiutato la bozza tre volte: scrivigli per capire cosa vuole, poi «Rigenera» o completa tu.',
    };
  }
  if (held === 'posting_closed') {
    return {
      group: 'done', code: 'posting_closed', label: 'Annuncio chiuso',
      detail: 'L’annuncio è stato chiuso prima dell’invio: il rimborso automatico è partito (se non riesce ricevi un avviso).',
    };
  }
  return {
    group: 'owner', code: 'retry_or_complete', label: 'Invio non riuscito',
    detail: 'L’invio automatico non è andato a buon fine. «Riprova l’invio automatico», oppure completala tu.',
  };
}

export function nextStepFor(order: NextStepOrder, nowMs: number = Date.now()): NextStep {
  if (order.submissionStatus === 'refunded') return { group: 'done', code: 'refunded', label: 'Rimborsata', detail: 'Ordine rimborsato.' };
  if (order.submissionStatus === 'submitted') return { group: 'done', code: 'submitted', label: 'Inviata', detail: 'La candidatura è arrivata al datore.' };
  if (order.submissionStatus === 'blocked') {
    return { group: 'owner', code: 'blocked_by_owner', label: 'Bloccata da te', detail: '«Riprendi lavorazione» per rimetterla in coda, oppure avvia il rimborso.' };
  }

  const flow = order.automation?.flow;
  if (!flow?.state) {
    if (!order.hasCv) {
      const paidMs = order.paidAt ? Date.parse(order.paidAt) : 0;
      const waiting = paidMs ? ` (pagato ${since(paidMs, nowMs)})` : '';
      return {
        group: 'candidate', code: 'waiting_cv', label: 'Aspetta il CV',
        detail: `Il candidato non ha ancora mandato il CV${waiting}. ${paidMs && nowMs - paidMs > 5 * DAY_MS ? 'È passato molto tempo: scrivigli, oppure avvia il rimborso.' : 'Riceve da solo il promemoria dopo 48 ore.'}`,
      };
    }
    return { group: 'owner', code: 'start', label: 'Da avviare', detail: 'Il CV c’è ma l’automazione non è partita: «Avvia automazione».' };
  }

  const heldBy = flow.heldBy || [];
  switch (flow.state) {
    case 'drafting':
    case 'regenerating':
      return {
        group: 'robot', code: 'drafting', label: 'Bozza in preparazione',
        detail: `Il robot sta scrivendo la bozza${flow.dispatch?.requestedAt ? ` (${since(flow.dispatch.requestedAt, nowMs)})` : ''}: di solito 10–15 minuti. Se non riesce, riprova da solo e poi ti avvisa.`,
      };
    case 'owner_review':
      if (heldBy.length) {
        return { group: 'owner', code: 'review_held', label: 'Bozza ferma: serve il tuo ok', detail: 'La bozza non passa al candidato finché non confermi gli avvisi qui sotto (fatti non verificati, requisito mancante, canale).' };
      }
      return {
        group: 'owner', code: 'review', label: 'Bozza da rivedere',
        detail: `Puoi approvarla, correggerla o fermarla.${flow.deadlineAt ? ` Se non fai nulla passa al candidato ${clock(flow.deadlineAt)}.` : ''}`,
      };
    case 'candidate_review': {
      const waitingSince = since(enteredAt(flow), nowMs);
      if (heldBy.some((held) => /^(question|document):/.test(held))) {
        return {
          group: 'candidate', code: 'waiting_candidate_answers', label: 'Aspetta il candidato',
          detail: `Mancano ${countHeld(heldBy)} che solo lui può dare${waitingSince ? ` (${waitingSince})` : ''}. Riceve promemoria a 24 e 72 ore; dopo 5 giorni arriva un avviso a te.${flow.reminderAt ? ` Prossimo promemoria ${clock(flow.reminderAt)}.` : ''}`,
        };
      }
      return {
        group: 'candidate', code: 'waiting_candidate_approval', label: 'Aspetta il candidato',
        detail: `Sta rivedendo la bozza${waitingSince ? ` (${waitingSince})` : ''}.${flow.deadlineAt ? ` Se non risponde parte da sola ${clock(flow.deadlineAt)}.` : ''}`,
      };
    }
    case 'needs_candidate_action':
      return {
        group: 'candidate', code: 'waiting_candidate_portal', label: 'Aspetta il candidato',
        detail: `Il portale ha chiesto ${countHeld(heldBy) || 'un’informazione'} che solo lui può dare: appena risponde l’invio riparte da solo.`,
      };
    case 'submitting':
      return {
        group: 'robot', code: 'submitting', label: 'Invio in corso',
        detail: `Il robot sta inviando la candidatura${flow.dispatch?.requestedAt ? ` (${since(flow.dispatch.requestedAt, nowMs)})` : ''}.`,
      };
    case 'candidate_handoff':
      return { group: 'candidate', code: 'candidate_handoff', label: 'Affidata al candidato', detail: 'Hai scelto di far completare a lui l’ultimo passaggio sul portale: l’ordine si chiude quando conferma l’invio. Puoi sempre completarla tu.' };
    case 'submitted':
      return { group: 'done', code: 'submitted', label: 'Inviata', detail: 'La candidatura è arrivata al datore.' };
    case 'owner_takeover':
      return takeoverStep(heldBy);
    case 'failed':
      return { group: 'owner', code: 'resume', label: 'Da riprendere', detail: 'Il flusso si è interrotto: «Riprendi automazione» o completala tu.' };
    default:
      return { group: 'owner', code: 'unknown', label: 'Da controllare', detail: `Stato non riconosciuto: ${flow.state}.` };
  }
}
