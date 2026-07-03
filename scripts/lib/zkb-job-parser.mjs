#!/usr/bin/env node
/**
 * Zürcher Kantonalbank (ZKB) job parser — Refline ATS tenant 792841 on
 * apply.refline.ch.
 *
 * ZKB is a major Swiss cantonal bank headquartered in Zürich (Bahnhofstrasse
 * 9, 8001 Zürich), with a second seat in Winterthur. Universal bank with
 * ~6'000 employees group-wide.
 *
 * Public career site:
 *   https://www.zkb.ch/de/ueber-uns/jobs-karriere/stellenboerse.html
 *   Refline widget: https://apply.refline.ch/792841/positions.html
 *
 * Listing format: table-row, ZKB sub-variant —
 *   <tr><td class="position"><a href=".../{posId}/pub/{rev}">Title</a></td>
 *       <td class="operationArea">…</td>
 *       <td class="workplace">…</td>
 *       <td class="workload">…</td>
 *       <td class="segment">…</td>
 *       <td class="locale">…</td></tr>
 *   Detail links here resolve directly WITHOUT the `/index.html` suffix used
 *   by other tenants, and the table adds an `operationArea` column between
 *   `position` and `workplace` — `refline-common.mjs`'s `parseReflineTableListing`
 *   was extended (backward-compatibly) to tolerate both.
 *
 * Detail page: <h1>Title</h1> + <div id="bDescription"> content blocks.
 */
import { createReflineParser } from './refline-common.mjs';

export const ZKB_KEY = 'zkb';
export const ZKB_COMPANY_NAME = 'Zürcher Kantonalbank';
export const ZKB_COMPANY_DOMAIN = 'zkb.ch';

const parser = createReflineParser({
  reflineTenant: '792841',
  companyKey: ZKB_KEY,
  companyName: ZKB_COMPANY_NAME,
  companyDomain: ZKB_COMPANY_DOMAIN,
  defaultCanton: 'ZH',
  defaultCity: 'Zürich',
  defaultPostalCode: '8001',
  publicCareerUrl: 'https://www.zkb.ch/de/ueber-uns/jobs-karriere/stellenboerse.html',
  defaultSourceLang: 'de',
  listingHost: 'apply.refline.ch',
  sector: 'Finanza / Banca',
  sourceLabel: 'Zürcher Kantonalbank Dedicated Parser (Refline 792841)',
});

export const fetchAllZkbJobs = parser.fetchAllJobs;
export const isZkbJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
