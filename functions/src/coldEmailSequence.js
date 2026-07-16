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

/**
 * Le 4 email della sequenza. Personalizzazione Livello 4 (skill cold-email):
 * numero REALE di candidati + RUOLO più cliccato, connessi al problema (i click
 * si perdono). Tono da pari, una sola call-to-action a basso attrito per touch.
 */
export function buildSequence({ company, candidates, periodLabel, contactName, topRole }) {
  // Solo il nome di battesimo nel saluto ("Ciao Denise,"), non nome+cognome.
  const firstName = (contactName || '').trim().split(/\s+/)[0];
  const hi = firstName ? `Ciao ${firstName},` : 'Buongiorno,';
  // Ruolo accorciato per leggibilità; fallback neutro se assente o generico
  // (titoli-pagina tipo "Lavora con noi", "Concorsi", "Careers" non sono ruoli).
  const role = (topRole || '').replace(/\s+/g, ' ').trim();
  const GENERIC_ROLE = /lavora con noi|lavorare con noi|concors|careers?|^jobs?$|offerte di lavoro|posizioni aperte|unsolicited|spontane/i;
  const pagina = role && !GENERIC_ROLE.test(role) ? `pagina di "${role.slice(0, 48)}"` : 'pagina lavoro';
  // Opt-out obbligatorio su ogni touch (norma cold-email B2B + deliverability).
  // Footer leggibile dall'umano; l'header List-Unsubscribe lo aggiunge il sender.
  // One-click opt-out link ({{UNSUB_URL}}) is substituted at send time by the
  // sender (buildUnsubUrl(companyKey)). The STOP/email reply path is kept as a
  // fallback for clients that don't render the link. Drafts keep the literal
  // placeholder (no companyKey context).
  const footer = `\n\n—\nPer non ricevere più queste email: {{UNSUB_URL}}\nIn alternativa rispondete con "STOP" (o scrivete a ${OPTOUT_EMAIL}) e vi rimuoviamo subito.`;
  const seq = [
    {
      touch: 1, gapDays: 0, subject: 'candidati inviati',
      body: `${hi}

${periodLabel} vi abbiamo mandato ${candidates} persone alla vostra ${pagina} da frontaliereticino.ch — gratis, dagli annunci che pubblichiamo per voi.

Il punto è che quei click arrivano sul vostro sito e spesso si perdono. Possiamo farveli arrivare come candidature dirette, CV incluso, nella vostra casella.

Ho preparato i vostri dati reali (annunci, visite, candidati) qui: {{INSIGHTS_URL}}

Valerie`,
    },
    {
      touch: 2, gapDays: 4, subject: 'di quei click',
      body: `${hi}

Di quei ${candidates} candidati che vi abbiamo mandato ${periodLabel}, quanti si sono poi candidati davvero da voi?

Con l'annuncio sponsorizzato la candidatura arriva diretta nella vostra casella — niente form esterni, niente dispersione. Vi mando un esempio reale?

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

Non vi disturbo oltre. In ogni caso vi lascio il riepilogo dei candidati che vi abbiamo mandato finora — usatelo come volete.

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
