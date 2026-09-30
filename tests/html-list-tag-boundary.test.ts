import { describe, expect, it } from "vitest";

import { stripHtml } from "../scripts/lib/crawler-template.mjs";
import { htmlToText } from "../scripts/lib/hospital-custom-html-helpers.mjs";

const HTML_WITH_SVG_TAG_NAMES =
  '<svg><line x1="0" x2="1"/><link rel="stylesheet" href="theme.css"/></svg>' +
  '<ul><li>Reale voce</li></ul>';

describe("HTML list tag boundaries", () => {
  it.each([
    ["crawler-template stripHtml", stripHtml],
    ["hospital htmlToText", htmlToText],
  ])("$0 recognizes only an actual li element", (_label, convert) => {
    expect(convert(HTML_WITH_SVG_TAG_NAMES)).toBe("• Reale voce");
  });
});
