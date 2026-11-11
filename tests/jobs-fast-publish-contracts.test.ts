import { describe, expect, it } from "vitest";
import { extractFirstPartyAssetUrls } from "../scripts/publish-jobs-fast.mjs";

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
});
