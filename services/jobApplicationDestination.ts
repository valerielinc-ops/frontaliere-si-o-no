export interface JobApplicationDestinationJob {
  companyKey?: string;
  company?: string;
  url?: string;
  applyUrl?: string;
}

const KNOWN_DEAD_DESTINATION_HOSTS = new Set([
  'fa-eqai-saasfaprod1.fa.ocs.oraclecloud.com',
  'iaadtu.fa.ocs.oraclecloud.com',
  'iaadtu.fa.ocs.oraclecloud.eu',
  'ejwl.fa.us2.oraclecloud.com',
]);

const EMPLOYER_CAREERS_FALLBACKS: Record<string, string> = {
  'efg-international': 'https://www.efginternational.com/us/about/careers',
  ubp: 'https://www.ubp.com/en/about-us/careers/experienced-professionals',
};

function hostOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isOracleCandidateUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    return (host.endsWith('.oraclecloud.com') || host.endsWith('.oraclecloud.eu'))
      && parsed.pathname.includes('/hcmUI/CandidateExperience/');
  } catch {
    return false;
  }
}

export function isKnownDeadJobDestination(rawUrl = ''): boolean {
  return KNOWN_DEAD_DESTINATION_HOSTS.has(hostOf(rawUrl));
}

function employerFallback(job: JobApplicationDestinationJob): string {
  const key = String(job.companyKey || '').trim().toLowerCase();
  if (EMPLOYER_CAREERS_FALLBACKS[key]) return EMPLOYER_CAREERS_FALLBACKS[key];

  const company = String(job.company || '').trim().toLowerCase();
  if (company.includes('efg international')) return EMPLOYER_CAREERS_FALLBACKS['efg-international'];
  if (company.includes('union bancaire privée')) return EMPLOYER_CAREERS_FALLBACKS.ubp;
  return '';
}

function isRetiredKnownEmployerOracleUrl(rawUrl: string, job: JobApplicationDestinationJob): boolean {
  if (!isOracleCandidateUrl(rawUrl)) return false;
  const key = String(job.companyKey || '').trim().toLowerCase();
  const company = String(job.company || '').trim().toLowerCase();
  return key.includes('efg')
    || key === 'ubp'
    || key.includes('marriott')
    || company.includes('efg international')
    || company.includes('union bancaire privée')
    || company.includes('marriott');
}

/**
 * Select the URL used by an application CTA.
 *
 * Crawler records retain their original `url` for provenance, but a handful
 * of Oracle tenants have been retired while their employer detail pages are
 * still valid. Prefer the live employer detail URL, or the explicit careers
 * fallback for EFG/UBP, instead of emitting a known dead ATS destination.
 */
export function resolveJobApplicationUrl(
  job: JobApplicationDestinationJob = {},
  fallbackUrl = '',
): string {
  const applyUrl = String(job.applyUrl || '').trim();
  const sourceUrl = String(job.url || '').trim();
  const candidate = applyUrl || sourceUrl || String(fallbackUrl || '').trim();
  const isDeadDestination = (url: string): boolean =>
    isKnownDeadJobDestination(url) || isRetiredKnownEmployerOracleUrl(url, job);

  if (!isDeadDestination(candidate)) return candidate;

  if (sourceUrl && !isDeadDestination(sourceUrl)) return sourceUrl;
  return employerFallback(job) || String(fallbackUrl || '').trim();
}
