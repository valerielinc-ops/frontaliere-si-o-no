import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SECTION_LEGACY_TI,
  TI_LEGACY_CITY_HUB_SLUGS,
} from '../../build-plugins/shared/cantonResolvers.mjs';
import {
  createJobBoardDetailPathMatcher,
  JOB_BOARD_DETAIL_PATH_RE,
  parseJobBoardDetailPath,
} from './job-board-detail-path-core.mjs';

export { JOB_BOARD_DETAIL_PATH_RE, parseJobBoardDetailPath };

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
let matcher;

/**
 * Sparse-checkout adapter for tools that need the route helper without the
 * generated canton data. The assembler imports the data-driven core directly,
 * so changes to this fallback do not invalidate its cached output.
 */
function getMatcher() {
  if (matcher !== undefined) return matcher;
  try {
    const read = (name) => JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
    matcher = createJobBoardDetailPathMatcher({
      cantonSlugFile: read('canton-url-slugs.json'),
      municipalitiesFile: read('canton-municipalities.json'),
    });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    matcher = null;
  }
  return matcher;
}

/**
 * Positive route identity for a job detail, with a conservative fallback for
 * sparse checkouts that omit the route data.
 *
 * @param {string} input
 * @returns {boolean}
 */
export function isJobBoardDetailPath(input) {
  const parsed = parseJobBoardDetailPath(input);
  if (!parsed) return false;

  const fullMatcher = getMatcher();
  if (fullMatcher) return fullMatcher(input);

  const { locale, section, tail } = parsed;
  if (section === SECTION_LEGACY_TI[locale]) {
    if (tail.length === 2) return TI_LEGACY_CITY_HUB_SLUGS.includes(tail[0]);
    return !TI_LEGACY_CITY_HUB_SLUGS.includes(tail[0]);
  }
  // Without route data a sparse checkout cannot prove that a one-tail path is
  // a city hub. Full checkouts always use the data-driven matcher above.
  return tail.length === 1;
}
