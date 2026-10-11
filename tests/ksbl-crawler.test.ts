import { describe, expect, it } from 'vitest';
import { parseKsblPage } from '../scripts/lib/ksbl-job-parser.mjs';

const uuid = '12345678-1234-1234-1234-123456789012';

describe('KSBL listing cards', () => {
  it('parses the current one-column card markup and its metadata', () => {
    const html = `
      <div class="col-12 mb-3">
        <div class="card border-0 rounded-0">
          <div class="card-body p-35 p-md-5">
            <div class="list-optional-label font-size-medium font-weight-bold mb-2 mb-md-3">Pflege</div>
            <h3 class="card-title mb-2 mb-md-3">Dipl. Pflegefachfrau/Pflegefachmann</h3>
            <ul class="nav jobs-list-description flex-column flex-md-row">
              <li class="list-item jobs-text-gray font-weight-bold">80-100%</li>
              <li class="list-item jobs-text-gray font-weight-bold">Pflege</li>
            </ul>
            <a href="https://karriere.ksbl.ch/de/offene-stellen/jobs/detail/job/pflegefachfrau/${uuid}" target="_top">Zur Stellenanzeige</a>
          </div>
        </div>
      </div>
    `;

    expect(parseKsblPage(html)).toEqual([{
      uuid,
      slug: 'pflegefachfrau',
      detailUrl: `https://karriere.ksbl.ch/de/offene-stellen/jobs/detail/job/pflegefachfrau/${uuid}`,
      title: 'Dipl. Pflegefachfrau/Pflegefachmann',
      category: 'Pflege',
      occupation: '80-100%',
    }]);
  });

  it('continues to parse the previous responsive card markup', () => {
    const html = `
      <div class="col-12 col-sm-6 col-lg-4 mb-gap mt-gap">
        <div class="card">
          <div class="card-body">
            <span class="optional-label">Administration</span>
            <h3 class="card-title">Kliniksekretär / in</h3>
            <span class="lead font-weight-normal">80%</span>
            <a href="https://karriere.ksbl.ch/de/offene-stellen/jobs/detail/job/kliniksekretaer/${uuid}">Stellenanzeige</a>
          </div>
        </div>
      </div>
    `;

    expect(parseKsblPage(html)).toEqual([{
      uuid,
      slug: 'kliniksekretaer',
      detailUrl: `https://karriere.ksbl.ch/de/offene-stellen/jobs/detail/job/kliniksekretaer/${uuid}`,
      title: 'Kliniksekretär / in',
      category: 'Administration',
      occupation: '80%',
    }]);
  });

  it('does not treat hyphenated class suffixes as KSBL card tokens', () => {
    const html = `
      <div class="foo-col-12 foo-mb-3">
        <a href="https://karriere.ksbl.ch/de/offene-stellen/jobs/detail/job/bad/${uuid}"></a>
        <h3 class="foo-card-title">Bad</h3>
        <ul><li class="foo-jobs-text-gray">80%</li></ul>
      </div></div></div>
    `;

    expect(parseKsblPage(html)).toEqual([]);
  });
});
