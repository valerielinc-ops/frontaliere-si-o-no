import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildFastLaneRequestHeaders,
  buildFastLaneHubVisibleJobIdsByLocale,
  extractFirstPartyAssetUrls,
  hasGoogleAnalyticsRuntime,
} from "../scripts/publish-jobs-fast.mjs";
import { filterFastLaneHubInventory } from "../build-plugins/shared/fastLaneHubInventory";
import { buildCanonicalJobDetailPath } from "../build-plugins/shared/jobDetailPath";

describe("jobs fast-publish HTML asset contract", () => {
  it("identifies public requests so Cloudflare accepts the Node publisher", () => {
    expect(buildFastLaneRequestHeaders("text/plain")).toEqual({
      accept: "text/plain",
      "user-agent":
        "FrontaliereJobsFastPublisher/1.0 (+https://frontaliereticino.ch)",
    });
  });

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

  it("recognizes analytics from either the static gtag loader or the SPA entry", () => {
    expect(
      hasGoogleAnalyticsRuntime(
        '<script async src="https://www.googletagmanager.com/gtag/js?id=G-TEST"></script>',
      ),
    ).toBe(true);
    expect(
      hasGoogleAnalyticsRuntime(
        '<script data-src="https://www.googletagmanager.com/gtag/js?id=G-TEST"></script>',
      ),
    ).toBe(false);
    expect(
      hasGoogleAnalyticsRuntime(
        '<script type="module" src="/assets/index-entry.js"></script>',
      ),
    ).toBe(true);
    expect(
      hasGoogleAnalyticsRuntime('<script src="/assets/unrelated.js"></script>'),
    ).toBe(false);
    expect(
      hasGoogleAnalyticsRuntime(
        '<script src="https://cdn.example.test/assets/index-entry.js"></script>',
      ),
    ).toBe(false);
    expect(
      hasGoogleAnalyticsRuntime(
        '<script src="https://analytics.example.test/?next=googletagmanager.com/gtag/js"></script>',
      ),
    ).toBe(false);
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

  it("renders into the fast publisher's isolated staging directory", () => {
    const renderer = readFileSync(
      new URL("../build-plugins/jobsSeoPagesPlugin.ts", import.meta.url),
      "utf8",
    );
    const fastPublisher = readFileSync(
      new URL("../scripts/publish-jobs-fast.mjs", import.meta.url),
      "utf8",
    );

    expect(renderer).toContain("fastLaneDistDir?: string;");
    expect(renderer).toContain("!options.fastLaneDistDir");
    expect(renderer).toContain("np.resolve(rootDir, options.fastLaneDistDir)");
    expect(renderer).toContain("const bundleDistDir = options.fastLane");
    expect(renderer).toContain("? np.resolve(rootDir, 'dist')");
    expect(renderer).toContain("const spaBundle = resolveSpaBundle(bundleDistDir);");
    expect(renderer).toContain("asyncCssHeadBlock(hasSpaBundle ? entryCss : undefined)");
    expect(renderer).toContain('src="/assets/${entryJs}"');
    expect(fastPublisher).toContain("fastLaneDistDir: distDir,");
  });
});
