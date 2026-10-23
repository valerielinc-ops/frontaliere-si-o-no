# Ad performance report and AdSense manual actions

The recommendations in the former April 2026 revenue plan are historical notes,
not verified instructions for the current AdSense configuration. Claims about
Auto Ads, US traffic, video RPM, sticky placements, alternative ad providers,
and expected revenue uplifts were not established by a current measurement.
Do not use those claims as a reason to change the live AdSense account.

## Read-only report

Run from the workspace root after loading the configured environment:

```sh
source bin/rc-env.sh
node frontaliere-si-o-no/scripts/ads-performance-report.mjs --days=28
```

The end date is inclusive and is at least two days old. To review a specific
settled interval, pass both dates:

```sh
node frontaliere-si-o-no/scripts/ads-performance-report.mjs --start=2026-09-21 --end=2026-10-18 --json
```

Add `--save` to write a local Markdown and JSON copy under the site's ignored
`reports/` directory. The command reads AdSense Management API v2 and GA4 Data
API only. It does not update ad settings, create GA4 definitions, emit browser
events, or place ad requests.

## What the report measures

- AdSense shows estimated earnings, ad requests, matched requests, impressions,
  Active View measurability and viewability ratios by reported ad unit, device
  class and domain. Estimated earnings are not finalized payments.
- The site slot registry adds possible placement aliases for each AdSense unit.
  A reused unit remains one revenue row: the report does not allocate its
  earnings among aliases or pages.
- GA4 shows aggregate event counts by event, device, and only those registered
  slot, placement, render-path, page-template and network dimensions that are
  supported by the property. It checks dimension discovery and compatibility
  before querying, caps rows, and reports truncation or missing dimensions.
- The report includes the existing `ad_page_diag` event with its registered
  aggregate slot, Auto Ads, consent and first-fill metrics when the property
  exposes them. To stay within GA4's 10-metric `runReport` limit (including
  `eventCount`), it queries at most nine custom metrics and lists any other
  discovered registered metrics as unqueried. The numeric mean for
  `first_fill_ms` is withheld because the aggregate cannot separate the
  collector's `-1` no-fill sentinel from filled-page latencies.
- Offerwall ads snapshots are a separate aggregate diagnostic section. Their
  event counts and mean snapshot metrics cannot be linked to an individual
  browser, click, request ID or Offerwall result by this report.

The report marks a value as `missing` when its source or dimension is
unavailable, `zero` when a successful report returns zero, and `low_sample`
when a positive count is below the printed threshold. Low-sample labels are
descriptive volume notes; they are not significance tests.
If GA4 metadata discovery itself fails, custom-dimension and metric
availability is marked unknown instead of missing. Truncation, sampling and
thresholding warnings are shown for each GA4 report section.

## Lifecycle limits and interpretation

The current manual-slot client emits `ad_request`, `ad_waiting`, `ad_filled`,
`ad_unfilled`, `ad_collapsed`, `ad_measurable`, and `ad_viewable`. `ad_waiting`
means the response deadline passed and is not a no-fill verdict.
`ad_measurable` records client-side iframe geometry, and manual `ad_viewable`
uses a 50% / one-second client rule. These signals do not equal AdSense Active
View. AdSense supplies aggregate measurability and viewability ratios, not
exact counts; the report does not reconstruct counts from impressions.

The report preserves Auto Ads and does not disable anchor, in-page, or vignette
formats. `ad_page_diag`'s `ad_blocked` metric is a client observation. It does
not establish the current anti-adblock configuration or prove that a specific
checker is active. The configuration associated with #13681 remains unknown
from this report.

GA4 event counts are not unique ad requests or request-to-viewable cohorts.
The report intentionally does not request `request_id`, page URLs, job IDs,
company IDs, or Offerwall identifiers. AdSense revenue and GA4 lifecycle data
remain separate sources with different reporting populations; the report
does not join them or infer causation.
Offerwall snapshots are not enough to verify the individual browser-level
correlation discussed in #12133. That verification prerequisite is unavailable
from these aggregate reports.

## Manual account changes

This document does not prescribe changes to blocking controls, site language,
video formats, sticky behavior, or ad-provider configuration. Any account
change is separate from this read-only report and follows the workspace's
existing authorization rules.
