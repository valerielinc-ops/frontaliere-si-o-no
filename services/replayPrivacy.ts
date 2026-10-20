/**
 * Marks an element whose rendered content session-replay tools must not record.
 *
 * posthog-js masks `<input>` by default (`maskAllInputs`) but records every
 * rendered text node, and Clarity has no masking configured in this repo: a
 * page that shows a person's own words or data ends up verbatim in a replay
 * unless its container opts out. `ph-no-capture` is PostHog's opt-out (the
 * element is replaced by a block of the same size), `data-clarity-mask` is
 * Clarity's.
 *
 *   <main className={`${REPLAY_PRIVATE_CLASS} mx-auto`} {...REPLAY_PRIVATE_ATTRS}>
 */
export const REPLAY_PRIVATE_CLASS = 'ph-no-capture';
export const REPLAY_PRIVATE_ATTRS = { 'data-clarity-mask': 'true' } as const;
