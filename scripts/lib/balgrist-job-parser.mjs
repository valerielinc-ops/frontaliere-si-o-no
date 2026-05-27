#!/usr/bin/env node
/**
 * Universitätsklinik Balgrist (Zürich) job parser — Prospective.ch (medium 1002177).
 *
 * Balgrist is the orthopaedic university clinic of the University of Zürich,
 * unique in CH as a teaching/research hospital fully dedicated to orthopaedics,
 * spinal cord injuries, paraplegia rehab, sports medicine and movement disorders.
 *
 * Public career site: https://www.balgrist.ch/karriere/offene-stellen/
 *   → embeds iframe to https://jobs.balgrist.ch/?lang=de
 *     (Prospective careercenter 1002177)
 *
 * The careercenter ID matches the Prospective v1 listing endpoint:
 *   https://ohws.prospective.ch/public/v1/medium/1002177/jobs?lang=de
 *
 * Independent tenant: although Balgrist sits within the broader Zürich
 * university hospital ecosystem, its career portal is a stand-alone
 * Prospective medium ID — distinct from USZ, Lindenhof, Triemli etc.
 *
 * Canton ZH, postal 8008 (Forchstrasse 340).
 *
 * Uses the shared Prospective.ch factory.
 */
import { createProspectiveChParser } from './prospective-ch-job-parser-common.mjs';

export const BALGRIST_KEY = 'balgrist';
export const BALGRIST_COMPANY_NAME = 'Universitätsklinik Balgrist';
export const BALGRIST_COMPANY_DOMAIN = 'balgrist.ch';

const parser = createProspectiveChParser({
  companyKey: BALGRIST_KEY,
  companyName: BALGRIST_COMPANY_NAME,
  companyDomain: BALGRIST_COMPANY_DOMAIN,
  mediumId: '1002177',
  apiLang: 'de',
  defaultCanton: 'ZH',
  defaultCity: 'Zürich',
  defaultPostalCode: '8008',
  publicCareerUrl: 'https://www.balgrist.ch/karriere/offene-stellen/',
  defaultSourceLang: 'de',
  extraTrustedHosts: ['jobs.balgrist.ch'],
});

export const fetchAllBalgristJobs = parser.fetchAllJobs;
export const isBalgristJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
