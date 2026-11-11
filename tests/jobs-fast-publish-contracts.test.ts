import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildFastLaneHubVisibleJobIdsByLocale,
  extractFirstPartyAssetUrls,
} from "../scripts/publish-jobs-fast.mjs";
import { filterFastLaneHubInventory } from "../build-plugins/shared/fastLaneHubInventory";
import { buildCanonicalJobDetailPath } from "../build-plugins/shared/jobDetailPath";

describe("jobs fast-publish HTML asset contract", () => {
  it("checks fetchable first-party resources without probing canonical or hreflang page URLs", () => {
    const html = `
      <meta property="og:image" content="https://cdn.frontaliereticino.ch/jobs/offer.jpg">
      <script src="/assets/site.js"></script>
      <img src="/images/employer.svg">
      <link rel="stylesheet" href="/assets/site.css">
      <link rel="modulepreload" href="/assets/chunk.js">
      <link rel="canonical" href="https://frontaliereticino.ch/cerca-lavoro-ticino/new-offer/">
      <link rel="alternate" hreflang="en" href="https://frontaliereticino.ch/en/jobs-in-tessin/new-offer/">
      <link rel="stylesheet" href="https://fonts.example.test/font.css">
    `;
    const assets = extractFirstPartyAssetUrls(html);
    expect(assets).toEqual([
      "/assets/chunk.js",
      "/assets/site.css",
      "/assets/site.js",
      "/images/employer.svg",
      "https://cdn.frontaliereticino.ch/jobs/offer.jpg",
    ]);
    expect(assets).not.toContain(
      "https://frontaliereticino.ch/cerca-lavoro-ticino/new-offer/",
    );
    expect(assets).not.toContain(
      "https://frontaliereticino.ch/en/jobs-in-tessin/new-offer/",
    );
  });

  it("keeps fast-lane hub cards to selected jobs and locale URLs in the live sitemap", () => {
    const jobs = [
      { id: "A", slug: "alpha", canton: "TI" },
      { id: "B", slug: "beta", canton: "TI" },
    ];
    const sitemap = `
      <urlset>
        <url>
          <loc>https://frontaliereticino.ch/cerca-lavoro-ticino/beta/</loc>
          <xhtml:link rel="alternate" hreflang="en" href="https://frontaliereticino.ch/en/find-jobs-ticino/beta/" />
        </url>
      </urlset>
    `;
    const visible = buildFastLaneHubVisibleJobIdsByLocale(
      jobs,
      ["A"],
      sitemap,
      {
        buildCanonicalJobDetailPath,
        resolveJobCanton: (job: { canton: string }) => job.canton,
      },
    );

    expect(visible.it).toEqual(["A", "B"]);
    expect(visible.en).toEqual(["A", "B"]);
    expect(visible.de).toEqual(["A"]);
    expect(visible.fr).toEqual(["A"]);
    expect(
      filterFastLaneHubInventory(jobs, new Set(visible.de)).map(
        (job) => job.id,
      ),
    ).toEqual(["A"]);

    const renderer = readFileSync(
      new URL("../build-plugins/jobsSeoPagesPlugin.ts", import.meta.url),
      "utf8",
    );
    expect(renderer).toContain(
      "filterFastLaneHubInventory(tiRecent, visibleIds)",
    );
    expect(renderer).toContain(
      "filterFastLaneHubInventory(cantonInventory, visibleIds)",
    );
  });
});
