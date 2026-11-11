import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const read = (file: string) => readFileSync(resolve(file), "utf8");
const workflowText = read(".github/workflows/jobs-fast-publish.yml");
const workflow = parse(workflowText) as any;
const events = workflow.on ?? workflow["on"];

describe("active jobs fast-publish workflow", () => {
  it("runs on crawler updates and a 30-minute fallback, with manual dry-run as the safe default", () => {
    expect(events.schedule).toEqual([{ cron: "*/30 * * * *" }]);
    expect(events.push.paths).toContain("data/jobs/by-crawler/**/*.json");
    expect(events.workflow_dispatch.inputs.dry_run.default).toBe(true);
    expect(workflow.concurrency).toEqual({
      group: "jobs-fast-publish",
      "cancel-in-progress": false,
    });
  });

  it("admits scheduled publishing only when Remote Config is true and caps every publish batch", () => {
    expect(workflowText).toContain("JOBS_FAST_PUBLISH_ENABLED");
    expect(workflowText).toContain("MANUAL_DRY_RUN");
    expect(workflowText).toContain(
      "npx --no-install tsx scripts/publish-jobs-fast.mjs --dry-run",
    );
    expect(workflowText).toContain(
      "npx --no-install tsx scripts/publish-jobs-fast.mjs --publish",
    );
    const runner = read("scripts/publish-jobs-fast.mjs");
    expect(runner).toContain("const MAX_PAGES_PER_RUN = 200;");
    expect(runner).toContain('policy: "skip"');
  });

  it("shares per-shard and sitemap writer leases with the full publisher", () => {
    const deployPublish = read(".github/workflows/deploy-publish.yml");
    const itPushHelper = read("scripts/ci/push-it-shard-group.sh");
    expect(deployPublish).toContain("scripts/ci/with-shard-writer-lock.mjs");
    expect(itPushHelper).toContain("scripts/ci/with-shard-writer-lock.mjs");
    expect(deployPublish).toContain(
      "--section __sitemaps__ --locale it --policy wait",
    );
    expect(workflowText).toContain("environment: shard-secrets-overflow");
  });
});
