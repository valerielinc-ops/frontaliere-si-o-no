# Product

## Register

brand

## Users
A mix of three overlapping audiences:
- **Stressed decision-makers**: people facing a major life/career decision (move to Switzerland vs. commute from Italy as a frontaliere). High stakes, need clarity, confidence, trust in the numbers.
- **Curious researchers**: casually exploring options, not yet committed. Need to be engaged and informed without overwhelm.
- **Daily tool users / frontalieri**: already decided, use the site as a recurring reference — this weekly "classifica dogane" article specifically serves commuters planning which border crossing to use and when.

All three need: clear information hierarchy, trustworthy data presentation, a sense the tool was built for *them*.

## Product Purpose
frontaliereticino.ch is a SEO-content funnel for cross-border commuters (frontalieri) working in Ticino, Switzerland. The weekly "classifica dogane ticino" article ranks Ticino border crossings by wait time, refreshed every week from live traffic data. Success = readers immediately grasp which crossing is fastest/slowest *this specific week*, understand how it changed since last week, and leave with a concrete, actionable takeaway (which crossing to prefer, what time to leave).

## Brand Personality
**Smart companion** — modern fintech energy (helpful, friendly, slightly playful) meets domain credibility. Think Revolut meets a Swiss tax consultant. Not corporate cold, not community-forum casual — confidently approachable.

Three words: **Precise. Warm. Trustworthy.**

## Anti-references
- Avoid pure "Swiss banking" coldness (the exact complaint on this article today: static, cold copy, unreadable legends, no context).
- Avoid AI slop: cyan-on-dark, purple gradients, hero-metric cards, identical card grids, side-stripe borders, gradient text, tiny uppercase eyebrows, numbered 01/02/03 scaffolding.
- Avoid raw unformatted data (unrounded floats, unexplained metric names) — every number needs a human-legible label and unit.

## Design Principles
1. **Clarity first** — every page has one clear job; dense content uses progressive disclosure, not compression.
2. **Warm precision** — numbers/data get clean structure; surrounding chrome feels human, not clinical.
3. **Legible hierarchy** — wide font-size range; `text-xs` reserved for metadata only.
4. **Breathe** — generous spacing between sections, tighter grouping within them.
5. **Italian warmth, Swiss rigor** — brand lives at the intersection; neither purely cold nor purely expressive.
6. **Every number tells a story** — a stat without a week-over-week comparison and a plain-language label is incomplete; never ship a raw float.

## Accessibility & Inclusion
WCAG-aligned per project convention: body text ≥4.5:1 contrast, large text ≥3:1; no `text-slate-400` on light backgrounds; only semantic color tokens (no inline hex); accessible names on all interactive elements; charts need readable legends independent of color alone (pattern/label backup for color-blind users); reduced-motion alternative for any new animation.
