import { describe, expect, it } from "vitest";
import {
  listActiveJobSitemapFilenames,
  listJobVariantShardFilenames,
  mergeFastJobSitemapIndex,
  mergeFastJobVariantShard,
  mergeFastJobsSitemap,
  JOBS_FAST_SITEMAP_DEFAULTS,
  nextJobVariantShardFilename,
  routeActiveJobSitemapRemovals,
  selectJobVariantShardFilename,
  staleActiveJobDetailLocs,
  stalePublishedActiveJobDetailLocs,
} from "../scripts/lib/jobs-fast-sitemap.mjs";
import { SITEMAP_SHARD_CAP } from "../scripts/lib/sitemap-limits.mjs";

const rootXml = (rows) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${rows.join("\n")}\n</urlset>\n`;
const urlEntry = (loc) =>
  ` <url>\n <loc>${loc}</loc>\n <changefreq>weekly</changefreq>\n </url>`;
const indexXml = (files) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${files.map((file) => `<sitemap><loc>https://frontaliereticino.ch/${file}</loc></sitemap>`).join("")}</sitemapindex>`;

describe("jobs-fast sitemap merge", () => {
  it("uses the shared full-build cap by default", () => {
    expect(JOBS_FAST_SITEMAP_DEFAULTS.maxUrls).toBe(SITEMAP_SHARD_CAP);
  });

  it("replaces a matching active URL while preserving unrelated entries", () => {
    const target = "https://frontaliereticino.ch/cerca-lavoro-ticino/offer/";
    const unrelated = "https://frontaliereticino.ch/cerca-lavoro-ticino/other/";
    const xml = mergeFastJobsSitemap(
      rootXml([urlEntry(target), urlEntry(unrelated)]),
      [
        {
          loc: target,
          urlEntry: `${urlEntry(target).replace("</url>", "<lastmod>2026-11-11</lastmod></url>")}`,
        },
      ],
    );
    expect(
      xml.match(
        /<loc>https:\/\/frontaliereticino\.ch\/cerca-lavoro-ticino\/offer\//gu,
      ),
    ).toHaveLength(1);
    expect(xml).toContain(unrelated);
    expect(xml).toContain("<lastmod>2026-11-11</lastmod>");
  });

  it("removes stale noindex URLs without dropping other jobs", () => {
    const stale = "https://frontaliereticino.ch/en/jobs-in-tessin/offer/";
    const kept = "https://frontaliereticino.ch/en/jobs-in-tessin/other/";
    const xml = mergeFastJobVariantShard(
      rootXml([urlEntry(stale), urlEntry(kept)]),
      [],
      { removeLocs: [stale] },
    );
    expect(xml).not.toContain(stale);
    expect(xml).toContain(kept);
  });

  it("removes a live detail absent from the candidate receipt without touching hubs or bridges", () => {
    const staleDetail = "https://frontaliereticino.ch/en/jobs-in-tessin/stale-detail/";
    const admittedDetail = "https://frontaliereticino.ch/en/jobs-in-tessin/admitted-detail/";
    const unrelatedHub = "https://frontaliereticino.ch/en/jobs-in-tessin/lugano/";
    const previousSlugBridge = "https://frontaliereticino.ch/en/jobs-in-tessin/previous-detail/";

    const removals = staleActiveJobDetailLocs(
      new Set([staleDetail, admittedDetail]),
      new Set(),
      new Set([admittedDetail]),
    );
    expect(removals).toEqual([staleDetail]);

    const xml = mergeFastJobVariantShard(
      rootXml([
        urlEntry(staleDetail),
        urlEntry(admittedDetail),
        urlEntry(unrelatedHub),
        urlEntry(previousSlugBridge),
      ]),
      [],
      { removeLocs: removals },
    );
    expect(xml).not.toContain(staleDetail);
    expect(xml).toContain(admittedDetail);
    expect(xml).toContain(unrelatedHub);
    expect(xml).toContain(previousSlugBridge);
  });

  it("removes retired detail URLs from every indexed active shard while keeping hubs", () => {
    const staleRoot = "https://frontaliereticino.ch/cerca-lavoro-ticino/retired-root/";
    const staleVariant = "https://frontaliereticino.ch/en/find-jobs-zurich/retired-variant/";
    const currentVariant = "https://frontaliereticino.ch/en/find-jobs-zurich/current/";
    const cantonHub = "https://frontaliereticino.ch/en/find-jobs-zurich/zurich/";
    const companyHub = "https://frontaliereticino.ch/en/find-jobs-zurich/company-acme/";
    const sectorHub = "https://frontaliereticino.ch/en/find-jobs-zurich/it-jobs/";
    const paginationHub = "https://frontaliereticino.ch/en/find-jobs-zurich/page-2/";
    const searchLanding = "https://frontaliereticino.ch/en/find-jobs-zurich/search-engineering/";
    const categoryLanding = "https://frontaliereticino.ch/en/find-jobs-zurich/category-health/";
    const sources = new Map([
      ["/sitemap-jobs.xml", rootXml([urlEntry(staleRoot)])],
      [
        "/sitemap-jobs-zurigo-en.xml",
        rootXml([
          urlEntry(staleVariant),
          urlEntry(currentVariant),
          urlEntry(cantonHub),
          urlEntry(companyHub),
          urlEntry(sectorHub),
          urlEntry(paginationHub),
          urlEntry(searchLanding),
          urlEntry(categoryLanding),
        ]),
      ],
      ["/sitemap-jobs-expired-001.xml", rootXml([urlEntry(staleVariant)])],
    ]);

    const removals = stalePublishedActiveJobDetailLocs(
      sources,
      new Set([currentVariant]),
    );

    expect([...removals].map(([pathname, locs]) => [pathname, [...locs]])).toEqual([
      ["/sitemap-jobs.xml", [staleRoot]],
      ["/sitemap-jobs-zurigo-en.xml", [staleVariant]],
    ]);
    expect(removals.has("/sitemap-jobs-expired-001.xml")).toBe(false);
    expect(removals.get("/sitemap-jobs-zurigo-en.xml")).not.toContain(cantonHub);
    expect(removals.get("/sitemap-jobs-zurigo-en.xml")).not.toContain(companyHub);
    expect(removals.get("/sitemap-jobs-zurigo-en.xml")).not.toContain(sectorHub);
    expect(removals.get("/sitemap-jobs-zurigo-en.xml")).not.toContain(paginationHub);
    expect(removals.get("/sitemap-jobs-zurigo-en.xml")).not.toContain(searchLanding);
    expect(removals.get("/sitemap-jobs-zurigo-en.xml")).not.toContain(categoryLanding);
  });

  it("lists only active job-detail sitemap files from the sitemap index", () => {
    const xml = indexXml([
      "sitemap-jobs.xml",
      "sitemap-jobs-legacy-001.xml",
      "sitemap-jobs-zurigo-en.xml",
      "sitemap-jobs-zurigo-en-001.xml",
      "sitemap-jobs-expired-001.xml",
      "sitemap-events.xml",
    ]);
    expect(listActiveJobSitemapFilenames(xml)).toEqual([
      "sitemap-jobs-legacy-001.xml",
      "sitemap-jobs-zurigo-en-001.xml",
      "sitemap-jobs-zurigo-en.xml",
      "sitemap-jobs.xml",
    ]);
  });

  it("fails closed without every full-build sitemap decision", () => {
    expect(() => staleActiveJobDetailLocs(null, new Set(), new Set())).toThrow(
      /active job-detail inventory must be a complete URL set/u,
    );
    expect(() => staleActiveJobDetailLocs(new Set(), null, new Set())).toThrow(
      /current receipt locations must be a complete URL set/u,
    );
    expect(() => staleActiveJobDetailLocs(new Set(), new Set(), null)).toThrow(
      /full-build sitemap allowlist must be a complete URL set/u,
    );
  });

  it("routes removals to root, legacy and localized shards and returns the verification ledger", () => {
    const rootLoc = "https://frontaliereticino.ch/cerca-lavoro-ticino/root-detail/";
    const legacyLoc = "https://frontaliereticino.ch/cerca-lavoro-zurigo/legacy-detail/";
    const localizedLoc = "https://frontaliereticino.ch/en/find-jobs-zurich/localized-detail/";
    const keptHub = "https://frontaliereticino.ch/en/find-jobs-zurich/zurich/";
    const expiredLoc = "https://frontaliereticino.ch/en/find-jobs-zurich/expired-detail/";
    const sources = new Map([
      ["/sitemap-jobs.xml", rootXml([urlEntry(rootLoc)])],
      ["/sitemap-jobs-legacy-001.xml", rootXml([urlEntry(legacyLoc)])],
      ["/sitemap-jobs-zurigo-en.xml", rootXml([urlEntry(localizedLoc), urlEntry(keptHub)])],
      ["/sitemap-jobs-expired-001.xml", rootXml([urlEntry(expiredLoc)])],
    ]);

    const removals = staleActiveJobDetailLocs(
      new Set([rootLoc, legacyLoc, localizedLoc]),
      new Set(),
      new Set(),
    );
    const plan = routeActiveJobSitemapRemovals(removals, sources);
    expect([...plan].map(([pathname, locs]) => [pathname, [...locs]])).toEqual([
      ["/sitemap-jobs.xml", [rootLoc]],
      ["/sitemap-jobs-legacy-001.xml", [legacyLoc]],
      ["/sitemap-jobs-zurigo-en.xml", [localizedLoc]],
    ]);
    expect([...plan.values()].some((locs) => locs.has(keptHub))).toBe(false);
    expect(plan.has("/sitemap-jobs-expired-001.xml")).toBe(false);
  });

  it("fails closed when one active detail is duplicated across target shards", () => {
    const duplicate = "https://frontaliereticino.ch/en/find-jobs-zurich/duplicate/";
    expect(() => routeActiveJobSitemapRemovals(
      [duplicate],
      new Map([
        ["/sitemap-jobs-zurigo-en.xml", rootXml([urlEntry(duplicate)])],
        ["/sitemap-jobs-zurigo-en-001.xml", rootXml([urlEntry(duplicate)])],
      ]),
    )).toThrow(/appears in multiple sitemap files/u);
  });

  it("fails closed at the URL cap and selects numbered parts deterministically", () => {
    expect(() =>
      mergeFastJobsSitemap(
        rootXml([urlEntry("https://frontaliereticino.ch/a/")]),
        [
          {
            loc: "https://frontaliereticino.ch/b/",
            urlEntry: urlEntry("https://frontaliereticino.ch/b/"),
          },
        ],
        { maxUrls: 1 },
      ),
    ).toThrow(/would exceed 1 URLs/u);

    const xml = indexXml([
      "sitemap-jobs-ticino-en.xml",
      "sitemap-jobs-ticino-en-001.xml",
      "sitemap-jobs-ticino-en-002.xml",
    ]);
    expect(listJobVariantShardFilenames(xml, "ticino", "en")).toEqual([
      "sitemap-jobs-ticino-en.xml",
      "sitemap-jobs-ticino-en-001.xml",
      "sitemap-jobs-ticino-en-002.xml",
    ]);
    expect(selectJobVariantShardFilename(xml, "ticino", "en")).toBe(
      "sitemap-jobs-ticino-en-002.xml",
    );
    expect(nextJobVariantShardFilename(xml, "ticino", "en")).toBe(
      "sitemap-jobs-ticino-en-003.xml",
    );
  });

  it("adds an unseen locale shard to the index idempotently", () => {
    const start = indexXml(["sitemap-jobs-ticino-en.xml"]);
    const first = mergeFastJobSitemapIndex(
      start,
      ["sitemap-jobs-ticino-en-001.xml"],
      "2026-11-11",
    );
    const second = mergeFastJobSitemapIndex(
      first,
      ["sitemap-jobs-ticino-en-001.xml"],
      "2026-11-11",
    );
    expect(first).toContain("sitemap-jobs-ticino-en-001.xml");
    expect(second.match(/sitemap-jobs-ticino-en-001\.xml/gu)).toHaveLength(1);
  });
});
