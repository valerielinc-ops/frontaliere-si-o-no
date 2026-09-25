import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(resolve(process.cwd(), "App.tsx"), "utf8");

describe("plate-auction navigation placement", () => {
  it("keeps the direct route in the footer without adding it to the header tabs", () => {
    const footerStart = appSource.indexOf('data-testid="footer-seo-links"');
    const footerEnd = appSource.indexOf("</nav>", footerStart);
    expect(footerStart).toBeGreaterThan(-1);
    expect(appSource.slice(footerStart, footerEnd)).toContain(
      'data-testid="footer-plate-auctions-link"',
    );

    const headerSource = appSource.slice(0, footerStart);
    expect(headerSource).not.toContain(
      "role=\"tab\" aria-selected={activeTab === 'plate-auctions'}",
    );
  });

  it("keeps the mobile quick navigation at six balanced items", () => {
    const mobileStart = appSource.indexOf('aria-label="Navigazione mobile"');
    const mobileEnd = appSource.indexOf("</nav>", mobileStart);
    const mobileSource = appSource.slice(mobileStart, mobileEnd);
    expect(mobileSource).toContain("grid-cols-6");
    expect(mobileSource).not.toContain("tab: 'plate-auctions'");
  });
});
