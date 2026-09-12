/**
 * coldEmailSequence.js — SINGLE SOURCE of the cold-outreach email sequence.
 *
 * Lives inside functions/ so it is bundled into the deployed Cloud Functions
 * (the `adminSendColdEmail` web-UI sender imports it). It is ALSO re-exported by
 * scripts/lib/cold-email-sequence.mjs, which is what the Node scripts
 * (generate-/send-cold-emails) and the browser admin panel
 * (components/pages/AdminPanel.tsx → email preview) import. One copy → the admin
 * preview, the CLI send, and the web-UI send are byte-identical (AGENTS.md
 * Non-Negotiable #6). Pure ESM, no node imports, so every runtime can load it.
 *
 * `{{UNSUB_URL}}` / `{{INSIGHTS_URL}}` are placeholders substituted at send time
 * by the sender (send-cold-emails.mjs or adminSendColdEmail): the real tokenized
 * one-click unsubscribe link and the per-company stats-page link.
 *
 * `bodyToHtml` also lives here (not just in send-cold-emails.mjs) so the web-UI
 * sender (adminSendColdEmail.js) builds the SAME html part as the CLI instead of
 * sending text-only — same single-source rationale as buildSequence.
 */

export const PRICE = 'CHF 49 al mese per annuncio';
// Indirizzo opt-out: chi risponde qui (o "STOP") va messo `suppressed` nel send-log.
export const OPTOUT_EMAIL = 'valerie@frontaliereticino.ch';

/** The only metric labels the outreach copy is allowed to claim. */
export const OUTREACH_METRIC_LABELS = Object.freeze({
  applyClicks: 'click per candidarsi',
  interestSignals: 'segnali di interesse',
});

const OUTREACH_ALLOWED_LABELS = new Set(Object.values(OUTREACH_METRIC_LABELS));

const OUTREACH_TIME_ZONE = 'Europe/Zurich';
const ISO_DATE_INPUT_RE = /^\d{4}-\d{2}-\d{2}(?:T.*)?$/;
const ITALIAN_MONTHS = [
  'gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
  'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre',
];

export function calendarParts(value, { requireTimeZone = false, timeZone = OUTREACH_TIME_ZONE } = {}) {
  const timestamp = Date.parse(String(value || '').trim());
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    }).formatToParts(date);
    const pick = (type) => Number(parts.find((part) => part.type === type)?.value);
    const year = pick('year');
    const month = pick('month');
    const day = pick('day');
    if ([year, month, day].every(Number.isFinite)) return { year, month, day };
  } catch (error) {
    if (requireTimeZone) {
      throw new RangeError(`Unable to resolve calendar date in timezone ${timeZone}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return null;
}

function endDateArticle(day) {
  return day === 8 || day === 11 ? `all'${day}` : `al ${day}`;
}

function periodRange(periodLabel) {
  if (periodLabel && typeof periodLabel === 'object' && !Array.isArray(periodLabel)) {
    return {
      from: String(periodLabel.from || '').trim(),
      to: String(periodLabel.to || '').trim(),
      inclusive: periodLabel.inclusive || '[from,to)',
      timeZone: String(periodLabel.timezone || OUTREACH_TIME_ZONE).trim() || OUTREACH_TIME_ZONE,
      isRange: true,
    };
  }

  const raw = String(periodLabel || '').trim();
  const match = raw.match(/^(.+?)\s*→\s*(.+?)$/);
  if (!match) return { raw, isRange: false };
  return {
    from: match[1].trim(),
    to: match[2].trim(),
    inclusive: '[from,to)',
    timeZone: OUTREACH_TIME_ZONE,
    isRange: true,
  };
}

function invalidPeriod(message, strict, fallback = '') {
  if (strict) throw new TypeError(message);
  return fallback;
}

/** Convert an ISO range to readable Italian copy without changing its bounds. */
export function formatItalianPeriodLabel(periodLabel, { strict = false } = {}) {
  const range = periodRange(periodLabel);
  if (!range.isRange) {
    // Human labels such as "negli ultimi 90 giorni" are still valid curated
    // copy. A bare ISO timestamp, however, is a malformed report label: it
    // must not leak into an outward-facing email when strict mode is active.
    if (strict && ISO_DATE_INPUT_RE.test(range.raw)) {
      return invalidPeriod('Strict period labels require an explicit from/to range', true);
    }
    return range.raw;
  }

  const inclusive = String(range.inclusive || '').trim();
  const bounds = inclusive.match(/^(\[|\()from,to(\]|\))$/);
  if (!bounds) return invalidPeriod(`Invalid period interval: ${inclusive || '(missing)'}`, strict, String(periodLabel || '').trim());

  const fromTimestamp = Date.parse(range.from);
  const toTimestamp = Date.parse(range.to);
  if (strict && (!ISO_DATE_INPUT_RE.test(range.from) || !ISO_DATE_INPUT_RE.test(range.to))) {
    return invalidPeriod('Period range must contain ISO from and to dates', true);
  }
  if (!Number.isFinite(fromTimestamp) || !Number.isFinite(toTimestamp)) {
    return invalidPeriod('Period range must contain valid from and to dates', strict, String(periodLabel || '').trim());
  }
  if (fromTimestamp >= toTimestamp) {
    return invalidPeriod('Period range must have from before to', strict, String(periodLabel || '').trim());
  }

  const fromValue = bounds[1] === '[' ? fromTimestamp : fromTimestamp + 1;
  const toValue = bounds[2] === ']' ? toTimestamp : toTimestamp - 1;
  const from = calendarParts(new Date(fromValue).toISOString(), {
    requireTimeZone: strict,
    timeZone: range.timeZone,
  });
  const to = calendarParts(new Date(toValue).toISOString(), {
    requireTimeZone: strict,
    timeZone: range.timeZone,
  });
  if (!from || !to || !ITALIAN_MONTHS[from.month - 1] || !ITALIAN_MONTHS[to.month - 1]) {
    return invalidPeriod('Period range could not be resolved in its timezone', strict, String(periodLabel || '').trim());
  }

  const fromDate = `${from.day} ${ITALIAN_MONTHS[from.month - 1]}`;
  const fromYear = from.year === to.year ? '' : ` ${from.year}`;
  return `dal ${fromDate}${fromYear} fino ${endDateArticle(to.day)} ${ITALIAN_MONTHS[to.month - 1]} ${to.year}`;
}

/**
 * Le 4 email della sequenza. Personalizzazione Livello 4 (skill cold-email):
 * metrica dichiarata di interazione + RUOLO più cliccato, connessi al problema
 * del passaggio finale. Tono da pari, una sola call-to-action a basso attrito per touch.
 */
export function buildSequence({ company, metricValue, metricLabel, periodLabel, contactName, topRole }) {
  // Solo il nome di battesimo nel saluto ("Ciao Denise,"), non nome+cognome.
  const firstName = (contactName || '').trim().split(/\s+/)[0];
  const hi = firstName ? `Ciao ${firstName},` : 'Buongiorno,';
  // Ruolo accorciato per leggibilità; fallback neutro se assente o generico
  // (titoli-pagina tipo "Lavora con noi", "Concorsi", "Careers" non sono ruoli).
  const role = (topRole || '').replace(/\s+/g, ' ').trim();
  const GENERIC_ROLE = /lavora con noi|lavorare con noi|concors|careers?|^jobs?$|offerte di lavoro|posizioni aperte|unsolicited|spontane/i;
  const pagina = role && !GENERIC_ROLE.test(role) ? `pagina di "${role.slice(0, 48)}"` : 'pagina lavoro';
  const providedMetric = metricValue !== undefined && metricValue !== null && metricValue !== '';
  const value = Number(providedMetric ? metricValue : NaN);
  const count = Number.isFinite(value) ? Math.trunc(value) : null;
  const metric = count !== null && count > 0
    ? {
        value: count,
        label: OUTREACH_ALLOWED_LABELS.has(metricLabel)
          ? metricLabel
          : OUTREACH_METRIC_LABELS.interestSignals,
      }
    : null;
  const period = formatItalianPeriodLabel(periodLabel, { strict: true });
  const metricSentence = metric && period
    ? `${period} abbiamo registrato ${metric.value} ${metric.label} sugli annunci che pubblichiamo per voi su frontaliereticino.ch.`
    : '';
  const metricFollowup = metric && period
    ? `Di quei ${metric.value} ${metric.label} registrati ${period}, quanti hanno completato la candidatura sul vostro sito?`
    : '';
  // Opt-out obbligatorio su ogni touch (norma cold-email B2B + deliverability).
  // Footer leggibile dall'umano; l'header List-Unsubscribe lo aggiunge il sender.
  // One-click opt-out link ({{UNSUB_URL}}) is substituted at send time by the
  // sender (buildUnsubUrl(companyKey)). The STOP/email reply path is kept as a
  // fallback for clients that don't render the link. Drafts keep the literal
  // placeholder (no companyKey context).
  const footer = `\n\n—\nPer non ricevere più queste email: {{UNSUB_URL}}\nIn alternativa rispondete con "STOP" (o scrivete a ${OPTOUT_EMAIL}) e vi rimuoviamo subito.`;
  const seq = [
    {
      touch: 1, gapDays: 0, subject: 'interazioni candidatura',
      body: `${hi}

${metricSentence ? `${metricSentence}\n\n` : ''}Abbiamo generato interesse per la vostra ${pagina} da frontaliereticino.ch — gratis, dagli annunci che pubblichiamo per voi.

Il passaggio finale avviene sul vostro sito. Possiamo portare il CV direttamente nella vostra casella con l'annuncio sponsorizzato.

Ho preparato il riepilogo verificabile delle interazioni con i vostri annunci qui: {{INSIGHTS_URL}}

Valerie`,
    },
    {
      touch: 2, gapDays: 4, subject: 'di quei click',
      body: `${hi}

${metricFollowup ? `${metricFollowup}\n\n` : ''}Con l'annuncio sponsorizzato il CV può essere raccolto direttamente nella vostra casella — niente form esterni, niente dispersione. Vi mando un esempio reale?

Valerie`,
    },
    {
      touch: 3, gapDays: 5, subject: 'quanto costa',
      body: `${hi}

Diverse aziende ticinesi hanno già reso sponsorizzati i loro ruoli da noi. Costa ${PRICE} — contro la fee di un recruiter (migliaia di CHF a ruolo) o un singolo posting su jobs.ch.

Se vi aiuta a coprire anche un solo ruolo, si ripaga da solo. Provo a mostrarvelo sul vostro annuncio più visto?

Valerie`,
    },
    {
      touch: 4, gapDays: 7, subject: 'chiudo',
      body: `${hi}

Non vi disturbo oltre. In ogni caso vi lascio il riepilogo delle interazioni registrate con i vostri annunci — usatelo come volete.

Se più avanti volete amplificarlo, sapete dove trovarmi.

Valerie`,
    },
  ];
  // Append the opt-out footer to every touch so drafts and real sends match.
  return seq.map((m) => ({ ...m, body: m.body + footer }));
}

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Wraps the two known placeholder tokens in <a>. Runs BEFORE {{UNSUB_URL}} /
// {{INSIGHTS_URL}} are substituted for the real signed URLs (send-cold-emails.mjs
// / adminSendColdEmail.js), so that later substitution fills in both the href
// and the visible text — turning the plain-text link into a real hyperlink.
// Muted color on the opt-out link keeps it a footer aside, not a second CTA,
// so the compliance-required unsubscribe doesn't read as mass-email chrome.
function linkifyPlaceholders(escaped) {
  return escaped
    .split('{{INSIGHTS_URL}}').join('<a href="{{INSIGHTS_URL}}" style="color:#4f46e5">{{INSIGHTS_URL}}</a>')
    .split('{{UNSUB_URL}}').join('<a href="{{UNSUB_URL}}" style="color:#6b7280">{{UNSUB_URL}}</a>');
}

/** Cold email = aspetto plain. HTML minimale: paragrafi, link reali, niente immagini/CTA grafiche. */
export function bodyToHtml(body) {
  const paras = body.trim().split(/\n\n+/).map((p) => {
    const escaped = escapeHtml(p).replace(/\n/g, '<br>');
    return `<p style="margin:0 0 14px">${linkifyPlaceholders(escaped)}</p>`;
  });
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a">${paras.join('')}</div>`;
}
