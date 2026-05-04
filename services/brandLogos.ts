export interface ProviderLogoEntry {
  domain: string;
  localPath?: string; // /images/providers/{slug}.{ext} — filled by crawl script
}

export const PROVIDER_LOGOS: Record<string, ProviderLogoEntry> = {
  // ── Currency exchange (matches CurrencyExchange.tsx provider list) ──
  'wise':               { domain: 'wise.com', localPath: '/images/providers/wise.png' },
  'revolut':            { domain: 'revolut.com', localPath: '/images/providers/revolut.png' },
  'yuh':                { domain: 'yuh.com', localPath: '/images/providers/yuh.png' },
  'postfinance':        { domain: 'postfinance.ch', localPath: '/images/providers/postfinance.png' },
  'ubs':                { domain: 'ubs.com', localPath: '/images/providers/ubs.png' },
  'credit-suisse':      { domain: 'credit-suisse.com', localPath: '/images/providers/credit-suisse.png' },
  'fineco':             { domain: 'finecobank.com', localPath: '/images/providers/fineco.png' },
  'intesa-sanpaolo':    { domain: 'intesasanpaolo.com' },
  'credit-agricole-it': { domain: 'credit-agricole.it', localPath: '/images/providers/credit-agricole-it.png' },
  'unicredit':          { domain: 'unicredit.it', localPath: '/images/providers/unicredit.png' },
  'banco-bpm':          { domain: 'bancobpm.it', localPath: '/images/providers/banco-bpm.png' },
  'cambiavalute':       { domain: 'cambiavalute.ch', localPath: '/images/providers/cambiavalute.png' },
  // ── Telecom — Italian operators ──
  'iliad':              { domain: 'iliad.it', localPath: '/images/providers/iliad.png' },
  'ho-mobile':          { domain: 'ho-mobile.it', localPath: '/images/providers/ho-mobile.png' },
  'vodafone-it':        { domain: 'vodafone.it', localPath: '/images/providers/vodafone-it.png' },
  'tim':                { domain: 'tim.it', localPath: '/images/providers/tim.png' },
  'windtre':            { domain: 'windtre.it', localPath: '/images/providers/windtre.png' },
  'very-mobile':        { domain: 'verymobile.it', localPath: '/images/providers/very-mobile.png' },
  'fastweb-mobile':     { domain: 'fastweb.it', localPath: '/images/providers/fastweb-mobile.png' },
  // ── Telecom — Swiss operators ──
  'swisscom':           { domain: 'swisscom.ch', localPath: '/images/providers/swisscom.png' },
  'salt':               { domain: 'salt.ch', localPath: '/images/providers/salt.png' },
  'sunrise':            { domain: 'sunrise.ch', localPath: '/images/providers/sunrise.png' },
  'yallo':              { domain: 'yallo.ch', localPath: '/images/providers/yallo.png' },
  'wingo':              { domain: 'wingo.ch', localPath: '/images/providers/wingo.png' },
  'aldi-mobile-ch':     { domain: 'aldisuisse.ch', localPath: '/images/providers/aldi-mobile-ch.png' },
};

/**
 * Returns localPath if the logo was already downloaded, otherwise the Clearbit CDN URL.
 * Returns null for unknown slugs (component falls back to COMPANY_LOGO_PLACEHOLDER).
 */
export function getProviderLogoUrl(slug: string): string | null {
  const entry = PROVIDER_LOGOS[slug];
  if (!entry) return null;
  if (entry.localPath) return entry.localPath;
  return `https://logo.clearbit.com/${entry.domain}`;
}
