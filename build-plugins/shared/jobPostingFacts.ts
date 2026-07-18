// jobPostingFacts.ts
//
// Shared helper for the thin-shell builders that operate on a single real
// job's full HTML (softLandingThinShell.ts, bridgeThinShell.ts) — both
// preserve HEAD verbatim (see each file's own header comment), which
// includes the page's own JobPosting JSON-LD (AGENTS.md non-negotiable #3:
// every job page emits `hiringOrganization.name` + `jobLocation` in every
// locale). Extracting the same two fields from the same script shape in
// two files would be exactly the "regex/constant duplicated across ≥2
// files" case the repo's sibling-pattern rule calls out — centralised
// here instead so drift between the two copies is impossible by
// construction.

/**
 * Pull `hiringOrganization.name` / `jobLocation.address.addressLocality`
 * out of the page's own JobPosting JSON-LD. Deliberately parses each
 * `<script>` block and checks `@type` rather than matching label text in
 * the discarded body: for soft-landings that label text is only present
 * in the constructed fallback description, NOT when a real
 * `jobDescription` was available, so label-text extraction would silently
 * miss a large share of pages. The JSON-LD is the one place this data is
 * guaranteed present whenever a JobPosting schema was emitted at all.
 */
export function extractJobPostingFacts(html: string): { company: string; location: string } {
  const scriptRx = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = scriptRx.exec(html))) {
    let data: unknown;
    try {
      data = JSON.parse(m[1]);
    } catch {
      continue;
    }
    if (data && typeof data === 'object' && (data as { '@type'?: string })['@type'] === 'JobPosting') {
      const jp = data as {
        hiringOrganization?: { name?: string };
        jobLocation?: { address?: { addressLocality?: string } };
      };
      return {
        company: jp.hiringOrganization?.name || '',
        location: jp.jobLocation?.address?.addressLocality || '',
      };
    }
  }
  return { company: '', location: '' };
}
