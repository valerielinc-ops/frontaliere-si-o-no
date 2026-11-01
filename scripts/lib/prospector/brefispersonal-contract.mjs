// The Brefis vacancy index exposes a bounded multi-page listing and a declared
// total. The generator emits this contract, while runtime compatibility uses
// it to repair promoted legacy specs until the next cron rewrite.
export const BREFISPERSONAL_PAGINATION = Object.freeze({
  maxPages: 10,
  declaredTotalPattern: "Offene\\s+Stellen(?:\\s|&nbsp;|<[^>]+>)*([\\d'’.,]+)",
  minCoverage: 0.95,
  // The live index uses numbered /Vacancyboard/<n> anchors without rel=next.
  // The generic runtime follows this route only when a spec opts in explicitly.
  numberedPagePattern: "/Vacancyboard/(\\d+)$",
});
