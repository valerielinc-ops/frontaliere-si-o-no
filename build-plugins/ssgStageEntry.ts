// Rollup sentinel for the second half of the staged production build.
//
// The SEO emitters run from closeBundle and do not need an application module
// graph. Keeping this entry deliberately empty means the SSG process owns only
// this module instead of retaining the full Vite/Rollup SPA graph while it
// renders hundreds of thousands of pages.
export {};
