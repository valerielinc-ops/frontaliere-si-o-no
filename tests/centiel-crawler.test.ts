import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchHtml, pdfGetText, writeJsonAtomic } = vi.hoisted(() => ({
  fetchHtml: vi.fn(),
  pdfGetText: vi.fn(),
  writeJsonAtomic: vi.fn(),
}));
vi.mock("@/scripts/lib/crawler-template.mjs", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, fetchHtml };
});
vi.mock("pdf-parse", () => ({
  PDFParse: class {
    getText() {
      return pdfGetText();
    }
  },
}));
vi.mock("@/scripts/lib/atomic-write-json.mjs", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, writeJsonAtomic };
});

import { main, parseCareersPage } from "../scripts/update-centiel-jobs.mjs";

const LIVE_LISTINGS = [
  [
    "Product Manager &#8211; Critical Power",
    "https://www.centiel.com/wp-content/uploads/2026/07/2026.06-JD-EG-Product-Manager-Critical-Power.pdf",
  ],
  [
    "Specialista Ufficio Tecnico",
    "https://www.centiel.com/wp-content/uploads/2026/07/2026.06-JD-IT-Specialista-ufficio-tecnico.pdf",
  ],
  [
    "Operatore di produzione",
    "https://www.centiel.com/wp-content/uploads/2026/07/2026.03-JD-IT-operatore-di-produzione.pdf",
  ],
  [
    "Tecnico Collaudatore",
    "https://www.centiel.com/wp-content/uploads/2026/07/2026.03-JD-IT-tecnico-collaudatore.pdf",
  ],
  [
    "Technical Services Manager &#8211; Centiel UK",
    "https://www.centiel.com/wp-content/uploads/2026/06/Job_Posting_Technical_Services_Manager_UK.pdf",
  ],
  [
    "Project Manager – Critical Power",
    "https://www.centiel.com/wp-content/uploads/2026/05/2026.02-JD-EG-Project-Manager-Critical-Power.pdf",
  ],
  [
    "Pre-Sales Application Engineer – Critical Power",
    "https://www.centiel.com/wp-content/uploads/2026/05/2026.02-JD-EG-Pre-sales-Application-Engineer-CP.pdf",
  ],
  [
    "Research &#038; Development Engineer",
    "https://www.centiel.com/wp-content/uploads/2025/11/2025.11-JD-EG-RD-Engineer-Rev1.pdf",
  ],
  [
    "After-Sales Technician",
    "https://www.centiel.com/wp-content/uploads/2025/05/Job_profile_After_Sales_Technician.pdf",
  ],
] as const;

const LIVE_CAREERS_FIXTURE = `
  <html><body>
    ${LIVE_LISTINGS.map(
      ([title, pdf]) => `
      <div class="accordion-item">
        <button><h3 class="block-title">${title}</h3></button>
        <div class="accordion-content"><div class="career-block"><div class="block-content">
          <p>Join Centiel in this role.</p>
          <p><strong>Workplace:</strong> Cadro (Lugano), with occasional travel</p>
          <p><strong>Reporting to:</strong> Head of Department</p>
          <p><strong>Working rate:</strong> 100%</p>
          <p><a href="${pdf}">Learn more</a></p>
        </div></div></div>
      </div>`,
    ).join("")}
  </body></html>`;

const VALID_LISTING_FIXTURE = `
  <div class="accordion-item">
    <h3 class="block-title">Valid role</h3>
    <div class="block-content">
      <p>Full role details.</p>
      <a href="https://www.centiel.com/jobs/valid-role.pdf">Learn more</a>
    </div>
  </div>`;

describe("Centiel careers parser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pdfGetText.mockResolvedValue({ text: "Usable PDF content" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves all nine listings from the observed live accordion payload", () => {
    const jobs = parseCareersPage(LIVE_CAREERS_FIXTURE);

    expect(jobs).toHaveLength(9);
    expect(jobs.map((job) => job.title)).toEqual([
      "Product Manager – Critical Power",
      "Specialista Ufficio Tecnico",
      "Operatore di produzione",
      "Tecnico Collaudatore",
      "Technical Services Manager – Centiel UK",
      "Project Manager – Critical Power",
      "Pre-Sales Application Engineer – Critical Power",
      "Research & Development Engineer",
      "After-Sales Technician",
    ]);
    expect(jobs.every((job) => job.pdfUrl.endsWith(".pdf"))).toBe(true);
  });

  it("accepts a listing without a PDF only when its inline content is substantial", () => {
    const html = `
      <div class="accordion-item">
        <h3 class="block-title">Inline-only role</h3>
        <div class="block-content">
          This is a complete inline job description with enough concrete information about responsibilities,
          qualifications, workplace, collaboration, customer support, engineering activities, employment terms,
          application expectations, professional experience, communication skills, and the Centiel team in Cadro.
        </div>
      </div>`;

    expect(parseCareersPage(html)).toEqual([
      expect.objectContaining({ title: "Inline-only role", pdfUrl: "" }),
    ]);
  });

  it.each([
    [
      "zero-result page",
      "<html><body><p>No open positions</p></body></html>",
      /zero valid accordion listings.*refusing to publish/i,
    ],
    [
      "partially malformed payload",
      `${VALID_LISTING_FIXTURE}<div class="accordion-item"><h3 class="block-title">Broken role</h3></div>`,
      /accordion 2.*missing \.block-content.*partial crawl/i,
    ],
    [
      "missing title",
      '<div class="accordion-item"><div class="block-content">A complete description that must not hide a missing title even when it contains plenty of otherwise usable words for this Centiel vacancy in Cadro.</div></div>',
      /accordion 1.*missing a job title.*partial crawl/i,
    ],
    [
      "empty content block",
      '<div class="accordion-item"><h3 class="block-title">Empty role</h3><div class="block-content"></div></div>',
      /neither a trusted PDF nor substantial inline content.*partial crawl/i,
    ],
    [
      "short placeholder without PDF",
      '<div class="accordion-item"><h3 class="block-title">Placeholder role</h3><div class="block-content">Details coming soon.</div></div>',
      /neither a trusted PDF nor substantial inline content.*partial crawl/i,
    ],
    [
      "untrusted PDF",
      '<div class="accordion-item"><h3 class="block-title">Redirected role</h3><div class="block-content"><a href="https://example.com/role.pdf">Learn more</a></div></div>',
      /untrusted PDF URL.*partial crawl/i,
    ],
    [
      "query-only PDF suffix",
      '<div class="accordion-item"><h3 class="block-title">Query role</h3><div class="block-content"><a href="https://www.centiel.com/download?file=role.pdf">Learn more</a></div></div>',
      /PDF URL path must end in \.pdf.*partial crawl/i,
    ],
    [
      "HTTP PDF URL",
      '<div class="accordion-item"><h3 class="block-title">HTTP role</h3><div class="block-content"><a href="http://www.centiel.com/jobs/role.pdf">Learn more</a></div></div>',
      /PDF URL must use HTTPS.*partial crawl/i,
    ],
    [
      "FTP PDF URL",
      '<div class="accordion-item"><h3 class="block-title">FTP role</h3><div class="block-content"><a href="ftp://www.centiel.com/jobs/role.pdf">Learn more</a></div></div>',
      /PDF URL must use HTTPS.*partial crawl/i,
    ],
  ])("fails closed for a %s", (_case, html, expectedError) => {
    expect(() => parseCareersPage(html)).toThrow(expectedError);
  });

  it.each([
    [
      "HTTP 404",
      () =>
        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue({ ok: false, status: 404 }),
        ),
    ],
    [
      "network rejection",
      () =>
        vi.stubGlobal(
          "fetch",
          vi.fn().mockRejectedValue(new Error("network unavailable")),
        ),
    ],
    [
      "PDF parse failure",
      () => {
        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue({
            ok: true,
            arrayBuffer: async () => new ArrayBuffer(8),
          }),
        );
        pdfGetText.mockRejectedValue(new Error("invalid PDF payload"));
      },
    ],
    [
      "short PDF text",
      () => {
        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue({
            ok: true,
            arrayBuffer: async () => new ArrayBuffer(8),
          }),
        );
        pdfGetText.mockResolvedValue({ text: "Page 1" });
      },
    ],
  ])(
    "fails closed after a %s leaves no substantial selected content",
    async (_case, arrange) => {
      fetchHtml.mockResolvedValueOnce(VALID_LISTING_FIXTURE);
      arrange();

      await expect(main()).rejects.toThrow(
        /selected description has only \d+ words.*partial crawl/i,
      );
      expect(writeJsonAtomic).not.toHaveBeenCalled();
    },
  );
});
