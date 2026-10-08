import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';

/**
 * Le deploy key delle sezioni shard oltre il tetto di 100 secret per repo
 * vivono solo nell'environment `shard-secrets-overflow`. Un job che legge
 * `secrets.SHARD_<SEZIONE>_<LOCALE>_DEPLOY_KEY` senza dichiararlo riceve una
 * stringa vuota: il push ripiega sul PAT e, sugli shard di proprieta'
 * nanakokyobashi-rgb (uri, vaud, vallese), riceve 403.
 *
 * Regressione: `publish-nonit-shards` e' stato estratto dal `build-locale` di
 * deploy.yml senza portarsi dietro l'environment. Nella run 37671196544 le tre
 * code non-IT hanno chiuso con sectionPush=failure, la ricevuta e' rimasta
 * `source-ready` e deploy / validate-dist / publish sono stati saltati con la
 * run verde.
 */

const root = path.resolve(import.meta.dirname, '..');
const workflowDir = path.join(root, '.github', 'workflows');

const OVERFLOW_ENVIRONMENT = 'shard-secrets-overflow';
const SECTION_SHARD_KEY_RX = /secrets\.SHARD_[A-Z0-9]+_(?:IT|EN|DE|FR)_DEPLOY_KEY/;
const SECTION_PUSH_WORKFLOWS = ['deploy.yml', 'deploy-publish.yml'];

function environmentName(environment: unknown): string | undefined {
  if (typeof environment === 'string') return environment;
  if (environment && typeof environment === 'object') {
    const name = (environment as { name?: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return undefined;
}

function jobsReadingSectionShardKeys(file: string): Array<{ job: string; environment: string | undefined }> {
  const doc = YAML.parse(fs.readFileSync(path.join(workflowDir, file), 'utf8')) as {
    jobs?: Record<string, { environment?: unknown }>;
  };
  return Object.entries(doc.jobs ?? {})
    .filter(([, job]) => SECTION_SHARD_KEY_RX.test(JSON.stringify(job)))
    .map(([name, job]) => ({ job: name, environment: environmentName(job.environment) }));
}

describe('shard-secrets-overflow wiring', () => {
  for (const file of SECTION_PUSH_WORKFLOWS) {
    it(`${file}: every job reading section-shard deploy keys declares the overflow environment`, () => {
      const jobs = jobsReadingSectionShardKeys(file);
      expect(jobs.length, `${file} no longer reads any section-shard deploy key`).toBeGreaterThan(0);
      const missing = jobs.filter((entry) => entry.environment !== OVERFLOW_ENVIRONMENT).map((entry) => entry.job);
      expect(
        missing,
        [
          `Job(s) reading secrets.SHARD_*_DEPLOY_KEY without \`environment: ${OVERFLOW_ENVIRONMENT}\`.`,
          'The overflow-held keys resolve to an empty string there and the push',
          'falls back to a PAT that cannot write the nanakokyobashi-rgb shards.',
        ].join(' '),
      ).toEqual([]);
    });
  }

  it('publish-nonit-shards is one of the guarded jobs', () => {
    const jobs = jobsReadingSectionShardKeys('deploy-publish.yml').map((entry) => entry.job);
    expect(jobs).toContain('publish-nonit-shards');
  });
});
