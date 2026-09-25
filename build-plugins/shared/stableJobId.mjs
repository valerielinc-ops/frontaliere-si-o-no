// Stable identity of a source job: its id, else its slug.
//
// Split out of incrementalManifest.mjs because the job renderer uses it as a
// memo key (the related-jobs pool), so it is a render input and must stay in
// the jobs SEO emitter fingerprint, while the rest of incrementalManifest.mjs
// (manifest I/O and the reuse digest) is kept out of it — see
// JOBS_SEO_FINGERPRINT_INERT_MODULES in incrementalHtmlReuse.mjs.
export function stableJobId(job) {
  return String(job?.id ?? job?.slug ?? '');
}
