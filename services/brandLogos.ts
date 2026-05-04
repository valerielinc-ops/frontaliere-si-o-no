export interface ProviderLogoEntry {
  domain: string;
  localPath?: string; // /images/providers/{slug}.{ext} — filled by crawl script
}

export const PROVIDER_LOGOS: Record<string, ProviderLogoEntry> = {
  // ── Currency exchange (matches CurrencyExchange.tsx provider list) ──
  'wise':               { domain: 'wise.com' },
  'revolut':            { domain: 'revolut.com' },
  'yuh':                { domain: 'yuh.com' },
  'postfinance':        { domain: 'postfinance.ch' },
  'ubs':                { domain: 'ubs.com' },
  'credit-suisse':      { domain: 'credit-suisse.com' },
  'fineco':             { domain: 'finecobank.com' },
  'intesa-sanpaolo':    { domain: 'intesasanpaolo.com' },
  'credit-agricole-it': { domain: 'credit-agricole.it' },
  'unicredit':          { domain: 'unicredit.it' },
  'banco-bpm':          { domain: 'bancobpm.it' },
  'cambiavalute':       { domain: 'cambiavalute.ch' },
  // ── Telecom — Italian operators ──
  'iliad':              { domain: 'iliad.it' },
  'ho-mobile':          { domain: 'ho-mobile.it' },
  'vodafone-it':        { domain: 'vodafone.it' },
  'tim':                { domain: 'tim.it' },
  'windtre':            { domain: 'windtre.it' },
  'very-mobile':        { domain: 'verymobile.it' },
  'fastweb-mobile':     { domain: 'fastweb.it' },
  // ── Telecom — Swiss operators ──
  'swisscom':           { domain: 'swisscom.ch' },
  'salt':               { domain: 'salt.ch' },
  'sunrise':            { domain: 'sunrise.ch' },
  'yallo':              { domain: 'yallo.ch' },
  'wingo':              { domain: 'wingo.ch' },
  'aldi-mobile-ch':     { domain: 'aldisuisse.ch' },
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
