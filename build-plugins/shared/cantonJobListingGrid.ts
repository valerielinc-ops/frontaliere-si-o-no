import {
  JOB_CARD_ICON_SYMBOLS,
  renderJobCardHtml,
  type JobCardJob,
  type JobCardLocale,
} from "./jobCardHtml";
import { infeedAdGridBlockHtml } from "../lib/adSlotHtml";
import { shouldPlaceInfeedAd } from "../../services/adsenseSlots";
import {
  isInfeedAdExperimentActiveFromEnv,
  isInfeedAdExperimentSurface,
  resolveInfeedAdVariant,
} from "../../services/adExperiment";

export const CANTON_LISTING_GRID_START = "<!--JOBS_FAST_LANE_LIST_START-->";
export const CANTON_LISTING_GRID_END = "<!--JOBS_FAST_LANE_LIST_END-->";

export interface CantonListingItem {
  job: JobCardJob;
  href: string;
}

const HEADING: Record<JobCardLocale, (display: string) => string> = {
  it: (display) => `Ultime offerte di lavoro in ${display}`,
  en: (display) => `Latest job openings in ${display}`,
  de: (display) => `Aktuelle Stellenangebote in ${display}`,
  fr: (display) => `Dernières offres d'emploi à ${display}`,
};

/** Shared renderer for the canton hub's first-page active job list. */
export function renderCantonJobListingGrid(options: {
  locale: JobCardLocale;
  canton: string;
  display: string;
  jobs: readonly CantonListingItem[];
  adExperimentActive?: boolean;
}): string {
  const { locale, canton, display, jobs } = options;
  if (jobs.length === 0)
    return `${CANTON_LISTING_GRID_START}${CANTON_LISTING_GRID_END}`;
  const adExperimentActive =
    options.adExperimentActive ??
    isInfeedAdExperimentActiveFromEnv(process.env);
  const cards = jobs
    .map(({ job, href }, index) => {
      const card = renderJobCardHtml(job, { href, locale });
      const variant = isInfeedAdExperimentSurface(canton)
        ? resolveInfeedAdVariant(canton, { active: adExperimentActive })
        : undefined;
      const ad =
        index + 1 < jobs.length &&
        shouldPlaceInfeedAd(index + 1, {
          canton,
          adExperimentActive,
        })
          ? infeedAdGridBlockHtml({ experimentVariant: variant })
          : "";
      return card + ad;
    })
    .join("");
  return (
    `${CANTON_LISTING_GRID_START}` +
    `<h2 class="s-iEVPhz">${escapeHtml(HEADING[locale](display))}</h2>` +
    `<section data-listing-grid data-jobs-fast-list-grid class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4 my-6">` +
    JOB_CARD_ICON_SYMBOLS +
    cards +
    `</section>` +
    `${CANTON_LISTING_GRID_END}`
  );
}

/** Replace only the shared list region; never edit a page without its marker. */
export function replaceCantonJobListingGrid(
  html: string,
  grid: string,
): string {
  const start = html.indexOf(CANTON_LISTING_GRID_START);
  const endMarker = html.indexOf(CANTON_LISTING_GRID_END);
  if (start >= 0 || endMarker >= 0) {
    if (
      start < 0 ||
      endMarker < start ||
      html.indexOf(CANTON_LISTING_GRID_START, start + 1) >= 0 ||
      html.indexOf(CANTON_LISTING_GRID_END, endMarker + 1) >= 0
    ) {
      throw new Error(
        "[jobs-fast-list] missing, reversed, or duplicate list markers",
      );
    }
    return `${html.slice(0, start)}${grid}${html.slice(endMarker + CANTON_LISTING_GRID_END.length)}`;
  }

  // The live shard can predate the first deploy carrying our markers. Upgrade
  // its one existing canton list in place so the fast lane can start without
  // waiting for a full-site rebuild; ambiguous legacy markup stays fail-closed.
  const legacySections = [
    ...html.matchAll(/<section\b[^>]*\bdata-listing-grid(?:\s|=|>)[^>]*>/giu),
  ];
  if (legacySections.length !== 1) {
    throw new Error(
      "[jobs-fast-list] legacy page has missing or ambiguous listing grid",
    );
  }
  const sectionStart = legacySections[0].index;
  const headingStart = html.lastIndexOf("<h2", sectionStart);
  const headingEnd =
    headingStart >= 0 ? html.indexOf("</h2>", headingStart) : -1;
  const sectionEnd = html.indexOf("</section>", sectionStart);
  if (
    sectionStart === undefined ||
    headingStart < 0 ||
    headingEnd < 0 ||
    html.slice(headingEnd + "</h2>".length, sectionStart).trim() !== "" ||
    sectionEnd < 0
  ) {
    throw new Error(
      "[jobs-fast-list] legacy listing grid boundaries are ambiguous",
    );
  }
  return `${html.slice(0, headingStart)}${grid}${html.slice(sectionEnd + "</section>".length)}`;
}

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
