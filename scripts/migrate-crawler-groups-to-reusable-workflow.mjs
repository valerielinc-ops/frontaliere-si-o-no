#!/usr/bin/env node

/**
 * Retired one-shot migrator.
 *
 * Reusable workflows force GitHub to download the cross-repo source before
 * any job step can apply sparse checkout or retry. Keeping the old generator
 * executable would allow that failed architecture to be recreated.
 */
throw new Error(
  'retired migration: use generate-crawler-group-workflows.mjs --cross-repo-out-dir <articles/.github/workflows> --cross-repo-contract <articles/generator/data/crawler-cross-repo-contract.json>',
);
