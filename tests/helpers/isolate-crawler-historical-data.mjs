import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';

/**
 * Keep synthetic crawler tests away from the production slug registry and
 * served-URL ledger, which are large and unrelated to their fixtures.
 */
export function isolateCrawlerHistoricalData() {
  let previousSlugRegistryPath;
  let previousUrlFirstSeenPath;
  let fixtureDirectory;
  let slugRegistryPath;
  let urlFirstSeenPath;

  const useFixturePaths = () => {
    process.env.SLUG_REGISTRY_PATH_OVERRIDE = slugRegistryPath;
    process.env.URL_FIRST_SEEN_PATH_OVERRIDE = urlFirstSeenPath;
  };

  beforeAll(() => {
    previousSlugRegistryPath = process.env.SLUG_REGISTRY_PATH_OVERRIDE;
    previousUrlFirstSeenPath = process.env.URL_FIRST_SEEN_PATH_OVERRIDE;
    fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-crawler-history-'));
    slugRegistryPath = path.join(fixtureDirectory, 'slug-registry.json');
    // An absent path means “no ledger”; an empty directory is malformed because
    // a present shard store must contain all sixteen shards.
    urlFirstSeenPath = path.join(fixtureDirectory, 'url-first-seen.json');
  });

  beforeEach(useFixturePaths);
  afterEach(useFixturePaths);

  afterAll(() => {
    if (previousSlugRegistryPath === undefined) delete process.env.SLUG_REGISTRY_PATH_OVERRIDE;
    else process.env.SLUG_REGISTRY_PATH_OVERRIDE = previousSlugRegistryPath;
    if (previousUrlFirstSeenPath === undefined) delete process.env.URL_FIRST_SEEN_PATH_OVERRIDE;
    else process.env.URL_FIRST_SEEN_PATH_OVERRIDE = previousUrlFirstSeenPath;
    fs.rmSync(fixtureDirectory, { recursive: true, force: true });
  });
}
