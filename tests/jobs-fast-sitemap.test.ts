import { describe, expect, it } from "vitest";
import {
  listJobVariantShardFilenames,
  mergeFastJobSitemapIndex,
  mergeFastJobVariantShard,
  mergeFastJobsSitemap,
  nextJobVariantShardFilename,
  selectJobVariantShardFilename,
} from "../scripts/lib/jobs-fast-sitemap.mjs";

const rootXml = (rows) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${rows.join("\n")}\n</urlset>\n`;
const urlEntry = (loc) =>
  ` <url>\n <loc>${loc}</loc>\n <changefreq>weekly</changefreq>\n </url>`;
const indexXml = (files) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${files.map((file) => `<sitemap><loc>https://frontaliereticino.ch/${file}</loc></sitemap>`).join("")}</sitemapindex>`;

describe("jobs-fast sitemap merge", () => {
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
