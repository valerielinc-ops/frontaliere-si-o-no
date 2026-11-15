import { JOB_BOARD_SECTION_PREFIX_SOURCE } from './jobBoardSectionPrefixes.mjs';

/**
 * Matches the company-hub segment immediately below a job-board section,
 * including both the directory index and the flat `.html` emitter output.
 * Keeping the section prefix in this small module lets consumers of only this
 * matcher avoid loading the profession-route classifier and its data file.
 */
export const JOB_BOARD_COMPANY_HUB_PATH_RX = new RegExp(
  `^(?:/(?:en|de|fr))?/(?:${JOB_BOARD_SECTION_PREFIX_SOURCE})-[a-z][a-z-]*/` +
  '(?:azienda|company|unternehmen|entreprise)-[a-z0-9][a-z0-9-]*(?:/|\\.html$|$)',
);
