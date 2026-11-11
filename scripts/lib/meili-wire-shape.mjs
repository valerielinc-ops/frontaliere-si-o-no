/**
 * Meilisearch Wire-Shape Cache Generator
 * Converte un annuncio di lavoro nella forma wire-shape compatta (100% dei campi della card).
 * Questo elimina qualsiasi query di idratazione verso Firestore/Postgres a tempo di ricerca,
 * consentendo risposte in 2–5 ms direttamente da Meilisearch.
 */

export function buildMeiliJobWireDocument(job) {
  if (!job) return null;

  const rawDesc = job.description || job.descriptionHtml || '';
  const excerpt = String(rawDesc)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000);

  const companyName = (value) => typeof value === 'string' ? value.trim() : '';
  const rawCompany = companyName(job.company)
    || companyName(job.company?.name)
    || companyName(job.hiringOrganization)
    || companyName(job.hiringOrganization?.name)
    || 'Azienda Svizzera';
  const companySlug = (typeof job.companySlug === 'string' && job.companySlug.trim())
    || rawCompany.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  const id = String(job.id || job._id || job.slug || '');
  if (!id) return null;

  const postedTs = job.publishedAt
    ? Math.floor(new Date(job.publishedAt).getTime() / 1000)
    : Math.floor(Date.now() / 1000);

  return {
    id,
    slug: job.slug || id,
    title: job.title || '',
    company: rawCompany,
    company_slug: companySlug,
    location: job.location || 'Svizzera',
    canton: job.canton || null,
    salary_min: typeof job.salaryMin === 'number' ? job.salaryMin : null,
    salary_max: typeof job.salaryMax === 'number' ? job.salaryMax : null,
    salary_currency: job.salaryCurrency || 'CHF',
    posted_ts: Number.isNaN(postedTs) ? Math.floor(Date.now() / 1000) : postedTs,
    skills: Array.isArray(job.skills) ? job.skills : [],
    role_fingerprint: job.roleFingerprint || '',
    has_copies: Boolean(job.copies && job.copies.length > 0),
    copies_count: Array.isArray(job.copies) ? job.copies.length : 0,
    description_excerpt: excerpt
  };
}
