#!/usr/bin/env bash
# scripts/lib/github-api-version.sh — SINGLE SOURCE GitHub REST API version pin.
#
# Sourced by scripts/lib/trigger-deploy.sh and scripts/lib/trigger-self.sh so
# the X-GitHub-Api-Version curl header can't drift between them (mirrors the
# JS-side single source at scripts/lib/githubApiHeaders.mjs; AGENTS.md
# Non-Negotiable #6).
GITHUB_API_VERSION="2022-11-28"
