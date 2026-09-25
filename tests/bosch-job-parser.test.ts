import { describe, expect, it } from 'vitest';
import {
  parseBoschListingsPage,
  isBoschTargetListing,
  parseBoschJobDetail,
  buildBoschLocalizedContent,
  inferBoschCategory,
} from '../scripts/lib/bosch-job-parser.mjs';

describe('bosch-job-parser', () => {
  it('parses listing cards and detects Ticino jobs', () => {
    const html = `
      <div class="A-JobPanel">
        <a href="https://jobs.bosch.com/en/job/REF280202G-tecnico-di-servizio-fossile-regione-ticino-m-f-div-ref280202g"><h2>Tecnico di servizio Fossile Regione Ticino (m/f/div.) REF280202G</h2></a>
        <dl>
          <dt>Bosch Location</dt><dd>Rivera</dd>
          <dt>Fields of work</dt><dd>Customer Service</dd>
          <dt>Job posted:</dt><dd>03/10/2026</dd>
        </dl>
      </div>
      <div class="A-JobPanel">
        <a href="https://jobs.bosch.com/en/job/REF279962P-business-unit-controller-m-w-d-ref279962p"><h2>Business Unit Controller (m/w/d) REF279962P</h2></a>
        <dl>
          <dt>Bosch Location</dt><dd>Frauenfeld</dd>
          <dt>Fields of work</dt><dd>Finanzen</dd>
          <dt>Job posted:</dt><dd>03/06/2026</dd>
        </dl>
      </div>
    `;
    const listings = parseBoschListingsPage(html);
    expect(listings).toHaveLength(2);
    expect(isBoschTargetListing(listings[0])).toBe(true);
    // Cathedral 2026-05-10: Frauenfeld (TG) is now a target canton — listings[1] passes.
    expect(isBoschTargetListing(listings[1])).toBe(true);
  });

  it('parses detail content and builds localized payload', () => {
    const html = `
      <main>
        <h1>Tecnico di servizio Fossile Regione Ticino (m/f/div.) REF280202G</h1>
        <div class="M-JobKeyFacts">
          <div class="M-JobKeyFacts__termWrapper">
            <div class="M-JobKeyFacts__term">Bosch Location</div>
            <div class="M-JobKeyFacts__fact"><div class="job-location-name">Rivera</div><div class="job-location-mode"><span>(On-site)</span></div></div>
          </div>
          <div class="M-JobKeyFacts__termWrapper">
            <div class="M-JobKeyFacts__term">Fields of work</div>
            <div class="M-JobKeyFacts__fact">Customer Service</div>
          </div>
          <div class="M-JobKeyFacts__termWrapper">
            <div class="M-JobKeyFacts__term">Working time</div>
            <div class="M-JobKeyFacts__fact">Full-time</div>
          </div>
          <div class="M-JobKeyFacts__termWrapper">
            <div class="M-JobKeyFacts__term">Legal entity</div>
            <div class="M-JobKeyFacts__fact">Bosch Thermotechnik AG</div>
          </div>
        </div>
        <a href="https://jobs.smartrecruiters.com/BoschGroup/744000113667978-tecnico-di-servizio-fossile-regione-ticino-m-f-div-ref280202g">Apply now</a>
        <section><h2>Your tasks</h2><div class="A-Text-RichText"><ul><li>Task uno</li><li>Task due</li></ul></div></section>
        <section><h2>Your profile</h2><div class="A-Text-RichText"><ul><li>Profilo uno</li></ul></div></section>
        <section><h2>Contact & additional information</h2><div class="A-Text-RichText"><p>Benefit importanti</p><ul><li>5 settimane di ferie</li></ul></div></section>
      </main>
    `;
    const detail = parseBoschJobDetail(html);
    expect(detail.title).toContain('Tecnico di servizio Fossile Regione Ticino');
    expect(detail.location).toBe('Rivera');
    expect(detail.legalEntity).toBe('Bosch Thermotechnik AG');
    expect(detail.applyUrl).toContain('smartrecruiters.com');
    expect(detail.description).toContain('## Your tasks');
    expect(detail.description).toContain('- Task uno');
    expect(inferBoschCategory(detail)).toBe('sales');

    const localized = buildBoschLocalizedContent(detail);
    expect(localized.slugByLocale.it).toContain('rivera');
    expect(localized.titleByLocale.en).toContain('Fossil Service Technician');
  });
});
