/**
 * emailEngagementBanners.js — the shared closing suite for editorial and
 * lifecycle emails.
 *
 * The order is intentional and part of the surface contract. Surfaces that
 * already render the "Consigliato per te" first-party service can omit the
 * first card so the automation CTA remains in its original slot exactly once.
 *
 * This module stays inside functions/src/lib/ so Cloud Functions, scripts and
 * the browser-side newsletter preview can render the same bytes. It uses only
 * tables and inline styles. Brand marks use hosted raster/favicon images with
 * visible text labels beside them, so a client that blocks images still shows
 * a complete, usable link.
 */

import { APPLICATION_CONCIERGE_PATH, localizedUrl } from './newsletterUrlPaths.js';

const LOCALES = ['it', 'en', 'de', 'fr'];
export const PREFERRED_SOURCE_URL = 'https://www.google.com/preferences/source?q=frontaliereticino.ch';

// Keep white CTA text above the normal-text contrast threshold in email clients.
const BRAND_ORANGE = '#9a3412';
const BRAND_DARK = '#0f172a';
const TEXT = '#334155';
const BORDER = '#e2e8f0';
const CARD_BG = '#f8fafc';
const ICON_TILE_BG = '#fff7ed';
const GOOGLE_LOGO_URL = 'https://www.google.com/images/branding/googlelogo/1x/googlelogo_color_272x92dp.png';
const SOCIAL_ICON_URLS = Object.freeze({
  linkedin: 'https://www.linkedin.com/favicon.ico',
  instagram: 'https://upload.wikimedia.org/wikipedia/commons/a/a5/Instagram_icon.png',
  tiktok: 'https://www.tiktok.com/favicon.ico',
  telegram: 'https://telegram.org/img/t_logo.png',
  facebook: 'https://www.facebook.com/favicon.ico',
});
const SOCIAL_ICON_KEYS = Object.freeze(['linkedin', 'instagram', 'tiktok', 'facebook']);

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

function socialLogoHtml(profile, size = 20) {
  const iconUrl = SOCIAL_ICON_URLS[profile.key] || '';
  return `<img data-email-logo="${escapeHtml(profile.key)}" src="${escapeHtml(iconUrl)}" alt="${escapeHtml(profile.label)}" width="${size}" height="${size}" style="display:inline-block;width:${size}px;height:${size}px;border:0;vertical-align:middle;">`;
}

function socialLinkHtml(profile) {
  return `<a target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(profile.label)}" href="${escapeHtml(profile.url)}" style="display:inline-block;width:58px;margin:0 8px 8px 0;vertical-align:top;text-align:center;color:${TEXT};text-decoration:none;"><span style="display:block;width:44px;height:44px;margin:0 auto;border:1px solid ${BORDER};border-radius:10px;background:#ffffff;color:${BRAND_DARK};text-align:center;line-height:44px;">${socialLogoHtml(profile)}</span><span style="display:block;margin-top:5px;font-size:11px;line-height:14px;font-weight:700;color:${BRAND_DARK};">${escapeHtml(profile.label)}</span></a>`;
}

function socialIconTile() {
  const profiles = SOCIAL_ICON_KEYS
    .map((key) => SOCIAL_PROFILES.find((profile) => profile.key === key))
    .filter(Boolean);
  const firstRow = profiles.slice(0, 2).map((profile) => `<td align="center" style="padding:3px 2px;">${socialLogoHtml(profile, 14)}</td>`).join('');
  const secondRow = profiles.slice(2, 4).map((profile) => `<td align="center" style="padding:3px 2px;">${socialLogoHtml(profile, 14)}</td>`).join('');
  return `<table role="presentation" width="44" height="44" cellpadding="0" cellspacing="0" border="0" style="width:44px;height:44px;background:${ICON_TILE_BG};color:${BRAND_DARK};border:1px solid ${BORDER};border-radius:10px;"><tr>${firstRow}</tr><tr>${secondRow}</tr></table>`;
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

function cardShell({ background, border, color, content, padding = '18px', bottomPadding = '10px' }) {
  return `<tr><td style="padding:0 0 ${bottomPadding};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${background}" style="width:100%;background:${background};color:${color};border:1px solid ${border};border-radius:14px;"><tr><td style="padding:${padding};color:${color};">${content}</td></tr></table></td></tr>`;
}

function ctaHtml(href, label) {
  return `<a target="_blank" rel="noopener noreferrer" href="${escapeHtml(href)}" style="display:inline-block;background:${BRAND_ORANGE};color:#ffffff;font-size:13px;font-weight:700;text-decoration:none;padding:9px 20px;border-radius:8px;">${escapeHtml(label)}</a>`;
}

function textIconTile(mark) {
  return `<div style="width:44px;height:44px;border-radius:10px;background:${ICON_TILE_BG};border:1px solid ${BORDER};text-align:center;line-height:44px;font-size:18px;font-weight:800;color:${BRAND_ORANGE};">${escapeHtml(mark)}</div>`;
}

function imageIconTile(src, alt, width = 36, height = 24) {
  return `<div style="width:44px;height:44px;border-radius:10px;background:${ICON_TILE_BG};border:1px solid ${BORDER};color:${BRAND_ORANGE};text-align:center;line-height:44px;"><img data-email-logo="google" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" width="${width}" height="${height}" style="display:inline-block;width:${width}px;height:${height}px;max-width:36px;object-fit:contain;vertical-align:middle;border:0;"></div>`;
}

function featureCard({ iconHtml, title, body, ctaHref, ctaLabel }) {
  return cardShell({
    background: CARD_BG,
    border: BORDER,
    color: TEXT,
    content: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td width="56" style="padding:0;vertical-align:top;">${iconHtml}</td><td style="padding:0 0 0 14px;vertical-align:top;"><div style="font-size:15px;font-weight:800;color:${BRAND_DARK};margin:0 0 4px;line-height:1.3;">${escapeHtml(title)}</div><div style="font-size:13px;color:${TEXT};line-height:1.5;margin:0 0 10px;">${escapeHtml(body)}</div>${ctaHtml(ctaHref, ctaLabel)}</td></tr></table>`,
  });
}

/**
 * Render the selected option 1 — editorial cards in a fixed order.
 * `includeAutomation` is false on surfaces whose existing "Consigliato per
 * te" slot already owns the automation CTA.
 * `telegramUrl` is a convenience override for Cloud Functions callers that
 * resolve the public URL from Remote Config asynchronously before rendering.
 * `trailingSlash` defaults to the site's canonical slash-terminated URL
 * convention; callers can disable it only when they explicitly need the
 * legacy bare-path form.
 */
export function renderEmailEngagementBanners({ locale = 'it', socialLinks, telegramUrl, trailingSlash = true, includeAutomation = true } = {}) {
  const lang = normLocale(locale);
  const copy = COPY[lang];
  const links = resolveSocialLinks({
    ...(socialLinks || {}),
    ...(telegramUrl !== undefined ? { telegram: telegramUrl } : {}),
  });
  const automationUrl = maybeTrailingSlash(localizedUrl(APPLICATION_CONCIERGE_PATH, lang), trailingSlash);
  const socialLinksHtml = links.map(socialLinkHtml).join(' ');

  const automation = includeAutomation
    ? featureCard({
        iconHtml: textIconTile('A'),
        title: copy.automationTitle,
        body: copy.automationBody,
        ctaHref: automationUrl,
        ctaLabel: copy.automationCta,
      })
    : '';

  const preferredSource = featureCard({
    iconHtml: imageIconTile(GOOGLE_LOGO_URL, 'Google', 36, 14),
    title: copy.preferredSourceTitle,
    body: copy.preferredSourceBody,
    ctaHref: PREFERRED_SOURCE_URL,
    ctaLabel: copy.preferredSourceCta,
  });

  const social = cardShell({
    background: CARD_BG,
    border: BORDER,
    color: TEXT,
    padding: '18px 18px 14px',
    bottomPadding: '0',
    content: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td width="56" style="padding:0;vertical-align:top;">${socialIconTile()}</td><td style="padding:0 0 0 14px;vertical-align:top;"><div style="font-size:15px;font-weight:800;color:${BRAND_DARK};margin:0 0 4px;line-height:1.3;">${escapeHtml(copy.socialTitle)}</div><div style="font-size:13px;color:${TEXT};line-height:1.5;margin:0;">${escapeHtml(copy.socialBody)}</div></td></tr></table><div style="margin:14px 0 0;font-size:0;line-height:0;">${socialLinksHtml}</div>`,
  });

  return `<tr><td data-email-component="engagement-banners" style="background:#ffffff;color:${TEXT};padding:8px 28px 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#ffffff;color:${TEXT};">${automation}${preferredSource}${social}</table></td></tr>`;
}

/** Plain-text companion for templates that build their own multipart body. */
export function emailEngagementBannersText({ locale = 'it', socialLinks, telegramUrl, trailingSlash = true, includeAutomation = true } = {}) {
  const lang = normLocale(locale);
  const copy = COPY[lang];
  const links = resolveSocialLinks({
    ...(socialLinks || {}),
    ...(telegramUrl !== undefined ? { telegram: telegramUrl } : {}),
  });
  const automationUrl = maybeTrailingSlash(localizedUrl(APPLICATION_CONCIERGE_PATH, lang), trailingSlash);
  return [
    ...(includeAutomation ? [copy.automationTitle, copy.automationBody, `${copy.automationCta}: ${automationUrl}`, ''] : []),
    copy.preferredSourceTitle,
    copy.preferredSourceBody,
    `${copy.preferredSourceCta}: ${PREFERRED_SOURCE_URL}`,
    '',
    copy.socialTitle,
    copy.socialBody,
    ...links.map((profile) => `${profile.label}: ${profile.url}`),
  ].join('\n');
}
