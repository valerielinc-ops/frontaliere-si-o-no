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
  // ── Banks (matches BankComparison.tsx bank list) ──
  // PostFinance/UBS/Credit Suisse/Fineco/Yuh/Revolut/Wise/Intesa/UniCredit
  // already declared in the currency-exchange section above and reused here
  // via the same slug. New entries below cover banks unique to BankComparison.
  'raiffeisen':         { domain: 'raiffeisen.ch' },
  'neon':               { domain: 'neon-free.ch' },
  'n26':                { domain: 'n26.com' },
  'hype':               { domain: 'hype.it' },
  'bnl':                { domain: 'bnl.it' },
  // ── Telecom — Italian operators ──
  'iliad':              { domain: 'iliad.it', localPath: '/images/providers/iliad.png' },
  'ho-mobile':          { domain: 'ho-mobile.it', localPath: '/images/providers/ho-mobile.png' },
  'vodafone-it':        { domain: 'vodafone.it', localPath: '/images/providers/vodafone-it.png' },
  'tim':                { domain: 'tim.it', localPath: '/images/providers/tim.png' },
  'windtre':            { domain: 'windtre.it', localPath: '/images/providers/windtre.png' },
  'very-mobile':        { domain: 'verymobile.it', localPath: '/images/providers/very-mobile.png' },
  'fastweb-mobile':     { domain: 'fastweb.it', localPath: '/images/providers/fastweb-mobile.png' },
  'spusu-oltreconfine': { domain: 'spusu.it', localPath: '/images/providers/spusu-oltreconfine.png' },
  // ── Telecom — Swiss operators ──
  'swisscom':           { domain: 'swisscom.ch', localPath: '/images/providers/swisscom.png' },
  'salt':               { domain: 'salt.ch', localPath: '/images/providers/salt.png' },
  'salt-travel':        { domain: 'salt.ch', localPath: '/images/providers/salt.png' },
  'salt-swiss-max':     { domain: 'salt.ch', localPath: '/images/providers/salt.png' },
  'sunrise':            { domain: 'sunrise.ch', localPath: '/images/providers/sunrise.png' },
  'yallo':              { domain: 'yallo.ch', localPath: '/images/providers/yallo.png' },
  'wingo':              { domain: 'wingo.ch', localPath: '/images/providers/wingo.png' },
  'aldi-mobile-ch':     { domain: 'aldisuisse.ch', localPath: '/images/providers/aldi-mobile-ch.png' },
  'm-budget-mobile':    { domain: 'm-budget.migros.ch', localPath: '/images/providers/m-budget-mobile.svg' },
  'digitec-connect':    { domain: 'digitec.ch', localPath: '/images/providers/digitec-connect.png' },
};

/**
 * Returns the committed local logo path for a provider slug, or null when none
 * is bundled. We no longer emit a Clearbit CDN URL: Clearbit's logo API is
 * defunct (every request errors) so it only ever degraded to a broken image.
 * `<ProviderLogo>` renders a deterministic coloured-initials badge for a null
 * result — a real visual identity, never the grey globe.
 */
export function getProviderLogoUrl(slug: string): string | null {
  const entry = PROVIDER_LOGOS[slug];
  if (!entry) return null;
  return entry.localPath ?? null;
}

// ── Health insurer logos keyed by domain ────────────────────────────────────
// Downloaded from each insurer's official site (SVG preferred). Domains without
// a bundled asset fall back to the coloured-initials badge in <ProviderLogo>
// (no Clearbit / Google-favicon hop — both only produced a broken grey globe).

export const INSURER_LOGOS: Record<string, string> = {
  'css.ch':            '/images/insurers/css.svg',
  'aquilana.ch':       '/images/insurers/aquilana.png',
  'sumiswalder.ch':    '/images/insurers/sumiswalder.png',
  'concordia.ch':      '/images/insurers/concordia.svg',
  'atupri.ch':         '/images/insurers/atupri.png',
  'groupemutuel.ch':   '/images/insurers/avenir.svg',  // all Groupe Mutuel brands
  'kpt.ch':            '/images/insurers/kpt.svg',
  'oekk.ch':           '/images/insurers/okk.png',
  'curaulta.ch':       '/images/insurers/curaulta.svg',
  'egk.ch':            '/images/insurers/egk.svg',
  'slkk.ch':           '/images/insurers/slkk.svg',
  'sodalis.ch':        '/images/insurers/sodalis.png',
  'kkwaedenswil.ch':   '/images/insurers/wadenswil.png',
  'swica.ch':          '/images/insurers/swica.svg',
  'galenos.ch':        '/images/insurers/galenos.png',
  'rhenusana.ch':      '/images/insurers/rhenusana.svg',
  'sanitas.com':       '/images/insurers/sanitas.png',
  'assura.ch':         '/images/insurers/assura.png',
  'visana.ch':         '/images/insurers/visana.svg',
  'helsana.ch':        '/images/insurers/helsana.svg',
  'sana24.ch':         '/images/insurers/sana24.svg',
};

/** Returns the committed local logo path for a health insurer domain, or null. */
export function getInsurerLogoUrl(domain: string): string | null {
  return INSURER_LOGOS[domain] ?? null;
}
