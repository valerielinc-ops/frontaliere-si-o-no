import { describe, expect, it } from "vitest";
import {
  CANTON_LISTING_GRID_END,
  CANTON_LISTING_GRID_START,
  renderCantonJobListingGrid,
  replaceCantonJobListingGrid,
} from "../build-plugins/shared/cantonJobListingGrid";

describe("fast-lane canton listing grid replacement", () => {
  it("keeps the static listing flow aligned with the hydrated job board", () => {
    const html = renderCantonJobListingGrid({
      locale: "it",
      canton: "ZH",
      display: "Zurigo",
      jobs: [{ job: { title: "Ruolo", company: "Azienda", location: "Zurigo" }, href: "/lavoro/ruolo/" }],
      adExperimentActive: false,
    });

    expect(html).toContain('class="space-y-3 min-h-[600px] my-6"');
    expect(html).not.toContain("sm:grid-cols-2");
    expect(html).not.toContain("lg:grid-cols-3");
  });

  it("replaces a marked grid without changing surrounding page content", () => {
    const current = `<main>before${CANTON_LISTING_GRID_START}<section data-listing-grid>old</section>${CANTON_LISTING_GRID_END}after</main>`;
    const next = `${CANTON_LISTING_GRID_START}<section data-listing-grid>new</section>${CANTON_LISTING_GRID_END}`;

    expect(replaceCantonJobListingGrid(current, next)).toBe(
      `<main>before${next}after</main>`,
    );
  });

  it("upgrades the one legacy unmarked canton grid before the full deploy lands", () => {
    const legacy = `<main><h2 class="heading">Old jobs</h2><section data-listing-grid class="grid">old cards</section><p>keep this</p></main>`;
    const next = `${CANTON_LISTING_GRID_START}<h2>New jobs</h2><section data-listing-grid>new cards</section>${CANTON_LISTING_GRID_END}`;

    expect(replaceCantonJobListingGrid(legacy, next)).toBe(
      `<main>${next}<p>keep this</p></main>`,
    );
  });

  it("fails closed when legacy listing boundaries are ambiguous", () => {
    expect(() =>
      replaceCantonJobListingGrid(
        `<main><h2>Old jobs</h2><section data-listing-grid>old</section><section data-listing-grid>second</section></main>`,
        "replacement",
      ),
    ).toThrow(/ambiguous listing grid/u);
  });
});
