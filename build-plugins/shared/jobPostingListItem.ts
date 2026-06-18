/**
 * Build a `JobPosting` suitable for embedding inside an `ItemList` `ListItem`
 * on a job LIST page (e.g. the editorial city/sector landings).
 *
 * Reuses the canonical `buildJobPostingSchema` builder so the 9 mandatory
 * fields stay consistent with the single-job detail pages, then:
 *   - strips `@context` (the parent ItemList script declares it once), and
 *   - caps `description` to keep list-page JSON-LD light — the full
 *     description lives on the linked detail page, and these landings sit
 *     under a hard 195 KB page-weight budget.
 *
 * NEVER throws: `buildJobPostingSchema` throws when a job is too sparse to
 * yield a valid schema (e.g. no derivable city/canton). On any failure this
 * returns `null` so the caller can fall back to a plain `name` + `url`
 * `ListItem` stub — one bad job can never break the build.
 *
 * Note on Google policy: JobPosting is officially meant for single-job detail
 * pages, not list pages. This embeds it inside an ItemList (the same pattern
 * weeklyEmployersPlugin already uses for company×city hubs) as a richer
 * supplementary signal; the authoritative per-job JobPosting still lives on
 * each linked detail page.
 */
import { buildJobPostingSchema, type JobInput } from './jobPostingSchema';
import { truncateCodeUnits } from './safeTruncate';

/** Max `description` length embedded per list item (full text is on the detail page). */
export const LIST_ITEM_DESCRIPTION_CAP = 300;

export interface ListItemJobPostingOptions {
  readonly locale: string;
  /** Absolute canonical URL of the job's detail page. */
  readonly url: string;
  readonly baseUrl: string;
}

export function buildListItemJobPosting(
  input: JobInput,
  opts: ListItemJobPostingOptions,
): Record<string, unknown> | null {
  try {
    const schema = buildJobPostingSchema(input, opts) as unknown as Record<string, unknown>;
    const { '@context': _omitContext, ...rest } = schema;
    if (typeof rest.description === 'string' && rest.description.length > LIST_ITEM_DESCRIPTION_CAP) {
      // Surrogate-safe cut: a raw slice can split an emoji pair and leave a lone
      // surrogate that makes Google reject the JSON-LD ("Truncated Unicode char").
      rest.description = `${truncateCodeUnits(rest.description, LIST_ITEM_DESCRIPTION_CAP)}…`;
    }
    return rest;
  } catch {
    return null;
  }
}
