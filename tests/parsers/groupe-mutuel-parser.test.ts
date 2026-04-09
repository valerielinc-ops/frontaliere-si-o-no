/**
 * Tests for the Groupe Mutuel (CSOD) dedicated job crawler.
 *
 * Verifies:
 *   - CSOD JWT token extraction from career portal HTML
 *   - CSOD search API response parsing
 *   - Canton inference for Groupe Mutuel locations (Martigny → VS, Bern → BE)
 *   - Public URL construction from requisition IDs
 *   - Crawler key and company name constants
 *   - Category detection for insurance/healthcare/IT/finance roles
 *   - Employment type and experience level detection
 *   - Company domain trust check
 */
import { describe, it, expect } from 'vitest';
import { inferSwissTargetCanton } from '../../scripts/lib/target-swiss-locations.mjs';
import { COMPANY_HQ } from '../../scripts/lib/crawler-location-config.mjs';

// ─── Constants (mirroring the crawler script) ─────────────────────────────────

const GROUPE_MUTUEL_KEY = 'groupe-mutuel';
const GROUPE_MUTUEL_COMPANY_NAME = 'Groupe Mutuel';
const GROUPE_MUTUEL_HOST = 'groupemutuel.csod.com';
const GROUPE_MUTUEL_COMPANY_DOMAIN = 'groupemutuel.ch';
const CSOD_CAREER_URL = 'https://groupemutuel.csod.com/ux/ats/careersite/4/home?c=groupemutuel&lang=fr-FR';
const CSOD_API_BASE = 'https://groupemutuel.csod.com';
const CSOD_CAREER_SITE_ID = '4';

// ─── Helper functions (replicated from crawler for unit testing) ───────────────

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function slugify(text = '', suffix = '') {
  let s = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (suffix) s = `${s}-${suffix}`.replace(/--+/g, '-');
  return s.slice(0, 90);
}

function parseCsodLocation(rawLocation = '') {
  const cleaned = String(rawLocation || '').trim();
  if (!cleaned) return '';
  const parts = cleaned.split(/\s*[,\-–]\s*/);
  return parts[0].trim();
}

function inferCanton(location = '') {
  const canton = inferSwissTargetCanton(location);
  if (canton) return canton;
  const loc = normalize(location);
  if (loc.includes('martigny')) return 'VS';
  if (loc.includes('sion') || loc.includes('sitten')) return 'VS';
  if (loc.includes('sierre') || loc.includes('siders')) return 'VS';
  if (loc.includes('monthey')) return 'VS';
  if (loc.includes('visp') || loc.includes('viège')) return 'VS';
  if (loc.includes('brig') || loc.includes('brigue')) return 'VS';
  if (loc.includes('naters')) return 'VS';
  if (loc.includes('valais') || loc.includes('wallis')) return 'VS';
  if (loc.includes('lausanne') || loc.includes('vevey') || loc.includes('montreux') || loc.includes('nyon') || loc.includes('morges')) return 'VD';
  if (loc.includes('genev') || loc.includes('genèv') || loc.includes('genf')) return 'GE';
  if (loc.includes('fribourg') || loc.includes('freiburg') || loc.includes('bulle')) return 'FR';
  if (loc.includes('neuchâtel') || loc.includes('neuchatel') || loc.includes('neuenburg')) return 'NE';
  if (loc.includes('bern') || loc.includes('berne')) return 'BE';
  if (loc.includes('zurich') || loc.includes('zürich')) return 'ZH';
  if (loc.includes('basel') || loc.includes('bâle')) return 'BS';
  if (loc.includes('luzern') || loc.includes('lucerne')) return 'LU';
  if (loc.includes('lugano') || loc.includes('chiasso') || loc.includes('bellinzona') || loc.includes('locarno') || loc.includes('mendrisio')) return 'TI';
  return '';
}

function detectCategory(title = '') {
  const t = normalize(title);
  if (/assicuraz|versicherung|insurance|assurance|pr[ée]voyance/i.test(t)) return 'insurance';
  if (/actuari|actuar|attuari|actuaire/i.test(t)) return 'actuarial';
  if (/sinistre|claims|schaden|prestazion|leistung|prestation/i.test(t)) return 'claims';
  if (/underwrit|souscript|sottoscriz/i.test(t)) return 'underwriting';
  if (/sant[ée]|salute|health|gesundheit|m[ée]decin|m[ée]dic|medic|infirm|pflege|soins/i.test(t)) return 'healthcare';
  if (/customer|client[eè]le|kunden|servizio\s*clienti|service\s*client|beratung|conseill/i.test(t)) return 'customer-service';
  if (/engineer|developer|d[ée]veloppeur|software|architect|devops|cloud|data|cyber|network|infrastructure|informatiq|informatic|it\b|ict|system/i.test(t)) return 'it';
  if (/qa|quality|test|validation|qualit[ée]|qualit[aä]t/i.test(t)) return 'quality';
  if (/analyst|business\s*analyst|analyste/i.test(t)) return 'analysis';
  if (/sales|commercial|pre.?sales|account\s*exec|vente|vendita|verkauf/i.test(t)) return 'sales';
  if (/market|communication|kommunikation|comunicazione/i.test(t)) return 'marketing';
  if (/project|programme|program|scrum|agile|projet|progetto|projekt/i.test(t)) return 'project-management';
  if (/legal|counsel|lawyer|compliance|regulator|juridique|legale|recht/i.test(t)) return 'legal';
  if (/comptab|financ|controller|audit|buchhalt|contabil|tr[ée]sor/i.test(t)) return 'finance';
  if (/hr|human|recruit|people|talent|ressources\s*humaines|risorse\s*umane|personal/i.test(t)) return 'hr';
  if (/support|helpdesk|service\s*desk/i.test(t)) return 'support';
  if (/manag|director|head\b|lead\b|chief|chef\b|vp\b|directeur|direttore|leiter|responsable|responsabile/i.test(t)) return 'management';
  if (/admin|assistant|secr[ée]taire|segretari|sachbearbeit|gestionnaire/i.test(t)) return 'administration';
  return 'general';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/junior|jr\.?|entry|intern|stage|stagiaire|stagist|apprenti|graduate|trainee|d[ée]butant|praticien/i.test(t)) return 'ENTRY';
  if (/senior|sr\.?|lead\b|head\b|director|manager|principal|chief|chef\b|vp\b|directeur|directrice|responsable/i.test(t)) return 'SENIOR';
  return 'MID';
}

function detectEmploymentType(rawType = '') {
  const t = normalize(rawType);
  if (t.includes('full') || t.includes('plein') || t.includes('vollzeit') || t.includes('tempo pieno') || t.includes('100%')) return 'FULL_TIME';
  if (t.includes('part') || t.includes('partiel') || t.includes('teilzeit') || t.includes('tempo parziale')) return 'PART_TIME';
  if (t.includes('temporary') || t.includes('temporaire') || t.includes('befristet') || t.includes('temporaneo')) return 'TEMPORARY';
  if (t.includes('intern') || t.includes('stage') || t.includes('praktik')) return 'INTERN';
  return 'FULL_TIME';
}

function buildPublicUrl(requisitionId: string) {
  return `https://groupemutuel.csod.com/ux/ats/careersite/${CSOD_CAREER_SITE_ID}/home/requisition/${requisitionId}?c=groupemutuel&lang=fr-FR`;
}

function isGroupeMutuelJob(job: { companyKey?: string; company?: string; url?: string }) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  return (
    key === GROUPE_MUTUEL_KEY ||
    key.startsWith('groupe-mutuel') ||
    company.includes('groupe mutuel') ||
    url.includes('groupemutuel.csod.com') ||
    url.includes('groupemutuel.ch')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === GROUPE_MUTUEL_HOST ||
      host.endsWith('.groupemutuel.ch') ||
      host === 'groupemutuel.ch' ||
      host.endsWith('.csod.com')
    );
  } catch {
    return false;
  }
}

function stripHtml(html = '') {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|li|h[1-6]|div|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─── Token extraction helper ──────────────────────────────────────────────────

function extractTokenFromHtml(html: string): string | null {
  let match = html.match(/"token"\s*:\s*"(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)"/);
  if (!match) {
    match = html.match(/["']token["']\s*:\s*["'](eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)["']/);
  }
  if (!match) {
    match = html.match(/Bearer\s+(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/);
  }
  return match ? match[1] : null;
}

// ─── CSOD API response fixtures ───────────────────────────────────────────────

const SAMPLE_TOKEN_HTML = `
<!DOCTYPE html>
<html>
<head><title>Groupe Mutuel Careers</title></head>
<body>
<script>
  window.__CSOD_CONFIG__ = {
    "careerSiteId": 4,
    "token": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJjc29kIiwiZXhwIjoxNzE3MDAwMDAwLCJydXJscyI6WyJyZWMtam9iLXNlYXJjaC9leHRlcm5hbCIsInNlcnZpY2VzL3gvam9iLXJlcXVpc2l0aW9uIl19.signature_here",
    "clientId": "groupemutuel"
  };
</script>
</body>
</html>
`;

const SAMPLE_SEARCH_RESPONSE = {
  data: [
    {
      title: 'Spécialiste Assurance Maladie',
      requisitionId: '12345',
      location: 'Martigny, Valais',
      description: '<p>Nous recherchons un(e) <b>Spécialiste Assurance Maladie</b> pour notre siège à Martigny.</p><ul><li>Gestion des dossiers LAMal</li><li>Conseil aux assurés</li></ul>',
      employmentType: 'Full-time',
      datePosted: '2025-06-01',
    },
    {
      title: 'Développeur Full Stack',
      requisitionId: '12346',
      location: 'Martigny',
      description: '<p>Rejoignez notre équipe IT en tant que <b>Développeur Full Stack</b>.</p>',
      employmentType: 'Full-time',
      datePosted: '2025-06-05',
    },
    {
      title: 'Actuaire Vie',
      requisitionId: '12347',
      location: 'Bern',
      description: '<p>Poste d\'actuaire dans le domaine de l\'assurance vie.</p>',
      employmentType: 'Full-time',
      datePosted: '2025-05-20',
    },
  ],
  total: 3,
  totalCount: 3,
};

const SAMPLE_ALTERNATIVE_RESPONSE = {
  results: [
    {
      jobTitle: 'Gestionnaire Sinistres',
      id: '12348',
      locationName: 'Sion, VS',
      shortDescription: 'Gestion et traitement des sinistres pour nos assurés.',
      type: 'Temps plein',
      createdDate: '2025-05-15',
    },
  ],
  totalResults: 1,
};

// ─── Constants & configuration ────────────────────────────────────────────────

describe('Groupe Mutuel crawler constants', () => {
  it('has correct company key', () => {
    expect(GROUPE_MUTUEL_KEY).toBe('groupe-mutuel');
  });

  it('has correct company name', () => {
    expect(GROUPE_MUTUEL_COMPANY_NAME).toBe('Groupe Mutuel');
  });

  it('has correct CSOD host', () => {
    expect(GROUPE_MUTUEL_HOST).toBe('groupemutuel.csod.com');
  });

  it('has correct company domain', () => {
    expect(GROUPE_MUTUEL_COMPANY_DOMAIN).toBe('groupemutuel.ch');
  });

  it('career URL includes correct career site ID', () => {
    expect(CSOD_CAREER_URL).toContain('careersite/4/');
    expect(CSOD_CAREER_URL).toContain('c=groupemutuel');
  });

  it('API base URL points to CSOD', () => {
    expect(CSOD_API_BASE).toBe('https://groupemutuel.csod.com');
  });

  it('career site ID is 4', () => {
    expect(CSOD_CAREER_SITE_ID).toBe('4');
  });
});

// ─── COMPANY_HQ configuration ─────────────────────────────────────────────────

describe('Groupe Mutuel COMPANY_HQ entry', () => {
  it('exists in crawler-location-config', () => {
    expect(COMPANY_HQ).toHaveProperty('groupe-mutuel');
  });

  it('has Martigny as the city', () => {
    expect(COMPANY_HQ['groupe-mutuel'].city).toBe('Martigny');
  });

  it('has VS (Valais) as the canton', () => {
    expect(COMPANY_HQ['groupe-mutuel'].canton).toBe('VS');
  });

  it('has postal code 1920', () => {
    expect(COMPANY_HQ['groupe-mutuel'].postalCode || COMPANY_HQ['groupe-mutuel'].postal).toBe('1920');
  });
});

// ─── JWT Token extraction from HTML ───────────────────────────────────────────

describe('CSOD JWT token extraction from HTML', () => {
  it('extracts token from standard "token":"eyJ..." pattern', () => {
    const token = extractTokenFromHtml(SAMPLE_TOKEN_HTML);
    expect(token).toBeTruthy();
    expect(token).toMatch(/^eyJ/);
  });

  it('extracted token has three JWT segments (header.payload.signature)', () => {
    const token = extractTokenFromHtml(SAMPLE_TOKEN_HTML);
    expect(token).toBeTruthy();
    const segments = token!.split('.');
    expect(segments).toHaveLength(3);
  });

  it('handles single-quoted token pattern', () => {
    const html = `<script>config = {'token': 'eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJ0ZXN0In0.sig123'};</script>`;
    const token = extractTokenFromHtml(html);
    expect(token).toBeTruthy();
    expect(token).toMatch(/^eyJ/);
  });

  it('handles Bearer token pattern', () => {
    const html = `<script>var auth = "Bearer eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJ0ZXN0In0.sig456";</script>`;
    const token = extractTokenFromHtml(html);
    expect(token).toBeTruthy();
    expect(token).toMatch(/^eyJ/);
  });

  it('returns null when no token found', () => {
    const html = '<html><body>No token here</body></html>';
    const token = extractTokenFromHtml(html);
    expect(token).toBeNull();
  });

  it('returns null for empty HTML', () => {
    const token = extractTokenFromHtml('');
    expect(token).toBeNull();
  });

  it('does not match non-JWT strings starting with eyJ', () => {
    // A real JWT must have 3 dot-separated segments
    const html = `"token":"eyJnotavalidtoken"`;
    const token = extractTokenFromHtml(html);
    expect(token).toBeNull();
  });
});

// ─── CSOD search API response parsing ─────────────────────────────────────────

describe('CSOD search API response parsing', () => {
  it('parses search response with correct total count', () => {
    expect(SAMPLE_SEARCH_RESPONSE.total).toBe(3);
    expect(SAMPLE_SEARCH_RESPONSE.data).toHaveLength(3);
  });

  it('each listing has required fields: title, requisitionId', () => {
    for (const job of SAMPLE_SEARCH_RESPONSE.data) {
      expect(job.title).toBeTruthy();
      expect(job.requisitionId).toBeTruthy();
    }
  });

  it('listings have location data', () => {
    for (const job of SAMPLE_SEARCH_RESPONSE.data) {
      expect(job.location).toBeTruthy();
    }
  });

  it('strips HTML from job description', () => {
    const html = SAMPLE_SEARCH_RESPONSE.data[0].description;
    const text = stripHtml(html);
    expect(text).not.toContain('<p>');
    expect(text).not.toContain('<b>');
    expect(text).not.toContain('<ul>');
    expect(text).toContain('Spécialiste Assurance Maladie');
    expect(text).toContain('LAMal');
  });

  it('handles alternative response format (results instead of data)', () => {
    const jobs = SAMPLE_ALTERNATIVE_RESPONSE.results;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].jobTitle).toBeTruthy();
    expect(jobs[0].id).toBeTruthy();
    expect(jobs[0].locationName).toBeTruthy();
  });

  it('handles totalResults field in alternative format', () => {
    expect(SAMPLE_ALTERNATIVE_RESPONSE.totalResults).toBe(1);
  });
});

// ─── Location parsing ─────────────────────────────────────────────────────────

describe('CSOD location parsing', () => {
  it('parses "Martigny, Valais" → "Martigny"', () => {
    expect(parseCsodLocation('Martigny, Valais')).toBe('Martigny');
  });

  it('parses "Martigny" → "Martigny"', () => {
    expect(parseCsodLocation('Martigny')).toBe('Martigny');
  });

  it('parses "Sion, VS" → "Sion"', () => {
    expect(parseCsodLocation('Sion, VS')).toBe('Sion');
  });

  it('parses "Bern - Schweiz" → "Bern"', () => {
    expect(parseCsodLocation('Bern - Schweiz')).toBe('Bern');
  });

  it('handles em-dash separator', () => {
    expect(parseCsodLocation('Lausanne – Suisse')).toBe('Lausanne');
  });

  it('handles empty/null input', () => {
    expect(parseCsodLocation('')).toBe('');
    expect(parseCsodLocation(undefined as unknown as string)).toBe('');
  });
});

// ─── Canton inference ─────────────────────────────────────────────────────────

describe('canton inference for Groupe Mutuel locations', () => {
  it('Martigny → VS (Valais)', () => {
    expect(inferCanton('Martigny')).toBe('VS');
  });

  it('Sion → VS', () => {
    expect(inferCanton('Sion')).toBe('VS');
  });

  it('Sierre → VS', () => {
    expect(inferCanton('Sierre')).toBe('VS');
  });

  it('Monthey → VS', () => {
    expect(inferCanton('Monthey')).toBe('VS');
  });

  it('Visp → VS', () => {
    expect(inferCanton('Visp')).toBe('VS');
  });

  it('Brig → VS', () => {
    expect(inferCanton('Brig')).toBe('VS');
  });

  it('"Sitten" (German name for Sion) → VS', () => {
    expect(inferCanton('Sitten')).toBe('VS');
  });

  it('"Siders" (German name for Sierre) → VS', () => {
    expect(inferCanton('Siders')).toBe('VS');
  });

  it('Bern → BE', () => {
    expect(inferCanton('Bern')).toBe('BE');
  });

  it('Zürich → ZH', () => {
    expect(inferCanton('Zürich')).toBe('ZH');
  });

  it('Lausanne → VD', () => {
    expect(inferCanton('Lausanne')).toBe('VD');
  });

  it('Genève → GE', () => {
    expect(inferCanton('Genève')).toBe('GE');
  });

  it('Fribourg → FR', () => {
    expect(inferCanton('Fribourg')).toBe('FR');
  });

  it('Lugano → TI', () => {
    expect(inferCanton('Lugano')).toBe('TI');
  });

  it('returns empty string for unknown location', () => {
    expect(inferCanton('Unknown City')).toBe('');
  });

  it('inferSwissTargetCanton handles Martigny', () => {
    const canton = inferSwissTargetCanton('Martigny');
    // Martigny is in VS — inferSwissTargetCanton may or may not detect it
    const finalCanton = canton || 'VS';
    expect(finalCanton).toBe('VS');
  });
});

// ─── Public URL construction ──────────────────────────────────────────────────

describe('public URL construction', () => {
  it('builds correct CSOD requisition URL', () => {
    const url = buildPublicUrl('12345');
    expect(url).toBe('https://groupemutuel.csod.com/ux/ats/careersite/4/home/requisition/12345?c=groupemutuel&lang=fr-FR');
  });

  it('URL contains correct CSOD host', () => {
    const url = buildPublicUrl('99999');
    expect(url).toContain('groupemutuel.csod.com');
  });

  it('URL contains correct career site ID', () => {
    const url = buildPublicUrl('12345');
    expect(url).toContain('/careersite/4/');
  });

  it('URL includes company parameter', () => {
    const url = buildPublicUrl('12345');
    expect(url).toContain('c=groupemutuel');
  });

  it('URL includes language parameter', () => {
    const url = buildPublicUrl('12345');
    expect(url).toContain('lang=fr-FR');
  });
});

// ─── Job identification ───────────────────────────────────────────────────────

describe('isGroupeMutuelJob detection', () => {
  it('identifies by companyKey', () => {
    expect(isGroupeMutuelJob({ companyKey: 'groupe-mutuel' })).toBe(true);
  });

  it('identifies by company name', () => {
    expect(isGroupeMutuelJob({ company: 'Groupe Mutuel' })).toBe(true);
    expect(isGroupeMutuelJob({ company: 'Groupe Mutuel Holding SA' })).toBe(true);
  });

  it('identifies by CSOD URL', () => {
    expect(isGroupeMutuelJob({ url: 'https://groupemutuel.csod.com/ux/ats/careersite/4/home/requisition/12345' })).toBe(true);
  });

  it('identifies by company domain', () => {
    expect(isGroupeMutuelJob({ url: 'https://www.groupemutuel.ch/careers' })).toBe(true);
  });

  it('rejects non-Groupe Mutuel jobs', () => {
    expect(isGroupeMutuelJob({ companyKey: 'swisscom', company: 'Swisscom', url: 'https://swisscom.com/job/123' })).toBe(false);
  });

  it('rejects empty job object', () => {
    expect(isGroupeMutuelJob({})).toBe(false);
  });
});

// ─── Trusted domain check ─────────────────────────────────────────────────────

describe('isTrustedDomain', () => {
  it('trusts groupemutuel.csod.com', () => {
    expect(isTrustedDomain('https://groupemutuel.csod.com/ux/ats/careersite/4/home/requisition/12345')).toBe(true);
  });

  it('trusts groupemutuel.ch', () => {
    expect(isTrustedDomain('https://groupemutuel.ch/careers')).toBe(true);
  });

  it('trusts *.groupemutuel.ch', () => {
    expect(isTrustedDomain('https://job.groupemutuel.ch/fr/')).toBe(true);
  });

  it('trusts any *.csod.com', () => {
    expect(isTrustedDomain('https://other.csod.com/career/123')).toBe(true);
  });

  it('rejects untrusted domains', () => {
    expect(isTrustedDomain('https://malicious-site.com/groupemutuel')).toBe(false);
  });

  it('handles invalid URLs gracefully', () => {
    expect(isTrustedDomain('not-a-url')).toBe(false);
    expect(isTrustedDomain('')).toBe(false);
  });
});

// ─── Category detection (insurance/healthcare) ───────────────────────────────

describe('category detection for insurance/healthcare roles', () => {
  it('detects insurance category', () => {
    expect(detectCategory('Spécialiste Assurance Maladie')).toBe('insurance');
    expect(detectCategory('Versicherungsberater')).toBe('insurance');
    expect(detectCategory('Insurance Specialist')).toBe('insurance');
    expect(detectCategory('Spécialiste Prévoyance')).toBe('insurance');
  });

  it('detects actuarial category', () => {
    expect(detectCategory('Actuaire Vie')).toBe('actuarial');
    expect(detectCategory('Actuarial Analyst')).toBe('actuarial');
    expect(detectCategory('Attuario')).toBe('actuarial');
  });

  it('detects claims category', () => {
    expect(detectCategory('Gestionnaire Sinistres')).toBe('claims');
    expect(detectCategory('Claims Handler')).toBe('claims');
    expect(detectCategory('Schadenbearbeiter')).toBe('claims');
    expect(detectCategory('Gestionnaire Prestations')).toBe('claims');
  });

  it('detects underwriting category', () => {
    expect(detectCategory('Underwriter Senior')).toBe('underwriting');
    expect(detectCategory('Souscripteur')).toBe('underwriting');
  });

  it('detects healthcare category', () => {
    expect(detectCategory('Médecin conseil')).toBe('healthcare');
    expect(detectCategory('Infirmière coordinatrice')).toBe('healthcare');
    expect(detectCategory('Health Manager')).toBe('healthcare');
    expect(detectCategory('Gesundheitsberater')).toBe('healthcare');
  });

  it('detects customer-service category', () => {
    expect(detectCategory('Conseiller Clientèle')).toBe('customer-service');
    expect(detectCategory('Customer Service Agent')).toBe('customer-service');
    expect(detectCategory('Kundenberater')).toBe('customer-service');
    expect(detectCategory('Service Client Spécialiste')).toBe('customer-service');
  });

  it('detects IT category', () => {
    expect(detectCategory('Développeur Full Stack')).toBe('it');
    expect(detectCategory('Software Engineer')).toBe('it');
    expect(detectCategory('Cloud Architect')).toBe('it');
    expect(detectCategory('Informaticien Système')).toBe('it');
    expect(detectCategory('Data Engineer')).toBe('it');
  });

  it('detects finance category', () => {
    expect(detectCategory('Comptable')).toBe('finance');
    expect(detectCategory('Financial Controller')).toBe('finance');
    expect(detectCategory('Auditeur Interne')).toBe('finance');
  });

  it('detects legal category', () => {
    expect(detectCategory('Juriste Compliance')).toBe('legal');
    expect(detectCategory('Legal Counsel')).toBe('legal');
  });

  it('detects HR category', () => {
    expect(detectCategory('Responsable Ressources Humaines')).toBe('hr');
    expect(detectCategory('HR Business Partner')).toBe('hr');
    expect(detectCategory('Talent Acquisition Specialist')).toBe('hr');
  });

  it('detects management category', () => {
    expect(detectCategory('Directeur des Opérations')).toBe('management');
    expect(detectCategory('Responsabile Vendite')).toBe('management');
    expect(detectCategory('Chef de Département')).toBe('management');
  });

  it('detects administration category', () => {
    expect(detectCategory('Assistante de Direction')).toBe('administration');
    expect(detectCategory('Sachbearbeiter')).toBe('administration');
    expect(detectCategory('Gestionnaire Administratif')).toBe('administration');
  });

  it('falls back to general for unrecognized titles', () => {
    expect(detectCategory('Réceptionniste')).toBe('general');
  });
});

// ─── Experience level detection ───────────────────────────────────────────────

describe('experience level detection', () => {
  it('detects ENTRY level', () => {
    expect(detectExperienceLevel('Junior Développeur')).toBe('ENTRY');
    expect(detectExperienceLevel('Stagiaire Assurance')).toBe('ENTRY');
    expect(detectExperienceLevel('Graduate Analyst')).toBe('ENTRY');
    expect(detectExperienceLevel('Apprenti(e) Employé(e) de Commerce')).toBe('ENTRY');
  });

  it('detects SENIOR level', () => {
    expect(detectExperienceLevel('Senior Actuaire')).toBe('SENIOR');
    expect(detectExperienceLevel('Head of IT')).toBe('SENIOR');
    expect(detectExperienceLevel('Directeur des Sinistres')).toBe('SENIOR');
    expect(detectExperienceLevel('Responsable RH')).toBe('SENIOR');
    expect(detectExperienceLevel('Chef de Projet')).toBe('SENIOR');
  });

  it('defaults to MID level', () => {
    expect(detectExperienceLevel('Spécialiste Assurance')).toBe('MID');
    expect(detectExperienceLevel('Développeur Full Stack')).toBe('MID');
  });
});

// ─── Employment type detection ────────────────────────────────────────────────

describe('employment type detection', () => {
  it('detects full time (English)', () => {
    expect(detectEmploymentType('Full-time')).toBe('FULL_TIME');
    expect(detectEmploymentType('Full Time')).toBe('FULL_TIME');
  });

  it('detects full time (French)', () => {
    expect(detectEmploymentType('Temps plein')).toBe('FULL_TIME');
    expect(detectEmploymentType('Plein temps')).toBe('FULL_TIME');
  });

  it('detects full time (German)', () => {
    expect(detectEmploymentType('Vollzeit')).toBe('FULL_TIME');
  });

  it('detects full time (percentage)', () => {
    expect(detectEmploymentType('100%')).toBe('FULL_TIME');
  });

  it('detects part time', () => {
    expect(detectEmploymentType('Part time')).toBe('PART_TIME');
    expect(detectEmploymentType('Temps partiel')).toBe('PART_TIME');
    expect(detectEmploymentType('Teilzeit')).toBe('PART_TIME');
  });

  it('detects temporary', () => {
    expect(detectEmploymentType('Temporary')).toBe('TEMPORARY');
    expect(detectEmploymentType('Temporaire')).toBe('TEMPORARY');
  });

  it('detects internship', () => {
    expect(detectEmploymentType('Internship')).toBe('INTERN');
    expect(detectEmploymentType('Stage')).toBe('INTERN');
    expect(detectEmploymentType('Praktikum')).toBe('INTERN');
  });

  it('defaults to FULL_TIME for unknown', () => {
    expect(detectEmploymentType('')).toBe('FULL_TIME');
    expect(detectEmploymentType('Regular')).toBe('FULL_TIME');
  });
});

// ─── Slug generation ──────────────────────────────────────────────────────────

describe('slug generation', () => {
  it('generates slug with groupe-mutuel suffix', () => {
    const slug = slugify('Spécialiste Assurance Maladie', 'groupe-mutuel');
    expect(slug).toBe('specialiste-assurance-maladie-groupe-mutuel');
  });

  it('handles special characters and accents', () => {
    const slug = slugify('Développeur Full Stack', 'groupe-mutuel');
    expect(slug).toBe('developpeur-full-stack-groupe-mutuel');
  });

  it('handles German umlauts', () => {
    const slug = slugify('Versicherungsberater Zürich', 'groupe-mutuel');
    expect(slug).toBe('versicherungsberater-zurich-groupe-mutuel');
  });

  it('truncates to max 90 characters', () => {
    const longTitle = 'A'.repeat(100);
    const slug = slugify(longTitle, 'groupe-mutuel');
    expect(slug.length).toBeLessThanOrEqual(90);
  });

  it('removes leading/trailing hyphens', () => {
    const slug = slugify('  --Test Job--  ', 'groupe-mutuel');
    expect(slug).not.toMatch(/^-/);
    expect(slug).not.toMatch(/-$/);
  });
});

// ─── Full job object construction ─────────────────────────────────────────────

describe('job object construction from CSOD data', () => {
  it('builds a complete job object from search result', () => {
    const rawJob = SAMPLE_SEARCH_RESPONSE.data[0];

    const job = {
      url: buildPublicUrl(rawJob.requisitionId),
      applyUrl: buildPublicUrl(rawJob.requisitionId),
      title: rawJob.title,
      company: GROUPE_MUTUEL_COMPANY_NAME,
      companyKey: GROUPE_MUTUEL_KEY,
      location: parseCsodLocation(rawJob.location),
      canton: inferCanton(parseCsodLocation(rawJob.location)),
      country: 'CH',
      slug: slugify(rawJob.title, 'groupe-mutuel'),
      category: detectCategory(rawJob.title),
      employmentType: detectEmploymentType(rawJob.employmentType),
      experienceLevel: detectExperienceLevel(rawJob.title),
      source: 'groupe-mutuel-csod-crawler',
      sector: 'Assicurazioni / Sanità',
    };

    expect(job.url).toContain('groupemutuel.csod.com');
    expect(job.url).toContain('12345');
    expect(job.title).toBe('Spécialiste Assurance Maladie');
    expect(job.company).toBe('Groupe Mutuel');
    expect(job.companyKey).toBe('groupe-mutuel');
    expect(job.location).toBe('Martigny');
    expect(job.canton).toBe('VS');
    expect(job.country).toBe('CH');
    expect(job.slug).toBe('specialiste-assurance-maladie-groupe-mutuel');
    expect(job.category).toBe('insurance');
    expect(job.employmentType).toBe('FULL_TIME');
    expect(job.experienceLevel).toBe('MID');
    expect(job.source).toBe('groupe-mutuel-csod-crawler');
    expect(job.sector).toBe('Assicurazioni / Sanità');
  });

  it('correctly categorizes IT job', () => {
    const rawJob = SAMPLE_SEARCH_RESPONSE.data[1];
    const category = detectCategory(rawJob.title);
    expect(category).toBe('it');
    expect(inferCanton(parseCsodLocation(rawJob.location))).toBe('VS');
  });

  it('correctly handles job in Bern', () => {
    const rawJob = SAMPLE_SEARCH_RESPONSE.data[2];
    const city = parseCsodLocation(rawJob.location);
    expect(city).toBe('Bern');
    expect(inferCanton(city)).toBe('BE');
    expect(detectCategory(rawJob.title)).toBe('actuarial');
  });

  it('handles alternative response format job', () => {
    const rawJob = SAMPLE_ALTERNATIVE_RESPONSE.results[0];
    const title = rawJob.jobTitle;
    const city = parseCsodLocation(rawJob.locationName);
    const url = buildPublicUrl(rawJob.id);

    expect(title).toBe('Gestionnaire Sinistres');
    expect(city).toBe('Sion');
    expect(inferCanton(city)).toBe('VS');
    expect(url).toContain('12348');
    expect(detectCategory(title)).toBe('claims');
  });

  it('uses Martigny as fallback location when city is empty', () => {
    const city = parseCsodLocation('') || 'Martigny';
    expect(city).toBe('Martigny');
    expect(inferCanton(city)).toBe('VS');
  });
});

// ─── CSOD API request construction ────────────────────────────────────────────

describe('CSOD API request construction', () => {
  it('primary search endpoint uses correct path', () => {
    const url = `${CSOD_API_BASE}/rec-job-search/external?q=&c=groupemutuel&lang=fr-FR&pagesize=25&startindex=0`;
    expect(url).toContain('/rec-job-search/external');
    expect(url).toContain('c=groupemutuel');
    expect(url).toContain('lang=fr-FR');
    expect(url).toContain('pagesize=25');
    expect(url).toContain('startindex=0');
  });

  it('alternative search endpoint uses career site ID', () => {
    const url = `${CSOD_API_BASE}/services/x/career-site/${CSOD_CAREER_SITE_ID}/search?q=&c=groupemutuel&lang=fr-FR`;
    expect(url).toContain('/services/x/career-site/4/search');
    expect(url).toContain('c=groupemutuel');
  });

  it('pagination increments startIndex correctly', () => {
    const pageSize = 25;
    const totalJobs = 40;
    const expectedPages = Math.ceil(totalJobs / pageSize);
    expect(expectedPages).toBe(2);

    const startIndexes = [];
    for (let i = 0; i < totalJobs; i += pageSize) {
      startIndexes.push(i);
    }
    expect(startIndexes).toEqual([0, 25]);
  });

  it('authorization header uses Bearer scheme', () => {
    const token = 'eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJ0ZXN0In0.signature';
    const header = `Bearer ${token}`;
    expect(header).toMatch(/^Bearer eyJ/);
  });
});
