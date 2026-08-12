/**
 * daily-brief-template.mjs — the email dress of the "Bollettino del Frontaliere".
 *
 * WHY THIS EXISTS (issue #5415 §2b)
 * ─────────────────────────────────
 * The daily brief shipped inside `buildNewsletter()`, the WEEKLY newsletter's
 * template, which parametrises none of its own dress: the recipient got the
 * weekly masthead, the weekly issue counter (`getIssueNumberFallback`, so two
 * consecutive days carried the same number), the hero subtitle "Ecco cosa
 * succede ai tuoi soldi QUESTA SETTIMANA" over daily numbers, hardcoded
 * placeholder metrics (2.8% / CHF 467), and a `<title>` reading "Frontaliere
 * Weekly". The brief's own paragraphs went into the slot the weekly reserves
 * for its editorial. Only the subject line differed.
 *
 * So this is a SEPARATE template, not a parameter on that one. What it reuses
 * from the weekly channel is the MECHANICS — signed unsubscribe/preferences
 * URLs, the provider cascade, suppression sets, per-user send scheduling — all
 * of which live outside the template. What it deliberately does not reuse is
 * the layout, the palette, the voice, and the issue numbering.
 *
 * SHAPE. Four data blocks, each its own section with its own live-page link
 * (border waits, fuel, exchange rate, jobs), under a masthead that names the
 * bulletin and carries THE EDITION'S date — `brief.dateIso`, never `new Date()`,
 * so a resend or a delayed slot cannot relabel yesterday's numbers as today's.
 * A block the corpus could not measure is simply absent (`available: false`);
 * the sender refuses to send at all below two blocks.
 *
 * NO ISSUE NUMBER. A daily edition is identified by its date. The weekly's
 * fallback counter is exactly the artefact that made two consecutive bulletins
 * look like the same issue.
 *
 * Everything is inline-styled and table-based: this has to survive Gmail,
 * Outlook and Apple Mail, none of which can be relied on for <style> blocks.
 */

import { nlNormLocale, localizedUrl } from '../functions/src/lib/newsletterUrlPaths.js';
// Data-controller identity for the footer (#5675) — see that file's header
// for why the canonical home is functions/src/lib/, not services/.
import { dataControllerFooterLine } from '../functions/src/lib/dataControllerIdentity.js';

const BASE_URL = 'https://frontaliereticino.ch';

/**
 * Deliberately NOT the weekly's palette. The weekly is orange-on-slate
 * (#f97316/#0f172a); the bulletin is a cold early-morning blue, so the two are
 * told apart in the inbox preview before a single word is read.
 */
const INK = '#0b2545';
const INK_SOFT = '#13315c';
const ACCENT = '#0ea5e9';
const PAGE_BG = '#eef2f7';
const CARD_BG = '#ffffff';
const PANEL_BG = '#f4f7fb';
const BORDER = '#d9e2ec';
const TEXT = '#31425a';
const MUTED = '#64748b';
const GOOD = '#16a34a';
const WARN = '#ea580c';

const LOCALES = ['it', 'en', 'de', 'fr'];

const DATE_LOCALE = { it: 'it-IT', en: 'en-GB', de: 'de-DE', fr: 'fr-FR' };

const I18N = {
  it: {
    masthead: 'Bollettino del Frontaliere',
    tagline: 'I numeri di stamattina, misurati da noi.',
    greeting: 'Buongiorno.',
    greetingNamed: 'Buongiorno, {name}.',
    borderTitle: 'Valichi',
    borderWorst: 'Attesa più lunga',
    borderClear: '{n} valichi su {total} senza coda',
    borderCta: 'Traffico ai valichi in tempo reale',
    fuelTitle: 'Benzina',
    fuelCheapest: 'Minimo nei comuni di confine',
    fuelSaving: 'Risparmio su un pieno da 50 litri a {place}',
    fuelCta: 'Prezzi benzina al confine, oggi',
    fxTitle: 'Cambio',
    fxLabel: '1 franco',
    fxFlat: 'stabile sul giorno precedente',
    fxUp: '+{delta} sul giorno precedente',
    fxDown: '{delta} sul giorno precedente',
    fxCta: 'Confronta i servizi di cambio',
    jobsTitle: 'Lavoro',
    jobsYesterday: 'Nuovi annunci ieri',
    jobsActive: '{n} annunci attivi da {companies} aziende',
    jobsCta: 'Cerca lavoro in Ticino e in Svizzera',
    editionCta: 'Leggi il bollettino completo',
    editionNote: 'I numeri qui sopra fotografano il momento della pubblicazione. Le pagine collegate restano aggiornate tutto il giorno.',
    cadenceNote: 'Ricevi il bollettino {cadence}. La frequenza si adatta a quanto lo apri: puoi fissarla o disattivarla dalle tue preferenze.',
    cadenceDaily: 'ogni mattina',
    cadenceEveryN: 'ogni {n} giorni',
    cadenceWeekly: 'una volta a settimana',
    preferences: 'Gestisci le preferenze',
    unsubscribe: 'Disiscriviti',
    footer: 'Bollettino quotidiano di Frontaliere Ticino — dati misurati, non stimati.',
    minutes: 'min',
  },
  en: {
    masthead: 'Cross-border Daily Brief',
    tagline: "This morning's numbers, measured by us.",
    greeting: 'Good morning.',
    greetingNamed: 'Good morning, {name}.',
    borderTitle: 'Border crossings',
    borderWorst: 'Longest wait',
    borderClear: '{n} of {total} crossings queue-free',
    borderCta: 'Live border traffic',
    fuelTitle: 'Fuel',
    fuelCheapest: 'Border-municipality low',
    fuelSaving: 'Saving on a 50-litre tank in {place}',
    fuelCta: "Today's border fuel prices",
    fxTitle: 'Exchange rate',
    fxLabel: '1 franc',
    fxFlat: 'flat on the previous day',
    fxUp: '+{delta} on the previous day',
    fxDown: '{delta} on the previous day',
    fxCta: 'Compare exchange services',
    jobsTitle: 'Jobs',
    jobsYesterday: 'New listings yesterday',
    jobsActive: '{n} active listings from {companies} companies',
    jobsCta: 'Search jobs in Ticino and Switzerland',
    editionCta: 'Read the full brief',
    editionNote: 'The numbers above are a snapshot taken at publication. The linked pages stay live all day.',
    cadenceNote: 'You receive this brief {cadence}. The frequency follows how often you open it — you can pin it or turn it off in your preferences.',
    cadenceDaily: 'every morning',
    cadenceEveryN: 'every {n} days',
    cadenceWeekly: 'once a week',
    preferences: 'Manage preferences',
    unsubscribe: 'Unsubscribe',
    footer: 'Frontaliere Ticino daily brief — measured data, not estimates.',
    minutes: 'min',
  },
  de: {
    masthead: 'Grenzgänger-Tagesbulletin',
    tagline: 'Die Zahlen von heute Morgen, von uns gemessen.',
    greeting: 'Guten Morgen.',
    greetingNamed: 'Guten Morgen, {name}.',
    borderTitle: 'Grenzübergänge',
    borderWorst: 'Längste Wartezeit',
    borderClear: '{n} von {total} Übergängen ohne Warteschlange',
    borderCta: 'Grenzverkehr in Echtzeit',
    fuelTitle: 'Benzin',
    fuelCheapest: 'Tiefstpreis der Grenzgemeinden',
    fuelSaving: 'Ersparnis bei 50 Litern in {place}',
    fuelCta: 'Benzinpreise an der Grenze, heute',
    fxTitle: 'Wechselkurs',
    fxLabel: '1 Franken',
    fxFlat: 'unverändert zum Vortag',
    fxUp: '+{delta} zum Vortag',
    fxDown: '{delta} zum Vortag',
    fxCta: 'Wechseldienste vergleichen',
    jobsTitle: 'Stellen',
    jobsYesterday: 'Neue Inserate gestern',
    jobsActive: '{n} aktive Inserate von {companies} Unternehmen',
    jobsCta: 'Stellen im Tessin und in der Schweiz suchen',
    editionCta: 'Zum vollständigen Bulletin',
    editionNote: 'Die Zahlen oben sind eine Momentaufnahme zum Zeitpunkt der Veröffentlichung. Die verlinkten Seiten bleiben den ganzen Tag aktuell.',
    cadenceNote: 'Sie erhalten dieses Bulletin {cadence}. Die Frequenz richtet sich danach, wie oft Sie es öffnen — in den Einstellungen können Sie sie festlegen oder abschalten.',
    cadenceDaily: 'jeden Morgen',
    cadenceEveryN: 'alle {n} Tage',
    cadenceWeekly: 'einmal pro Woche',
    preferences: 'Einstellungen verwalten',
    unsubscribe: 'Abmelden',
    footer: 'Tagesbulletin von Frontaliere Ticino — gemessene Daten, keine Schätzungen.',
    minutes: 'Min.',
  },
  fr: {
    masthead: 'Bulletin du Frontalier',
    tagline: 'Les chiffres de ce matin, mesurés par nos soins.',
    greeting: 'Bonjour.',
    greetingNamed: 'Bonjour, {name}.',
    borderTitle: 'Passages frontaliers',
    borderWorst: 'Attente la plus longue',
    borderClear: '{n} passages sur {total} sans file',
    borderCta: 'Trafic aux douanes en temps réel',
    fuelTitle: 'Essence',
    fuelCheapest: 'Minimum des communes frontalières',
    fuelSaving: 'Économie sur un plein de 50 litres à {place}',
    fuelCta: "Prix de l'essence à la frontière, aujourd'hui",
    fxTitle: 'Taux de change',
    fxLabel: '1 franc',
    fxFlat: 'stable par rapport à la veille',
    fxUp: '+{delta} par rapport à la veille',
    fxDown: '{delta} par rapport à la veille',
    fxCta: 'Comparer les services de change',
    jobsTitle: 'Emploi',
    jobsYesterday: 'Nouvelles offres hier',
    jobsActive: '{n} offres actives de {companies} entreprises',
    jobsCta: 'Chercher un emploi au Tessin et en Suisse',
    editionCta: 'Lire le bulletin complet',
    editionNote: 'Les chiffres ci-dessus sont un instantané au moment de la publication. Les pages liées restent à jour toute la journée.',
    cadenceNote: 'Vous recevez ce bulletin {cadence}. La fréquence suit la façon dont vous l’ouvrez — vous pouvez la fixer ou la désactiver dans vos préférences.',
    cadenceDaily: 'chaque matin',
    cadenceEveryN: 'tous les {n} jours',
    cadenceWeekly: 'une fois par semaine',
    preferences: 'Gérer les préférences',
    unsubscribe: 'Se désabonner',
    footer: 'Bulletin quotidien de Frontaliere Ticino — des données mesurées, pas estimées.',
    minutes: 'min',
  },
};

/**
 * The live page behind each block, as CANONICAL IT paths — `localizedUrl()`
 * resolves them per locale through LOCALE_PATH_MAP, the same map the weekly
 * newsletter, the onboarding drip and the welcome email already use. Spelling
 * the localized slugs out here would be a fourth copy of the route table.
 *
 * `jobs` points at the Switzerland-wide board, not the Ticino one: the block's
 * figures (`activeJobs`, `yesterdayAdded`) count every canton, so the TI board
 * would open on a shorter list than the number printed above the link. Same
 * reasoning the weekly's own "browse all jobs" CTA follows.
 */
const LIVE_PAGES = {
  border: '/traffico-dogane',
  fuel: '/prezzi-benzina/oggi',
  fx: '/compara-servizi/cambio-franco-euro',
  jobs: '/cerca-lavoro-svizzera',
};

const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const fill = (template, values) =>
  String(template).replace(/\{(\w+)\}/g, (_, key) => (values[key] == null ? '' : String(values[key])));

/**
 * The edition's date, spelled out in the recipient's locale.
 * Parsed as UTC noon so a timezone shift can never move the label to the
 * neighbouring day — the label has to match the edition id.
 */
export function formatEditionDate(dateIso, locale) {
  const date = new Date(`${dateIso}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return dateIso;
  return new Intl.DateTimeFormat(DATE_LOCALE[locale] || 'it-IT', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  }).format(date);
}

/** Localized decimal separator for the numbers in the blocks. */
const num = (value, digits, locale) =>
  new Intl.NumberFormat(DATE_LOCALE[locale] || 'it-IT', {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  }).format(value);

const int = (value, locale) => new Intl.NumberFormat(DATE_LOCALE[locale] || 'it-IT').format(value);

/**
 * The one sentence that tells the recipient why this arrived today and how to
 * change that (issue #5415 §3.7: adaptive cadence is only acceptable with a
 * disclosed, effective opt-out). `tierDays` is the recipient's cadence in days.
 */
export function cadenceSentence(locale, tierDays) {
  const s = I18N[locale] || I18N.it;
  const days = Number(tierDays);
  const cadence = !Number.isFinite(days) || days <= 1
    ? s.cadenceDaily
    : days >= 7 ? s.cadenceWeekly : fill(s.cadenceEveryN, { n: days });
  return fill(s.cadenceNote, { cadence });
}

// ── Section builders ───────────────────────────────────────────────────────

/** One data block: label, the number that matters, a supporting line, a link. */
function blockSection({ title, headline, unit, support, ctaLabel, ctaUrl, tone }) {
  const toneColor = tone === 'warn' ? WARN : tone === 'good' ? GOOD : INK;
  return `
      <tr><td style="padding:0 28px 18px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PANEL_BG};border:1px solid ${BORDER};border-radius:12px">
          <tr><td style="padding:18px 20px 16px">
            <div style="font:600 11px/1.2 Arial,Helvetica,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:${MUTED}">${esc(title)}</div>
            <div style="margin:8px 0 0;font:700 27px/1.15 Georgia,'Times New Roman',serif;color:${toneColor}">${esc(headline)}${unit ? `<span style="font:400 15px/1.2 Arial,Helvetica,sans-serif;color:${MUTED}"> ${esc(unit)}</span>` : ''}</div>
            ${support ? `<div style="margin:6px 0 0;font:400 14px/1.5 Arial,Helvetica,sans-serif;color:${TEXT}">${esc(support)}</div>` : ''}
            <div style="margin:12px 0 0"><a href="${esc(ctaUrl)}" style="font:600 13px/1.2 Arial,Helvetica,sans-serif;color:${ACCENT};text-decoration:none">${esc(ctaLabel)} &rarr;</a></div>
          </td></tr>
        </table>
      </td></tr>`;
}

/**
 * The four blocks, in reading order, skipping whatever the corpus could not
 * measure this morning. Exported so the sender's text/plain part and the
 * cadence gate read the SAME availability the HTML does.
 */
export function briefSections(brief, locale, { utm = '' } = {}) {
  const s = I18N[locale] || I18N.it;
  // `localizedUrl` returns a bare path (no trailing slash) by design — the edge
  // 301s to the slashed form, same as every other lifecycle email.
  const link = (key) => `${localizedUrl(LIVE_PAGES[key], locale)}/${utm}`;
  const sections = [];

  const wait = brief?.blocks?.borderWait;
  if (wait?.available && wait.worst) {
    sections.push({
      key: 'borderWait',
      title: s.borderTitle,
      headline: `${wait.worst.waitMinutes} ${s.minutes}`,
      support: `${wait.worst.name} — ${fill(s.borderClear, { n: wait.zeroWaitCount, total: wait.count })}`,
      ctaLabel: s.borderCta,
      ctaUrl: link('border'),
      tone: wait.worst.waitMinutes >= 10 ? 'warn' : 'good',
      text: `${s.borderTitle}: ${wait.worst.name} ${wait.worst.waitMinutes} ${s.minutes} (${fill(s.borderClear, { n: wait.zeroWaitCount, total: wait.count })})`,
    });
  }

  const fuel = brief?.blocks?.fuel;
  const cheapest = fuel?.cheapestItaly?.[0];
  if (fuel?.available && cheapest) {
    const best = fuel.bestSavings?.[0];
    sections.push({
      key: 'fuel',
      title: s.fuelTitle,
      headline: `${num(cheapest.minPriceEur, 3, locale)} €/L`,
      support: `${s.fuelCheapest}: ${cheapest.municipality}${cheapest.province ? ` (${cheapest.province})` : ''}`
        + (best?.saving50LEur ? ` · ${fill(s.fuelSaving, { place: best.municipality })}: ${num(best.saving50LEur, 2, locale)} €` : ''),
      ctaLabel: s.fuelCta,
      ctaUrl: link('fuel'),
      text: `${s.fuelTitle}: ${num(cheapest.minPriceEur, 3, locale)} €/L — ${cheapest.municipality}`,
    });
  }

  const fx = brief?.blocks?.exchange;
  if (fx?.available && Number.isFinite(fx.rate)) {
    const delta = Number(fx.delta1d ?? 0);
    const move = delta === 0 ? s.fxFlat
      : delta > 0 ? fill(s.fxUp, { delta: num(delta, 4, locale) })
        : fill(s.fxDown, { delta: num(delta, 4, locale) });
    sections.push({
      key: 'exchange',
      title: s.fxTitle,
      headline: `${num(fx.rate, 4, locale)} €`,
      support: `${s.fxLabel} — ${move}`,
      ctaLabel: s.fxCta,
      ctaUrl: link('fx'),
      tone: delta > 0 ? 'good' : delta < 0 ? 'warn' : undefined,
      text: `${s.fxTitle}: ${s.fxLabel} = ${num(fx.rate, 4, locale)} € (${move})`,
    });
  }

  const jobs = brief?.blocks?.jobs;
  if (jobs?.available && Number.isFinite(jobs.yesterdayAdded)) {
    sections.push({
      key: 'jobs',
      title: s.jobsTitle,
      headline: `+${int(jobs.yesterdayAdded, locale)}`,
      support: `${s.jobsYesterday} · ${fill(s.jobsActive, { n: int(jobs.activeJobs ?? 0, locale), companies: int(jobs.activeCompanies ?? 0, locale) })}`,
      ctaLabel: s.jobsCta,
      ctaUrl: link('jobs'),
      text: `${s.jobsTitle}: +${int(jobs.yesterdayAdded, locale)} — ${fill(s.jobsActive, { n: int(jobs.activeJobs ?? 0, locale), companies: int(jobs.activeCompanies ?? 0, locale) })}`,
    });
  }

  return sections;
}

/**
 * Build the bulletin email.
 *
 * @param {object} data
 * @param {'it'|'en'|'de'|'fr'} data.locale
 * @param {object} data.brief             the day's payload (`daily-brief.json`)
 * @param {string} data.editionUrl        the edition's page for this locale
 * @param {string} data.editionTitle      the edition's own title — also the subject
 * @param {string} [data.recipientName]   already sanitized by the caller
 * @param {number} [data.cadenceDays]     the recipient's cadence, for the disclosure line
 * @param {string} data.unsubscribeUrl
 * @param {string} data.preferencesUrl
 * @returns {{ html: string, text: string, preheader: string }}
 */
export function buildDailyBriefEmail(data) {
  const locale = LOCALES.includes(data.locale) ? data.locale : nlNormLocale(data.locale);
  const s = I18N[locale] || I18N.it;
  const brief = data.brief || {};
  const utm = '?utm_source=daily-brief&utm_medium=email&utm_campaign=bollettino';
  const editionUrl = data.editionUrl ? `${data.editionUrl}${data.editionUrl.includes('?') ? '&' : '?'}${utm.slice(1)}` : BASE_URL;
  const editionDate = formatEditionDate(brief.dateIso, locale);
  const sections = briefSections(brief, locale, { utm });
  const greeting = data.recipientName ? fill(s.greetingNamed, { name: data.recipientName }) : s.greeting;
  const cadence = cadenceSentence(locale, data.cadenceDays);

  // The inbox preview line. It carries the date and the headline number, so the
  // bulletin is identifiable before it is opened — the weekly's preheader was
  // the article title.
  const preheader = `${editionDate} · ${sections.map((section) => `${section.title} ${section.headline}`).join(' · ')}`;

  const html = `<!DOCTYPE html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${esc(data.editionTitle || `${s.masthead} — ${editionDate}`)}</title>
</head>
<body style="margin:0;padding:0;background:${PAGE_BG}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAGE_BG}">
  <tr><td align="center" style="padding:24px 12px">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background:${CARD_BG};border-radius:16px;overflow:hidden">

      <tr><td style="background:${INK};padding:22px 28px">
        <div style="font:700 20px/1.2 Georgia,'Times New Roman',serif;color:#ffffff;letter-spacing:.01em">${esc(s.masthead)}</div>
        <div style="margin:6px 0 0;font:400 13px/1.4 Arial,Helvetica,sans-serif;color:#b9cbe4">${esc(editionDate)}</div>
      </td></tr>
      <tr><td style="background:${INK_SOFT};padding:9px 28px;font:400 12px/1.4 Arial,Helvetica,sans-serif;color:#cddcef">${esc(s.tagline)}</td></tr>

      <tr><td style="padding:22px 28px 14px">
        <div style="font:600 16px/1.4 Arial,Helvetica,sans-serif;color:${INK}">${esc(greeting)}</div>
      </td></tr>

${sections.map((section) => blockSection({ ...section, ctaLabel: section.ctaLabel })).join('')}

      <tr><td style="padding:6px 28px 4px">
        <a href="${esc(editionUrl)}" style="display:block;background:${ACCENT};color:#ffffff;text-align:center;padding:14px 18px;border-radius:10px;font:700 15px/1.2 Arial,Helvetica,sans-serif;text-decoration:none">${esc(s.editionCta)}</a>
      </td></tr>
      <tr><td style="padding:12px 28px 22px;font:400 13px/1.6 Arial,Helvetica,sans-serif;color:${MUTED}">${esc(s.editionNote)}</td></tr>

      <tr><td style="border-top:1px solid ${BORDER};padding:18px 28px 22px;background:${PANEL_BG}">
        <div style="font:400 12px/1.6 Arial,Helvetica,sans-serif;color:${MUTED}">${esc(cadence)}</div>
        <div style="margin:10px 0 0;font:400 12px/1.6 Arial,Helvetica,sans-serif;color:${MUTED}">
          <a href="${esc(data.preferencesUrl)}" style="color:${MUTED};text-decoration:underline">${esc(s.preferences)}</a>
          &nbsp;·&nbsp;
          <a href="${esc(data.unsubscribeUrl)}" style="color:${MUTED};text-decoration:underline">${esc(s.unsubscribe)}</a>
        </div>
        <div style="margin:10px 0 0;font:400 11px/1.5 Arial,Helvetica,sans-serif;color:#94a3b8">${esc(s.footer)}</div>
        <div style="margin:4px 0 0;font:400 11px/1.5 Arial,Helvetica,sans-serif;color:#94a3b8">${esc(dataControllerFooterLine(locale))}</div>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;

  const text = [
    `${s.masthead} — ${editionDate}`,
    '',
    greeting,
    '',
    ...sections.map((section) => `- ${section.text}`),
    '',
    `${s.editionCta}: ${editionUrl}`,
    '',
    s.editionNote,
    '',
    cadence,
    `${s.preferences}: ${data.preferencesUrl}`,
    `${s.unsubscribe}: ${data.unsubscribeUrl}`,
    '',
    dataControllerFooterLine(locale),
  ].join('\n');

  return { html, text, preheader };
}

export { I18N as DAILY_BRIEF_STRINGS };
