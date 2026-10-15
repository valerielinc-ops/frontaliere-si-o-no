import { describe, expect, it } from "vitest";
import {
  aggregateRows,
  aggregateTsv,
  canonicalFuel,
  mergePeriods,
  normalizeCanton,
  SWISS_CANTON_CODES,
} from "../scripts/lib/astra-vehicle-stats-parser.mjs";

describe("ASTRA vehicle statistics parser", () => {
  it("aggregates raw TSV rows by canton, fuel and CO2", () => {
    const raw = [
      "Treibstoff\tHybridcode\tCO2-WLTP\tErstinverkehrsetzung_Kanton\tDatenstand",
      "Elektrisch\t\t0\tTI\t01.09.2026",
      "Benzin / Elektrisch\t\t40\tZH\t01.09.2026",
      "Diesel\t\t120\tTI\t01.09.2026",
    ].join("\n");

    const result = aggregateTsv(raw, { dataset: "test" });

    expect(result.national.total).toBe(3);
    expect(result.national.electric).toBe(1);
    expect(result.national.plugInHybrid).toBe(1);
    expect(result.byCanton.TI.total).toBe(2);
    expect(result.byCanton.TI.diesel).toBe(1);
    expect(result.byCanton.ZH.plugInHybrid).toBe(1);
    expect(result.dataAsOf).toBe("01.09.2026");
  });

  it("weights weekly report rows by Anzahl Fahrzeuge", () => {
    const result = aggregateRows(
      [
        "Anzahl Fahrzeuge",
        "Treibstoff",
        "Erstinverkehrsetzung_Woche",
        "Erstinverkehrsetzung_Jahr",
        "Erstinverkehrsetzung_Kanton",
      ],
      [
        ["12", "Benzin", "36", "2026", "TI"],
        ["3", "Elektrisch", "38", "2026", "ZH"],
      ],
      { dataset: "weekly" },
    );

    expect(result.national.total).toBe(15);
    expect(result.byCanton.TI.petrol).toBe(12);
    expect(result.byCanton.ZH.electric).toBe(3);
    expect(result.period).toBe("2026-W38");
  });

  it("keeps only the 26 Swiss cantons", () => {
    expect(SWISS_CANTON_CODES).toHaveLength(26);
    expect(normalizeCanton("TI")).toBe("TI");
    expect(normalizeCanton("LI")).toBeNull();
    expect(canonicalFuel("Diesel / Elektrisch")).toBe("plugInHybrid");

    const result = aggregateRows(
      ["Kanton", "Treibstoff", "Anzahl Fahrzeuge"],
      [
        ["TI", "Elektrisch", "2"],
        ["ZH", "Benzin", "3"],
        ["LI", "Diesel", "50"],
        ["", "Diesel", "50"],
      ],
      { dataset: "best" },
    );
    expect(result.national.total).toBe(5);
    expect(Object.keys(result.byCanton)).toEqual(["TI", "ZH"]);
  });

  it("replaces a same-period history point and bounds history", () => {
    const history = mergePeriods(
      [
        { period: "2026-01", value: 1 },
        { period: "2026-02", value: 2 },
      ],
      { period: "2026-02", value: 3 },
      2,
    );
    expect(history).toEqual([
      { period: "2026-01", value: 1 },
      { period: "2026-02", value: 3 },
    ]);
  });
});
