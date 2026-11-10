import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  renderJobOgImages,
  type JobMinimal,
} from '../../build-plugins/jobOgImagesPlugin';

const jobsFile = process.argv[2];
if (!jobsFile) throw new Error('usage: render-job-og-cache-prewarm.ts <shard-plan.json>');
const plan = JSON.parse(readFileSync(path.resolve(jobsFile), 'utf8')) as {
  jobs?: JobMinimal[];
  includeArchive?: boolean;
};
if (!Array.isArray(plan.jobs)) throw new Error(`invalid OG prewarm plan: ${jobsFile}`);

const result = await renderJobOgImages(process.cwd(), plan.jobs, {
  outDir: null,
  cacheRoot: '.cache/og-jobs',
  budgetMs: null,
  cacheOnly: true,
  includeArchive: plan.includeArchive === true,
  strict: true,
});
console.log(
  `[og-job-prewarm] rendered=${result.rendered} cached=${result.cached} errors=${result.errors}`,
);
