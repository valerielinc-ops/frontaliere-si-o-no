import { describe, expect, it } from 'vitest';
import { fetchAllGiardinoJobs, TALENTS_URL, TALENTS_EN_URL } from '../scripts/lib/giardino-job-parser.mjs';
const file = 'job-restaurant-manager.html';
const url = `${TALENTS_URL}${file}`;
const date = '2025-09-29T23:45:12+02:00';
const text = 'Das Team begleitet unsere Gäste während ihres Aufenthalts und arbeitet mit den Kollegen im Restaurant zusammen. Zu den Aufgaben gehören sorgfältige Planung und Organisation sowie die persönliche Betreuung der Gäste und die Sicherung einer hohen Qualität in allen Abläufen. '.repeat(4);
const card = `<a class="job-card" data-job data-loc="ascona" data-dep="service" href="${file}"><h3>Restaurant Manager</h3></a>`;
const board = (cards: string) => `<strong id="jobs-count">${cards ? 1 : 0}</strong><!--JOBS-START-->${cards}<!--JOBS-ENDE-->`;
const posting = (raw: unknown) => ({ '@type': 'JobPosting', title: 'Restaurant Manager', url, datePosted: raw });
const detail = (ld: unknown) => `<script type="application/ld+json">${JSON.stringify(ld)}</script><h1>Restaurant Manager</h1><p class="intro">Giardino Ascona</p><h2 class="detail-h">#aboutthejob</h2><p class="detail-text">${text}</p><h2 class="detail-h">#aboutyou</h2><ul><li>Berufserfahrung</li></ul><h2 class="detail-h">#talentculture</h2><ul><li>Schulungen</li></ul>`;
async function crawl(ld: unknown, english = false) {
  return fetchAllGiardinoJobs({ fetchPage: async (requested: string) => {
    if (requested === TALENTS_URL) return board(card);
    if (requested === TALENTS_EN_URL) return board(english ? card : '');
    if (requested === `${TALENTS_EN_URL}${file}`) throw new Error('English vacancy unavailable');
    if (requested === url) return detail(ld);
    throw new Error(`Unexpected request ${requested}`);
  } });
}
async function expectPublication(ld: unknown, expected = '', english = false) {
  const jobs = await crawl(ld, english);
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ url, companyKey: 'giardino', canton: 'TI', datePosted: expected, postedDate: expected, postingDateSource: expected ? 'reported' : 'unknown' });
  expect(jobs[0].description.split(/\s+/).length).toBeGreaterThan(50);
}
describe('Giardino publication evidence follows the actual fetched language page', () => {
  for (const [label, raw] of [['timestamp', date], ['missing', undefined], ['invalid', '2025-02-30T12:00:00Z'], ['future', '2999-01-01T12:00:00Z']]) {
    it(`${label}: emits strict tuple without crawl fallback`, async () => {
      await expectPublication(posting(raw), label === 'timestamp' ? date : '');
    });
  }
  it('does not attest a URL-less posting', async () => {
    await expectPublication({ ...posting(date), url: undefined });
  });
  it('does not borrow a publication date from another vacancy', async () => {
    await expectPublication({ ...posting(date), url: `${TALENTS_URL}job-another-role.html` });
  });
  it('rejects conflicting sameAs identity', async () => {
    await expectPublication({ ...posting(date), sameAs: `${TALENTS_URL}job-another-role.html` });
  });
  it('retains German publication evidence when the English detail falls back with its URL', async () => {
    await expectPublication(posting(date), date, true);
  });
});
