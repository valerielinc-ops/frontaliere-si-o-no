# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary audience is people living in Italy who work, or are considering work, in Switzerland, especially Ticino. Their situations include:

- People weighing cross-border work against other options. They need to understand likely take-home pay, taxes, insurance, pension, and commuting costs before making a decision.
- People already working across the border who use practical guidance and tools for recurring questions about work, pay, regulations, travel, and daily life.
- People looking for work in Switzerland who need to find roles and employers, prepare application materials, or use their CV-derived profile.
- People exploring whether cross-border work fits their circumstances and looking for clear, relevant information before they commit.

These users need information connected to their personal situation, clear estimates with their assumptions and limits, and useful next steps.

## Product Purpose

frontaliereticino.ch is a multilingual web platform for people considering or navigating cross-border work in Switzerland, with a particular focus on Ticino. It brings together job search and application support, practical guides and editorial information, and interactive tools covering salary, tax, insurance, pension, commuting, and life across the border.

The product helps users move from a question to an informed next step: compare work and tax scenarios, estimate take-home pay, understand practical requirements, plan a commute, or find and apply for a job. Calculations are estimates based on the information and assumptions entered by the user.

## Positioning

The implementation combines job discovery and application support with cross-border calculators and practical guidance for Italian residents working or considering work in Switzerland. The intended differentiator and any comparative market claim have not been confirmed; do not claim uniqueness, guaranteed outcomes, or measured impact without evidence.

## Operating Context

- The product is used on the web in Italian, English, German, and French.
- Users may arrive while comparing whether and where to work in Switzerland, while already employed across the border, or while looking for a role and preparing an application.
- Users provide personal circumstances to interactive tools; signed-in profiles can also display information extracted from a user's CV.
- The site combines frequently changing practical information with reference material and recurring tools used for individual decisions.
- Salary and tax outputs are estimates and do not replace advice from a qualified professional or a decision by the relevant authority.

## Capabilities and Constraints

- Salary and tax simulators support comparisons between cross-border work scenarios and tax regimes.
- Other tools cover pay, pensions, insurance, costs, currency, commuting, and border-crossing information.
- Job-search features include listings and employer information, with user profile and application-support flows.
- A signed-in user profile can show the name of the CV used for CV-derived profile information. CV-derived information must remain distinguishable from details the user entered or edited themselves.
- Guides, articles, FAQs, statistics, and company information provide context for using the tools and making decisions.
- The interface supports Italian, English, German, and French.
- Financial and tax calculations are estimates whose results depend on the user's inputs and the underlying parameters. The product must make this limitation clear and must not present results as professional advice or an official determination.
- Do not invent testimonials, customer counts, outcome rates, or comparative performance claims.

## Brand Commitments

The existing brand direction describes a smart companion: helpful, friendly, precise, and trustworthy, with a lightly playful tone. It should feel approachable while treating cross-border work and financial decisions with care.

## Evidence on Hand

- The app route map documents the tool, guide, job-search, company, statistics, and editorial surfaces in `services/router.ts`.
- Salary and other interactive tools are implemented under `components/calculator/` and `components/fisco/`.
- The user profile shows the source CV filename alongside CV-derived profile information in `components/pages/UserProfile.tsx`.
- Editorial content and its rendering engine live in `packages/articles/`.
- These implementation paths demonstrate existing product capabilities; they do not establish market position, user outcomes, or customer impact.

## Product Principles

1. Help people understand their options and take a practical next step.
2. Make the assumptions, freshness, and limits behind estimates and information clear.
3. Explain cross-border decisions in the context that changes them, such as work location, tax regime, household, and commute.
4. Connect guidance and data to relevant tools, jobs, and actions.
5. Keep user-provided information and CV-derived information distinguishable.

## Accessibility & Inclusion

Follow the project's WCAG-aligned convention: normal text contrast of at least 4.5:1 and large text contrast of at least 3:1; accessible names for interactive controls; charts whose meaning does not depend on color alone; and reduced-motion alternatives for new animation.
