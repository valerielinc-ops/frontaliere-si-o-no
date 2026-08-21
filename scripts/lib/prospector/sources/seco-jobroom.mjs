/**
 * Discovery source — job-room.ch, the Swiss public employment service feed.
 *
 * Why this feed and not a job board. Under the Stellenmeldepflicht, employers
 * hiring in occupations above the unemployment threshold MUST notify the RAV
 * before advertising anywhere else, and that notification lands here. So this
 * is not a marketing surface an employer opted into — it is a legal obligation
 * that pulls in exactly the small, local employers who never appear on the
 * national boards.
 *
 * Measured on Ticino, 30-day window: 305 ads, 186 distinct employers, of which
 * 163 (87%) were absent from our entire jobs dataset and 41 had no dedicated
 * crawler. That is the coverage gap, quantified.
 *
 * What each record hands us: the legal company name, its street address and
 * town, and — on ~45% of ads — the URL the employer wants applications sent to.
 * That URL is doing double duty: it is a careers page AND, when it points at a
 * third party, a platform sighting. The host histogram alone surfaced
 * ohws.prospective.ch, umantis.com, careers-page.com and solique.ch without
 * anyone naming a vendor.
 */
import { politeFetch } from './../polite-fetch.mjs';
import { normalizeHost } from './../registrable.mjs';

const API = 'https://www.job-room.ch/jobadservice/api/jobAdvertisements/_search';

/**
 * @typedef {Object} SecoEmployer
 * @property {string} name
 * @property {string} city
 * @property {string} zip
 * @property {string} canton
 * @property {string} [website]
 * @property {string[]} applyHosts  hosts seen on this employer's apply URLs
 * @property {number} adCount
 * @property {string[]} titles
 */

/**
 * @param {{ cantons?: string[], onlineSince?: number, maxPages?: number, pageSize?: number }} [opts]
 * @returns {Promise<{ employers: SecoEmployer[], adCount: number, hostHistogram: Record<string, number> }>}
 */
export async function fetchSecoEmployers(opts = {}) {
  const cantons = opts.cantons || ['TI'];
  const onlineSince = opts.onlineSince ?? 30;
  const maxPages = opts.maxPages ?? 20;
  const pageSize = opts.pageSize ?? 100;

  /** @type {Map<string, SecoEmployer>} */
  const employers = new Map();
  /** @type {Record<string, number>} */
  const hostHistogram = {};
  let adCount = 0;

  for (let page = 0; page < maxPages; page++) {
    const res = await politeFetch(`${API}?page=${page}&size=${pageSize}&sort=date_desc`, {
      method: 'POST',
      accept: 'application/json',
      ignoreRobots: true,
      body: JSON.stringify({
        permanent: null,
        workloadPercentageMin: 0,
        workloadPercentageMax: 100,
        onlineSince,
        displayRestricted: false,
        keywords: [],
        professionCodes: [],
        cantonCodes: cantons,
        communalCodes: [],
        companyName: null,
      }),
    });
    if (!res.ok) break;
    let batch;
    try { batch = JSON.parse(res.body); } catch { break; }
    if (!Array.isArray(batch) || !batch.length) break;

    for (const row of batch) {
      const jc = row?.jobAdvertisement?.jobContent;
      if (!jc) continue;
      adCount++;
      const c = jc.company || {};
      const name = String(c.name || '').trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (!employers.has(key)) {
        employers.set(key, {
          name,
          city: String(c.city || '').trim(),
          zip: String(c.postalCode || '').trim(),
          canton: cantons.length === 1 ? cantons[0] : '',
          website: c.website || undefined,
          applyHosts: [],
          adCount: 0,
          titles: [],
        });
      }
      const e = employers.get(key);
      e.adCount++;
      const title = (jc.jobDescriptions || [])[0]?.title;
      if (title && e.titles.length < 5) e.titles.push(String(title).slice(0, 120));
      const url = jc.externalUrl || jc.applyChannel?.formUrl || null;
      if (url) {
        try {
          const host = normalizeHost(new URL(url).hostname);
          if (host) {
            if (!e.applyHosts.includes(host)) e.applyHosts.push(host);
            hostHistogram[host] = (hostHistogram[host] || 0) + 1;
          }
        } catch { /* malformed apply URL */ }
      }
    }
    if (batch.length < pageSize) break;
  }

  return { employers: [...employers.values()], adCount, hostHistogram };
}
