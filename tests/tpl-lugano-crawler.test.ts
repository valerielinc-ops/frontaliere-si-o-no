/**
 * TPL (Trasporti Pubblici Luganesi) crawler parser tests
 *
 * Tests parseTplListingPage() and isTplJob().
 * Fixtures recalced from the live tplsa.ch markup (2026-07):
 *   - listing: https://www.tplsa.ch/2/50/tpl-lavora-con-noi.html
 * The CMS emits spaces around attribute `=` (href = "...") and links each
 * position to /2/50/candidati/?idhr=NNN; idhr=0 is the spontaneous form.
 */
import { describe, it, expect } from 'vitest';

import {
  parseTplListingPage,
  isTplJob,
  inferEmploymentType,
} from '@/scripts/lib/tpl-lugano-job-parser.mjs';

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
        <br/><br/><br/><a href = "/2/50/candidati/?idhr=0">Unicamente per candidature spontanee, preghiamo di utilizzare il seguente formulario <i class="fas fa-arrow-right"></i></a>
    </section>
</body>
</html>`;

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
