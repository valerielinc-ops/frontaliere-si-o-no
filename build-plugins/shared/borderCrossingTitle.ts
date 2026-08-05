/**
 * <title> composition for the border-crossing wait pages
 * (`/guida-frontaliere/tempi-attesa-dogana/<crossing-id>/`).
 *
 * Leaf module by design: it imports nothing but `./titleSuffix`, so the
 * regression suite can exercise it without dragging in `staticPagesPlugin`'s
 * whole data graph (`data/*.json`, `public/assets/*`) — the same reason
 * `injectContextualLinks` was moved to a leaf in #4959.
 *
 * Why the cascade (issue #4828)
 * -----------------------------
 * Same regression class as #3772/#4593/#4886: a fixed boilerplate sized for the
 * curated Ticino valichi (Chiasso, Brogeda, Stabio) that later had to carry
 * nationwide data. The crossing set now spans the whole Swiss border, and the
 * DE/FR ids encode a municipality PAIR plus a street —
 * `busingen-am-hochrhein-schaffhausen-gennersbrunnerstrasse` renders a 56-char
 * label, which the 38-char rich boilerplate pushes to 94 chars.
 *
 * Post-deploy validation run 30974294824: 44 of the ~54 full-corpus
 * `spa-other` offenders were this one template, tripping the
 * `audit:title-length` per-feature rate ratchet (3.476 % vs 1.996 % allowed,
 * 17 offenders vs a cap of 13).
 *
 * The rungs are longest-first and every rung embeds the FULL label: the
 * boilerplate shrinks, the place name never does. The shortest rung keeps the
 * "Dogana" token so it can never degrade to a keyword-free bare label
 * (#4886 Item 1) — a bare place name stays under the cap but carries no query
 * intent, so it would be SEO-dead if ever selected.
 */
import { clampMetaDescription, composePlaceTitle, TITLE_MAX_CHARS } from './titleSuffix';

/**
 * Human-readable crossing label derived from the crossing id.
 *
 * Single source of truth: `staticPagesPlugin`'s emit loop and the regression
 * suite both call this instead of re-implementing the slug→label transform,
 * so a change to the transform can't silently desynchronise the gate from the
 * emitter (AGENTS.md non-negotiable #6).
 */
export function borderCrossingLabel(crossingId: string): string {
  return crossingId.replace(/-/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

/**
 * Budget-aware, place-preserving <title> for one border crossing.
 *
 * Raw `.length` (composePlaceTitle's default measure) is exact here, unlike the
 * crawler-derived-token callers that must pass `(s) => esc(s).length`: the
 * label comes from a slug id (`[a-z0-9-]+`), so it can never contain an
 * `&`/`<`/`>`/`"` that would expand on escape.
 */
export function buildBorderCrossingTitle(label: string): string {
  return composePlaceTitle(
    [
      `Traffico dogana ${label} | Tempi attesa valico`,
      `Traffico dogana ${label} | Tempi attesa`,
      `Dogana ${label} | Tempi attesa`,
      `Tempi attesa dogana ${label}`,
      `Dogana ${label}`,
    ],
    TITLE_MAX_CHARS,
  );
}

/**
 * `<meta name="description">` for one border crossing, clamped to the SERP
 * snippet budget.
 *
 * Same unbounded-label defect as the title, one layer down: the fixed copy is
 * 107 chars, so the two longest live crossing labels push the raw string to
 * 163-166 chars and Google drops the tail ("…consigli pratici per frontalieri
 * al valico") from the displayed snippet. `clampMetaDescription` is the
 * repo-wide safety net for exactly this (SearchAtlas `meta_desc_invalid_length`);
 * applying it here keeps the SSG page and the SPA runtime head byte-identical.
 */
export function buildBorderCrossingDescription(label: string): string {
  return clampMetaDescription(
    `Traffico dogana ${label} in tempo reale: tempi di attesa, orari apertura e consigli pratici per frontalieri al valico.`,
  );
}
