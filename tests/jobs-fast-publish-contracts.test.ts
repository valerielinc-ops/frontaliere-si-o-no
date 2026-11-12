import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildFastLaneExpectedPagePlan,
  buildFastLaneRequestHeaders,
  buildFastLaneHubVisibleJobIdsByLocale,
  canonicalPathsForFastLaneJob,
  extractFirstPartyAssetUrls,
  hasGoogleAnalyticsRuntime,
  previousJobSitemapEntriesToRemove,
  validateFullBuildActiveJobAlternates,
} from "../scripts/publish-jobs-fast.mjs";
import { filterFastLaneHubInventory } from "../build-plugins/shared/fastLaneHubInventory";
import {
  ACTIVE_JOB_PAGE_LOCALES,
  buildActiveJobPathOwners,
  localizedActiveJobSlug,
} from "../build-plugins/shared/activeJobPageSelection";
import { buildCanonicalJobDetailPath } from "../build-plugins/shared/jobDetailPath";

describe("jobs fast-publish HTML asset contract", () => {
  it("matches the full build's all-or-nothing active hreflang contract", () => {
    const partialPages = [
      { locale: "it", path: "/it/jobs/partial-it/" },
      { locale: "de", path: "/de/jobs/partial-de/" },
      { locale: "fr", path: "/fr/jobs/partial-fr/" },
    ];
    expect(() =>
      validateFullBuildActiveJobAlternates(new Map(), partialPages, "it"),
    ).not.toThrow();
    expect(() =>
      validateFullBuildActiveJobAlternates(
        new Map([["en", ["https://frontaliereticino.ch/en/jobs/partial-en/"]]]),
        partialPages,
        "it",
      ),
    ).toThrow(/partial locale ownership/);

    const completePages = ["it", "en", "de", "fr"].map((locale) => ({
      locale,
      path: `/${locale}/jobs/full-${locale}/`,
    }));
    const completeAlternates = new Map(
      completePages.map((page) => [
        page.locale,
        [`https://frontaliereticino.ch${page.path}`],
      ]),
    );
    completeAlternates.set("x-default", [
      "https://frontaliereticino.ch/it/jobs/full-it/",
    ]);
    expect(() =>
      validateFullBuildActiveJobAlternates(
        completeAlternates,
        completePages,
        "it",
      ),
    ).not.toThrow();
  });

  it("uses the full renderer's locale ownership for partially translated offers", () => {
    const jobs = [
      { id: "full-build-winner", slug: "shared-route", canton: "TI" },
      {
        id: "partial-translation",
        slug: "partial-role",
        slugByLocale: {
          it: "partial-role-it",
          de: "partial-role-de",
          fr: "partial-role-fr",
          en: "shared-route",
        },
        canton: "TI",
        needsRetranslation: true,
        sourceLang: "de",
      },
      {
        id: "fully-shadowed",
        slug: "shared-route",
        slugByLocale: {
          it: "shared-route",
          en: "shared-route",
          de: "shared-route",
          fr: "shared-route",
        },
        canton: "TI",
      },
    ];
    const helpers = {
      buildCanonicalJobDetailPath,
      resolveJobCanton: (job: { canton: string }) => job.canton,
    };
    const plan = buildFastLaneExpectedPagePlan(
      jobs,
      ["partial-translation", "fully-shadowed"],
      helpers,
    );

    expect(
      plan.pagesById
        .get("partial-translation")
        ?.map((page: { locale: string }) => page.locale),
    ).toEqual(["it", "de", "fr"]);
    expect(plan.suppressedById.get("partial-translation")).toEqual([
      { locale: "en", ownerId: "full-build-winner" },
    ]);
    expect(plan.pagesById.get("fully-shadowed")).toEqual([]);
    expect(plan.suppressedById.get("fully-shadowed")).toEqual([
      { locale: "it", ownerId: "full-build-winner" },
      { locale: "en", ownerId: "full-build-winner" },
      { locale: "de", ownerId: "full-build-winner" },
      { locale: "fr", ownerId: "full-build-winner" },
    ]);

    const pathOwners = buildActiveJobPathOwners(
      jobs,
      ACTIVE_JOB_PAGE_LOCALES,
      helpers.resolveJobCanton,
      localizedActiveJobSlug,
    );
    expect(
      canonicalPathsForFastLaneJob(jobs[1], {
        ...helpers,
        pathOwners,
      }),
    ).toEqual([
      "/cerca-lavoro-ticino/partial-role-it/",
      "/de/jobs-im-tessin/partial-role-de/",
      "/fr/trouver-emploi-tessin/partial-role-fr/",
    ]);
    expect(
      canonicalPathsForFastLaneJob(jobs[2], {
        ...helpers,
        pathOwners,
      }),
    ).toEqual([]);

    const renderer = readFileSync(
      new URL("../build-plugins/jobsSeoPagesPlugin.ts", import.meta.url),
      "utf8",
    );
    expect(renderer).toContain("buildActiveJobPathOwners(");
    expect(renderer).toContain("activeJobPathOwnerKey(");
    expect(renderer).toContain("localizedActiveJobSlug");
  });

  it("preserves previous routes admitted by the full-build sitemap", () => {
    const winner = { id: "full-build-winner", slug: "shared-route", canton: "TI" };
    const noindexWinner = {
      id: "active-noindex-winner",
      slug: "noindex-route",
      canton: "TI",
    };
    const partialTranslation = {
      id: "partial-translation",
      slug: "partial-role",
      slugByLocale: {
        it: "partial-role-it",
        en: "shared-route",
        de: "partial-role-de",
        fr: "partial-role-fr",
      },
      canton: "TI",
      needsRetranslation: true,
      sourceLang: "de",
    };
    const previousWinnerPath = buildCanonicalJobDetailPath(
      "en",
      winner,
      "shared-route",
      "TI",
    );
    const previousNoindexPath = buildCanonicalJobDetailPath(
      "de",
      noindexWinner,
      "noindex-route",
      "TI",
    );
    const previousRemovedPath = buildCanonicalJobDetailPath(
      "fr",
      partialTranslation,
      "previous-role-fr",
      "TI",
    );
    const selectedPages = buildFastLaneExpectedPagePlan(
      [winner, noindexWinner, partialTranslation],
      [partialTranslation.id],
      {
        buildCanonicalJobDetailPath,
        resolveJobCanton: (job: { canton: string }) => job.canton,
      },
    ).pagesById.get(partialTranslation.id);
    const currentReceiptLocs = new Set(
      selectedPages.map((page: { path: string }) =>
        `https://frontaliereticino.ch${page.path}`,
      ),
    );
    const fullBuildSitemapLocs = new Set([
      `https://frontaliereticino.ch${previousWinnerPath}`,
    ]);

    const removals = previousJobSitemapEntriesToRemove(
      [previousWinnerPath, previousNoindexPath, previousRemovedPath],
      currentReceiptLocs,
      fullBuildSitemapLocs,
    );

    expect(removals.map(({ route }: { route: string }) => route)).toEqual([
      previousNoindexPath,
      previousRemovedPath,
    ]);
  });

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
