/**
 * recommendedBlock.js — config-driven "Consigliato per te" revenue block for
 * every email we send (weekly newsletter + onboarding drip + welcome email).
 * Issue #4450.
 *
 * Canonical home is functions/src/lib/ (not services/newsletter/) because
 * functions/src/lib/welcomeEmailTemplate.js needs this at Cloud Functions
 * runtime, and firebase.json's `source: "functions"` means functions/src/**
 * cannot import anything outside functions/ (no bundler at deploy time).
 * services/newsletter/recommendedBlock.mjs re-exports this so every existing
 * importer (services/newsletter-template.mjs, services/newsletter/onboardingDrip.mjs,
 * scripts/send-job-alerts.mjs, tests) keeps resolving to the exact same
 * module — no drift between call sites.
 *
 * ONE block per send, appended at the end of the content, rendered ONLY when a
 * partner or sponsor is actually active (never an empty box). Two sources, in
 * priority order:
 *
 *   1. NEWSLETTER_SPONSORS — fixed-rate paid sponsors (config-driven, empty by
 *      default; an owner flips `active: true` when a deal is signed). Paid
 *      placements win because they are guaranteed revenue.
 *   2. Affiliate partners — the enabled entries from
 *      functions/src/lib/affiliatePartnersRegistry.js (single source of the
 *      enable gate; a partner disabled there disappears from email too, no
 *      drift). Each email click routes through the /go/{id}/ redirect page for
 *      uniform edge attribution, exactly like on-site partner cards.
 *
 * Links carry utm + acquisitionSource tracking and a trailing slash. NEVER
 * AdSense / Google Ads in email (AdSense policy) — this block only ever links
 * to our own /go/ redirect or a signed sponsor URL.
 */

import {
  goPathFromId,
  getEnabledPartner,
} from './affiliatePartnersRegistry.js';

const BASE_URL = 'https://frontaliereticino.ch';
const BRAND_ORANGE = '#f97316';
const BRAND_DARK = '#0f172a';
const CARD_BG = '#f8fafc';
const BORDER_COLOR = '#e2e8f0';
const MUTED_COLOR = '#64748b';
const TEXT_COLOR = '#334155';

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

// ── Block chrome i18n (eyebrow + disclosure) ─────────────────────────
const CHROME_I18N = {
  it: { eyebrow: '⭐ Consigliato per te', sponsoredLabel: 'Contenuto sponsorizzato', affiliateLabel: 'In collaborazione con un partner · link affiliato' },
  en: { eyebrow: '⭐ Recommended for you', sponsoredLabel: 'Sponsored content', affiliateLabel: 'In partnership with a partner · affiliate link' },
  de: { eyebrow: '⭐ Für dich empfohlen', sponsoredLabel: 'Gesponserter Inhalt', affiliateLabel: 'In Zusammenarbeit mit einem Partner · Affiliate-Link' },
  fr: { eyebrow: '⭐ Recommandé pour toi', sponsoredLabel: 'Contenu sponsorisé', affiliateLabel: 'En partenariat avec un partenaire · lien affilié' },
};

function chrome(locale, key) {
  const loc = normLocale(locale);
  return CHROME_I18N[loc]?.[key] || CHROME_I18N.it[key] || '';
}

/**
 * Fixed-rate sponsor slots. Config-driven and EMPTY by default: no active
 * sponsor → the block falls back to the affiliate partners below. Flip
 * `active: true` (and fill a real `url` + per-locale copy) once a deal is
 * signed. `weight` breaks ties between multiple active sponsors (higher first).
 *
 * @type {Array<{ id: string, name: string, emoji: string, url: string, active: boolean, weight?: number, copy: Record<string,{title:string,body:string,cta:string}> }>}
 */
export const NEWSLETTER_SPONSORS = [];

/**
 * Email presentation config for affiliate partners, keyed by the registry
 * `goId`. This is email-specific benefit-first copy + segment relevance — NOT a
 * duplicate of the registry (name / emoji / priority / enable gate all come
 * from functions/src/lib/affiliatePartnersRegistry.js at selection time). An
 * entry whose partner is disabled there is skipped automatically.
 *
 * `interests` lists the acquisition segments (see services/newsletter-segments.mjs
 * INTERESTS) the partner is most relevant to; used to pick the best match for a
 * subscriber. Entries relevant to every segment include 'general'.
 */
export const NEWSLETTER_AFFILIATE_ENTRIES = [
  {
    goId: 'wise',
    interests: ['general', 'utility', 'jobs', 'articles'],
    copy: {
      it: { title: 'Cambia CHF in EUR senza perderci', body: 'Wise usa il tasso reale e ti mostra la commissione prima di confermare. Sul tuo stipendio da frontaliere sono centinaia di euro l’anno.', cta: 'Scopri Wise →' },
      en: { title: 'Change CHF to EUR without losing out', body: 'Wise uses the real rate and shows the fee before you confirm. On a cross-border salary that’s hundreds of euros a year.', cta: 'Discover Wise →' },
      de: { title: 'CHF in EUR wechseln ohne Verlust', body: 'Wise nutzt den echten Kurs und zeigt die Gebühr vor der Bestätigung. Auf ein Grenzgänger-Gehalt sind das Hunderte Euro im Jahr.', cta: 'Wise entdecken →' },
      fr: { title: 'Change CHF en EUR sans y perdre', body: 'Wise utilise le taux réel et affiche les frais avant de confirmer. Sur un salaire de frontalier, c’est des centaines d’euros par an.', cta: 'Découvrir Wise →' },
    },
  },
  {
    goId: 'cambiavalute',
    interests: ['utility'],
    copy: {
      it: { title: 'Cambio franco-euro allo sportello giusto', body: 'CambiaValute.ch confronta i tassi reali per il cambio in contanti vicino al confine. Utile prima di andare al cambiavalute sotto casa.', cta: 'Confronta i tassi →' },
      en: { title: 'CHF-EUR cash exchange, done right', body: 'CambiaValute.ch compares real rates for cash exchange near the border. Handy before walking into the shop next door.', cta: 'Compare rates →' },
      de: { title: 'CHF-EUR-Wechsel am richtigen Schalter', body: 'CambiaValute.ch vergleicht echte Kurse für den Bargeldwechsel nahe der Grenze. Praktisch vor dem nächsten Wechselschalter.', cta: 'Kurse vergleichen →' },
      fr: { title: 'Change CHF-EUR au bon guichet', body: 'CambiaValute.ch compare les taux réels pour le change en espèces près de la frontière. Utile avant d’aller au bureau de change du coin.', cta: 'Comparer les taux →' },
    },
  },
  {
    goId: 'fineco',
    interests: ['general', 'jobs'],
    copy: {
      it: { title: 'Un conto italiano che non ti spenna sui cambi', body: 'Fineco gestisce multivaluta e bonifici esteri senza le commissioni assurde delle banche tradizionali. Comodo per chi incassa in CHF e spende in EUR.', cta: 'Scopri Fineco →' },
      en: { title: 'An Italian account that won’t gouge you on FX', body: 'Fineco handles multi-currency and foreign transfers without the absurd fees of traditional banks. Handy if you earn in CHF and spend in EUR.', cta: 'Discover Fineco →' },
      de: { title: 'Ein italienisches Konto ohne Wucher beim Wechsel', body: 'Fineco kann Multiwährung und Auslandsüberweisungen ohne die absurden Gebühren klassischer Banken. Praktisch, wenn du in CHF verdienst und in EUR ausgibst.', cta: 'Fineco entdecken →' },
      fr: { title: 'Un compte italien qui ne te plume pas au change', body: 'Fineco gère le multidevise et les virements étrangers sans les frais absurdes des banques classiques. Pratique quand on gagne en CHF et dépense en EUR.', cta: 'Découvrir Fineco →' },
    },
  },
  {
    goId: 'revolut',
    interests: ['utility', 'general'],
    copy: {
      it: { title: 'Una carta per spendere in due valute', body: 'Revolut ti fa pagare in EUR e in CHF con tassi di mercato e nessun costo nascosto sui piccoli acquisti quotidiani da frontaliere.', cta: 'Scopri Revolut →' },
      en: { title: 'One card for spending in two currencies', body: 'Revolut lets you pay in EUR and CHF at market rates with no hidden costs on the small daily cross-border spends.', cta: 'Discover Revolut →' },
      de: { title: 'Eine Karte für zwei Währungen', body: 'Mit Revolut zahlst du in EUR und CHF zu Marktkursen, ohne versteckte Kosten bei den kleinen täglichen Grenzausgaben.', cta: 'Revolut entdecken →' },
      fr: { title: 'Une carte pour dépenser en deux devises', body: 'Revolut te laisse payer en EUR et en CHF aux taux du marché, sans coûts cachés sur les petites dépenses quotidiennes de frontalier.', cta: 'Découvrir Revolut →' },
    },
  },
  {
    goId: 'creditagricole',
    interests: ['general'],
    copy: {
      it: { title: 'Conto italiano pensato per chi lavora in Svizzera', body: 'Crédit Agricole ha condizioni dedicate a chi incassa lo stipendio in franchi. Da valutare se vuoi un conto fisico vicino a casa.', cta: 'Scopri l’offerta →' },
      en: { title: 'An Italian account built for cross-border workers', body: 'Crédit Agricole has terms for people paid in francs. Worth a look if you want a branch account close to home.', cta: 'See the offer →' },
      de: { title: 'Italienisches Konto für Grenzgänger', body: 'Crédit Agricole bietet Konditionen für alle, die ihr Gehalt in Franken beziehen. Interessant, wenn du ein Filialkonto in der Nähe willst.', cta: 'Angebot ansehen →' },
      fr: { title: 'Un compte italien pensé pour les frontaliers', body: 'Crédit Agricole propose des conditions dédiées à ceux qui touchent leur salaire en francs. À voir si tu veux un compte en agence près de chez toi.', cta: 'Voir l’offre →' },
    },
  },
];

/**
 * Choose the single recommendation for this send, or null when nothing is
 * active (→ the block is not rendered, never an empty box).
 *
 * @param {{ locale?: string, interest?: string }} args
 * @returns {null | { kind: 'sponsor'|'affiliate', id: string, name: string, emoji: string, title: string, body: string, cta: string, disclosure: string, url?: string, goId?: string }}
 */
export function pickNewsletterRecommendation({ locale, interest } = {}) {
  const loc = normLocale(locale);

  // 1. Paid sponsor wins (guaranteed revenue).
  const activeSponsors = NEWSLETTER_SPONSORS
    .filter((s) => s && s.active && s.url && s.copy?.[loc])
    .sort((a, b) => (b.weight || 0) - (a.weight || 0));
  if (activeSponsors.length > 0) {
    const s = activeSponsors[0];
    const c = s.copy[loc];
    return {
      kind: 'sponsor',
      id: s.id,
      name: s.name,
      emoji: s.emoji || '⭐',
      title: c.title,
      body: c.body,
      cta: c.cta,
      url: s.url,
      disclosure: chrome(loc, 'sponsoredLabel'),
    };
  }

  // 2. Best enabled affiliate partner for the subscriber's interest.
  const wanted = interest || 'general';
  const candidates = NEWSLETTER_AFFILIATE_ENTRIES
    .map((entry) => {
      const partner = getEnabledPartner(entry.goId); // null when disabled/unknown
      if (!partner || !entry.copy?.[loc]) return null;
      const matches = (entry.interests || []).includes(wanted);
      return { entry, partner, matches, priority: partner.priority || 0 };
    })
    .filter(Boolean)
    // Prefer interest matches, then registry priority (highest first).
    .sort((a, b) => (Number(b.matches) - Number(a.matches)) || (b.priority - a.priority));

  if (candidates.length === 0) return null;

  const { entry, partner } = candidates[0];
  const c = entry.copy[loc];
  return {
    kind: 'affiliate',
    id: partner.id,
    goId: entry.goId,
    name: partner.name,
    emoji: partner.emoji || '⭐',
    title: c.title,
    body: c.body,
    cta: c.cta,
    disclosure: chrome(loc, 'affiliateLabel'),
  };
}

/**
 * Build the tracked, trailing-slashed destination URL for a recommendation.
 * Affiliate → our own /go/{id}/ redirect (edge attribution); sponsor → the
 * signed sponsor URL. Both carry utm + acquisitionSource so revenue can be
 * attributed to the email channel and the originating signup surface.
 *
 * @param {{ kind: string, goId?: string, url?: string, id: string }} rec
 * @param {{ acquisitionSource?: string|null, campaign?: string }} [opts]
 * @returns {string}
 */
export function buildRecommendedHref(rec, { acquisitionSource, campaign } = {}) {
  const params = new URLSearchParams();
  params.set('utm_source', 'newsletter');
  params.set('utm_medium', 'email');
  params.set('utm_campaign', campaign || 'recommended');
  params.set('utm_content', rec.id);
  if (acquisitionSource) params.set('as', String(acquisitionSource));

  if (rec.kind === 'affiliate' && rec.goId) {
    // goPathFromId already carries the canonical trailing slash before the query.
    return `${BASE_URL}${goPathFromId(rec.goId)}?${params.toString()}`;
  }
  // Sponsor: append utm to the (external) signed URL without breaking it.
  try {
    const u = new URL(rec.url);
    for (const [k, v] of params) u.searchParams.set(k, v);
    return u.toString();
  } catch {
    return rec.url || '#';
  }
}

/**
 * Render the "Consigliato per te" block as a newsletter table row, or '' when
 * no partner/sponsor is active. Styling mirrors the newsletter template card
 * language (light card, orange accent). Clear disclosure line above the card.
 *
 * @param {{ locale?: string, interest?: string, acquisitionSource?: string|null, campaign?: string }} [args]
 * @returns {string} HTML `<tr>…</tr>` or ''
 */
export function renderRecommendedBlock({ locale, interest, acquisitionSource, campaign } = {}) {
  const loc = normLocale(locale);
  const rec = pickNewsletterRecommendation({ locale: loc, interest });
  if (!rec) return '';

  const href = buildRecommendedHref(rec, { acquisitionSource, campaign });
  const eyebrow = chrome(loc, 'eyebrow');

  return `
    <tr><td class="section-pad" style="background:#ffffff;padding:8px 28px 24px;">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:2px;color:${BRAND_ORANGE};font-weight:700;margin:0 0 6px;">${eyebrow}</div>
      <a target="_blank" rel="noopener noreferrer sponsored" href="${escapeHtml(href)}" style="text-decoration:none;display:block;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background:${CARD_BG};border:1px solid ${BORDER_COLOR};border-radius:14px;">
          <tr>
            <td width="56" style="padding:18px 0 18px 18px;vertical-align:top;">
              <div style="width:44px;height:44px;border-radius:10px;background:#fff7ed;border:1px solid ${BORDER_COLOR};text-align:center;line-height:44px;font-size:22px;">${rec.emoji}</div>
            </td>
            <td style="padding:18px 18px 18px 14px;vertical-align:top;">
              <div style="font-size:15px;font-weight:800;color:${BRAND_DARK};margin:0 0 4px;line-height:1.3;">${escapeHtml(rec.title)}</div>
              <div style="font-size:13px;color:${TEXT_COLOR};line-height:1.5;margin:0 0 10px;">${escapeHtml(rec.body)}</div>
              <span style="display:inline-block;background:${BRAND_ORANGE};color:#ffffff;font-weight:700;font-size:13px;padding:9px 20px;border-radius:8px;">${escapeHtml(rec.cta)}</span>
            </td>
          </tr>
        </table>
      </a>
      <div style="font-size:11px;color:${MUTED_COLOR};margin:8px 2px 0;">${escapeHtml(rec.disclosure)}</div>
    </td></tr>`;
}
