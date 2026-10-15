import { dataControllerFooterLine } from '../../functions/src/lib/dataControllerIdentity.js';
import { renderJobCard } from '../../services/newsletter/jobCard.mjs';
import { renderRecommendedBlock } from '../../services/newsletter/recommendedBlock.mjs';

const BRAND_ORANGE = '#f97316';
const BRAND_DARK = '#0f172a';
const LIGHT_BG = '#f1f5f9';
const WHITE = '#ffffff';
const MUTED = '#64748b';
const MUTED_ON_DARK = '#94a3b8';

const STRINGS = {
  it: {
    subject: (count) => count === 1 ? 'Hai cliccato «Candidati» su un annuncio' : `Hai cliccato «Candidati» su ${count} annunci`,
    preheader: 'Un promemoria sul tuo click «Candidati», senza presumere l’esito della candidatura.',
    heroTitle: 'Gli annunci su cui hai cliccato «Candidati»',
    heroDesc: 'Controlla sul sito dell’azienda se hai già completato la candidatura o se vuoi riprendere da qui.',
    sectionLabel: '📝 Click su «Candidati»',
    sectionTitle: 'Annunci su cui hai cliccato «Candidati»',
    sectionDesc: 'Il click non prova che la candidatura sia stata inviata o completata.',
    applicationIntentBadge: 'Da verificare',
    newBadge: '✨ NUOVA',
    postedOn: 'Pubblicato il',
    viewJob: 'Apri annuncio →',
    recommendationsTitle: '✨ Offerte simili per te',
    manageCta: 'Gestisci le tue preferenze →',
    manageLink: 'Gestisci i promemoria nel tuo profilo',
    unsubscribe: 'Disiscriviti da questi promemoria',
    footer: (email) => `Ricevi questa email a ${email} perché hai cliccato «Candidati» su Frontaliere Ticino.`,
    closer: 'Un click esprime interesse, non conferma l’invio della candidatura.',
    signature: 'A presto. ☕',
    at: 'presso',
  },
  en: {
    subject: (count) => count === 1 ? 'You clicked “Apply” on one listing' : `You clicked “Apply” on ${count} listings`,
    preheader: 'A reminder about your “Apply” click, without assuming the application outcome.',
    heroTitle: 'Listings where you clicked “Apply”',
    heroDesc: 'Check the employer’s site to see whether you completed the application or want to pick up where you left off.',
    sectionLabel: '📝 Apply clicks',
    sectionTitle: 'Listings where you clicked “Apply”',
    sectionDesc: 'The click does not prove that an application was sent or completed.',
    applicationIntentBadge: 'To check',
    newBadge: '✨ NEW',
    postedOn: 'Posted on',
    viewJob: 'Open listing →',
    recommendationsTitle: '✨ Similar jobs for you',
    manageCta: 'Manage your preferences →',
    manageLink: 'Manage reminders in your profile',
    unsubscribe: 'Unsubscribe from these reminders',
    footer: (email) => `You receive this email at ${email} because you clicked “Apply” on Frontaliere Ticino.`,
    closer: 'A click shows interest; it does not confirm that an application was sent.',
    signature: 'See you soon. ☕',
    at: 'at',
  },
  de: {
    subject: (count) => count === 1 ? 'Sie haben bei einer Stelle auf „Bewerben“ geklickt' : `Sie haben bei ${count} Stellen auf „Bewerben“ geklickt`,
    preheader: 'Eine Erinnerung an Ihren Klick auf „Bewerben“, ohne den Ausgang der Bewerbung vorauszusetzen.',
    heroTitle: 'Stellen, bei denen Sie auf „Bewerben“ geklickt haben',
    heroDesc: 'Prüfen Sie auf der Website des Arbeitgebers, ob Sie die Bewerbung abgeschlossen haben oder weitermachen möchten.',
    sectionLabel: '📝 Klicks auf „Bewerben“',
    sectionTitle: 'Stellen, bei denen Sie auf „Bewerben“ geklickt haben',
    sectionDesc: 'Der Klick beweist nicht, dass eine Bewerbung gesendet oder abgeschlossen wurde.',
    applicationIntentBadge: 'Zu prüfen',
    newBadge: '✨ NEU',
    postedOn: 'Veröffentlicht am',
    viewJob: 'Stelle öffnen →',
    recommendationsTitle: '✨ Ähnliche Stellen für Sie',
    manageCta: 'Einstellungen verwalten →',
    manageLink: 'Erinnerungen in Ihrem Profil verwalten',
    unsubscribe: 'Von diesen Erinnerungen abmelden',
    footer: (email) => `Sie erhalten diese E-Mail an ${email}, weil Sie auf Frontaliere Ticino auf „Bewerben“ geklickt haben.`,
    closer: 'Ein Klick zeigt Interesse; er bestätigt nicht, dass eine Bewerbung gesendet wurde.',
    signature: 'Bis bald. ☕',
    at: 'bei',
  },
  fr: {
    subject: (count) => count === 1 ? 'Vous avez cliqué sur « Postuler » sur une offre' : `Vous avez cliqué sur « Postuler » sur ${count} offres`,
    preheader: 'Un rappel de votre clic sur « Postuler », sans supposer le résultat de la candidature.',
    heroTitle: 'Les offres où vous avez cliqué sur « Postuler »',
    heroDesc: 'Consultez le site de l’employeur pour voir si vous avez terminé la candidature ou si vous souhaitez reprendre.',
    sectionLabel: '📝 Clics sur « Postuler »',
    sectionTitle: 'Offres où vous avez cliqué sur « Postuler »',
    sectionDesc: 'Le clic ne prouve pas qu’une candidature a été envoyée ou terminée.',
    applicationIntentBadge: 'À vérifier',
    newBadge: '✨ NOUVELLE',
    postedOn: 'Publié le',
    viewJob: 'Ouvrir l’offre →',
    recommendationsTitle: '✨ Des offres similaires pour vous',
    manageCta: 'Gérer vos préférences →',
    manageLink: 'Gérer les rappels dans votre profil',
    unsubscribe: 'Se désabonner de ces rappels',
    footer: (email) => `Vous recevez cet e-mail à ${email} car vous avez cliqué sur « Postuler » sur Frontaliere Ticino.`,
    closer: 'Un clic montre un intérêt ; il ne confirme pas l’envoi d’une candidature.',
    signature: 'À bientôt. ☕',
    at: 'chez',
  },
};

export function getApplicationIntentReminderStrings(locale = 'it') {
  return STRINGS[locale] || STRINGS.it;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

/**
 * @param {{locale?: string, applicationIntentEntries?: any[], recommendations?: any[], manageUrl?: string, unsubUrl?: string, email?: string}} [options]
 * @returns {string}
 */
export function buildApplicationIntentReminderEmailHtml({
  locale = 'it',
  applicationIntentEntries = [],
  recommendations = [],
  manageUrl,
  unsubUrl,
  email,
} = {}) {
  const s = getApplicationIntentReminderStrings(locale);
  const sourceCards = applicationIntentEntries
    .map((entry) => renderJobCard(entry, locale, s, { applicationIntent: true }))
    .join('');
  const recommendationCards = recommendations
    .map((entry) => renderJobCard(entry, locale, s))
    .join('');
  const recommendationBlock = recommendations.length
    ? `<tr><td style="padding:20px 0 8px;font-size:16px;font-weight:800;color:${BRAND_DARK};">${escapeHtml(s.recommendationsTitle)}</td></tr>${recommendationCards}`
    : '';
  const sponsoredBlock = renderRecommendedBlock({
    locale,
    interest: 'jobs',
    acquisitionSource: 'application-intent-reminder',
    campaign: 'application-intent-reminder',
  });
  return `<!DOCTYPE html><html lang="${escapeHtml(locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escapeHtml(s.heroTitle)} — Frontaliere Ticino</title><style>body{margin:0;padding:0;background:${LIGHT_BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-text-size-adjust:100%;}table{border-collapse:collapse;}@media only screen and (max-width:620px){.outer-table{width:100%!important;}.section-pad{padding-left:16px!important;padding-right:16px!important;}}</style></head><body>
  <div style="display:none!important;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(s.preheader)}&nbsp;&#8203;&#8203;&#8203;&#8203;</div>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:${LIGHT_BG};"><tr><td align="center"><table class="outer-table" width="620" cellpadding="0" cellspacing="0" style="width:100%;max-width:620px;">
    <tr><td style="background:${BRAND_DARK};padding:14px 28px;"><table width="100%" cellpadding="0" cellspacing="0"><tr><td style="font-size:15px;font-weight:800;color:${WHITE};"><span style="color:${BRAND_ORANGE};">●</span> Frontaliere Ticino</td><td align="right" style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;"><a href="${escapeHtml(manageUrl)}" style="color:${BRAND_ORANGE};text-decoration:none;">${escapeHtml(s.manageCta)}</a></td></tr></table></td></tr>
    <tr><td style="background:${BRAND_DARK};padding:20px 28px 28px;" class="section-pad"><div style="font-size:22px;font-weight:800;color:${WHITE};">${escapeHtml(s.heroTitle)}</div><div style="font-size:13px;color:${MUTED_ON_DARK};margin-top:6px;">${escapeHtml(s.heroDesc)}</div></td></tr>
    <tr><td class="section-pad" style="background:${WHITE};padding:24px 28px 8px;"><div style="font-size:11px;text-transform:uppercase;letter-spacing:2px;color:${BRAND_ORANGE};font-weight:700;">${escapeHtml(s.sectionLabel)}</div><div style="font-size:18px;font-weight:800;color:${BRAND_DARK};">${escapeHtml(s.sectionTitle)}</div><div style="font-size:13px;color:${MUTED};margin:4px 0 0;">${escapeHtml(s.sectionDesc)}</div></td></tr>
    <tr><td class="section-pad" style="background:${WHITE};padding:8px 28px 20px;"><table width="100%" cellpadding="0" cellspacing="0">${sourceCards}${recommendationBlock}<tr><td style="text-align:center;padding-top:14px;"><a href="${escapeHtml(manageUrl)}" style="display:inline-block;background:transparent;border:2px solid ${BRAND_ORANGE};color:${BRAND_ORANGE};font-weight:700;font-size:13px;text-decoration:none;padding:11px 28px;border-radius:8px;">${escapeHtml(s.manageCta)}</a></td></tr></table></td></tr>
    ${sponsoredBlock}
    <tr><td class="section-pad" style="background:${WHITE};padding:0 28px 20px;"><div style="background:#f8fafc;border-radius:12px;padding:18px 20px;text-align:center;"><div style="font-size:14px;color:#334155;line-height:1.5;margin:0 0 8px;">${escapeHtml(s.closer)}</div><div style="font-size:12px;color:${BRAND_ORANGE};font-weight:700;">${escapeHtml(s.signature)}</div></div></td></tr>
    <tr><td style="background:${BRAND_DARK};padding:28px;text-align:center;"><div style="font-size:11px;color:${MUTED_ON_DARK};margin:0 0 14px;line-height:1.5;">${escapeHtml(s.footer(email))}</div><div style="font-size:12px;color:${MUTED_ON_DARK};margin:4px 0;"><a href="${escapeHtml(manageUrl)}" style="color:${BRAND_ORANGE};text-decoration:underline;font-weight:600;">${escapeHtml(s.manageLink)}</a></div><div style="font-size:12px;color:${MUTED_ON_DARK};margin:4px 0;">${escapeHtml(s.unsubscribe)}: <a href="${escapeHtml(unsubUrl)}" style="color:${MUTED_ON_DARK};text-decoration:underline;">${escapeHtml(unsubUrl)}</a></div><div style="font-size:12px;color:${MUTED_ON_DARK};margin-top:12px;">© ${new Date().getFullYear()} Frontaliere Ticino</div><div style="font-size:11px;color:${MUTED_ON_DARK};margin-top:6px;">${escapeHtml(dataControllerFooterLine(locale))}</div></td></tr>
  </table></td></tr></table></body></html>`;
}

/**
 * @param {{locale?: string, applicationIntentEntries?: any[], recommendations?: any[], manageUrl?: string, unsubUrl?: string}} [options]
 * @returns {string}
 */
export function buildApplicationIntentReminderEmailText({
  locale = 'it',
  applicationIntentEntries = [],
  recommendations = [],
  manageUrl,
  unsubUrl,
} = {}) {
  const s = getApplicationIntentReminderStrings(locale);
  const lines = [s.heroTitle, '', s.sectionTitle, s.sectionDesc];
  for (const entry of applicationIntentEntries) lines.push(`- ${entry.title} (${s.at} ${entry.company}): ${entry.url}`);
  if (recommendations.length) {
    lines.push('', s.recommendationsTitle);
    for (const entry of recommendations) lines.push(`- ${entry.title} (${s.at} ${entry.company}): ${entry.url}`);
  }
  lines.push('', `${s.manageLink}: ${manageUrl}`, `${s.unsubscribe}: ${unsubUrl}`, '', s.closer, `© ${new Date().getFullYear()} Frontaliere Ticino`, dataControllerFooterLine(locale));
  return lines.join('\n');
}
