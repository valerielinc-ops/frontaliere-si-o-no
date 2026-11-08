# Instagram-agent-skill source

- Repository: https://github.com/Jakeschincariol/instagram-agent-skill
- Pinned revision: d03c56bb598be770c60b201f94237e5d1a4268a6
- License: MIT; see the upstream `LICENSE`.
- All thirteen skills at the pinned revision were inspected and are
  project-versioned under `.agents/skills/ig-*`. The six core writing skills
  plus `ig-repurpose` and `ig-story` inform the scheduled Codex copy workflow;
  comment, DM, reply, profile, and own-account performance skills are limited
  to sanitized drafts or review. No upstream scraper is part of the project.

Adapted ideas include platform-specific hooks, one primary action, save/share
utility, and learning from the account's own eligible Insights. The automated
workflow uses one weekly Codex generation and the existing validated JSON
schema. The repurpose guidance helps select specific angles from the sanitized
published-topic inventory; publishers still supply exact, verified facts.
There are no per-post model calls and credentials never enter the Codex job.

The English-oriented hook, caption, and humanizer scores are editorial aids,
not Italian pass/fail gates or performance predictors. Third-party-account
scraping, auto-comment/follow/cold-DM instructions, unsupported interactive
Story promises, and unverified trend/limit claims are not enabled. The
`ig-viral` skill uses only the project's sanitized own-account performance
brief, and the upstream competitor swipe collector was removed.

The supported Instagram publishing surface is Meta's Content Publishing API
for Professional accounts. The publisher supports Facebook Login with a linked
Page or direct Instagram Login with the separate Instagram user token and
`graph.instagram.com` API host. The login modes, scopes, and format limits are
documented by [Meta's Instagram API collection](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api?entity=request-23987686-3fe78620-2258-44b6-893f-42d76c7200d7).
`scripts/instagram-login-auth.mjs` performs the one-time state-checked OAuth
flow and stores the app secret and access token as GitHub Actions Secrets;
`firebase-server` Remote Config contains only non-secret app/account metadata,
granted scopes, and token expiry. Publisher steps receive the access token only
as a step-scoped secret, while Codex generation jobs do not receive it. A daily
workflow refreshes the token inside its 30-day expiry window. The direct login token is not interchangeable with
the Facebook Page token. Insights and existing community routes retain their
separate Facebook Login credentials and authorization checks.
Browser publishing, Insights, and community automation each fail closed unless
their separate Remote Config permission flag is exactly `true`; a flag may be
set only after the corresponding Meta express permission is verified. Without
browser permission, the poster uses Graph API when its token and grants are
ready and otherwise skips delivery.
