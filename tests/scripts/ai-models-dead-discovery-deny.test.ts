import { describe, expect, it } from 'vitest';

// Pins the dead-model discovery deny-lists added 2026-06-22 to stop the
// generation cascade wasting attempts on ids that providers advertise in
// /v1/models but this account cannot actually call.
//
// - NVIDIA: nemotron-4-340b / nemotron-nano-3-30b / llama-3.1-nemotron-{ultra-253b,70b,51b}
//   all return HTTP 404 "Not found for account …" yet parse as allowed chat
//   families, so the allowlist let them through and discovery re-injected them
//   every run (runs 27949428878 / 27957791379). They must be denied without
//   knocking out their live siblings.
// - Mistral: labs-* models return HTTP 403 (admin-gated Labs tier) on this
//   account and must be denied.
//
// Without a committed test, a future cascade refactor would silently re-flood
// the chain with these dead ids (cf. the NVIDIA allowlist regression guard).

const aiModels = (await import('../../scripts/lib/ai-models.mjs')) as unknown as {
  DISCOVERY_PROVIDERS: ReadonlyArray<{
    name: string;
    prefix: string;
    pick: (m: { id?: string; capabilities?: unknown; max_context_length?: number }) => string | null;
  }>;
};

const { DISCOVERY_PROVIDERS } = aiModels;

function provider(name: string) {
  const cfg = DISCOVERY_PROVIDERS.find((p) => p.name === name);
  if (!cfg) throw new Error(`${name} discovery provider missing`);
  return cfg;
}

// Exact ids that 404'd on the chat endpoint (org-prefixed, as NVIDIA lists them).
const NVIDIA_DEAD_IDS = [
  'nvidia/nemotron-4-340b-instruct',
  'nvidia/nemotron-nano-3-30b-a3b',
  'nvidia/llama-3.1-nemotron-ultra-253b-v1',
  'nvidia/llama-3.1-nemotron-70b-instruct',
  'nvidia/llama-3.1-nemotron-51b-instruct',
];

// Live NVIDIA chat ids that share tokens with the dead ones and MUST keep flowing.
// NOTE: nvidia/nemotron-3.5-content-safety was removed from this list 2026-07-02
// (run 28611052353) — it isn't actually a usable chat sibling, it's a moderation
// classifier that always 400s "Conversation roles must alternate". See the
// dedicated content-safety-exclusion test below.
const NVIDIA_LIVE_SIBLINGS = [
  'nvidia/llama-3.3-nemotron-super-49b-v1',
  'meta/llama-3.1-70b-instruct',
  'meta/llama-3.1-8b-instruct',
];

// NVIDIA moderation/classifier ids that share the "nemotron" family token and
// slipped through NVIDIA_ALLOW_FAMILY_RE (same failure mode as the
// reward/parse case, 2026-06-15) — they always 400 "Conversation roles must
// alternate" on the chat endpoint (run 28611052353) and must be denied.
const NVIDIA_CONTENT_SAFETY_IDS = [
  'nvidia/nemotron-3-content-safety',
  'nvidia/nemotron-3.5-content-safety',
  'nvidia/nemotron-content-safety-reasoning-4b',
];

describe('dead-model discovery deny-lists (2026-06-22)', () => {
  it('NVIDIA rejects every account-404 nemotron id', () => {
    const { pick } = provider('NVIDIA');
    for (const id of NVIDIA_DEAD_IDS) {
      expect(pick({ id }), `expected dead NVIDIA id rejected: ${id}`).toBeNull();
    }
  });

  it('NVIDIA keeps live siblings that share tokens with the dead ids', () => {
    const { pick } = provider('NVIDIA');
    for (const id of NVIDIA_LIVE_SIBLINGS) {
      expect(pick({ id }), `expected live NVIDIA id to pass: ${id}`).toBe(id);
    }
  });

  it('NVIDIA rejects content-safety classifier ids (not chat-capable, run 28611052353)', () => {
    const { pick } = provider('NVIDIA');
    for (const id of NVIDIA_CONTENT_SAFETY_IDS) {
      expect(pick({ id }), `expected content-safety id rejected: ${id}`).toBeNull();
    }
  });

  it('Mistral rejects admin-gated Labs models', () => {
    const { pick } = provider('Mistral');
    expect(pick({ id: 'labs-leanstral-2603', max_context_length: 32768 })).toBeNull();
  });

  it('Mistral keeps a normal chat model', () => {
    const { pick } = provider('Mistral');
    expect(pick({ id: 'mistral-medium-2508', max_context_length: 32768 })).toBe('mistral-medium-2508');
  });
});
