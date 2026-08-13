/**
 * publisherBlastEmail — branded single-job email for the sponsored-ad blast
 * (scripts/blast-publisher-ads.mjs).
 *
 * Mirrors the visual language of the job-alert / newsletter emails (dark top
 * bar, hero, job card with logo + chips, orange CTA, dark footer) instead of
 * the previous bare `<h2>title</h2><p>company</p><a href="/lavoro">` stub. The
 * CTA links to the SPECIFIC ad page (`/lavoro/<slug>/`), never the generic
 * job-board alias, with email UTM tags.
 *
 * Pure + self-contained (no IO / Firestore / heavy imports) so it is unit
 * testable and callable from a plain Node script. The caller computes the ad
 * URL (slug derived exactly like publisherJobProjection) and the unsubscribe
 * URL and passes them in.
 */

import { peelDanglingClauseTail } from '../build-plugins/shared/clauseTail.mjs';
import { dataControllerFooterLine } from '../functions/src/lib/dataControllerIdentity.js';

const BRAND_ORANGE = '#f97316';
const BRAND_DARK = '#0f172a';
const DARK_CARD = '#1e293b';
const LIGHT_BG = '#f1f5f9';
const WHITE = '#ffffff';
const MUTED = '#64748b';        // 4.55:1 on CARD_BG (#f8fafc) — the job-card meta line, fine there
const CARD_BG = '#f8fafc';
// #5714 item 1 (follow-up of #5707, review of #5697): MUTED was ALSO used
// verbatim for the `why`/`adsNote`/unsub-wrapper lines in the DARK footer
// (background: BRAND_DARK) — 3.75:1 there, below AA (4.5:1) for that 11-12px
// text. `#94a3b8` is already the value the identity line in the same footer
// (below) correctly uses on this background — 6.96:1 — so this names it
// instead of leaving a second unnamed literal for the same background.
const MUTED_ON_DARK = '#94a3b8';

const LOCALES = ['it', 'en', 'de', 'fr'];

const STR = {
  it: {
    subject: (t) => `Nuova offerta per te: ${t}`,
    preheader: 'Un datore di lavoro cerca proprio il tuo profilo su Frontaliere Ticino.',
    sponsored: 'Sponsorizzato',
    hero: 'Offerta in evidenza per te',
    sectionLabel: 'Annuncio sponsorizzato',
    cta: 'Candidati ora',
    salary: 'Retribuzione',
    why: (email) => `Ricevi questa email perché corrisponde alle tue ricerche di lavoro su Frontaliere Ticino (${email}).`,
    unsub: 'Disiscriviti',
    prefs: 'Gestisci le tue preferenze',
    adsNote: 'Questa è pubblicità di terzi. Puoi disattivare solo questo canale dalle tue preferenze, senza toccare le altre comunicazioni.',
    viewAll: 'Vedi tutte le offerte',
  },
  en: {
    subject: (t) => `A new job for you: ${t}`,
    preheader: 'An employer is looking for your exact profile on Frontaliere Ticino.',
    sponsored: 'Sponsored',
    hero: 'A featured job for you',
    sectionLabel: 'Sponsored listing',
    cta: 'Apply now',
    salary: 'Salary',
    why: (email) => `You receive this email because it matches your job searches on Frontaliere Ticino (${email}).`,
    unsub: 'Unsubscribe',
    prefs: 'Manage your preferences',
    adsNote: 'This is third-party advertising. You can switch off this channel alone from your preferences, without touching the other communications.',
    viewAll: 'See all jobs',
  },
  de: {
    subject: (t) => `Ein neues Stellenangebot für Sie: ${t}`,
    preheader: 'Ein Arbeitgeber sucht genau Ihr Profil auf Frontaliere Ticino.',
    sponsored: 'Gesponsert',
    hero: 'Ein hervorgehobenes Angebot für Sie',
    sectionLabel: 'Gesponsertes Inserat',
    cta: 'Jetzt bewerben',
    salary: 'Gehalt',
    why: (email) => `Sie erhalten diese E-Mail, weil sie zu Ihren Jobsuchen auf Frontaliere Ticino passt (${email}).`,
    unsub: 'Abmelden',
    prefs: 'Einstellungen verwalten',
    adsNote: 'Dies ist Werbung Dritter. Sie können allein diesen Kanal in Ihren Einstellungen abschalten, ohne die übrigen Mitteilungen zu berühren.',
    viewAll: 'Alle Angebote ansehen',
  },
  fr: {
    subject: (t) => `Une nouvelle offre pour vous : ${t}`,
    preheader: 'Un employeur recherche exactement votre profil sur Frontaliere Ticino.',
    sponsored: 'Sponsorisé',
    hero: 'Une offre en vedette pour vous',
    sectionLabel: 'Annonce sponsorisée',
    cta: 'Postuler',
    salary: 'Salaire',
    why: (email) => `Vous recevez cet e-mail car il correspond à vos recherches d'emploi sur Frontaliere Ticino (${email}).`,
    unsub: 'Se désabonner',
    prefs: 'Gérer vos préférences',
    adsNote: 'Ceci est de la publicité de tiers. Vous pouvez désactiver ce seul canal depuis vos préférences, sans toucher aux autres communications.',
    viewAll: 'Voir toutes les offres',
  },
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** "CHF 70'000–90'000" / "CHF 70'000+" — Swiss grouping; null when no data. */
function formatSalary(ad) {
  const min = Number(ad?.salaryMin);
  const max = Number(ad?.salaryMax);
  const cur = esc(ad?.currency || 'CHF');
  const fmt = (n) => Number(n).toLocaleString('de-CH');
  if (Number.isFinite(min) && min > 0 && Number.isFinite(max) && max > 0) {
    return `${cur} ${fmt(min)}–${fmt(max)}`;
  }
  if (Number.isFinite(min) && min > 0) return `${cur} ${fmt(min)}+`;
  if (Number.isFinite(max) && max > 0) return `${cur} ${fmt(max)}`;
  return null;
}

/** First ~160 chars of the plain description, cut at a word boundary. */
function snippet(text, max = 160) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const slot = t.slice(0, max - 1);
  const lastSpace = slot.lastIndexOf(' ');
  // Shared peel — a word-boundary cut still stops mid-clause.
  return peelDanglingClauseTail(lastSpace > max * 0.5 ? slot.slice(0, lastSpace) : slot) + '…';
}

function chip(label) {
  return `<span style="font-size:11px;background:rgba(249,115,22,0.15);color:#c2410c;padding:3px 9px;border-radius:6px;font-weight:600;display:inline-block;margin:2px 4px 2px 0;">${esc(label)}</span>`;
}

/**
 * @param {object} args
 * @param {object} args.ad             publisher_jobs doc (title, company, locations, salary…).
 * @param {string} args.recipientEmail recipient (for the "why" line, escaped).
 * @param {string} [args.locale]       it|en|de|fr (defaults to it).
 * @param {string} args.adUrl          absolute URL to the specific /lavoro/<slug>/ page (with UTM).
 * @param {string} args.unsubscribeUrl absolute unsubscribe URL.
 * @param {string} [args.preferencesUrl] absolute preference-centre URL (#5759).
 *   Omitted → the block degrades to the unsubscribe link alone rather than to a
 *   broken href, the same rule `buildDripEmail` follows.
 * @param {string} [args.locationLabel] the SAME location the CTA slug is built from
 *   (caller passes the distinctLocations-derived label). Keeps the card's city and
 *   the CTA's target page consistent for bare-string / empty-first location shapes.
 * @returns {{ subject: string, html: string }}
 */
export function buildBlastEmail({ ad, recipientEmail, locale = 'it', adUrl, unsubscribeUrl, preferencesUrl, locationLabel }) {
  const loc = LOCALES.includes(locale) ? locale : 'it';
  const s = STR[loc];
  const title = String(ad?.title || '').trim();
  const company = String(ad?.company?.name || '').trim();
  // Prefer the caller-provided label (derived via distinctLocations, identical to
  // the CTA slug) so the card city never diverges from the linked page; fall back
  // to the raw first-location label only when not supplied.
  const firstLoc = String(
    locationLabel != null && String(locationLabel).trim()
      ? locationLabel
      : (Array.isArray(ad?.locations) && ad.locations[0] ? (ad.locations[0].label ?? ad.locations[0]) : ''),
  ).trim();
  const logoUrl = String(ad?.company?.logoUrl || '').trim();
  const logoOk = /^https:\/\/\S+$/i.test(logoUrl);
  const initial = (company || title || '?')[0].toUpperCase();

  const subject = s.subject(title);

  const chips = [];
  const sal = formatSalary(ad);
  if (sal) chips.push(`${s.salary}: ${sal}`);
  if (firstLoc) chips.push(firstLoc);
  if (ad?.sector) chips.push(String(ad.sector));
  const chipsHtml = chips.map(chip).join('');

  const desc = snippet(ad?.description);

  const avatarHtml = logoOk
    ? `<img src="${esc(logoUrl)}" alt="${esc(company)}" width="52" height="52" style="display:block;width:52px;height:52px;border-radius:12px;background:#fff;object-fit:contain;padding:5px;box-sizing:border-box;">`
    : `<div style="width:52px;height:52px;border-radius:12px;background:linear-gradient(135deg,${BRAND_DARK},#334155);text-align:center;line-height:52px;font-size:22px;font-weight:800;color:${BRAND_ORANGE};">${esc(initial)}</div>`;

  const html = `<!DOCTYPE html>
<html lang="${loc}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${esc(title)} — Frontaliere Ticino</title>
  <style>
    body{margin:0;padding:0;background:${LIGHT_BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-text-size-adjust:100%;}
    table{border-collapse:collapse;}
    @media only screen and (max-width:620px){.outer-table{width:100%!important;}.section-pad{padding-left:16px!important;padding-right:16px!important;}}
  </style>
</head>
<body>
  <div style="display:none!important;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${esc(s.preheader)}&nbsp;‌‌‌‌</div>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:${LIGHT_BG};">
    <tr><td align="center" style="padding:0;">
      <table class="outer-table" width="620" cellpadding="0" cellspacing="0" style="width:100%;max-width:620px;">

        <!-- Top bar -->
        <tr><td style="background:${BRAND_DARK};padding:14px 28px;">
          <span style="font-size:15px;font-weight:800;color:${WHITE};letter-spacing:-0.3px;"><span style="color:${BRAND_ORANGE};">●</span> Frontaliere Ticino</span>
        </td></tr>

        <!-- Hero -->
        <tr><td style="background:${BRAND_DARK};padding:18px 28px 26px;" class="section-pad">
          <span style="font-size:10px;background:rgba(249,115,22,0.2);color:#fdba74;padding:3px 9px;border-radius:6px;text-transform:uppercase;letter-spacing:0.5px;font-weight:700;">${esc(s.sponsored)}</span>
          <div style="font-size:22px;font-weight:800;color:${WHITE};margin:12px 0 0;">${esc(s.hero)}</div>
        </td></tr>

        <!-- Job card -->
        <tr><td class="section-pad" style="background:${WHITE};padding:24px 28px 8px;">
          <a target="_blank" rel="noopener noreferrer" href="${esc(adUrl)}" style="text-decoration:none;display:block;">
            <table width="100%" cellpadding="0" cellspacing="0" style="background:${CARD_BG};border:1px solid #e2e8f0;border-radius:14px;">
              <tr>
                <td width="68" style="padding:18px 0 18px 18px;vertical-align:top;">${avatarHtml}</td>
                <td style="padding:18px;vertical-align:top;">
                  <div style="font-size:17px;font-weight:800;color:${BRAND_DARK};margin:0 0 3px;">${esc(title)}</div>
                  <div style="font-size:13px;color:${MUTED};margin:0 0 8px;">${esc(company)}${company && firstLoc ? ' · ' : ''}${esc(firstLoc)}</div>
                  ${chipsHtml ? `<div style="margin:0 0 8px;">${chipsHtml}</div>` : ''}
                  ${desc ? `<div style="font-size:13px;color:#334155;line-height:1.55;margin:0;">${esc(desc)}</div>` : ''}
                </td>
              </tr>
            </table>
          </a>
        </td></tr>

        <!-- CTA -->
        <tr><td class="section-pad" style="background:${WHITE};padding:18px 28px 26px;text-align:center;">
          <a target="_blank" rel="noopener noreferrer" href="${esc(adUrl)}" style="display:inline-block;background:${BRAND_ORANGE};color:${WHITE};font-weight:800;font-size:15px;text-decoration:none;padding:14px 38px;border-radius:10px;">${esc(s.cta)}</a>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:${BRAND_DARK};padding:26px 28px;text-align:center;">
          <div style="margin-bottom:12px;">
            <a target="_blank" rel="noopener noreferrer" href="https://www.linkedin.com/company/frontaliere-ticino" style="display:inline-block;margin:0 6px;font-size:18px;text-decoration:none;">💼</a>
            <a target="_blank" rel="noopener noreferrer" href="https://frontaliereticino.ch" style="display:inline-block;margin:0 6px;font-size:18px;text-decoration:none;">🌐</a>
          </div>
          <div style="font-size:11px;color:${MUTED_ON_DARK};margin:0 0 10px;line-height:1.5;">${esc(s.why(recipientEmail))}</div>
          <!--
            #5759 — this channel is third-party advertising, consented to as an
            OPT-OUT with no separate checkbox. The switch that stops it alone
            lives in the preference centre, so the mail that relies on the
            switch has to carry the way to it: an opt-out nobody can find is
            the whole of #5684, and "unsubscribe from everything" is not the
            same offer.
          -->
          <div style="font-size:11px;color:${MUTED_ON_DARK};margin:0 0 10px;line-height:1.5;">${esc(s.adsNote)}</div>
          <div style="font-size:12px;color:${MUTED_ON_DARK};">
            <a target="_blank" rel="noopener noreferrer" href="${esc(unsubscribeUrl)}" style="color:${BRAND_ORANGE};text-decoration:underline;">${esc(s.unsub)}</a>${
              preferencesUrl
                ? ` &nbsp;·&nbsp; <a target="_blank" rel="noopener noreferrer" href="${esc(preferencesUrl)}" style="color:${BRAND_ORANGE};text-decoration:underline;">${esc(s.prefs)}</a>`
                : ''
            }
          </div>
          <div style="font-size:11px;color:${MUTED_ON_DARK};margin-top:10px;">${esc(dataControllerFooterLine(loc))}</div>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, html };
}
