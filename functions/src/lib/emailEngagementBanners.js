/**
 * emailEngagementBanners.js — the shared closing suite for editorial and
 * lifecycle emails.
 *
 * The order is intentional and part of the surface contract:
 *   1. automate the job search;
 *   2. make Frontaliere Ticino a preferred Google source;
 *   3. follow the social channel the reader prefers.
 *
 * This module stays inside functions/src/lib/ so Cloud Functions, scripts and
 * the browser-side newsletter preview can render the same bytes. It uses only
 * tables, inline styles and small inline vector marks: there is no image
 * request to block, and every social mark has a visible text label fallback.
 */

import { APPLICATION_CONCIERGE_PATH, localizedUrl } from './newsletterUrlPaths.js';

const LOCALES = ['it', 'en', 'de', 'fr'];
export const PREFERRED_SOURCE_URL = 'https://www.google.com/preferences/source?q=frontaliereticino.ch';

const BRAND_ORANGE_DARK = '#9a3412';
const TEXT = '#334155';
const MUTED = '#475569';
const BORDER = '#e2e8f0';
const AUTOMATION_BG = '#fff7ed';
const AUTOMATION_BORDER = '#fed7aa';
const GOOGLE_BG = '#ffffff';
const SOCIAL_BG = '#0f172a';
const SOCIAL_BUTTON_BG = '#1e293b';
const SOCIAL_BUTTON_BORDER = '#475569';
const SOCIAL_TEXT = '#f8fafc';
const SOCIAL_MUTED = '#cbd5e1';
const CTA_TEXT = '#ffffff';

const COPY = {
  it: {
    automationTitle: 'Automatizza la tua ricerca di lavoro',
    automationBody: 'Per 30 giorni troviamo posizioni compatibili e prepariamo candidature su misura, senza rinnovo.',
    automationCta: 'Scopri il servizio →',
    preferredSourceTitle: 'Rendici una delle tue fonti preferite su Google',
    preferredSourceBody: 'Su Google puoi scegliere le fonti che vuoi vedere più spesso nei risultati e nelle risposte AI. Un click e ci trovi più facilmente.',
    preferredSourceCta: 'Aggiungi alle fonti preferite →',
    socialTitle: 'Seguici dove preferisci',
    socialBody: 'Offerte, aggiornamenti e strumenti per frontalieri, nel canale che usi di più.',
  },
  en: {
    automationTitle: 'Automate your job search',
    automationBody: 'For 30 days we find compatible positions and prepare tailored applications, with no renewal.',
    automationCta: 'See the service →',
    preferredSourceTitle: 'Make us one of your preferred sources on Google',
    preferredSourceBody: 'Google lets you pick the sources you want to see more often in results and AI answers. One click and we are easier to find.',
    preferredSourceCta: 'Add to preferred sources →',
    socialTitle: 'Follow us where you prefer',
    socialBody: 'Jobs, updates and tools for cross-border workers, on the channel you use most.',
  },
  de: {
    automationTitle: 'Automatisiere deine Jobsuche',
    automationBody: '30 Tage lang finden wir passende Stellen und erstellen Bewerbungen nach Mass – ohne Verlängerung.',
    automationCta: 'Service ansehen →',
    preferredSourceTitle: 'Mach uns zu einer deiner bevorzugten Quellen bei Google',
    preferredSourceBody: 'Bei Google kannst du festlegen, welche Quellen du in den Ergebnissen und in KI-Antworten häufiger sehen willst. Ein Klick, und du findest uns leichter.',
    preferredSourceCta: 'Zu bevorzugten Quellen hinzufügen →',
    socialTitle: 'Folge uns, wo du möchtest',
    socialBody: 'Stellen, Updates und Tools für Grenzgänger – auf dem Kanal, den du am liebsten nutzt.',
  },
  fr: {
    automationTitle: 'Automatise ta recherche d’emploi',
    automationBody: 'Pendant 30 jours, nous trouvons des postes compatibles et préparons des candidatures sur mesure, sans renouvellement.',
    automationCta: 'Découvrir le service →',
    preferredSourceTitle: 'Fais de nous une de tes sources préférées sur Google',
    preferredSourceBody: 'Sur Google, tu peux choisir les sources que tu veux voir plus souvent dans les résultats et les réponses IA. Un clic et on se trouve plus facilement.',
    preferredSourceCta: 'Ajouter aux sources préférées →',
    socialTitle: 'Suis-nous où tu préfères',
    socialBody: 'Offres, actualités et outils pour frontaliers, sur le canal que tu utilises le plus.',
  },
};

const SOCIAL_PROFILES = Object.freeze([
  { key: 'linkedin', label: 'LinkedIn', defaultUrl: 'https://www.linkedin.com/company/frontaliere-ticino' },
  { key: 'instagram', label: 'Instagram', defaultUrl: 'https://www.instagram.com/frontaliereticino/' },
  { key: 'tiktok', label: 'TikTok', defaultUrl: 'https://www.tiktok.com/@frontaliereticino' },
  { key: 'telegram', label: 'Telegram', defaultUrl: '' },
  { key: 'facebook', label: 'Facebook', defaultUrl: 'https://www.facebook.com/frontaliereticino/' },
]);

export const DEFAULT_SOCIAL_LINKS = Object.freeze({
  linkedin: 'https://www.linkedin.com/company/frontaliere-ticino',
  instagram: 'https://www.instagram.com/frontaliereticino/',
  tiktok: 'https://www.tiktok.com/@frontaliereticino',
  telegram: '',
  facebook: 'https://www.facebook.com/frontaliereticino/',
});

function normLocale(raw) {
  const lang = String(raw || 'it').toLowerCase().split(/[-_]/)[0];
  return LOCALES.includes(lang) ? lang : 'it';
}
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function configuredTelegramUrl() {
  // `process` is intentionally guarded: the weekly template is also imported
  // by the Vite newsletter preview, where a Node global is not guaranteed.
  if (typeof process === 'undefined') return '';
  return process.env?.TELEGRAM_CHANNEL_URL || process.env?.VITE_TELEGRAM_CHANNEL_URL || '';
}

function safeSocialUrl(value, key) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return '';
    const allowedHost = {
      linkedin: ['www.linkedin.com', 'linkedin.com'],
      instagram: ['www.instagram.com', 'instagram.com'],
      tiktok: ['www.tiktok.com', 'tiktok.com'],
      telegram: ['t.me'],
      facebook: ['www.facebook.com', 'facebook.com'],
    }[key] || [];
    if (!allowedHost.includes(url.hostname.toLowerCase())) return '';
    if (key === 'telegram') {
      // Keep the email CTA aligned with services/telegramChannel.ts: only a
      // public channel handle is valid, without redirects, query data, or
      // credentials that could turn the optional promotion into a wrong link.
      if (!/^\/[A-Za-z0-9_+-]+\/?$/.test(url.pathname)) return '';
      if (url.search || url.hash || url.username || url.password || url.port) return '';
    }
    return url.toString();
  } catch {
    return '';
  }
}

/**
 * Resolve the public social URLs without ever manufacturing the Telegram link.
 * The Telegram channel is a Remote Config value and remains hidden until the
 * owner has configured a valid public channel URL.
 */
export function resolveSocialLinks(overrides = {}) {
  const configured = {
    ...DEFAULT_SOCIAL_LINKS,
    telegram: configuredTelegramUrl(),
    ...(overrides || {}),
  };
  return SOCIAL_PROFILES
    .map((profile) => ({
      ...profile,
      url: safeSocialUrl(configured[profile.key] || profile.defaultUrl, profile.key),
    }))
    .filter((profile) => profile.url);
}

export function emailEngagementCopy(locale = 'it') {
  return COPY[normLocale(locale)];
}

const SOCIAL_ICONS = {
  linkedin: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style="display:block;width:16px;height:16px"><path fill="currentColor" d="M20.45 20.45h-3.56v-5.57c0-1.33-.03-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.34V8.99h3.42v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.29ZM5.32 7.43a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12ZM3.56 20.45h3.56V8.99H3.56v11.46ZM22.23 0H1.77C.79 0 0 .77 0 1.72v20.56C0 23.23.79 24 1.77 24h20.46C23.21 24 24 23.23 24 22.28V1.72C24 .77 23.21 0 22.23 0Z"/></svg>',
  instagram: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style="display:block;width:16px;height:16px"><rect x="3.5" y="3.5" width="17" height="17" rx="4.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="17.5" cy="6.5" r="1.25" fill="currentColor"/></svg>',
  tiktok: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style="display:block;width:16px;height:16px"><path fill="currentColor" d="M14.2 3h3.1c.3 2.05 1.45 3.45 3.5 4.2v3.15c-1.25-.08-2.42-.45-3.5-1.1v5.5A6.25 6.25 0 1 1 11 8.5v3.35a2.9 2.9 0 1 0 2.9 2.9V3h.3Z"/></svg>',
  telegram: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style="display:block;width:16px;height:16px"><path fill="currentColor" d="m21.6 4.4-3.3 15.5c-.25 1.1-.9 1.35-1.82.84l-5.02-3.7-2.42 2.33c-.27.27-.5.5-1.03.5l.37-5.12 9.32-8.42c.4-.36-.09-.56-.63-.2L5.55 13.3.63 11.76c-1.07-.34-1.1-1.08.22-1.6L20.1 2.7c.9-.33 1.69.2 1.5 1.7Z"/></svg>',
  facebook: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style="display:block;width:16px;height:16px"><path fill="currentColor" d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07c0 6.02 4.39 11 10.13 11.93v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.68.24 2.68.24v2.96h-1.51c-1.49 0-1.96.93-1.96 1.89v2.26h3.33l-.53 3.49h-2.8V24C19.61 23.07 24 18.09 24 12.07Z"/></svg>',
};

function socialLinkHtml(profile) {
  const icon = SOCIAL_ICONS[profile.key] || '';
  return `<a target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(profile.label)}" href="${escapeHtml(profile.url)}" style="display:inline-block;margin:0 4px 6px 0;padding:7px 9px;border:1px solid ${SOCIAL_BUTTON_BORDER};border-radius:7px;color:${SOCIAL_TEXT};background:${SOCIAL_BUTTON_BG};font-size:13px;line-height:16px;font-weight:700;text-decoration:none;white-space:nowrap;"><span style="display:inline-block;width:16px;height:16px;margin-right:5px;vertical-align:-3px;color:${SOCIAL_TEXT};">${icon}</span><span>${escapeHtml(profile.label)}</span></a>`;
}

function maybeTrailingSlash(url, enabled) {
  if (!enabled) return url;
  try {
    const parsed = new URL(url);
    if (!parsed.pathname.endsWith('/')) parsed.pathname = `${parsed.pathname}/`;
    return parsed.toString();
  } catch {
    return url;
  }
}

function cardShell({ background, border, color, content, padding = '17px 19px' }) {
  return `<tr><td style="padding:0 0 10px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${background}" style="width:100%;background:${background};color:${color};border:1px solid ${border};border-radius:12px;"><tr><td style="padding:${padding};color:${color};">${content}</td></tr></table></td></tr>`;
}

function ctaHtml(href, label) {
  return `<a target="_blank" rel="noopener noreferrer" href="${escapeHtml(href)}" style="display:inline-block;background:${BRAND_ORANGE_DARK};color:${CTA_TEXT};font-size:13px;line-height:18px;font-weight:800;text-decoration:none;padding:9px 14px;border-radius:8px;">${escapeHtml(label)}</a>`;
}

/**
 * Render the selected option 1 — three editorial cards in a fixed order.
 * `telegramUrl` is a convenience override for Cloud Functions callers that
 * resolve the public URL from Remote Config asynchronously before rendering.
 * `trailingSlash` defaults to the site's canonical slash-terminated URL
 * convention; callers can disable it only when they explicitly need the
 * legacy bare-path form.
 */
export function renderEmailEngagementBanners({ locale = 'it', socialLinks, telegramUrl, trailingSlash = true } = {}) {
  const lang = normLocale(locale);
  const copy = COPY[lang];
  const links = resolveSocialLinks({
    ...(socialLinks || {}),
    ...(telegramUrl !== undefined ? { telegram: telegramUrl } : {}),
  });
  const automationUrl = maybeTrailingSlash(localizedUrl(APPLICATION_CONCIERGE_PATH, lang), trailingSlash);
  const socialLinksHtml = links.map(socialLinkHtml).join(' ');

  const automation = cardShell({
    background: AUTOMATION_BG,
    border: AUTOMATION_BORDER,
    color: TEXT,
    content: `<div style="font-size:15px;line-height:20px;font-weight:800;color:${BRAND_ORANGE_DARK};">${escapeHtml(copy.automationTitle)}</div><div style="margin:6px 0 12px;font-size:13px;line-height:20px;color:${MUTED};">${escapeHtml(copy.automationBody)}</div>${ctaHtml(automationUrl, copy.automationCta)}`,
  });

  const preferredSource = cardShell({
    background: GOOGLE_BG,
    border: BORDER,
    color: TEXT,
    content: `<div style="font-size:15px;line-height:20px;font-weight:800;color:${TEXT};text-align:center;">${escapeHtml(copy.preferredSourceTitle)}</div><div style="margin:6px 0 12px;font-size:13px;line-height:20px;color:${MUTED};text-align:center;">${escapeHtml(copy.preferredSourceBody)}</div><div style="text-align:center;">${ctaHtml(PREFERRED_SOURCE_URL, copy.preferredSourceCta)}</div>`,
  });

  const social = cardShell({
    background: SOCIAL_BG,
    border: SOCIAL_BG,
    color: SOCIAL_TEXT,
    padding: '17px 19px 11px',
    content: `<div style="font-size:15px;line-height:20px;font-weight:800;color:${SOCIAL_TEXT};">${escapeHtml(copy.socialTitle)}</div><div style="margin:6px 0 12px;font-size:13px;line-height:20px;color:${SOCIAL_MUTED};">${escapeHtml(copy.socialBody)}</div><div style="font-size:0;line-height:0;">${socialLinksHtml}</div>`,
  });

  return `<tr><td data-email-component="engagement-banners" style="background:#ffffff;color:${TEXT};padding:4px 28px 14px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#ffffff;color:${TEXT};">${automation}${preferredSource}${social}</table></td></tr>`;
}

/** Plain-text companion for templates that build their own multipart body. */
export function emailEngagementBannersText({ locale = 'it', socialLinks, telegramUrl, trailingSlash = true } = {}) {
  const lang = normLocale(locale);
  const copy = COPY[lang];
  const links = resolveSocialLinks({
    ...(socialLinks || {}),
    ...(telegramUrl !== undefined ? { telegram: telegramUrl } : {}),
  });
  const automationUrl = maybeTrailingSlash(localizedUrl(APPLICATION_CONCIERGE_PATH, lang), trailingSlash);
  return [
    copy.automationTitle,
    copy.automationBody,
    `${copy.automationCta}: ${automationUrl}`,
    '',
    copy.preferredSourceTitle,
    copy.preferredSourceBody,
    `${copy.preferredSourceCta}: ${PREFERRED_SOURCE_URL}`,
    '',
    copy.socialTitle,
    copy.socialBody,
    ...links.map((profile) => `${profile.label}: ${profile.url}`),
  ].join('\n');
}
