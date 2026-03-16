import { describe, expect, it } from 'vitest';
import {
  parseSunriseSearchPage,
  parseSunriseJobDetail,
  isSunriseTargetLocation,
  buildSunriseDetailUrl,
} from '../scripts/lib/sunrise-job-parser.mjs';

describe('sunrise-job-parser', () => {
  it('parses search jobs from Phenom ddo and keeps target locations', () => {
    const html = `
      <script>
        phApp.ddo = {"eagerLoadRefineSearch":{"data":{"jobs":[
          {"reqId":"REQ_1","jobId":"REQ_1","title":"Key Account Manager","city":"Manno_Via Violino 1","state":"Ticino","postedDate":"2026-03-10T00:00:00.000+0000"},
          {"reqId":"REQ_2","jobId":"REQ_2","title":"Sales Agent","city":"Bern","state":"","postedDate":"2026-03-10T00:00:00.000+0000"}
        ]}}};
        phApp.experimentData = {};
      </script>
    `;
    const jobs = parseSunriseSearchPage(html);
    expect(jobs).toHaveLength(2);
    expect(isSunriseTargetLocation(jobs[0])).toBe(true);
    expect(isSunriseTargetLocation(jobs[1])).toBe(false);
    expect(buildSunriseDetailUrl(jobs[0])).toContain('/job/REQ_1/key-account-manager');
  });

  it('parses detail content from sunrise job page', () => {
    const html = `
      <script>
        phApp.ddo = {"jobDetail":{"data":{"job":{
          "reqId":"REQ_30036296",
          "jobSeqNo":"SCASCAGBREQ30036296EXTERNALITIT",
          "title":"Key Account Manager Italian-speaking Switzerland 80-100%",
          "cityState":"Manno, Ticino",
          "cityStateCountry":"Manno, Ticino, Svizzera",
          "state":"Ticino",
          "standardisedStateCode":"TI",
          "location":"Manno_Via Violino 1",
          "applyUrl":"https://sunrise.wd3.myworkdayjobs.com/Sunrise/job/Manno/apply",
          "locale":"it_IT",
          "description":"<h2>Main responsibilities</h2><ul><li>Build partnerships</li><li>Grow revenue</li></ul>"
        }}}};
        phApp.experimentData = {};
      </script>
      <script type="application/ld+json">
        {"@context":"https://schema.org","@type":"JobPosting","jobLocation":{"@type":"Place","address":{"@type":"PostalAddress","addressLocality":"Manno_Via Violino 1","addressRegion":"Ticino","postalCode":"6928"}}}
      </script>
    `;
    const detail = parseSunriseJobDetail(html);
    expect(detail.reqId).toBe('REQ_30036296');
    expect(detail.standardisedStateCode).toBe('TI');
    expect(detail.postalCode).toBe('6928');
    expect(detail.description).toContain('## Main responsibilities');
    expect(detail.description).toContain('- Build partnerships');
    expect(detail.applyUrl).toContain('myworkdayjobs.com');
  });
});
