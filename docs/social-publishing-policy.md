# Social publishing policy

Owner decision, 2026-11-11.

## Selected publishers

- Instagram posts and Reels use the existing authenticated browser publisher and its web UI.
- TikTok uses the existing browser uploader in TikTok Studio.
- LinkedIn uses the existing member publisher with `w_member_social` on the personal profile Valerie Linc. Do not switch this route to the Company Page publisher.

## Authorization and delivery safeguards

- Instagram and TikTok browser publishing each require their own owner flag: `SOCIAL_ROBOT_INSTAGRAM_BROWSER_PUBLISHING_OWNER_APPROVED=true` or `SOCIAL_ROBOT_TIKTOK_BROWSER_PUBLISHING_OWNER_APPROVED=true`. Both also require `SOCIAL_ROBOT_PUBLISHING_MODE=live`.
- These settings authorize the selected browser publishers only. They do not approve Meta or TikTok publishing APIs, Instagram Community or Insights automation, or change the separate `SOCIAL_ROBOT_MODE`.
- The robot must verify that the authenticated browser profile matches the configured target account before publishing. Keep the per-channel posted ledger and daily cap enabled.
- A publish click without a visible confirmation is an uncertain result: hold the channel, check the profile and reconcile the journal before any retry. Do not claim a post succeeded without confirmation.
- LinkedIn publishes only through the member workflow and configured member URN. A rejected or expired access token requires fresh OAuth authorization; do not mark an unsuccessful request as published or bypass the member route.

The Instagram and TikTok workflows create browser queue items; the local social robot is their transport. LinkedIn posts through its existing API workflow. The concrete configuration and environment mapping live in `scripts/set-instagram-tiktok-rc.mjs` and `scripts/load-rc-env.mjs`.
