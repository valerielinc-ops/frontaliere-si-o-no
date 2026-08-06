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
// Split out of the original single `<script\b[^>]*>([\s\S]*?)<\/script\s*>`
// so the body can be inspected by INDEX before any substring is
// materialised. Pairing an open tag with the first following close tag is
// exactly what the lazy `[\s\S]*?` did; an open tag with no close made the
// whole alternative fail, which the caller reproduces by resuming the search
// after that open tag.
const SCRIPT_OPEN_RX = /<script\b[^>]*>/gi;
const SCRIPT_CLOSE_RX = /<\/script\s*>/gi;

export function extractJobPostingFacts(html: string): { company: string; location: string } {
  SCRIPT_OPEN_RX.lastIndex = 0;
  let open: RegExpExecArray | null;
  while ((open = SCRIPT_OPEN_RX.exec(html))) {
    const bodyStart = open.index + open[0].length;
    SCRIPT_CLOSE_RX.lastIndex = bodyStart;
    const close = SCRIPT_CLOSE_RX.exec(html);
    if (!close) break;
    const bodyEnd = close.index;
    SCRIPT_OPEN_RX.lastIndex = close.index + close[0].length;

    // Only a JSON *object* can carry `@type`, and a JSON object literal
    // starts with `{` after optional JSON whitespace (space/tab/LF/CR — the
    // only four the grammar allows). Every other script body reached the
    // `catch`/type-check below and was discarded, so short-circuiting here is
    // behaviour-identical — it just does not pay for the throw, nor for
    // materialising the body.
    //
    // Both savings are large. A soft-landing page carries ~7 <script> blocks
    // and only the two JSON-LD ones are objects; the other five (early-boot,
    // `window.__EXPIRED_JOB_DATA__=…`, gtag, adsense,
    // `window.__STATIC_BODY_HTML__=…`) each raised a SyntaxError, and V8
    // captures a stack trace when it constructs one. The
    // `__EXPIRED_JOB_DATA__` body alone is a multi-KB substring that was
    // allocated only to be thrown away. At 183 445 soft-landings +
    // 110 766 previousSlug bridges per build, this ran ~1.5 M times.
    let k = bodyStart;
    while (k < bodyEnd) {
      const c = html.charCodeAt(k);
      if (c === 32 || c === 9 || c === 10 || c === 13) k += 1;
      else break;
    }
    if (k >= bodyEnd || html.charCodeAt(k) !== 123 /* { */) continue;
    let data: unknown;
    try {
      data = JSON.parse(html.slice(bodyStart, bodyEnd));
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

/**
 * Pre-optimisation implementation, kept executable as the DEFINITION of this
 * module's output: one regex with a capture group, `JSON.parse` on every
 * `<script>` body, `catch` on the ones that are not JSON.
 *
 * Nothing in the build calls this. `tests/seo/soft-landing-thin-shell-equivalence.test.ts`
 * requires it to agree with {@link extractJobPostingFacts} on every fixture
 * and on 1 500 randomised structural mutations — the `{`-precondition and the
 * index-based body scan are only safe for as long as that holds.
 */
export function extractJobPostingFactsReference(html: string): { company: string; location: string } {
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
