/**
 * Behavior-preserving consolidation guard for the three job URL-key variants.
 *
 * extractStableJobId (merge), assemblerIdentity's URL branch (assemble), and
 * normalizeIdentityUrl (identity) were three separate URL normalizations that
 * diverged in subtle ways. They were consolidated into scripts/lib/job-url-key.mjs
 * (mergeUrlKey / assembleUrlKey / identityUrlKey). These are PERSISTED dedup/merge
 * keys — this test pins each variant's output byte-for-byte so the consolidation
 * (and any future change) cannot silently re-key existing jobs.
 */
import { describe, it, expect } from 'vitest';
import { mergeUrlKey, assembleUrlKey, identityUrlKey, lowerStripTrailingSlash, workdayReqFromLeaf } from '../scripts/lib/job-url-key.mjs';
import { extractStableJobId } from '../scripts/lib/job-match-key.mjs';
import { buildStableJobIdentity } from '../scripts/lib/job-identity.mjs';

const GALENICA = 'https://www.galenica.com/it/jobs/#job.id=12345';

describe('mergeUrlKey (crawl-time merge key — was extractStableJobId)', () => {
  it('extracts a UUID across vendor slug renames', () => {
    const a = 'https://jobs.pwc.ch/job-vacancies/old-title/0441e237-ebd9-4263-9fe5-e21facbd03ba';
    const b = 'https://jobs.pwc.ch/job-vacancies/renamed/0441e237-ebd9-4263-9fe5-e21facbd03ba';
    expect(mergeUrlKey(a)).toBe('uuid:0441e237-ebd9-4263-9fe5-e21facbd03ba');
    expect(mergeUrlKey(a)).toBe(mergeUrlKey(b));
  });
  it('falls back to long numeric id', () => {
    expect(mergeUrlKey('https://example.com/jobs/123456/old')).toBe('num:123456');
  });
  it('falls back to long hex token', () => {
    expect(mergeUrlKey('https://example.com/jobs/abcdef0123/old')).toBe('hex:abcdef0123');
  });
  it('falls back to normalized full URL', () => {
    expect(mergeUrlKey('https://example.com/jobs/only-a-slug')).toBe('url:https://example.com/jobs/only-a-slug');
  });
  it('decodes &amp; before keying', () => {
    expect(mergeUrlKey('https://example.com/jobs/only-a-slug?a=1&amp;b=2')).toBe('url:https://example.com/jobs/only-a-slug?a=1&b=2');
  });
  it('normalizes trailing slash + case', () => {
    expect(mergeUrlKey('https://Example.com/Path/')).toBe(mergeUrlKey('https://example.com/path'));
  });
  it('returns empty string for empty input', () => {
    expect(mergeUrlKey('')).toBe('');
    expect(mergeUrlKey(undefined as unknown as string)).toBe('');
  });
});

describe('mergeUrlKey PageExecutive requisition rule (#6785)', () => {
  const first = 'https://www.pageexecutive.com/job-detail/head-legal/ref/jn-082026-7087025';
  const second = 'https://www.pageexecutive.com/job-detail/chief-operating-officer/ref/jn-082026-7089682';

  it('uses the final requisition, not the shared MMYYYY publication tag', () => {
    expect(mergeUrlKey(first)).toBe('num:7087025');
    expect(mergeUrlKey(second)).toBe('num:7089682');
    expect(mergeUrlKey(first)).not.toBe(mergeUrlKey(second));
  });

  it('survives a PageExecutive title-slug rename', () => {
    const renamed = 'https://www.pageexecutive.com/job-detail/renamed-role/ref/jn-082026-7087025';
    expect(mergeUrlKey(renamed)).toBe(mergeUrlKey(first));
  });

  it('does not alter other hosts or non-canonical PageExecutive paths', () => {
    expect(mergeUrlKey('https://example.com/job-detail/head-legal/ref/jn-082026-7087025'))
      .toBe('num:082026');
    expect(mergeUrlKey('https://www.pageexecutive.com/jobs/ref/jn-082026-7087025'))
      .toBe('num:082026');
    expect(mergeUrlKey('https://www.pageexecutive.com/job-detail/head-legal/ref/jn-132026-7087025'))
      .toBe('num:132026');
    expect(mergeUrlKey('https://example.com/jobs/123456/old')).toBe('num:123456');
  });
});

describe('mergeUrlKey Workday requisition rule (Rule W — slug-drift class)', () => {
  // Workday URLs are `…/job/<Location>/<Title>_<req>`; the title is freely
  // re-slugged by the vendor, so the requisition (everything after the first
  // underscore in the leaf) is the only rename-stable token. Keying on the whole
  // title-bearing leaf fragmented the merge on a title rename → old slug orphaned
  // (no previousSlug captured → noindex soft-landing). Observed: Swiss Life R11696.
  const SWISS_LIFE = 'https://swisslife.wd3.myworkdayjobs.com/en-US/Swiss_Life_Career_Site/job/Sion/Conseiller-en-immobilier--f-h-d-----Agence-gnrale-Sion-Valais-romand--Rgion-Sion---Sierre-_R11696';
  it('extracts the requisition id and survives a title rename', () => {
    const renamed = 'https://swisslife.wd3.myworkdayjobs.com/de-DE/Swiss_Life_Career_Site/job/Sion/Immobilienberater--w-m-d-_R11696';
    expect(mergeUrlKey(SWISS_LIFE)).toBe('req:swisslife.wd3.myworkdayjobs.com:r11696');
    expect(mergeUrlKey(SWISS_LIFE)).toBe(mergeUrlKey(renamed));
  });
  it('extracts every vendor requisition format (after-first-underscore), host-prefixed', () => {
    // R / JR / SJR — the FULL host prefixes the req so two tenants sharing a
    // requisition id never collide (mirrors extractJobIdentityFromUrl full-host).
    expect(mergeUrlKey('https://novartis.wd3.myworkdayjobs.com/en/job/Basel/Some-Title_JR123456')).toBe('req:novartis.wd3.myworkdayjobs.com:jr123456');
    expect(mergeUrlKey('https://x.wd5.myworkdayjobs.com/job/Loc/Title_SJR98765')).toBe('req:x.wd5.myworkdayjobs.com:sjr98765');
    // pure-numeric req (Abbott) — previously `num:`, now uniformly `req:`
    expect(mergeUrlKey('https://abbott.wd5.myworkdayjobs.com/en-US/abbottcareers/job/CH/Cloud-Architect_31138417')).toBe('req:abbott.wd5.myworkdayjobs.com:31138417');
    // dash-prefixed forms the old regex missed (REQ-, R-, J-)
    expect(mergeUrlKey('https://x.wd3.myworkdayjobs.com/job/L/Solution-Consultant_REQ-16005')).toBe('req:x.wd3.myworkdayjobs.com:req-16005');
    expect(mergeUrlKey('https://x.wd3.myworkdayjobs.com/job/L/Apprendistato-afc_R-0002527')).toBe('req:x.wd3.myworkdayjobs.com:r-0002527');
    // internal-underscore req (R26_173)
    expect(mergeUrlKey('https://x.wd3.myworkdayjobs.com/job/L/Operateur_R26_173')).toBe('req:x.wd3.myworkdayjobs.com:r26_173');
  });
  it('keeps the -N re-posting suffix distinct (two postings of the same req)', () => {
    expect(mergeUrlKey('https://swisslife.wd3.myworkdayjobs.com/job/Sion/Title_R11696-1')).toBe('req:swisslife.wd3.myworkdayjobs.com:r11696-1');
    expect(mergeUrlKey('https://swisslife.wd3.myworkdayjobs.com/job/Sion/Title_R11696'))
      .not.toBe(mergeUrlKey('https://swisslife.wd3.myworkdayjobs.com/job/Sion/Title_R11696-1'));
  });
  it('different Workday tenants sharing a requisition id key distinctly (cross-tenant safety)', () => {
    // Two distinct employers both happen to use requisition `R11696`. The full-host
    // prefix keeps their merge keys separate so a hypothetical multi-tenant match
    // set never collapses them onto one job.
    const swisslife = 'https://swisslife.wd3.myworkdayjobs.com/job/Sion/Title_R11696';
    const other = 'https://acme.wd3.myworkdayjobs.com/job/Zug/Other-Title_R11696';
    expect(mergeUrlKey(swisslife)).toBe('req:swisslife.wd3.myworkdayjobs.com:r11696');
    expect(mergeUrlKey(other)).toBe('req:acme.wd3.myworkdayjobs.com:r11696');
    expect(mergeUrlKey(swisslife)).not.toBe(mergeUrlKey(other));
  });
  it('does NOT change keys for non-Workday hosts (host-gated, no re-key)', () => {
    // A non-Workday leaf that happens to end in `_r12345` must stay url:-keyed.
    expect(mergeUrlKey('https://acme.com/careers/title_r12345')).toBe('url:https://acme.com/careers/title_r12345');
    expect(mergeUrlKey('https://example.com/jobs/123456/old')).toBe('num:123456');
  });
});

describe('mergeUrlKey Bank Cler requisition rule (Rule K — slug-drift class)', () => {
  // Cler's requisition id is only 3-4 digits — below Rule B's ≥6-digit
  // threshold — so without a host-specific rule the leaf carries no
  // extractable token and every key falls back to the whole URL. Cler
  // relaunched its career section mid-day on 2026-07-04 (`jobs-und-karriere`
  // → `jobs-und-karriere-2026`, an ancestor segment unrelated to job
  // identity) which changed the whole-URL key for every open position and
  // duplicated all of them (#3497).
  it('extracts the requisition id and survives an ancestor-path rename', () => {
    const before = 'https://www.cler.ch/de/bank-cler/jobs-und-karriere/suchen-und-bewerben/offene-stellen/kundenberaterin-basis-thun-w-m-2589';
    const after = 'https://www.cler.ch/de/bank-cler/jobs-und-karriere-2026/suchen-und-bewerben/offene-stellen/kundenberaterin-basis-thun-w-m-2589';
    expect(mergeUrlKey(before)).toBe('req:cler.ch:2589');
    expect(mergeUrlKey(before)).toBe(mergeUrlKey(after));
  });
  it('does NOT change keys for non-Cler hosts (host-gated, no re-key)', () => {
    expect(mergeUrlKey('https://example.com/careers/title-2589')).toBe('url:https://example.com/careers/title-2589');
  });
  // #4205 item 3 — a cler.ch LISTING url (the leaf IS the `offene-stellen`
  // segment, there is no per-job slug after it) has no per-job token at all,
  // so it falls through Rule K/L/R/X to Rule C, which always returns a
  // non-empty `url:`-prefixed key — never ''. This confirms the whole-URL
  // fallback stays a STABLE, non-empty key (so callers like
  // dedupeClerJobsByStableId never mistake it for "no derivable id").
  // Scope note (#5230): the leaf-based key added below is gated on the
  // `/offene-stellen/<slug>` DETAIL shape precisely so this listing url keeps
  // its whole-URL key instead of collapsing every locale's listing onto one.
  it('falls back to a stable whole-URL key for a cler.ch listing url (no per-job slug)', () => {
    const url = 'https://www.cler.ch/de/bank-cler/jobs-und-karriere/suchen-und-bewerben/offene-stellen';
    const key = mergeUrlKey(url);
    expect(key).toBe(`url:${url.toLowerCase()}`);
    expect(key).not.toBe('');
    expect(mergeUrlKey(url)).toBe(mergeUrlKey(url));
  });

  // #5230 — the audit's only CRITICAL crawler was banca-cler at 18/22 (82%)
  // "duplicate listings". Cause: Rule K only fired when the leaf ENDED in a
  // digit run. Cler's apprenticeship/internship slugs carry no requisition
  // suffix, so they fell through to Rule C's whole-URL key — and cler.ch
  // still serves every posting under BOTH the legacy `…/jobs-und-karriere/…`
  // and the relaunched `…/jobs-und-karriere-2026/…` ancestor (verified
  // 2026-08-06: both HTTP 200, same <title>, each SELF-canonical), so the same
  // job was emitted twice. This is #3497's duplication, still live for every
  // non-numeric slug.
  const LEGACY = 'https://www.cler.ch/de/bank-cler/jobs-und-karriere/suchen-und-bewerben/offene-stellen';
  const RELAUNCH = 'https://www.cler.ch/de/bank-cler/jobs-und-karriere-2026/suchen-und-bewerben/offene-stellen';

  it('collapses a requisition-less slug across the jobs-und-karriere-2026 ancestor split', () => {
    const slug = 'du-willst-mehr-als-nur-einen-schreibtischjob-aka-lehrstelle-kauffrau-kaufmann-efz-bank-region-bern';
    expect(mergeUrlKey(`${LEGACY}/${slug}`)).toBe(`req:cler.ch:slug:${slug}`);
    expect(mergeUrlKey(`${LEGACY}/${slug}`)).toBe(mergeUrlKey(`${RELAUNCH}/${slug}`));
  });

  it('collapses a requisition-less slug across the de/it locale path variants', () => {
    // Same posting, German and Italian career sections — different locale,
    // different section wording, identical leaf.
    const slug = 'du-willst-lernen-wie-man-beim-thema-zahlen-fuer-ein-echtes-aha-sorgt-aka-bem-praktikum-region-basel';
    const de = `https://www.cler.ch/de/bank-cler/jobs-und-karriere/suchen-und-bewerben/offene-stellen/${slug}`;
    const it = `https://www.cler.ch/it/banca-cler/jobs-und-karriere/cercare-candidatura/offene-stellen/${slug}`;
    expect(mergeUrlKey(de)).toBe(mergeUrlKey(it));
  });

  // The other half of #5230: trailingDigitRunFromLeaf returns ANY trailing run,
  // so a 1-digit slug disambiguator was read as a requisition id. Every Cler
  // slug ending in `-2` keyed to `req:cler.ch:2` — silently merging unrelated
  // postings (an over-collapse DROPS a real job, worse than duplicating one).
  it('does not mistake a 1-digit slug disambiguator for a requisition id', () => {
    const bern = `${LEGACY}/du-willst-lernen-wie-man-beim-thema-zahlen-fuer-ein-echtes-aha-sorgt-aka-bem-praktikum-region-bern-2`;
    const other = `${LEGACY}/kundenberaterin-basis-thun-w-m-2`;
    expect(mergeUrlKey(bern)).not.toBe('req:cler.ch:2');
    expect(mergeUrlKey(bern)).not.toBe(mergeUrlKey(other));
  });

  it('still collapses a disambiguator-suffixed slug across the ancestor split', () => {
    const slug = 'du-willst-lernen-wie-man-beim-thema-zahlen-fuer-ein-echtes-aha-sorgt-aka-bem-praktikum-region-bern-2';
    expect(mergeUrlKey(`${LEGACY}/${slug}`)).toBe(mergeUrlKey(`${RELAUNCH}/${slug}`));
  });

  it('keeps the 3-4 digit requisition id winning over the leaf key', () => {
    const slug = 'consulente-alla-clientela-privata-individuale-lugano-f-m-2690';
    expect(mergeUrlKey(`${LEGACY}/${slug}`)).toBe('req:cler.ch:2690');
  });

  it('does NOT apply the leaf key to non-Cler hosts (host-gated)', () => {
    const url = 'https://example.com/careers/offene-stellen/lehrstelle-kauffrau-efz-region-bern';
    expect(mergeUrlKey(url)).toBe(`url:${url}`);
  });
});

describe('mergeUrlKey ETA SA requisition rule (Rule L — slug-drift class)', () => {
  // ETA SA's requisition id is only 4 digits — below Rule B's ≥6-digit
  // threshold — so without a host-specific rule the leaf carries no
  // extractable token and every key falls back to the whole URL. eta.ch
  // toggles an ancestor `index.php/` path segment (unrelated to job
  // identity) which changed the whole-URL key for every open position and
  // duplicated all of them (#3497).
  it('extracts the requisition id and survives an ancestor-path rename', () => {
    const before = 'https://www.eta.ch/en/jobs-careers/vacancies/detail/3719';
    const after = 'https://www.eta.ch/index.php/en/jobs-careers/vacancies/detail/3719';
    expect(mergeUrlKey(before)).toBe('req:eta.ch:3719');
    expect(mergeUrlKey(before)).toBe(mergeUrlKey(after));
  });
  it('does NOT change keys for non-ETA hosts (host-gated, no re-key)', () => {
    expect(mergeUrlKey('https://example.com/careers/title-3719')).toBe('url:https://example.com/careers/title-3719');
  });
});

describe('mergeUrlKey Umantis vacancy rule (Rule U — tenant-id collision class)', () => {
  // The per-vacancy id (3-4 digits) lives in an ANCESTOR segment
  // (`/Vacancies/<id>/…`) and is below Rule B's ≥6-digit threshold, while the
  // TENANT id in the hostname (`recruitingapp-122706`) is 6 digits — so the
  // legacy whole-URL scan returned `num:122706` for EVERY job at the tenant.
  // The old Rule U merely host-prefixed that token, collapsing all of a
  // tenant's jobs onto ONE key; mergePreserveLocaleData's non-injective-key
  // guard then refused every existing↔fresh match and the whole slice
  // re-keyed on each crawl, wiping previousSlugs/firstSeenAt (KSA incident,
  // run 29086057860 / commit c74a569d: 31 previousSlugs entries lost across
  // 19 jobs).
  it('extracts the per-vacancy id from the CheckLogin URL shape', () => {
    expect(mergeUrlKey('https://recruitingapp-122706.umantis.com/Vacancies/5105/Application/CheckLogin/1'))
      .toBe('req:recruitingapp-122706.umantis.com:vac:5105');
  });
  it('gives distinct vacancies at the same tenant DISTINCT keys', () => {
    const a = mergeUrlKey('https://recruitingapp-122706.umantis.com/Vacancies/5105/Application/CheckLogin/1');
    const b = mergeUrlKey('https://recruitingapp-122706.umantis.com/Vacancies/5506/Application/CheckLogin/1');
    expect(a).not.toBe(b);
  });
  it('keys the same vacancy identically across the Description → CheckLogin URL migration', () => {
    const description = 'https://recruitingapp-122706.umantis.com/Vacancies/5105/Description/1?lang=ger';
    const checkLogin = 'https://recruitingapp-122706.umantis.com/Vacancies/5105/Application/CheckLogin/1';
    expect(mergeUrlKey(description)).toBe(mergeUrlKey(checkLogin));
  });
  it('scopes the key per tenant (vacancy ids are per-tenant sequences)', () => {
    const a = mergeUrlKey('https://recruitingapp-122706.umantis.com/Vacancies/1910/Application/CheckLogin/1');
    const b = mergeUrlKey('https://recruitingapp-999888.umantis.com/Vacancies/1910/Application/CheckLogin/1');
    expect(a).toBe('req:recruitingapp-122706.umantis.com:vac:1910');
    expect(b).toBe('req:recruitingapp-999888.umantis.com:vac:1910');
    expect(a).not.toBe(b);
  });
  it('keeps the host-prefixed legacy fallback for umantis URLs without a /Vacancies/<id>/ segment', () => {
    expect(mergeUrlKey('https://recruitingapp-122706.umantis.com/Jobs/All'))
      .toBe('req:recruitingapp-122706.umantis.com:num:122706');
  });
  it('does NOT change keys for non-umantis hosts (host-gated, no re-key)', () => {
    expect(mergeUrlKey('https://www.eta.ch/en/jobs-careers/vacancies/detail/3719')).toBe('req:eta.ch:3719');
    expect(mergeUrlKey('https://example.com/vacancies/1910/apply')).toBe('url:https://example.com/vacancies/1910/apply');
  });
});

describe('workdayReqFromLeaf', () => {
  it('returns the after-first-underscore token when it carries a digit', () => {
    expect(workdayReqFromLeaf('Cloud-Architect_31138417')).toBe('31138417');
    expect(workdayReqFromLeaf('Conseiller-en-immobilier-_R11696')).toBe('r11696');
    expect(workdayReqFromLeaf('Operateur_R26_173')).toBe('r26_173');
  });
  it('returns empty for a leaf with no underscore, nothing after it, or no digit', () => {
    expect(workdayReqFromLeaf('plain-title')).toBe('');
    expect(workdayReqFromLeaf('title_')).toBe('');
    expect(workdayReqFromLeaf('title_draft')).toBe('');
    expect(workdayReqFromLeaf('')).toBe('');
  });
});

describe('mergeUrlKey leaf-scoping — shared-ancestor-token collision class', () => {
  // Regression guard for the bug where the legacy leftmost-token scan latched
  // onto a token shared across a whole crawler (board/company/upload-folder id
  // or a `%20`+year artifact) and collapsed every sibling posting onto ONE merge
  // key — `mergePreserveLocaleData` then merged them onto a single id, leaving
  // N-1 of N postings rendering the SPA "annuncio non più disponibile" orphan
  // view. Each pair below MUST key distinctly so siblings stay separate.

  it('cseb: keys on the per-job (leaf) UUID, not the shared board UUID', () => {
    const a = 'https://jobs.cseb.ch/job-advertisement/d9c5a048-f665-4e64-a2c7-cdd8231bac77/534b2d31-8165-2902-d3c2-b3657eb7c07c';
    const b = 'https://jobs.cseb.ch/job-advertisement/d9c5a048-f665-4e64-a2c7-cdd8231bac77/439cb41c-0371-94c9-6c59-909203c12844';
    expect(mergeUrlKey(a)).toBe('uuid:534b2d31-8165-2902-d3c2-b3657eb7c07c');
    expect(mergeUrlKey(b)).toBe('uuid:439cb41c-0371-94c9-6c59-909203c12844');
    expect(mergeUrlKey(a)).not.toBe(mergeUrlKey(b));
  });

  it('refline: generic index.html leaf → full URL (companyId is shared)', () => {
    const a = 'https://apply.refline.ch/514915/2643/pub/1/index.html';
    const b = 'https://apply.refline.ch/514915/2438/pub/1/index.html';
    expect(mergeUrlKey(a)).toBe('url:https://apply.refline.ch/514915/2643/pub/1/index.html');
    expect(mergeUrlKey(a)).not.toBe(mergeUrlKey(b));
  });

  it('lwphr: document (.pdf) leaf → full URL (upload-folder id is shared)', () => {
    const a = 'https://www.lwphr.ch/uploads/1/4/6/5/146598773/segretaria_legale_.pdf';
    const b = 'https://www.lwphr.ch/uploads/1/4/6/5/146598773/esperta_fiscale.pdf';
    expect(mergeUrlKey(a)).toBe('url:https://www.lwphr.ch/uploads/1/4/6/5/146598773/segretaria_legale_.pdf');
    expect(mergeUrlKey(a)).not.toBe(mergeUrlKey(b));
  });

  it('flury: %20-encoded year is NOT a job id (.pdf leaf → full URL)', () => {
    const a = 'https://www.flurystiftung.ch/sites/default/files/2026-02/Lehrstelle%20Fachperson%20Gesundheit%20EFZ%202027.pdf';
    const b = 'https://www.flurystiftung.ch/sites/default/files/2026-02/Lehrstelle%20Fachperson%20Betreuung%202027.pdf';
    expect(mergeUrlKey(a)).not.toBe('num:202027');
    expect(mergeUrlKey(a)).not.toBe(mergeUrlKey(b));
  });

  it('grace/hotelcareer: keys on the trailing leaf jobId, not the companyId', () => {
    const a = 'https://www.hotelcareer.com/jobs/grace-la-margna-st-moritz-120155/assistant-outlet-manager-3957038';
    const b = 'https://www.hotelcareer.com/jobs/grace-la-margna-st-moritz-120155/assistant-waiter-3639754';
    expect(mergeUrlKey(a)).toBe('num:3957038');
    expect(mergeUrlKey(b)).toBe('num:3639754');
  });

  it('Rule A query-id: generic leaf + per-job ?id= keys on the id, not the full URL', () => {
    // `…/index.html?id=NNN` behind a generic leaf: the per-job id lives in the
    // query, so a varying tracking param must NOT fragment the same job into
    // duplicate postings. Both URLs below are the SAME job re-crawled with a
    // different tracking param → must collapse to one key.
    const a = 'https://jobs.example.com/index.html?id=987654&utm_source=newsletter';
    const b = 'https://jobs.example.com/index.html?id=987654&utm_source=linkedin';
    expect(mergeUrlKey(a)).toBe('num:987654');
    expect(mergeUrlKey(a)).toBe(mergeUrlKey(b));
    // jobId variant behind a .php leaf, hex token.
    expect(mergeUrlKey('https://recruit.example.com/apply.php?jobId=abcdef0123&ref=x'))
      .toBe('hex:abcdef0123');
  });

  it('Rule A no-op: refline generic leaf with shared ?cid= still keys on full URL', () => {
    // `cid=101` is a SHARED company id, not a per-job token (`[?&]id=` must not
    // match `cid=`). Sibling jobs differ only in the path number → full URL keeps
    // them distinct; the query-id extraction must NOT collapse them.
    const a = 'https://apply.refline.ch/245893/0050/index.html?cid=101&lang=de';
    const b = 'https://apply.refline.ch/245893/0051/index.html?cid=101&lang=de';
    expect(mergeUrlKey(a)).toBe('url:https://apply.refline.ch/245893/0050/index.html?cid=101&lang=de');
    expect(mergeUrlKey(a)).not.toBe(mergeUrlKey(b));
  });

  it('Rule C preserved — id in query/fragment, leaf carries no token', () => {
    // pi-asp.de: distinct UUID lives in the fragment; leaf `bewerber-web` has no
    // token, so the legacy leftmost scan still wins (must NOT regress).
    expect(mergeUrlKey('https://bellinz.pi-asp.de/bewerber-web/?company=*-FIRMA-ID#position,id=1f4b718d-4377-49f4-b52e-de560a2e1b30'))
      .toBe('uuid:1f4b718d-4377-49f4-b52e-de560a2e1b30');
    // Workday-style ?JobID=NNN in the query, generic leaf.
    expect(mergeUrlKey('https://careers.zegnagroup.com/jobs/job-details?JobID=267802502&Team=231361275'))
      .toBe('num:267802502');
  });
});

describe('extractStableJobId output is pinned (real regression guard)', () => {
  // Pinned expected VALUES, not a comparison to mergeUrlKey — extractStableJobId
  // now delegates to mergeUrlKey, so `extractStableJobId(u) === mergeUrlKey(u)`
  // would hold by construction and prove nothing. These literals lock the
  // observable output so a future change to the shared key (in either module)
  // is caught here. Complements tests/job-match-key-stable-id.test.ts.
  const expected: Array<[string, string]> = [
    ['https://jobs.pwc.ch/job-vacancies/x/0441e237-ebd9-4263-9fe5-e21facbd03ba', 'uuid:0441e237-ebd9-4263-9fe5-e21facbd03ba'],
    ['https://example.com/jobs/123456/old', 'num:123456'],
    ['https://example.com/jobs/abcdef0123/old', 'hex:abcdef0123'],
    ['https://example.com/jobs/only-a-slug', 'url:https://example.com/jobs/only-a-slug'],
    ['https://Example.com/Path/', 'url:https://example.com/path'],
    ['https://example.com/jobs/only-a-slug?a=1&amp;b=2', 'url:https://example.com/jobs/only-a-slug?a=1&b=2'],
    // Galenica: 5-digit id (not ≥6) and no ≥10-char hex run → no stable token,
    // so the full normalized URL (hash preserved) is the key.
    [GALENICA, 'url:https://www.galenica.com/it/jobs/#job.id=12345'],
    ['', ''],
  ];
  for (const [url, want] of expected) {
    it(`extractStableJobId(${url || '(empty)'}) === ${want || '(empty)'}`, () => {
      expect(extractStableJobId(url)).toBe(want);
    });
  }
});

describe('assembleUrlKey (assemble-time dedup key)', () => {
  it('lowercases + strips trailing slash, no url: prefix', () => {
    expect(assembleUrlKey('https://Example.com/Path/')).toBe('https://example.com/path');
  });
  it('PRESERVES hash fragments (Galenica positions)', () => {
    expect(assembleUrlKey(GALENICA)).toBe('https://www.galenica.com/it/jobs/#job.id=12345');
  });
  it('returns empty string for empty input', () => {
    expect(assembleUrlKey('')).toBe('');
  });
  it('equals lowerStripTrailingSlash', () => {
    expect(assembleUrlKey(GALENICA)).toBe(lowerStripTrailingSlash(GALENICA));
  });
});

describe('identityUrlKey (stats/diff/firstSeenAt identity)', () => {
  it('STRIPS hash fragments (and the trailing-slash pathname)', () => {
    expect(identityUrlKey(GALENICA)).toBe('https://www.galenica.com/it/jobs');
  });
  it('strips default ports', () => {
    expect(identityUrlKey('https://example.com:443/jobs/x')).toBe('https://example.com/jobs/x');
  });
  it('normalizes trailing slash + case', () => {
    expect(identityUrlKey('https://Example.com/Path/')).toBe('https://example.com/path');
  });
  it('falls back gracefully for unparseable input', () => {
    expect(identityUrlKey('not a url/')).toBe('not a url');
  });
  it('returns empty string for empty input', () => {
    expect(identityUrlKey('')).toBe('');
  });
  it('keys Johdi Suite offer fragments on the numeric id, not the shared page', () => {
    const a = identityUrlKey('https://www.ehnv.ch/emplois#offer/3428/une-medecin-adjointe-a-80');
    const b = identityUrlKey('https://www.ehnv.ch/emplois#offer/4220/un-infirmier');
    expect(a).toBe('https://www.ehnv.ch/emplois#offer-3428');
    expect(b).toBe('https://www.ehnv.ch/emplois#offer-4220');
    expect(a).not.toBe(b);
  });
  it('Johdi Suite key is stable across a slug rename', () => {
    const a = identityUrlKey('https://www.ehnv.ch/emplois#offer/3428/une-medecin-adjointe-a-80');
    const b = identityUrlKey('https://www.ehnv.ch/emplois#offer/3428/medecin-adjointe-renamed');
    expect(a).toBe(b);
  });
});

describe('intentional divergence: hash handling', () => {
  it('assemble preserves but identity strips the Galenica fragment', () => {
    expect(assembleUrlKey(GALENICA)).not.toBe(identityUrlKey(GALENICA));
    expect(assembleUrlKey(GALENICA)).toContain('#job.id=12345');
    expect(identityUrlKey(GALENICA)).not.toContain('#');
  });
  it('buildStableJobIdentity uses the hash-stripped identity variant', () => {
    expect(buildStableJobIdentity({ url: GALENICA })).toBe(`url:${identityUrlKey(GALENICA)}`);
  });
});
