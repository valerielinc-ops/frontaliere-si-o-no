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
 * ── ONE EMAIL, N COMPANY SECTIONS (residuo #5283) ─────────────────────────
 * The template started mono-employer because the sender mailed one email per
 * alert per run: somebody following 10 employers that published in the same
 * 6h window received TEN near-identical emails. `buildCompanyAlertEmail` now
 * takes a `sections` array — one entry per followed employer — and renders a
 * single message; the mono form is kept as the 1-section case, byte-identical
 * to what it rendered before, because it is still the common case and a
 * subject that names one employer outperforms any grouped phrasing.
 *
 * The builder RETURNS the sections it actually rendered (`{ sections }`),
 * trimmed by `allocateCompanyAlertCards`. That return value — not the caller's
 * input — is what scripts/send-company-alerts.mjs marks as sent in every
 * alert's `sentJobIds`. Deriving "what was sent" from anything other than what
 * the renderer emitted is how a job gets marked delivered without ever
 * appearing in an inbox.
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
import { dataControllerFooterLine } from '../functions/src/lib/dataControllerIdentity.js';

/** ESP tag / campaign namespace. The `company_alert.*` identity of this template. */
export const COMPANY_ALERT_TEMPLATE_ID = 'company_alert';

/** Max job cards rendered for ONE employer section. */
export const COMPANY_ALERT_MAX_CARDS = 6;

/**
 * Max job cards rendered in one CompanyAlert email, across every section.
 *
 * Three separate ceilings collapse into this single number, which is why it is
 * worth stating rather than inferring:
 *
 *  1. **Message size.** Gmail clips a message past 102 KB behind a «Visualizza
 *     messaggio completo» link — and the unsubscribe footer is exactly what
 *     ends up below that fold. The worst shape for 20 cards is 20 sections of
 *     one card each (most chrome per card): measured 52.8 KB of HTML plus
 *     18.3 KB of plaintext alternative, ≈ 71 KB of body, with fully
 *     autologin-decorated URLs. Under the clip, with the margin thin enough to
 *     be worth pinning — tests/company-alert.test.ts fails if a template change
 *     pushes it over.
 *  2. **Section count.** A section needs at least one card to exist, so this is
 *     also the hard ceiling on sections per email — and therefore on Firestore
 *     writes per recipient, which is what lets send-company-alerts.mjs pick a
 *     `commitInChunks` chunk size that keeps one recipient's `sentJobIds`
 *     updates inside ONE atomic batch.
 *  3. **The follow budget.** MAX_COMPANY_ALERTS_PER_USER (services/jobAlertService.ts)
 *     is pinned to this same 20 so that even the pathological run — every
 *     followed employer publishing inside the same window — still fits in a
 *     single message and can never spill into a second email.
 *
 * Overflow is not lost: the sections that do not fit keep their `sentJobIds`
 * untouched, so the next run (push-driven, minutes away) finds them still
 * unsent while the ones just mailed drop out — the order rotates by itself.
 */
export const COMPANY_ALERT_MAX_TOTAL_CARDS = 20;

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
    // Two employers: both get named. The employer name is the strongest open
    // signal this template has, and at two it still fits an inbox preview.
    subjectTwo: (a, b, n) => `${a} e ${b}: ${n} nuove offerte`,
    // Three or more: the freshest employer keeps the front of the line (a
    // subject that opens with a bare number reads like a newsletter), the rest
    // become a count. Never "N aziende che segui" alone — that names nobody.
    subjectMulti: (company, others, n) => `${company} e altre ${others} aziende: ${n} nuove offerte`,
    preheader: (company, n) => n === 1
      ? `${company} ha appena pubblicato un nuovo annuncio.`
      : `${company} ha appena pubblicato ${n} nuovi annunci.`,
    preheaderMulti: (n, companies) => `${n} nuovi annunci dalle ${companies} aziende che segui.`,
    heroOne: (company) => `${company} sta assumendo`,
    heroMany: (company, n) => `${company}: ${n} nuove posizioni`,
    heroMulti: (n, companies) => `${n} nuove offerte da ${companies} aziende`,
    sectionNew: (n) => (n === 1 ? '1 nuova offerta' : `${n} nuove offerte`),
    followedLabel: 'Azienda seguita',
    followedLabelMulti: 'Aziende seguite',
    ctaAll: (company) => `Vedi tutte le offerte di ${company}`,
    // Not cosmetic: `closer` says «questa azienda». A message covering four
    // employers that claims to be about one is the same class of lie as the
    // pre-#5012 «tutte le offerte» filter line this template was born to fix.
    closerMulti: 'Ricevi questa email perché segui queste aziende su Frontaliere Ticino.',
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
    subjectTwo: (a, b, n) => `${a} and ${b}: ${n} new jobs`,
    subjectMulti: (company, others, n) => `${company} and ${others} more companies: ${n} new jobs`,
    preheader: (company, n) => n === 1
      ? `${company} just posted a new opening.`
      : `${company} just posted ${n} new openings.`,
    preheaderMulti: (n, companies) => `${n} new openings from the ${companies} companies you follow.`,
    heroOne: (company) => `${company} is hiring`,
    heroMany: (company, n) => `${company}: ${n} new openings`,
    heroMulti: (n, companies) => `${n} new jobs from ${companies} companies`,
    sectionNew: (n) => (n === 1 ? '1 new job' : `${n} new jobs`),
    followedLabel: 'Company you follow',
    followedLabelMulti: 'Companies you follow',
    ctaAll: (company) => `See all jobs at ${company}`,
    closerMulti: 'You get this email because you follow these companies on Frontaliere Ticino.',
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
    subjectTwo: (a, b, n) => `${a} und ${b}: ${n} neue Stellen`,
    subjectMulti: (company, others, n) => `${company} und ${others} weitere Unternehmen: ${n} neue Stellen`,
    preheader: (company, n) => n === 1
      ? `${company} hat soeben eine neue Stelle ausgeschrieben.`
      : `${company} hat soeben ${n} neue Stellen ausgeschrieben.`,
    preheaderMulti: (n, companies) => `${n} neue Stellen von den ${companies} Unternehmen, denen du folgst.`,
    heroOne: (company) => `${company} stellt ein`,
    heroMany: (company, n) => `${company}: ${n} neue Stellen`,
    heroMulti: (n, companies) => `${n} neue Stellen von ${companies} Unternehmen`,
    sectionNew: (n) => (n === 1 ? '1 neue Stelle' : `${n} neue Stellen`),
    followedLabel: 'Gefolgtes Unternehmen',
    followedLabelMulti: 'Gefolgte Unternehmen',
    ctaAll: (company) => `Alle Stellen bei ${company} ansehen`,
    closerMulti: 'Du erhältst diese E-Mail, weil du diesen Unternehmen auf Frontaliere Ticino folgst.',
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
    subjectTwo: (a, b, n) => `${a} et ${b} : ${n} nouvelles offres`,
    subjectMulti: (company, others, n) => `${company} et ${others} autres entreprises : ${n} nouvelles offres`,
    preheader: (company, n) => n === 1
      ? `${company} vient de publier une nouvelle annonce.`
      : `${company} vient de publier ${n} nouvelles annonces.`,
    preheaderMulti: (n, companies) => `${n} nouvelles annonces des ${companies} entreprises que vous suivez.`,
    heroOne: (company) => `${company} recrute`,
    heroMany: (company, n) => `${company} : ${n} nouveaux postes`,
    heroMulti: (n, companies) => `${n} nouvelles offres de ${companies} entreprises`,
    sectionNew: (n) => (n === 1 ? '1 nouvelle offre' : `${n} nouvelles offres`),
    followedLabel: 'Entreprise suivie',
    followedLabelMulti: 'Entreprises suivies',
    ctaAll: (company) => `Voir toutes les offres de ${company}`,
    closerMulti: 'Vous recevez cet e-mail car vous suivez ces entreprises sur Frontaliere Ticino.',
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
 * DUPLICATED, DELIBERATELY, AND ASSERTED. hooks/useEmployerHub.ts's
 * `employerHubPath()` is the runtime (browser) half of this same URL, and it is
 * TypeScript: this module is imported by scripts/send-company-alerts.mjs, which
 * .github/workflows/send-company-alerts.yml runs under plain `node` — no tsx,
 * no bundler — so importing it would take the entire send down at runtime to
 * save a template literal. The gap is closed by assertion instead of by import:
 * tests/employer-hub-internal-links.test.ts pins
 * `companyHubUrl(slug, locale, '') === employerHubPath(slug, locale)` for every
 * locale, so a drift fails CI rather than shipping a 404 into every email.
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
 * Trim a candidate section list down to what one email may actually render.
 *
 * Pure, deterministic, and idempotent — running it on its own output is a
 * no-op — so the sender can hand it every candidate section and read back the
 * exact set that got rendered (see `buildCompanyAlertEmail`'s `sections`
 * return). Three rules, in order:
 *
 *  1. Each section is capped at `COMPANY_ALERT_MAX_CARDS` (6). An employer that
 *     dumps 30 roles in one window does not get 30 cards.
 *  2. Sections beyond `COMPANY_ALERT_MAX_TOTAL_CARDS` are dropped whole — a
 *     section with zero cards is not a section, so the card budget is also the
 *     section budget.
 *  3. If the surviving sections still exceed the card budget, cards are removed
 *     from the FATTEST section first, one at a time (water-filling), so a single
 *     prolific employer cannot starve the others out of the email. Every section
 *     that made rule 2 therefore keeps at least one card.
 *
 * Order is never changed: the caller ranks the sections (freshest employer
 * first) and that ranking decides who headlines the subject line.
 *
 * @param {Array<{jobs?: object[], [key: string]: unknown}>} sections
 * @param {{perSectionCap?: number, totalCap?: number}} [opts]
 * @returns {Array<{jobs: object[], [key: string]: unknown}>} new section objects (inputs untouched)
 */
export function allocateCompanyAlertCards(sections, {
  perSectionCap = COMPANY_ALERT_MAX_CARDS,
  totalCap = COMPANY_ALERT_MAX_TOTAL_CARDS,
} = {}) {
  const capped = (sections || [])
    .map((section) => ({ ...section, jobs: (section?.jobs || []).slice(0, perSectionCap) }))
    .filter((section) => section.jobs.length > 0)
    .slice(0, Math.max(0, totalCap));

  let total = capped.reduce((sum, section) => sum + section.jobs.length, 0);
  if (total <= totalCap) return capped;

  while (total > totalCap) {
    let fattest = 0;
    for (let i = 1; i < capped.length; i += 1) {
      if (capped[i].jobs.length > capped[fattest].jobs.length) fattest = i;
    }
    // Unreachable while `capped.length <= totalCap` (rule 2 guarantees it), but
    // a loop that can only exit by shrinking must not depend on that proof.
    if (capped[fattest].jobs.length <= 1) break;
    capped[fattest].jobs = capped[fattest].jobs.slice(0, -1);
    total -= 1;
  }
  return capped;
}

function jobCardHtml(job, hubUrl, wrapUrl) {
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
}

/**
 * Build the CompanyAlert email — one message, one section per followed employer.
 *
 * Pure: every URL and the recipient/company identity come in as arguments, so
 * the function does no IO and no secret lookup of its own (the caller,
 * scripts/send-company-alerts.mjs, owns those).
 *
 * TWO ACCEPTED SHAPES, one code path. Pass `sections` for the grouped form;
 * the legacy mono arguments (`companyName`/`companySlug`/`jobs`/
 * `unsubscribeUrl`) are normalised into a single section, so a 1-section email
 * renders exactly what this template rendered before grouping existed. That is
 * deliberate and not just back-compat: following ONE employer is the common
 * case, and «Nuova offerta presso X» is a stronger subject than any grouped
 * phrasing could be.
 *
 * @param {object} opts
 * @param {Array<{companyName?: string, companySlug?: string, jobs?: object[], unsubscribeUrl?: string, [key: string]: unknown}>} [opts.sections]
 *   One entry per followed employer, ALREADY ranked by the caller (first =
 *   headline = the employer the subject names). Each carries its own per-alert
 *   unsubscribe URL; any extra field (e.g. `alertId`) is passed through
 *   untouched to the returned `sections`.
 * @param {string} [opts.companyName]  Mono form: display name of the employer.
 * @param {string} [opts.companySlug]  Mono form: canonical slug (`alert.specificCompanyKey`).
 * @param {object[]} [opts.jobs]       Mono form: new jobs from that employer (already deduped).
 * @param {string} [opts.unsubscribeUrl] Mono form: per-alert one-click unsubscribe.
 * @param {string} opts.email        Recipient.
 * @param {string} opts.locale       it|en|de|fr (normalised internally).
 * @param {string} opts.manageUrl    Followed-companies / preferences link.
 * @param {string} opts.unsubscribeAllUrl All-alerts unsubscribe.
 * @param {function(string):string} [opts.wrapUrl] Autologin/UTM decorator.
 * @param {string} [opts.baseUrl]
 * @returns {{ subject: string, html: string, text: string, sections: Array<{company: string, hubUrl: string, jobs: object[], [key: string]: unknown}> }}
 *   `sections` is what was ACTUALLY rendered, after `allocateCompanyAlertCards`
 *   — the caller marks exactly these jobs as sent, never its own input.
 */
export function buildCompanyAlertEmail({
  sections,
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

  const requested = Array.isArray(sections) && sections.length > 0
    ? sections
    : [{ companyName, companySlug, jobs, unsubscribeUrl }];
  const shownSections = allocateCompanyAlertCards(requested).map((section) => ({
    ...section,
    // Display name resolved once, here, so the subject, the section header and
    // the unfollow link can never disagree about what the employer is called.
    company: String(section.companyName || '').trim() || String(section.companySlug || ''),
    hubUrl: wrapUrl(companyHubUrl(String(section.companySlug || ''), loc, baseUrl)),
  }));

  // Counts state what the email RENDERS, never the size of the match pool —
  // the lesson the generic template's "186 nuove offerte" bug taught (#3798).
  // With sections that now means two numbers, and both must be rendered ones:
  // `total` is cards after the card budget, `companies` is surviving sections.
  const total = shownSections.reduce((sum, section) => sum + section.jobs.length, 0);
  const companies = shownSections.length;
  const multi = companies > 1;
  const headline = shownSections[0] || { company: '', hubUrl: baseUrl, jobs: [] };

  let subject;
  if (!multi) subject = total === 1 ? s.subjectOne(headline.company) : s.subjectMany(headline.company, total);
  else if (companies === 2) subject = s.subjectTwo(headline.company, shownSections[1].company, total);
  else subject = s.subjectMulti(headline.company, companies - 1, total);

  const preheader = multi ? s.preheaderMulti(total, companies) : s.preheader(headline.company, total);
  const heroTitle = multi
    ? s.heroMulti(total, companies)
    : (total === 1 ? s.heroOne(headline.company) : s.heroMany(headline.company, total));
  const followedLabel = multi ? s.followedLabelMulti : s.followedLabel;
  const closer = multi ? s.closerMulti : s.closer;

  // Body. The mono form keeps the layout it always had — no section header (the
  // hero already names the employer, repeating it reads like a bug) and the one
  // big orange CTA. The grouped form gives every employer its own header and a
  // pair of text links; a stack of six orange buttons is not a call to action,
  // it is wallpaper.
  const body = shownSections.map((section) => {
    const cards = section.jobs.map((job) => jobCardHtml(job, section.hubUrl, wrapUrl)).join('');
    const header = multi ? `
        <tr><td style="background:${WHITE};padding:20px 28px 2px;" class="section-pad">
          <a href="${escHtml(section.hubUrl)}" target="_blank" rel="noopener noreferrer" style="font-size:17px;font-weight:800;color:${BRAND_DARK};text-decoration:none;">${escHtml(section.company)}</a>
          <div style="font-size:12px;color:#64748b;margin-top:2px;">${escHtml(s.sectionNew(section.jobs.length))}</div>
        </td></tr>` : '';
    // Per-section unsubscribe, in the grouped form only: the reader who wants
    // out of ONE employer must be able to say so without a session, and this
    // link is pure HMAC (scripts/lib/job-alert-unsub-urls.mjs). In the mono
    // form the same link already lives in the footer, next to the global one.
    const footerLinks = multi ? `
        <tr><td style="background:${WHITE};padding:2px 28px 16px;" class="section-pad">
          <a href="${escHtml(section.hubUrl)}" target="_blank" rel="noopener noreferrer" style="font-size:12px;font-weight:600;color:${BRAND_ORANGE};text-decoration:none;">${escHtml(s.ctaAll(section.company))} →</a>
          &nbsp;·&nbsp;
          <a href="${escHtml(section.unsubscribeUrl || '')}" target="_blank" rel="noopener noreferrer" style="font-size:12px;color:#94a3b8;text-decoration:underline;">${escHtml(s.unsubThis(section.company))}</a>
        </td></tr>` : '';
    return `${header}
        <tr><td style="background:${WHITE};padding:${multi ? '8px' : '22px'} 28px 6px;" class="section-pad">
          <table width="100%" cellpadding="0" cellspacing="0">${cards}</table>
        </td></tr>${footerLinks}`;
  }).join('');

  const monoCta = multi ? '' : `
        <tr><td align="center" style="background:${WHITE};padding:10px 28px 26px;" class="section-pad">
          <a href="${escHtml(headline.hubUrl)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:${BRAND_ORANGE};color:${WHITE};font-size:14px;font-weight:700;text-decoration:none;padding:13px 22px;border-radius:8px;">${escHtml(s.ctaAll(headline.company))}</a>
        </td></tr>`;

  // Footer unsubscribe row. Mono keeps «Smetti di seguire X» + the global link.
  // Grouped drops the per-employer link here — it is already at the foot of
  // every section, where it names the employer it belongs to — and keeps the
  // global one, which is ALSO the URL the RFC 8058 List-Unsubscribe header
  // points at for a grouped send (see scripts/send-company-alerts.mjs): a
  // one-click that silently unfollowed only the first of six employers would
  // leave the reader clicking «Unsubscribe» again and again on a message that
  // keeps arriving.
  const footerUnsub = multi ? `
            <a href="${escHtml(unsubscribeAllUrl)}" target="_blank" rel="noopener noreferrer" style="color:${BRAND_ORANGE};text-decoration:underline;">${escHtml(s.unsubAll)}</a>` : `
            <a href="${escHtml(headline.unsubscribeUrl || '')}" target="_blank" rel="noopener noreferrer" style="color:${BRAND_ORANGE};text-decoration:underline;">${escHtml(s.unsubThis(headline.company))}</a>
            &nbsp;·&nbsp;
            <a href="${escHtml(unsubscribeAllUrl)}" target="_blank" rel="noopener noreferrer" style="color:#94a3b8;text-decoration:underline;">${escHtml(s.unsubAll)}</a>`;

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
  <div style="display:none!important;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escHtml(preheader)}&nbsp;‌‌‌‌</div>
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
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:${BRAND_ORANGE};">${escHtml(followedLabel)}</div>
          <div style="font-size:22px;font-weight:800;color:${WHITE};margin-top:6px;">${escHtml(heroTitle)}</div>
        </td></tr>
${body}${monoCta}

        <tr><td style="background:${BRAND_DARK};padding:20px 28px;color:#94a3b8;font-size:11px;line-height:1.6;" class="section-pad">
          <div>${escHtml(closer)}</div>
          <div style="margin-top:8px;">${escHtml(s.intendedFor(email))}</div>
          <div style="margin-top:8px;">${footerUnsub}
          </div>
          <div style="margin-top:8px;">${escHtml(dataControllerFooterLine(loc))}</div>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  // Plaintext alternative, built from the same section list as the HTML —
  // never regex-stripped from it.
  const textSections = shownSections.flatMap((section) => [
    ...(multi ? [`── ${section.company} — ${s.sectionNew(section.jobs.length)}`] : []),
    ...section.jobs.map((job) => {
      const place = [job.location, job.canton].filter(Boolean).join(', ');
      return `- ${job.title || ''}${place ? ` (${place})` : ''}\n  ${wrapUrl(String(job.url || section.hubUrl))}`;
    }),
    `${s.ctaAll(section.company)}: ${section.hubUrl}`,
    ...(multi ? [`${s.unsubThis(section.company)}: ${section.unsubscribeUrl || ''}`] : []),
    '',
  ]);

  const text = [
    heroTitle,
    '',
    ...textSections,
    closer,
    `${s.manage}: ${manageUrl}`,
    ...(multi ? [] : [`${s.unsubThis(headline.company)}: ${headline.unsubscribeUrl || ''}`]),
    `${s.unsubAll}: ${unsubscribeAllUrl}`,
    s.intendedFor(email),
    '',
    dataControllerFooterLine(loc),
  ].join('\n');

  return { subject, html, text, sections: shownSections };
}
