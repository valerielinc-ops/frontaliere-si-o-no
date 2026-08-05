/**
 * CompanyAlert email template — `company_alert.*` (issue #5012, phase 2).
 *
 * The dedicated template the issue asks for: subject «Nuova offerta presso
 * [Azienda]», CTA «Vedi tutte le offerte di [Azienda]». Before this, a
 * followed-employer alert went out under the GENERIC job-alert template, whose
 * hero reads "N nuove offerte per te" and whose filter line said «tutte le
 * offerte» — because `filterLabel` in send-job-alerts.mjs only ever looked at
 * keywords/locations/sectors, and a CompanyAlert has none of those. The user
 * followed one employer and received an email that never named it.
 *
 * Repo convention (there is no template registry, no .mjml, no
 * `scripts/lib/email-templates/`): ONE module per email type exporting a
 * `build*Email()` that returns `{ subject, html, text }`, with an inline
 * `it/en/de/fr` string table. Mirrors services/publisherBlastEmail.mjs,
 * services/winbackEmail.mjs, services/newsletter/onboardingDrip.mjs.
 *
 * `COMPANY_ALERT_TEMPLATE_ID` is the template's identity in the only slot the
 * codebase actually has for one: the ESP tag (`type=company_alert`) and the
 * Feedback-ID / utm_campaign namespace. That is what makes the send
 * distinguishable in provider dashboards and in PostHog from `job-alert`.
 *
 * Deliberately NOT importing from scripts/send-job-alerts.mjs: that module has
 * top-level `fs.readFileSync` of data/*.json and a Firebase-admin lazy init,
 * so importing it from anywhere (including a unit test) does file IO. This
 * builder is pure — no IO, no Date.now() beyond the caller-supplied `now` —
 * so tests/company-alert.test.ts can assert the rendered output directly.
 */

import { nlNormLocale } from './newsletter-template.mjs';

/** ESP tag / campaign namespace. The `company_alert.*` identity of this template. */
export const COMPANY_ALERT_TEMPLATE_ID = 'company_alert';

/** Max job cards rendered in one CompanyAlert email. */
export const COMPANY_ALERT_MAX_CARDS = 6;

const BRAND_DARK = '#0f172a';
const BRAND_ORANGE = '#f97316';
const LIGHT_BG = '#f8fafc';
const WHITE = '#ffffff';

/**
 * Employer-profile hub segment. ONE literal `aziende` for every locale, not a
 * per-locale word: build-plugins/employerProfilePagesPlugin.ts emits
 * `/aziende/<slug>/` and `/en|/de|/fr/aziende/<slug>/`, and services/router.ts
 * matches exactly that shape (`^\/(en|de|fr)?\/aziende\/…`). Translating the
 * segment here would build a CTA to a URL the site does not serve — the
 * "looks localised, 404s" mistake the `/lavoro/` family already documents.
 */
const COMPANY_HUB_SEGMENT = 'aziende';

const LOCALE_PREFIX = { it: '', en: '/en', de: '/de', fr: '/fr' };

/**
 * it/en/de/fr copy. Every user-facing string of a new surface must exist in all
 * four locales (workspace rule) — a template shipped in one language is
 * incomplete, not "translatable later".
 */
export const COMPANY_ALERT_STRINGS = {
  it: {
    subjectOne: (company) => `Nuova offerta presso ${company}`,
    subjectMany: (company, n) => `${n} nuove offerte presso ${company}`,
    preheader: (company, n) => n === 1
      ? `${company} ha appena pubblicato un nuovo annuncio.`
      : `${company} ha appena pubblicato ${n} nuovi annunci.`,
    heroOne: (company) => `${company} sta assumendo`,
    heroMany: (company, n) => `${company}: ${n} nuove posizioni`,
    followedLabel: 'Azienda seguita',
    ctaAll: (company) => `Vedi tutte le offerte di ${company}`,
    closer: 'Ricevi questa email perché segui questa azienda su Frontaliere Ticino.',
    manage: 'Gestisci le aziende seguite',
    unsubThis: (company) => `Smetti di seguire ${company}`,
    unsubAll: 'Disattiva tutti gli avvisi',
    intendedFor: (email) => `Email inviata a ${email}.`,
    contract: 'Contratto',
    location: 'Luogo',
  },
  en: {
    subjectOne: (company) => `New job at ${company}`,
    subjectMany: (company, n) => `${n} new jobs at ${company}`,
    preheader: (company, n) => n === 1
      ? `${company} just posted a new opening.`
      : `${company} just posted ${n} new openings.`,
    heroOne: (company) => `${company} is hiring`,
    heroMany: (company, n) => `${company}: ${n} new openings`,
    followedLabel: 'Company you follow',
    ctaAll: (company) => `See all jobs at ${company}`,
    closer: 'You get this email because you follow this company on Frontaliere Ticino.',
    manage: 'Manage followed companies',
    unsubThis: (company) => `Stop following ${company}`,
    unsubAll: 'Turn off all alerts',
    intendedFor: (email) => `Sent to ${email}.`,
    contract: 'Contract',
    location: 'Location',
  },
  de: {
    subjectOne: (company) => `Neue Stelle bei ${company}`,
    subjectMany: (company, n) => `${n} neue Stellen bei ${company}`,
    preheader: (company, n) => n === 1
      ? `${company} hat soeben eine neue Stelle ausgeschrieben.`
      : `${company} hat soeben ${n} neue Stellen ausgeschrieben.`,
    heroOne: (company) => `${company} stellt ein`,
    heroMany: (company, n) => `${company}: ${n} neue Stellen`,
    followedLabel: 'Gefolgtes Unternehmen',
    ctaAll: (company) => `Alle Stellen bei ${company} ansehen`,
    closer: 'Du erhältst diese E-Mail, weil du diesem Unternehmen auf Frontaliere Ticino folgst.',
    manage: 'Gefolgte Unternehmen verwalten',
    unsubThis: (company) => `${company} nicht mehr folgen`,
    unsubAll: 'Alle Benachrichtigungen deaktivieren',
    intendedFor: (email) => `Gesendet an ${email}.`,
    contract: 'Vertrag',
    location: 'Ort',
  },
  fr: {
    subjectOne: (company) => `Nouvelle offre chez ${company}`,
    subjectMany: (company, n) => `${n} nouvelles offres chez ${company}`,
    preheader: (company, n) => n === 1
      ? `${company} vient de publier une nouvelle annonce.`
      : `${company} vient de publier ${n} nouvelles annonces.`,
    heroOne: (company) => `${company} recrute`,
    heroMany: (company, n) => `${company} : ${n} nouveaux postes`,
    followedLabel: 'Entreprise suivie',
    ctaAll: (company) => `Voir toutes les offres de ${company}`,
    closer: 'Vous recevez cet e-mail car vous suivez cette entreprise sur Frontaliere Ticino.',
    manage: 'Gérer les entreprises suivies',
    unsubThis: (company) => `Ne plus suivre ${company}`,
    unsubAll: 'Désactiver toutes les alertes',
    intendedFor: (email) => `Envoyé à ${email}.`,
    contract: 'Contrat',
    location: 'Lieu',
  },
};

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Public `/aziende/<slug>/` hub for the followed employer — the destination of
 * the «Vedi tutte le offerte di [Azienda]» CTA the issue asks for. `slug` is
 * the alert's own `specificCompanyKey`, i.e. the canonical company slug from
 * build-plugins/shared/companyProfileSlug.mjs, which is exactly the slug
 * jobsSeoPagesPlugin emits those pages under. One normalisation, one URL.
 *
 * @param {string} slug   Canonical company slug (`alert.specificCompanyKey`).
 * @param {string} locale Normalised locale.
 * @param {string} [baseUrl]
 * @returns {string}
 */
export function companyHubUrl(slug, locale, baseUrl = 'https://frontaliereticino.ch') {
  const loc = nlNormLocale(locale);
  return `${baseUrl}${LOCALE_PREFIX[loc] || ''}/${COMPANY_HUB_SEGMENT}/${encodeURIComponent(slug)}/`;
}

/**
 * Build the CompanyAlert email.
 *
 * Pure: every URL and the recipient/company identity come in as arguments, so
 * the function does no IO and no secret lookup of its own (the caller,
 * scripts/send-company-alerts.mjs, owns those).
 *
 * @param {object} opts
 * @param {string} opts.companyName  Display name of the followed employer.
 * @param {string} opts.companySlug  Canonical slug (`alert.specificCompanyKey`).
 * @param {object[]} opts.jobs       New jobs from that employer (already deduped).
 * @param {string} opts.email        Recipient.
 * @param {string} opts.locale       it|en|de|fr (normalised internally).
 * @param {string} opts.manageUrl    Followed-companies / preferences link.
 * @param {string} opts.unsubscribeUrl   Per-alert one-click unsubscribe.
 * @param {string} opts.unsubscribeAllUrl All-alerts unsubscribe.
 * @param {function(string):string} [opts.wrapUrl] Autologin/UTM decorator.
 * @param {string} [opts.baseUrl]
 * @returns {{ subject: string, html: string, text: string }}
 */
export function buildCompanyAlertEmail({
  companyName,
  companySlug,
  jobs,
  email,
  locale,
  manageUrl,
  unsubscribeUrl,
  unsubscribeAllUrl,
  wrapUrl = (u) => u,
  baseUrl = 'https://frontaliereticino.ch',
}) {
  const loc = nlNormLocale(locale);
  const s = COMPANY_ALERT_STRINGS[loc] || COMPANY_ALERT_STRINGS.it;
  const shown = (jobs || []).slice(0, COMPANY_ALERT_MAX_CARDS);
  const n = shown.length;
  const company = String(companyName || '').trim() || companySlug;

  // Counts state what the email RENDERS, never the size of the match pool —
  // the lesson the generic template's "186 nuove offerte" bug taught (#3798).
  const subject = n === 1 ? s.subjectOne(company) : s.subjectMany(company, n);
  const hubUrl = wrapUrl(companyHubUrl(companySlug, loc, baseUrl));

  const cards = shown.map((job) => {
    const title = String(job.title || '').trim();
    const url = wrapUrl(String(job.url || hubUrl));
    const place = [job.location, job.canton].filter(Boolean).join(', ');
    const contract = String(job.contractType || job.contract || '').trim();
    const metaBits = [place, contract].filter(Boolean).map(escHtml).join(' · ');
    return `
        <tr><td style="padding:0 0 10px;">
          <a href="${escHtml(url)}" target="_blank" rel="noopener noreferrer" style="display:block;text-decoration:none;background:${BRAND_DARK};border-radius:10px;padding:16px 18px;">
            <div style="font-size:15px;font-weight:700;color:#f1f5f9;margin:0;">${escHtml(title)}</div>
            ${metaBits ? `<div style="font-size:12px;color:#94a3b8;margin-top:4px;">${metaBits}</div>` : ''}
          </a>
        </td></tr>`;
  }).join('');

  const heroTitle = n === 1 ? s.heroOne(company) : s.heroMany(company, n);

  const html = `<!DOCTYPE html>
<html lang="${loc}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${escHtml(subject)}</title>
  <style>
    body{margin:0;padding:0;background:${LIGHT_BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-text-size-adjust:100%;}
    table{border-collapse:collapse;}
    @media only screen and (max-width:620px){
      .outer-table{width:100%!important;}
      .section-pad{padding-left:16px!important;padding-right:16px!important;}
    }
  </style>
</head>
<body>
  <div style="display:none!important;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escHtml(s.preheader(company, n))}&nbsp;‌‌‌‌</div>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:${LIGHT_BG};">
    <tr><td align="center" style="padding:0;">
      <table class="outer-table" width="620" cellpadding="0" cellspacing="0" style="width:100%;max-width:620px;">

        <tr><td style="background:${BRAND_DARK};padding:14px 28px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="font-size:15px;font-weight:800;color:${WHITE};letter-spacing:-0.3px;">
                <span style="color:${BRAND_ORANGE};">●</span> Frontaliere Ticino
              </td>
              <td align="right" style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;">
                <a target="_blank" rel="noopener noreferrer" href="${escHtml(manageUrl)}" style="color:${BRAND_ORANGE};text-decoration:none;">${escHtml(s.manage)}</a>
              </td>
            </tr>
          </table>
        </td></tr>

        <tr><td style="background:${BRAND_DARK};padding:18px 28px 28px;" class="section-pad">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:${BRAND_ORANGE};">${escHtml(s.followedLabel)}</div>
          <div style="font-size:22px;font-weight:800;color:${WHITE};margin-top:6px;">${escHtml(heroTitle)}</div>
        </td></tr>

        <tr><td style="background:${WHITE};padding:22px 28px 6px;" class="section-pad">
          <table width="100%" cellpadding="0" cellspacing="0">${cards}</table>
        </td></tr>

        <tr><td align="center" style="background:${WHITE};padding:10px 28px 26px;" class="section-pad">
          <a href="${escHtml(hubUrl)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:${BRAND_ORANGE};color:${WHITE};font-size:14px;font-weight:700;text-decoration:none;padding:13px 22px;border-radius:8px;">${escHtml(s.ctaAll(company))}</a>
        </td></tr>

        <tr><td style="background:${BRAND_DARK};padding:20px 28px;color:#94a3b8;font-size:11px;line-height:1.6;" class="section-pad">
          <div>${escHtml(s.closer)}</div>
          <div style="margin-top:8px;">${escHtml(s.intendedFor(email))}</div>
          <div style="margin-top:8px;">
            <a href="${escHtml(unsubscribeUrl)}" target="_blank" rel="noopener noreferrer" style="color:${BRAND_ORANGE};text-decoration:underline;">${escHtml(s.unsubThis(company))}</a>
            &nbsp;·&nbsp;
            <a href="${escHtml(unsubscribeAllUrl)}" target="_blank" rel="noopener noreferrer" style="color:#94a3b8;text-decoration:underline;">${escHtml(s.unsubAll)}</a>
          </div>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    heroTitle,
    '',
    ...shown.map((job) => {
      const place = [job.location, job.canton].filter(Boolean).join(', ');
      return `- ${job.title || ''}${place ? ` (${place})` : ''}\n  ${wrapUrl(String(job.url || hubUrl))}`;
    }),
    '',
    `${s.ctaAll(company)}: ${hubUrl}`,
    '',
    s.closer,
    `${s.manage}: ${manageUrl}`,
    `${s.unsubThis(company)}: ${unsubscribeUrl}`,
    `${s.unsubAll}: ${unsubscribeAllUrl}`,
    s.intendedFor(email),
  ].join('\n');

  return { subject, html, text };
}
