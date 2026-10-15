// Colocation shim (issue #4881 Fase 6) — the real implementation now lives
// in `packages/articles/engine/articleSeoFallback.ts`. This file exists only
// so every pre-existing `build-plugins/articleSeoFallback` import keeps
// resolving without edits. The bootstrap import MUST run before the package
// module is evaluated — it wires the real site values into
// `configureSiteShell()` that the package reads via `getSiteShell()`.
import './articlesSiteShellBootstrap';
export * from '../packages/articles/engine/articleSeoFallback';
