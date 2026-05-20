// scripts/lib/schemas/index.mjs
// Barrel export for all Zod schemas used at assemble/build time.
// Schemas live in this directory and are consumed by Node ESM scripts
// (scripts/*.mjs) and TypeScript build plugins (build-plugins/**/*.ts).
//
// Adding a new schema? Add the file alongside this index, then add a
// re-export line below.

export * from './seoText.mjs';
export * from './job.mjs';
export * from './article.mjs';
export * from './orphanCluster.mjs';
export * from './healthPremium.mjs';
export * from './fuelDaily.mjs';
export * from './borderWait.mjs';
