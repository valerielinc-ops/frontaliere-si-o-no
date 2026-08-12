/**
 * onboardingDrip.mjs — SINGLE SOURCE of the post-signup onboarding drip
 * sequence (#4451). Pure, dependency-light (only the newsletter template helpers
 * + the recommended revenue block): no Firestore / fs / network here, so it is
 * unit-testable with plain fixtures. The Firestore state + provider cascade live
 * in scripts/send-onboarding-drip.mjs.
 *
 * Four touches at day 0 / 3 / 7 / 14:
 *   day 0  — welcome / starter guide (always)
 *   day 3  — first of {job alert, salary calculator}, ordered by segment
 *   day 7  — the other of the pair
 *   day 14 — comparators recap (always)
 *
 * Segmentation by acquisitionSource-derived interest
 * (services/newsletter-segments.mjs:inferInterest):
 *   - arrived from JOBS  → gets the CALCULATOR first (day 3), job alert day 7;
 *   - arrived from the CALCULATOR/comparators (utility) or anything else → gets
 *     the JOB ALERT first (day 3), calculator day 7.
 *
 * Every drip email carries the same revenue block as the weekly newsletter
 * (epic #4449 goal: every send monetized) and a one-click unsubscribe.
 */

import { localizedUrl } from '../newsletter-template.mjs';
import { renderRecommendedBlock } from './recommendedBlock.mjs';
import { dataControllerFooterLine } from '../../functions/src/lib/dataControllerIdentity.js';

const BASE_URL = 'https://frontaliereticino.ch';
const BRAND_ORANGE = '#f97316';
const BRAND_DARK = '#0f172a';
const LIGHT_BG = '#f1f5f9';
const WHITE = '#ffffff';
const TEXT_COLOR = '#334155';
const MUTED_COLOR = '#64748b';
const BORDER_COLOR = '#e2e8f0';

/** Day offsets from enrollment for each step. */
export const DRIP_GAP_DAYS = [0, 3, 7, 14];
export const DRIP_STEP_COUNT = DRIP_GAP_DAYS.length;

function normLocale(raw) {
  if (!raw) return 'it';
  const lang = String(raw).toLowerCase().split(/[-_]/)[0];
  return ['en', 'de', 'fr'].includes(lang) ? lang : 'it';
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// The newsletter template's localizedUrl() returns bare (no-slash) paths — the
// weekly send relies on an edge 301 to add the slash. Drip links go straight to
// the canonical trailing-slashed form (AGENTS.md: trailing slash on every email
// URL), skipping the redirect hop.
function ensureTrailingSlash(url) {
  return url.endsWith('/') ? url : `${url}/`;
}

// ── Content cards (per-locale) ───────────────────────────────────────
// `path` is a canonical IT path present in newsletter-template's
// LOCALE_PATH_MAP so localizedUrl() resolves the correct localized, trailing-
// slashed URL for every locale.
const CARDS = {
  guide: {
    path: '/calcola-stipendio',
    it: {
      subject: 'Benvenuto tra i frontalieri — si parte da qui',
      heading: 'Ci siamo. Ecco da dove iniziare.',
      intro: 'Ti sei appena iscritto: benvenuto. In due settimane ti mostriamo gli strumenti che usano i frontalieri per non lasciare soldi sul tavolo. Si comincia dal più utile: quanto ti resta davvero in tasca.',
      cta: 'Calcola il tuo netto →',
    },
    en: {
      subject: 'Welcome to the frontalieri — start here',
      heading: 'You’re in. Here’s where to start.',
      intro: 'You just signed up — welcome. Over two weeks we’ll show you the tools cross-border workers use to stop leaving money on the table. Let’s start with the most useful one: what you actually keep.',
      cta: 'Calculate your net →',
    },
    de: {
      subject: 'Willkommen bei den Grenzgängern — hier geht’s los',
      heading: 'Du bist dabei. Hier fängst du an.',
      intro: 'Du hast dich gerade angemeldet — willkommen. In zwei Wochen zeigen wir dir die Tools, mit denen Grenzgänger kein Geld verschenken. Los geht’s mit dem nützlichsten: was dir wirklich bleibt.',
      cta: 'Netto berechnen →',
    },
    fr: {
      subject: 'Bienvenue chez les frontaliers — on commence ici',
      heading: 'Tu y es. Voici par où commencer.',
      intro: 'Tu viens de t’inscrire — bienvenue. En deux semaines, on te montre les outils que les frontaliers utilisent pour ne pas laisser d’argent sur la table. On commence par le plus utile : ce qu’il te reste vraiment.',
      cta: 'Calcule ton net →',
    },
  },
  jobalert: {
    path: '/cerca-lavoro-svizzera',
    it: {
      subject: 'Le offerte per frontalieri, prima degli altri',
      heading: 'Fatti avvisare quando esce il lavoro giusto',
      intro: 'Ogni settimana pubblichiamo offerte pensate per chi lavora in Svizzera. Imposta un job alert coi tuoi criteri e le ricevi appena escono — niente da controllare a mano.',
      cta: 'Crea il tuo job alert →',
    },
    en: {
      subject: 'Cross-border jobs, before everyone else',
      heading: 'Get pinged when the right job shows up',
      intro: 'Every week we publish roles for people working in Switzerland. Set a job alert with your criteria and get them the moment they’re posted — nothing to check by hand.',
      cta: 'Create your job alert →',
    },
    de: {
      subject: 'Grenzgänger-Jobs, vor allen anderen',
      heading: 'Lass dich benachrichtigen, wenn der passende Job kommt',
      intro: 'Jede Woche veröffentlichen wir Stellen für alle, die in der Schweiz arbeiten. Richte einen Job-Alert mit deinen Kriterien ein und erhalte sie sofort — nichts von Hand zu prüfen.',
      cta: 'Job-Alert erstellen →',
    },
    fr: {
      subject: 'Les offres pour frontaliers, avant les autres',
      heading: 'Sois prévenu quand le bon emploi arrive',
      intro: 'Chaque semaine, nous publions des offres pensées pour ceux qui travaillent en Suisse. Crée une alerte emploi avec tes critères et reçois-les dès leur parution — rien à vérifier à la main.',
      cta: 'Créer ton alerte emploi →',
    },
  },
  calculator: {
    path: '/calcola-stipendio',
    it: {
      subject: 'Lordo o netto? La differenza che conta',
      heading: 'Sai davvero quanto ti resta netto?',
      intro: 'Dal lordo in franchi al netto in euro: AVS, LPP, imposta alla fonte e cambio, tutto in un calcolo. Utile prima di firmare un contratto o valutare un aumento.',
      cta: 'Prova il calcolatore →',
    },
    en: {
      subject: 'Gross or net? The difference that matters',
      heading: 'Do you really know your take-home?',
      intro: 'From gross in francs to net in euros: AVS, LPP, withholding tax and FX, all in one calculation. Handy before signing a contract or weighing a raise.',
      cta: 'Try the calculator →',
    },
    de: {
      subject: 'Brutto oder netto? Der Unterschied zählt',
      heading: 'Weisst du wirklich, was netto bleibt?',
      intro: 'Vom Brutto in Franken zum Netto in Euro: AHV, BVG, Quellensteuer und Wechselkurs in einer Rechnung. Praktisch vor der Vertragsunterschrift oder bei einer Gehaltserhöhung.',
      cta: 'Rechner ausprobieren →',
    },
    fr: {
      subject: 'Brut ou net ? La différence qui compte',
      heading: 'Sais-tu vraiment ce qu’il te reste ?',
      intro: 'Du brut en francs au net en euros : AVS, LPP, impôt à la source et change, tout en un calcul. Utile avant de signer un contrat ou d’évaluer une augmentation.',
      cta: 'Essayer le calculateur →',
    },
  },
  comparators: {
    path: '/compara-servizi/confronta-casse-malati',
    it: {
      subject: 'Gli attrezzi che ti fanno risparmiare davvero',
      heading: 'Prima di rinnovare, confronta',
      intro: 'Cassa malati, cambio valuta, banche: piccole differenze che su un anno diventano centinaia di euro. I nostri comparatori ti mostrano dove stai pagando troppo.',
      cta: 'Confronta la LAMal →',
    },
    en: {
      subject: 'The tools that actually save you money',
      heading: 'Before you renew, compare',
      intro: 'Health insurance, currency exchange, banks: small differences that add up to hundreds of euros a year. Our comparators show you where you’re overpaying.',
      cta: 'Compare health insurance →',
    },
    de: {
      subject: 'Die Tools, die wirklich Geld sparen',
      heading: 'Vor der Verlängerung: vergleichen',
      intro: 'Krankenkasse, Wechselkurs, Banken: kleine Unterschiede, die aufs Jahr Hunderte Euro ausmachen. Unsere Vergleiche zeigen, wo du zu viel zahlst.',
      cta: 'Krankenkasse vergleichen →',
    },
    fr: {
      subject: 'Les outils qui font vraiment économiser',
      heading: 'Avant de renouveler, compare',
      intro: 'Caisse maladie, change, banques : de petites différences qui, sur un an, font des centaines d’euros. Nos comparateurs te montrent où tu paies trop.',
      cta: 'Comparer la caisse maladie →',
    },
  },
};

/**
 * Ordered card ids for the four steps, given the subscriber interest.
 * Jobs-arrivals get the calculator first; everyone else gets the job alert first.
 * @param {string|null} interest one of 'jobs'|'utility'|'articles'|'general'|null
 * @returns {[string,string,string,string]}
 */
export function resolveDripCards(interest) {
  const middle = interest === 'jobs'
    ? ['calculator', 'jobalert'] // arrived from jobs → calculator first
    : ['jobalert', 'calculator']; // utility / articles / general / unknown → jobs first
  return ['guide', middle[0], middle[1], 'comparators'];
}

// resolveDripSegment lives in ../newsletter-segments.mjs (functions/src/lib/
// newsletterSegments.js) — shared with functions/src/newsletterWelcomeEmail.js
// so the welcome email and this drip runner's `drip_segment` snapshot can
// never disagree (AGENTS.md #6).
export { resolveDripSegment } from '../newsletter-segments.mjs';

/** Absolute ms timestamp at which `step` becomes due, given enrollment time. */
export function dripStepDueAtMs(startedAtMs, step) {
  return startedAtMs + DRIP_GAP_DAYS[step] * 86400000;
}

/**
 * The next drip step to send, or null when none is due yet or the sequence is
 * complete. Pure — the runner layers unsubscribe/enrollment gating on top.
 * @param {{ startedAtMs: number, lastStep?: number, nowMs: number }} args
 * @returns {number|null}
 */
export function computeNextStep({ startedAtMs, lastStep = -1, nowMs }) {
  const prev = Number.isInteger(lastStep) ? lastStep : -1;
  const next = prev + 1;
  if (next >= DRIP_STEP_COUNT) return null;
  if (nowMs < dripStepDueAtMs(startedAtMs, next)) return null;
  return next;
}

/**
 * Footer label for the preference-centre link, one entry per site locale —
 * same four this module already branches on for the unsubscribe label (#5684).
 */
const PREFS_LABEL = { it: 'Gestisci le preferenze', en: 'Manage your preferences', de: 'Einstellungen verwalten', fr: 'Gérer mes préférences' };

/**
 * Build the drip email for a given step.
 * @param {{ step: number, locale?: string, interest?: string|null, acquisitionSource?: string|null, unsubscribeUrl?: string, oneClickUnsubscribeUrl?: string, preferencesUrl?: string }} args
 * @returns {{ subject: string, html: string, cardId: string }}
 */
export function buildDripEmail({ step, locale, interest, acquisitionSource, unsubscribeUrl, preferencesUrl }) {
  const loc = normLocale(locale);
  const cards = resolveDripCards(interest);
  const cardId = cards[step];
  if (!cardId) throw new Error(`invalid drip step: ${step}`);
  const card = CARDS[cardId];
  const copy = card[loc] || card.it;
  const ctaUrl = ensureTrailingSlash(localizedUrl(card.path, loc));

  const recommended = renderRecommendedBlock({
    locale: loc,
    interest,
    acquisitionSource,
    campaign: 'drip',
  });

  const unsub = unsubscribeUrl || `${BASE_URL}/?action=unsubscribe`;
  // #5684 — the drip is a recurring sequence (day 0/3/7/14), so it owes the
  // reader the preference centre and not only the one-way unsubscribe. This
  // module stays pure (it never sees the address), so the caller passes the
  // signed URL exactly the way it already passes `unsubscribeUrl`.
  const prefs = preferencesUrl || null;
  const stepLabel = `${step + 1}/${DRIP_STEP_COUNT}`;

  const html = `<!DOCTYPE html>
<html lang="${loc}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${escapeHtml(copy.subject)}</title>
  <style>
    body{margin:0;padding:0;background:${LIGHT_BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-text-size-adjust:100%;}
    table{border-collapse:collapse;}
    img{border:0;max-width:100%;}
    @media only screen and (max-width:620px){.section-pad{padding-left:16px!important;padding-right:16px!important;}}
  </style>
</head>
<body>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:${LIGHT_BG};">
    <tr><td align="center" style="padding:0;">
      <table width="620" cellpadding="0" cellspacing="0" style="width:100%;max-width:620px;background:${WHITE};">
        <tr><td class="section-pad" style="background:${BRAND_DARK};padding:14px 28px;">
          <table width="100%" cellpadding="0" cellspacing="0"><tr>
            <td style="font-size:15px;font-weight:900;color:${BRAND_ORANGE};letter-spacing:-0.3px;">Frontaliere Ticino</td>
            <td align="right" style="font-size:11px;color:${MUTED_COLOR};">Onboarding · ${stepLabel}</td>
          </tr></table>
        </td></tr>
        <tr><td class="section-pad" style="background:${WHITE};padding:28px 28px 8px;">
          <div style="font-size:22px;font-weight:800;color:${BRAND_DARK};margin:0 0 12px;line-height:1.25;">${escapeHtml(copy.heading)}</div>
          <div style="font-size:14px;color:${TEXT_COLOR};line-height:1.65;margin:0 0 20px;">${escapeHtml(copy.intro)}</div>
          <div style="margin:0 0 8px;">
            <a target="_blank" rel="noopener noreferrer" href="${escapeHtml(ctaUrl)}" style="display:inline-block;background:${BRAND_ORANGE};color:#fff;font-weight:700;font-size:14px;text-decoration:none;padding:12px 28px;border-radius:8px;">${escapeHtml(copy.cta)}</a>
          </div>
        </td></tr>
        <tr><td class="section-pad" style="padding:12px 28px;"><div style="border-top:1px solid ${BORDER_COLOR};"></div></td></tr>
        ${recommended}
        <tr><td class="section-pad" style="background:${BRAND_DARK};padding:24px 28px;text-align:center;">
          <div style="font-size:12px;color:${MUTED_COLOR};margin:4px 0;">Frontaliere Ticino · <a target="_blank" rel="noopener noreferrer" href="${BASE_URL}" style="color:${BRAND_ORANGE};text-decoration:underline;">frontaliereticino.ch</a></div>
          <div style="font-size:12px;color:${MUTED_COLOR};margin:4px 0;"><a target="_blank" rel="noopener noreferrer" href="${escapeHtml(unsub)}" style="color:${BRAND_ORANGE};text-decoration:underline;">${loc === 'it' ? 'Disiscriviti' : loc === 'de' ? 'Abmelden' : loc === 'fr' ? 'Se désinscrire' : 'Unsubscribe'}</a></div>
          ${prefs ? `<div style="font-size:12px;color:${MUTED_COLOR};margin:4px 0;"><a target="_blank" rel="noopener noreferrer" href="${escapeHtml(prefs)}" style="color:${BRAND_ORANGE};text-decoration:underline;">${PREFS_LABEL[loc] || PREFS_LABEL.it}</a></div>` : ''}
          <div style="font-size:11px;color:#475569;margin-top:8px;">${escapeHtml(dataControllerFooterLine(loc))}</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject: copy.subject, html, cardId };
}
