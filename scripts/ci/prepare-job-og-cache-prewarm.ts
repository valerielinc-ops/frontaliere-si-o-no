import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readJsonFile } from '../lib/read-large-json.mjs';
import path from 'node:path';
import {
  findMissingJobOgImageJobs,
  type JobMinimal,
} from '../../build-plugins/jobOgImagesPlugin';

const rootDir = process.cwd();
const outputDir = process.argv[2];
if (!outputDir) throw new Error('usage: prepare-job-og-cache-prewarm.ts <output-directory>');

const jobsPath = path.join(rootDir, 'data/jobs.json');
const parsed = readJsonFile(jobsPath) as unknown;
const jobs = Array.isArray(parsed)
  ? parsed as JobMinimal[]
  : (parsed as { jobs?: JobMinimal[] } | null)?.jobs;
if (!Array.isArray(jobs) || jobs.length === 0) {
  throw new Error('deploy-equivalent data/jobs.json is missing or empty');
}

const shardCount = 4;
const shards = Array.from({ length: shardCount }, () => [] as JobMinimal[]);
const missing = findMissingJobOgImageJobs(rootDir, jobs);
missing.jobs.forEach((job, index) => shards[index % shardCount].push(job));
mkdirSync(outputDir, { recursive: true });
for (let shard = 0; shard < shardCount; shard += 1) {
  writeFileSync(
    path.join(outputDir, `shard-${shard}.json`),
    `${JSON.stringify({ jobs: shards[shard], includeArchive: shard === 0 && missing.archiveMissing })}\n`,
  );
}

const missingCount = missing.jobs.length + Number(missing.archiveMissing);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `has_missing=${missingCount > 0}\nmissing_jobs=${missing.jobs.length}\narchive_missing=${missing.archiveMissing}\n`,
  );
}
console.log(
  `[og-job-prewarm] jobs=${jobs.length} missing=${missing.jobs.length} archive_missing=${missing.archiveMissing} shards=${shardCount}`,
);
