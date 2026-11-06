import { createHash } from 'node:crypto';

import { SOCIAL_UTM_SOURCE_BY_CHANNEL } from './social-channel-attribution.mjs';
import { withUtm } from './social-post-utils.mjs';

export const SOCIAL_REDIRECT_ORIGIN = 'https://frontaliereticino.ch';
export const SOCIAL_REDIRECT_PATH_PREFIX = '/social/r/';
export const SOCIAL_HUB_PATH_BY_LOCALE = Object.freeze({
  it: '/social/',
  en: '/en/social/',
  de: '/de/social/',
  fr: '/fr/social/',
});
export const SOCIAL_BIO_LINK_CHANNELS = Object.freeze([
  'instagram', 'tiktok', 'facebook', 'linkedin', 'telegram', 'threads', 'youtube',
]);
const REDIRECTABLE_SOURCES = new Set([
  SOCIAL_UTM_SOURCE_BY_CHANNEL.facebook,
  SOCIAL_UTM_SOURCE_BY_CHANNEL.instagram,
  SOCIAL_UTM_SOURCE_BY_CHANNEL.linkedin,
  SOCIAL_UTM_SOURCE_BY_CHANNEL.reddit,
  SOCIAL_UTM_SOURCE_BY_CHANNEL.telegram,
  SOCIAL_UTM_SOURCE_BY_CHANNEL.tiktok,
  SOCIAL_UTM_SOURCE_BY_CHANNEL.threads,
  SOCIAL_UTM_SOURCE_BY_CHANNEL.youtubeShorts,
]);

function validAttribution({ source, medium, campaign, content }) {
  return REDIRECTABLE_SOURCES.has(String(source || ''))
    && medium === 'social'
    && /^[a-z][a-z0-9_]{1,63}$/u.test(String(campaign || ''))
    && String(content || '').length <= 256
    && !/[\u0000-\u001f\u007f]/u.test(String(content || ''));
}

function cleanDestination(url) {
  let destination;
  try {
    destination = new URL(String(url || ''));
  } catch {
    return null;
  }
  if (destination.origin !== SOCIAL_REDIRECT_ORIGIN
    || destination.username || destination.password
    || (destination.pathname !== '/' && !destination.pathname.endsWith('/'))) return null;
  for (const key of [...destination.searchParams.keys()]) {
    if (key.toLowerCase().startsWith('utm_')) destination.searchParams.delete(key);
  }
  return `${destination.pathname}${destination.search}${destination.hash}`;
}

export function socialRedirectKey({ target, source, medium = 'social', campaign, content = '' } = {}) {
  const identity = { version: 1, target, source, medium, campaign, content };
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 20);
}

/** Create a stable, first-party redirect for a clickable social destination. */
export function socialRedirectUrl(url, attribution = {}) {
  const target = cleanDestination(url);
  const values = {
    source: String(attribution.source || ''),
    medium: String(attribution.medium || 'social'),
    campaign: String(attribution.campaign || ''),
    content: String(attribution.content || ''),
  };
  if (!target || !validAttribution(values)) return String(url || '');
  const key = socialRedirectKey({ target, ...values });
  const redirect = new URL(`${SOCIAL_REDIRECT_PATH_PREFIX}${key}/`, SOCIAL_REDIRECT_ORIGIN);
  redirect.searchParams.set('to', target);
  redirect.searchParams.set('utm_source', values.source);
  redirect.searchParams.set('utm_medium', values.medium);
  redirect.searchParams.set('utm_campaign', values.campaign);
  redirect.searchParams.set('utm_content', values.content);
  return redirect.toString();
}

/** Stable channel-level profile link; it deliberately does not claim post attribution. */
export function socialBioUrl(source, locale = 'it') {
  const normalizedSource = String(source || '');
  const path = SOCIAL_HUB_PATH_BY_LOCALE[locale];
  if (!path || !SOCIAL_BIO_LINK_CHANNELS.includes(normalizedSource)) return '';
  return socialRedirectUrl(`${SOCIAL_REDIRECT_ORIGIN}${path}`, {
    source: normalizedSource,
    medium: 'social',
    campaign: `${normalizedSource}_bio`,
    content: 'profile',
  });
}

/** Use a first-party redirect for site links and retain direct UTMs elsewhere. */
export function attributedSocialLink(url, attribution = {}) {
  const redirect = socialRedirectUrl(url, attribution);
  return redirect !== String(url || '') ? redirect : withUtm(url, attribution);
}
