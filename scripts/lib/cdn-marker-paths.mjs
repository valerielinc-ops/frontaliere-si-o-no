import { readFileSync } from 'node:fs';

const config = readFileSync(new URL('./cdn-marker-paths.env', import.meta.url), 'utf8');
const values = Object.fromEntries(
  config
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
);

function markerPath(name) {
  const value = values[name];
  if (!value || !/^[a-z0-9][a-z0-9.-]*\.txt$/.test(value)) {
    throw new Error(`invalid CDN marker filename: ${name}`);
  }
  return `/${value}`;
}

export const CDN_LIVE_BUILD_ID_PATH = markerPath('CDN_LIVE_BUILD_ID_FILE');
export const CDN_READY_BUILD_ID_PATH = markerPath('CDN_READY_BUILD_ID_FILE');
export const CDN_REPO_SSH = values.CDN_REPO_SSH;
