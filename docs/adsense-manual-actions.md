# AdSense Manual Actions — 2026-04-20 Revenue Push

Fixes #1, #3, #4, #5, #6 from the 10-item revenue plan shipped in code
(commits `6a7a8a1dd`, `2dadc7fa6`, `f15e5ccc8`). The remaining items require
AdSense dashboard access and cannot be automated.

Baseline (30 days before changes): €28.28 total, €0.94/day, 87% mobile,
€0 US traffic, CTR 0.48%.

---

## #2 — Disable Vignette Auto-Ads

**Why**: Vignette interstitials hurt mobile UX (87% of audience). Google
recommends pairing them with anchor + in-page only on desktop-heavy sites.
Our anchor (€16.01 RPM) and in-page (€10.42) already perform well; vignette
adds bounce risk without proportional upside.

**Where**: AdSense → Ads → Auto ads → Settings (gear icon) → Ad formats
- Toggle OFF: **Vignette ads**
- Keep ON: Anchor ads, In-page ads

**Rollback signal**: If daily RPM drops >15% after 14 days, toggle back.

---

## #7 — Enable Video Ads + Sticky Sidebar

**Why**: Video ads pay 3–5x display RPM on desktop. Sticky sidebar on
`/job-board/*` keeps JOBDETAIL_SIDEBAR (€8164676143) in viewport longer,
boosting viewable impressions.

**Where**:
1. AdSense → Ads → Auto ads → Ad formats
   - Toggle ON: **Video ads**
2. For existing manual sidebar slot:
   - AdSense → Ads → Ad units by ad unit → `JOBDETAIL_SIDEBAR`
   - Edit → Advanced → **Ad size: Responsive (vertical)**
   - Ensure CSS in `JobBoard.tsx` already applies `sticky top-20` (already
     present at line ~6413).

---

## #8 — Geo-Filter Strategy for €0 US Traffic

**Why**: AdSense reports show 0 US impressions despite 11% US traffic per
GA4. This indicates our ad inventory is not matched to US advertisers — most
likely because content is Italian-only and advertisers geo-target
language/country.

**Two options** (not mutually exclusive):

### 8a — Accept and optimize for IT/CH/DE markets
AdSense → Blocking controls → Advertiser URLs → leave empty.
AdSense → Blocking controls → General categories → block low-RPM verticals
(gambling, political). Focus optimization on Italian/Swiss advertisers.

### 8b — Enable English auto-translation (high risk)
GSC already serves the `en/` locale. Enable English AdSense ad serving:
AdSense → Sites → `frontaliereticino.ch` → Properties → Language: **Multi**
(IT + EN). Monitor for 14 days — if US RPM stays under €0.50 CPM, revert.

**Recommendation**: Start with 8a; revisit 8b only if EN traffic doubles.

---

## #9 — Header Bidding / AdX Consideration

**Why**: Current setup is AdSense auto-ads. Header bidding (via Ezoic,
Mediavine, or Google AdX) typically lifts RPM 20–40% by auctioning
inventory to multiple demand partners.

**Entry thresholds**:
- **Ezoic**: no minimum (apply anytime)
- **Mediavine**: 50k sessions/month (likely not met yet — verify in GA4)
- **AdX direct**: 5M pageviews/month (not met)

**Action**: If monthly sessions <50k, apply to Ezoic. If >50k, apply to
Mediavine. Both replace the AdSense tag entirely — plan a rollback window.

**Risk**: Switching away from AdSense auto-ads means rewriting
`AdSenseBanner.tsx` and the entire `adsenseSlots.ts` registry to use the
new provider's tags. Budget 2 days of work.

---

## #10 — SEO Internal Linking Boost

**Why**: The `RelatedTools` component (already on calculator pages)
internally links between high-intent pages. Extending it to blog articles
and comparators should improve dwell time and reduce bounces — both RPM
multipliers.

**Code change required** (but outside the 10-fix scope):
- Add `<RelatedTools context="...">` to:
  - `BlogArticles.tsx` — end of article (context="blog")
  - `CurrencyExchange.tsx` — already has `<PartnerRecommendations>`,
    also add `<RelatedTools context="exchange">` below
  - `JobBoard.tsx` detail view — after relatedJobs section
    (context="jobs")

**Expected impact**: +5–10% session depth, +2–5% RPM (compound effect).

---

## Verification Timeline

| Day | Metric to check | Success signal |
|-----|-----------------|----------------|
| +3  | Daily AdSense revenue | No drop >10% from baseline €0.94 |
| +7  | Calculator post-result RPM | New slot `5196931137` visible with >100 impressions |
| +7  | CurrencyExchange affiliate clicks | Measure via `trackExternalLink` in PostHog |
| +14 | Overall 30d revenue | Target: +15–25% vs baseline €28.28 |
| +30 | Striking-distance page position | Target: 3 pages moved from pos 8–9 to page 1 |

---

## Links

- AdSense Console: https://adsense.google.com/adsense/new/u/0/pub-8628054934855353/home
- Ad units: https://adsense.google.com/adsense/new/u/0/pub-8628054934855353/myads/units
- Auto ads settings: https://adsense.google.com/adsense/new/u/0/pub-8628054934855353/myads/autoads
- Blocking controls: https://adsense.google.com/adsense/new/u/0/pub-8628054934855353/myads/blockingcontrols
