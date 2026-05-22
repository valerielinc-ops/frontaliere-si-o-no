/**
 * Shared render context for the static job-detail page emitters.
 *
 * Phase 1 of the L3 refactor: extracts the SPA-parity IIFE blocks
 * (hero badges, mobile action block, highlights chips, right rail) from
 * `build-plugins/jobsSeoPagesPlugin.ts` into pure-TS modules so Phase 2
 * can hand the same renderers to the React SPA via dangerouslySetInnerHTML
 * (or a stricter equivalent). Each emitter takes a slice of this context
 * via `Pick<JobDetailRenderContext, ...>` and returns a self-contained
 * HTML string. No closure variables, no plugin-local imports.
 */
export type JobDetailLocale = 'it' | 'en' | 'de' | 'fr';

/**
 * Minimum job shape consumed by the detail emitters. Kept permissive
 * (`unknown`/optional everywhere except the discriminator-relevant
 * `featured` / `category`) because the upstream `data/jobs.json` schema
 * is intentionally loose — crawler outputs vary in completeness, and
 * the plugin already filters / normalises before reaching the body
 * template. The fields below are exactly the ones the four extracted
 * blocks read.
 */
export interface JobDetailJob {
  readonly slug?: string;
  readonly id?: string;
  readonly title?: string;
  readonly company?: string;
  readonly location?: string;
  readonly canton?: string;
  readonly category?: string;
  readonly contract?: string;
  readonly featured?: boolean;
  readonly postedDate?: string;
  readonly crawledAt?: string;
  readonly url?: string;
}

/**
 * Strict context required by every job-detail emitter under this folder.
 * Lives at the boundary between the plugin closure (which assembles the
 * fields from `data/jobs.json` + canonical AI data + per-job derived
 * state) and the pure HTML renderers.
 */
export interface JobDetailRenderContext {
  readonly job: JobDetailJob;
  readonly locale: JobDetailLocale;

  /** Pre-computed string used when a salary number is finite (matches
   *  the plugin's NumberFormat-driven `salaryText`). */
  readonly salaryText: string;
  /** May be NaN/undefined when the source job lacks salary data; emitters
   *  gate on `Number.isFinite(salaryMin)` to decide whether the salary
   *  pill / mobile salary line / rail salary card show. */
  readonly salaryMin: number;

  /** Already-resolved canonical apply URL for this job-detail page. */
  readonly canonicalUrl: string;

  /** Address fields used by the right rail's location card and the
   *  mobile action block's location tile. */
  readonly addressLocality: string;
  readonly addressRegion: string;
  readonly postalCode: string;

  /** Subset of the plugin's `localeCopy` we actually need in these
   *  blocks. Kept as a flat shape so it's trivial to satisfy from the
   *  plugin side (`pick`-style assignment, no transitive coupling). */
  readonly localeLabels: {
    readonly applyNow: string;
    readonly quickDetails: string;
    readonly location: string;
    readonly contract: string;
  };

  /**
   * Optional canonical-locale block (the AI-enriched per-locale data
   * read off `_canonical.<locale>`). The highlights emitter reads
   * `.highlights` when present and falls back to `canonicalKeywords`.
   * Typed as `unknown`-with-shape because the upstream blob is loose
   * JSON; the emitter narrows safely.
   */
  readonly canonicalLocale?: { highlights?: unknown };

  /** Already-cleaned keywords used by the highlights fallback and the
   *  right rail's "related searches" chip row. */
  readonly canonicalKeywords: ReadonlyArray<string>;

  /**
   * UTM-decorated apply URL builder. Passed in from the plugin so the
   * emitter doesn't need to know about UTM conventions — keeps this
   * module a pure HTML renderer.
   */
  readonly referralUrl: (raw: string, job: JobDetailJob) => string;

  /**
   * HTML escaper. Both `escHtml` from `../htmlEscape` and the plugin's
   * local `esc` produce identical output; the plugin passes its own
   * `esc` for byte-stable parity during the extraction.
   */
  readonly esc: (s: string) => string;
}
