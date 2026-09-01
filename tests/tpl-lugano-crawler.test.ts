/**
 * TPL (Trasporti Pubblici Luganesi) crawler parser tests
 *
 * Tests the source-specific listing/detail gates and adapter parity contract.
 * Fixtures recalced from the live tplsa.ch markup (2026-07):
 *   - listing: https://www.tplsa.ch/2/50/tpl-lavora-con-noi.html
 *   - detail:  https://www.tplsa.ch/2/50/candidati/?idhr=748
 * The CMS emits spaces around attribute `=` (href = "...") and links each
 * position to /2/50/candidati/?idhr=NNN; idhr=0 is the spontaneous form.
 */
import { describe, it, expect } from 'vitest';

import {
  parseTplListingPage,
  parseTplListingState,
  parseTplDetailPage,
  isTplJob,
  inferEmploymentType,
} from '@/scripts/lib/tpl-lugano-job-parser.mjs';
import {
  applyTplAuthoritativeDetails,
  buildTplAdapterSeedFields,
  fetchTplSourceSnapshot,
} from '@/scripts/update-tpl-lugano-jobs.mjs';

// ─── Fixture: Listing page with one open position (live markup) ───
const LISTING_WITH_JOBS_HTML = `
<html>
<body>
	<section id="tabs">
		<div class="container mt-5 mb-5">
				<div class="col-md-12">
					<h1>Lavora con noi</h1>
					<!--h2>Elenco posizioni</h2-->
				</div>
    		<div class="row no-gutters">
    			<h2>Qualsiasi concorso o posizione aperta presso la nostra azienda viene pubblicata nella presente area del sito.<br><br><img src = "/img/logo-lavoro.png"> <br></h2>
        <div class="col-md-12" style="border-bottom: 1px solid #d8d8d8; margin-top: 20px">
    <div class = "col-lg-3 mb-2"><b>Data pubblicazione</b></div>
    <div class = "col-lg-3 mb-2"><b>Data scadenza</b></div>
    <div class = "col-lg-6 mb-2"><b>Posizione</b></div>
</div>
<div class="col-md-12">
    <div class = "col-lg-3 mt-3">12 giugno 2026</div>
    <div class = "col-lg-3 mt-3">15 luglio 2026</div>
    <div class = "col-lg-6 mt-3"><h5><a  style = "color: #68be4d" href = "/2/50/candidati/?idhr=748"><i class="fas fa-arrow-right"></i> Specialista Risorse Umane</a></h5></div>
</div>
        <br/><br/><br/><a href = "/2/50/candidati/?idhr=0">Unicamente per candidature spontanee, preghiamo di utilizzare il seguente formulario <i class="fas fa-arrow-right"></i></a>
    		</div>
    	</div>
    </section>
</body>
</html>`;

// ─── Fixture: Listing page with multiple positions ───
const LISTING_MULTI_HTML = `
<div class="col-md-12">
  <div class = "col-lg-6 mt-3"><h5><a style = "color: #68be4d" href = "/2/50/candidati/?idhr=748"><i class="fas fa-arrow-right"></i> Specialista Risorse Umane</a></h5></div>
</div>
<div class="col-md-12">
  <div class = "col-lg-6 mt-3"><h5><a style = "color: #68be4d" href = "/2/50/candidati/?idhr=751"><i class="fas fa-arrow-right"></i> Autista Autobus</a></h5></div>
</div>
<div class="col-md-12">
  <div class = "col-lg-6 mt-3"><h5><a style = "color: #68be4d" href = "/2/50/candidati/?idhr=748"><i class="fas fa-arrow-right"></i> Specialista Risorse Umane</a></h5></div>
</div>
<a href = "/2/50/candidati/?idhr=0">Unicamente per candidature spontanee</a>`;

// ─── Fixture: Listing page with no jobs (only spontaneous form) ───
const LISTING_NO_JOBS_HTML = `
<html>
<body>
	<section id="tabs">
				<div class="col-md-12">
					<h1>Lavora con noi</h1>
				</div>
        <div class="col-md-12" style="border-bottom: 1px solid #d8d8d8; margin-top: 20px">
    <div class = "col-lg-3 mb-2"><b>Data pubblicazione</b></div>
    <div class = "col-lg-3 mb-2"><b>Data scadenza</b></div>
    <div class = "col-lg-6 mb-2"><b>Posizione</b></div>
</div>
        <h2>Non ci sono risultati nell'area selezionata.</h2>
        <p>Vi consigliamo di riprovare prossimamente.</p>
        <br/><br/><br/><a href = "/2/50/candidati/?idhr=0">Unicamente per candidature spontanee, preghiamo di utilizzare il seguente formulario <i class="fas fa-arrow-right"></i></a>
    </section>
</body>
</html>`;

const DETAIL_HTML = `
<html>
<body>
  <section>
    <div class="container mt-5 mb-5">
      <div class="col-md-12">
        <h1>Specialista Risorse Umane </h1>
        <a class="btn btn-candidati" href = "/repository/pdf/863388487-BandoSpecialistaRisorseUmane.pdf">Guarda il Capitolato <i class="fas fa-file"></i></a>
      </div>
      <div class="col-md-12">
        <hr>
        Le candidature per le posizioni vacanti, complete dei documenti richiesti, dovranno pervenire esclusivamente in formato elettronico all'indirizzo candidature@tplsa.ch.
      </div>
      <div class="Menu2 mt-5" id="accordion">
        <p>La Trasporti Pubblici Luganesi SA serve la città di Lugano e i comuni limitrofi.</p>
      </div>
    </div>
  </section>
</body>
</html>`;

// Live 2026-09-01: a retired idhr remains HTTP 200 but has no vacancy title
// or capitolato. Only the generic application sentence survives.
const GHOST_DETAIL_HTML = `
<section>
  <div class="container mt-5 mb-5">
    <div class="col-md-12"><h1> </h1></div>
    <div class="col-md-12"><hr>Le candidature per le posizioni vacanti dovranno pervenire esclusivamente in formato elettronico all'indirizzo candidature@tplsa.ch.</div>
    <div class="Menu2 mt-5" id="accordion"><p>Chi siamo</p></div>
  </div>
</section>`;

const sourceResponse = (html: string, status = 200) => new Response(html, {
  status,
  headers: { 'Content-Type': 'text/html; charset=utf-8' },
});

// ═══════════════════════════════════════════════════════════════
// parseTplListingPage
// ═══════════════════════════════════════════════════════════════

describe('parseTplListingPage', () => {
  it('extracts the open position from the live listing markup', () => {
    const results = parseTplListingPage(LISTING_WITH_JOBS_HTML);
    expect(results.length).toBe(1);
    expect(results[0].url).toBe('https://www.tplsa.ch/2/50/candidati/?idhr=748');
    expect(results[0].title).toBe('Specialista Risorse Umane');
  });

  it('handles spaces around the href attribute equals sign', () => {
    // The tplsa.ch CMS emits `href = "..."` — a plain href="..." regex never matches
    const results = parseTplListingPage(LISTING_WITH_JOBS_HTML);
    expect(results.length).toBeGreaterThan(0);
  });

  it('excludes the spontaneous-application form (idhr=0)', () => {
    const results = parseTplListingPage(LISTING_WITH_JOBS_HTML);
    expect(results.some((r) => /idhr=0\b/.test(r.url))).toBe(false);
  });

  it('extracts multiple positions and deduplicates by URL', () => {
    const results = parseTplListingPage(LISTING_MULTI_HTML);
    expect(results.length).toBe(2);
    expect(results.map((r) => r.title)).toEqual([
      'Specialista Risorse Umane',
      'Autista Autobus',
    ]);
  });

  it('strips the arrow icon from titles', () => {
    const results = parseTplListingPage(LISTING_WITH_JOBS_HTML);
    expect(results[0].title).not.toMatch(/fa-arrow|</);
  });

  it('returns empty array when only the spontaneous form is present', () => {
    const results = parseTplListingPage(LISTING_NO_JOBS_HTML);
    expect(results).toEqual([]);
  });

  it('returns empty array for empty input', () => {
    expect(parseTplListingPage('')).toEqual([]);
    expect(parseTplListingPage(null)).toEqual([]);
  });

  it('rejects an absolute off-domain detail href', () => {
    const poisoned = LISTING_WITH_JOBS_HTML.replace(
      '/2/50/candidati/?idhr=748',
      'https://attacker.example/2/50/candidati/?idhr=748',
    );
    expect(parseTplListingPage(poisoned)).toEqual([]);
  });
});

describe('parseTplListingState', () => {
  it('distinguishes source-proven zero from parser drift', () => {
    expect(parseTplListingState(LISTING_NO_JOBS_HTML)).toEqual({ state: 'empty', jobs: [] });
    expect(parseTplListingState('<h1>Lavora con noi</h1>')).toEqual({ state: 'invalid', jobs: [] });
  });

  it('prefers concrete rows over unrelated empty copy', () => {
    const result = parseTplListingState(`${LISTING_WITH_JOBS_HTML}<p>Non ci sono risultati nell'area selezionata. Vi consigliamo di riprovare prossimamente.</p>`);
    expect(result.state).toBe('jobs');
    expect(result.jobs).toHaveLength(1);
  });
});

describe('parseTplDetailPage', () => {
  it('extracts only the role-owned block before the generic accordion', () => {
    const result = parseTplDetailPage(DETAIL_HTML, 'Specialista Risorse Umane');
    expect(result).toEqual(expect.objectContaining({
      title: 'Specialista Risorse Umane',
      location: 'Lugano',
    }));
    expect(result?.body).toContain('Guarda il Capitolato');
    expect(result?.body).toContain('candidature@tplsa.ch');
    expect(result?.body).not.toContain('serve la città di Lugano');
  });

  it('fails closed on the live HTTP-200 ghost, thin blocks, and title mismatch', () => {
    expect(parseTplDetailPage(GHOST_DETAIL_HTML, 'Specialista Risorse Umane')).toBeNull();
    expect(parseTplDetailPage('<h1>Specialista Risorse Umane</h1><div class="Menu2">menu</div>')).toBeNull();
    expect(parseTplDetailPage(DETAIL_HTML, 'Autista Autobus')).toBeNull();
  });
});

describe('TPL source snapshot and adapter boundary', () => {
  it('validates every listed detail and declares the exact URLs as seedDetailUrls', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      return sourceResponse(url.includes('tpl-lavora-con-noi') ? LISTING_WITH_JOBS_HTML : DETAIL_HTML);
    }) as typeof fetch;

    const snapshot = await fetchTplSourceSnapshot({ fetchImpl, timeoutMs: 100 });
    expect(snapshot.state).toBe('jobs');
    expect(snapshot.jobs).toHaveLength(1);
    expect(calls).toEqual([
      'https://www.tplsa.ch/2/50/tpl-lavora-con-noi.html',
      'https://www.tplsa.ch/2/50/candidati/?idhr=748',
    ]);

    const seeds = buildTplAdapterSeedFields(snapshot.jobs);
    expect(seeds.seedDetailUrls).toEqual(['https://www.tplsa.ch/2/50/candidati/?idhr=748']);
    expect(seeds.seedUrls).toEqual(seeds.seedDetailUrls);
    expect(seeds.seedMetaByUrl[seeds.seedDetailUrls[0]]).toEqual(expect.objectContaining({
      location: 'Lugano',
      canton: 'TI',
    }));
  });

  it('accepts only the explicit source zero and never fetches a stale detail', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return sourceResponse(LISTING_NO_JOBS_HTML);
    }) as typeof fetch;
    await expect(fetchTplSourceSnapshot({ fetchImpl, timeoutMs: 100 })).resolves.toEqual({
      state: 'empty',
      jobs: [],
    });
    expect(calls).toBe(1);
    expect(buildTplAdapterSeedFields([])).toEqual({ seedUrls: [], seedDetailUrls: [], seedMetaByUrl: {} });
  });

  it('throws on unrecognised empty listings and HTTP-200 ghost details', async () => {
    const invalidListingFetch = (async () => sourceResponse('<h1>Lavora con noi</h1>')) as typeof fetch;
    await expect(fetchTplSourceSnapshot({ fetchImpl: invalidListingFetch, timeoutMs: 100 }))
      .rejects.toThrow(/neither vacancy rows nor the authoritative empty marker/);

    const ghostFetch = (async (input: string | URL | Request) => sourceResponse(
      String(input).includes('tpl-lavora-con-noi') ? LISTING_WITH_JOBS_HTML : GHOST_DETAIL_HTML,
    )) as typeof fetch;
    await expect(fetchTplSourceSnapshot({ fetchImpl: ghostFetch, timeoutMs: 100 }))
      .rejects.toThrow(/authoritative content gate/);
  });

  it('overlays content without changing identity and enforces one-to-one parity', () => {
    const source = [{
      url: 'https://www.tplsa.ch/2/50/candidati/?idhr=748',
      title: 'Specialista Risorse Umane',
      body: 'Descrizione autorevole della posizione e delle modalità di candidatura.',
      location: 'Lugano',
    }];
    const stable = {
      id: 'tpl-lugano-stable',
      slug: 'specialista-risorse-umane-tpl-lugano-stable',
      previousSlugs: ['specialista-risorse-umane-old'],
      companyKey: 'tpl-lugano',
      url: source[0].url,
      title: 'Generic title',
      description: 'Generic navigation',
    };
    const result = applyTplAuthoritativeDetails([
      stable,
      { ...stable, id: 'stale', url: 'https://www.tplsa.ch/2/50/candidati/?idhr=700' },
    ], source);
    expect(result).toEqual(expect.objectContaining({ matched: 1, removed: 1 }));
    expect(result.jobs[0]).toEqual(expect.objectContaining({
      id: stable.id,
      slug: stable.slug,
      previousSlugs: stable.previousSlugs,
      title: source[0].title,
      description: source[0].body,
    }));
    expect(applyTplAuthoritativeDetails(result.jobs, source).jobs).toEqual(result.jobs);

    expect(() => applyTplAuthoritativeDetails([], source)).toThrow(/lost 1 validated detail URL/);
    expect(() => applyTplAuthoritativeDetails([stable, { ...stable }], source)).toThrow(/duplicate URL/);
  });
});

// ═══════════════════════════════════════════════════════════════
// isTplJob
// ═══════════════════════════════════════════════════════════════

describe('isTplJob', () => {
  it('matches by companyKey', () => {
    expect(isTplJob({ companyKey: 'tpl-lugano', company: '' })).toBe(true);
  });

  it('matches by company name containing TPL', () => {
    expect(isTplJob({ companyKey: '', company: 'TPL SA' })).toBe(true);
  });

  it('matches by URL domain', () => {
    expect(isTplJob({ companyKey: '', company: '', url: 'https://www.tplsa.ch/2/50/candidati/?idhr=748' })).toBe(true);
  });

  it('does not match unrelated companies', () => {
    expect(isTplJob({ companyKey: 'lidl', company: 'Lidl', url: 'https://lidl.ch' })).toBe(false);
  });

  it('returns false for null', () => {
    expect(isTplJob(null)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// inferEmploymentType
// ═══════════════════════════════════════════════════════════════

describe('inferEmploymentType', () => {
  it('defaults to FULL_TIME', () => {
    expect(inferEmploymentType('Specialista Risorse Umane', '')).toBe('FULL_TIME');
  });

  it('detects part-time from percentage below 80', () => {
    expect(inferEmploymentType('Impiegato', 'Grado di occupazione: 50%')).toBe('PART_TIME');
  });

  it('treats 80-100% as full time', () => {
    expect(inferEmploymentType('Autista', 'Grado di occupazione: 80-100%')).toBe('FULL_TIME');
  });

  it('detects explicit tempo parziale', () => {
    expect(inferEmploymentType('Impiegato', 'Posizione a tempo parziale')).toBe('PART_TIME');
  });
});
