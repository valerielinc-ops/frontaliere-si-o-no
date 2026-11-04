# Instagram-agent-skill source

- Repository: https://github.com/Jakeschincariol/instagram-agent-skill
- Pinned revision: d03c56bb598be770c60b201f94237e5d1a4268a6
- License: MIT; see LICENSE.
- All thirteen skills at the pinned revision were inspected with the Codex
  skill-installer. The scheduled copy workflow reads the six copy skills
  (`ig-plan`, `ig-caption`, `ig-carousel`, `ig-reel`, `ig-audit`, and
  `ig-human`) plus the adapted `ig-repurpose` guide. `ig-profile` is available
  for a separate audit from owner-supplied material; it is not part of the
  scheduled generation prompt. Their useful patterns are adapted into
  `.agents/skills/social-content/SKILL.md` and the prompt; the English-oriented
  scripts are not used as Italian pass/fail gates.

Adapted ideas are platform-specific hooks, one primary action, save/share
utility, source-to-format planning, a profile decision path, and learning from
the account's own insights. The source's humanizer,
third-party-account scraping, auto-comment/follow/cold-DM instructions, and
unverified trend/limit claims were not imported into the automated publisher.
The upstream README says the skill itself only drafts content and warns about
browser-based posting; the project keeps publishing in its existing gated
publisher/robot processes and does not pass their credentials to Codex.

The Python humanizer is retained as upstream reference only; text mutation can
damage Italian copy and verified facts. Hook-score and caption heuristics are
not performance predictors or hard gates. Platform-length assertions and
trend claims were not adopted without current official evidence. The upstream
manual-publishing directions are adapted to the project's existing scheduled
publishers; this integration does not enable or change `SOCIAL_ROBOT_MODE`.
Credentials remain in publisher processes; Codex generates copy only.

The supported Instagram publishing surface remains Meta's Content Publishing
API for Professional accounts, with account permissions and format limits
defined by [Meta's Instagram API collection](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api?entity=request-23987686-3fe78620-2258-44b6-893f-42d76c7200d7).
