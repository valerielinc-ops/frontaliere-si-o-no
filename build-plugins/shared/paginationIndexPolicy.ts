// The pagination index policy lives inside `packages/articles` because the
// article archive emitter there (`renderArticleHubPages`) must apply the same
// rule as `emitSeoHubs`, and that package may not import from outside its own
// folder (tests/packages-articles-confinement.test.ts). Re-exported here so
// every site emitter keeps importing it from `build-plugins/shared`.
export * from '../../packages/articles/engine/shared/paginationIndexPolicy';
