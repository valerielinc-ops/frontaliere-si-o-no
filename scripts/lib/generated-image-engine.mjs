/**
 * Site-side compatibility entry point.
 *
 * The implementation lives in the mirrored articles engine so the corpus can
 * call the same provider boundary. Keep this path for existing site scripts.
 */
export * from '../../packages/articles/engine/shared/generatedImageEngine.mjs';
