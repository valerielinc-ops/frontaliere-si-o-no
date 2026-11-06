export const DIRECT_EMPLOYER_CHANNEL_FLAG = 'DIRECT_EMPLOYER_CHANNEL_ENABLED';

const DIRECT_EMPLOYER_SEO_PATHS = new Set([
  '/pubblica-offerta-gratuita/',
  '/aziende-candidature-spontanee/',
  '/en/post-free-job/',
  '/en/employers-open-applications/',
  '/de/kostenlose-stelle-veroeffentlichen/',
  '/de/unternehmen-spontanbewerbung/',
  '/fr/publier-offre-gratuite/',
  '/fr/entreprises-candidatures-spontanees/',
]);

function canonicalPath(value: string): string {
  const raw = String(value || '').trim();
  try {
    const parsed = new URL(raw, 'https://frontaliereticino.ch');
    const path = parsed.pathname || '/';
    return path === '/' ? '/' : `${path.replace(/\/+$/u, '')}/`;
  } catch {
    return '/';
  }
}

export function isDirectEmployerSeoPath(value: string): boolean {
  return DIRECT_EMPLOYER_SEO_PATHS.has(canonicalPath(value));
}

/** Build-time mirror of the fail-closed public Remote Config flag. */
export function isDirectEmployerBuildEnabled(env: Record<string, unknown> = {}): boolean {
  const value = env[DIRECT_EMPLOYER_CHANNEL_FLAG] ?? env[`VITE_${DIRECT_EMPLOYER_CHANNEL_FLAG}`];
  return value === true || String(value || '').trim().toLowerCase() === 'true';
}

/** Remove feature routes from a seeded sitemap while the feature is disabled. */
export function filterDirectEmployerSitemapXml(xml: string, enabled: boolean): string {
  if (enabled) return xml;
  return String(xml || '').replace(/<url>[\s\S]*?<\/url>/gu, (block) => {
    const loc = block.match(/<loc>\s*([^<]+?)\s*<\/loc>/u)?.[1] || '';
    return isDirectEmployerSeoPath(loc) ? '' : block;
  });
}
