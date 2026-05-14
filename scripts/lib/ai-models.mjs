/**
 * Centralized AI Model Service — v15 (free-only, 115+ models, 14 providers)
 *
 * Single source of truth for all LLM calls across scripts (jobs crawler,
 * article generator, company parser, etc.).
 *
 * Features:
 * - Extended fallback chain with 115+ FREE models across 14 providers
 * - **Dynamic OpenRouter discovery**: auto-detects new free models at runtime
 * - **Scored model selection**: models gain/lose score based on success/failure,
 *   so models that keep working float to the top and broken ones sink down,
 *   avoiding repeated failures that slow the crawl
 * - **Firestore-backed persistent scores**: scores and exhausted state are
 *   shared across all workflows via Firestore (`ai_model_scores` collection).
 *   Time-decayed on load so stale data self-heals. Debounced writes avoid
 *   I/O spam. Falls back to in-memory if Firestore is unavailable.
 * - Per-model daily-limit tracking (e.g. GitHub Models UserByModelByDay)
 * - Per-model retry with exponential backoff (default 5 retries per model)
 * - Automatic <think> tag stripping for reasoning models (DeepSeek-R1, o3/o4)
 * - Global stats tracking for observability (includes live scoreboard)
 * - Smart 429 backoff: longer waits for rate-limit errors
 *
 * Providers (ALL FREE or free-tier):
 * - GitHub Models (GH_MODELS_PAT) — OpenAI-compatible endpoint hosting
 *   GPT-4o/4.1/5-nano/5, Llama, Phi, Cohere, DeepSeek, Codestral, o4-mini, etc.
 *   Each model has its own daily limit (UserByModelByDay), so using 20+
 *   models yields 20× the daily capacity with a single PAT.
 * - Google Gemini + Gemma (GEMINI_API_KEY) — Native Gemini API (free tier)
 *   Gemma models (gemma-4-31b-it, gemma-3-27b-it, etc.) use the same API
 *   and key, adding 14,400 req/day each!
 * - Groq (GROQ_API_KEY) — Ultra-fast inference, OpenAI-compatible
 *   Llama 4 Scout, Llama 3.3 70B, Qwen3 32B, Kimi K2, GPT-OSS (1000 req/day each)
 * - OpenRouter (OPENROUTER_API_KEY) — Free tier with 50 req/day
 *   Llama 3.3 70B, Gemma 3 27B, Mistral Small 3.1, DeepSeek R1 Zero, etc. (all ":free")
 * - Cerebras (CEREBRAS_API_KEY) — Ultra-fast inference (free tier)
 *   Llama 3.1 8B/70B, Llama 3.3 70B — very low latency
 * - Together AI (TOGETHER_API_KEY) — Free tier inference
 *   Mistral 7B, Qwen 2.5 7B Turbo
 * - Fireworks AI (FIREWORKS_API_KEY) — Free tier inference
 *   Llama 3.1 8B, Mixtral 8x7B
 * - NVIDIA NIM (NVIDIA_NIM_API_KEY) — Free tier inference
 *   Llama 3.1 8B, Phi-3 Mini
 * - HuggingFace (HUGGINGFACE_API_KEY) — Free tier inference router
 *   Mistral 7B, Zephyr 7B
 * - SambaNova Cloud (SAMBANOVA_API_KEY) — Ultra-fast free tier inference
 *   Llama 4 Maverick 17B, Llama 3.3 70B, DeepSeek V3, Qwen 2.5 72B
 * - Cohere (COHERE_API_KEY) — OpenAI-compatible endpoint, free trial tier
 *   Command A, Command R+, Command R (1000 calls/month, 20 req/min)
 * - Cloudflare Workers AI (CF_API_TOKEN + CF_ACCOUNT_ID) — Free tier inference
 *   Llama 3.3 70B, Llama 4 Scout, Mistral Small, QwQ 32B, GPT-OSS (10K neurons/day)
 * - Mistral AI La Plateforme (MISTRAL_API_KEY) — Free tier inference
 *   Mistral Small, Codestral, Ministral 8B, Nemo (1B tokens/month, 1 req/sec)
 * - Mistral Codestral (MISTRAL_API_KEY) — Separate endpoint, separate quota
 *   codestral.mistral.ai — 30 req/min, 2000 req/day (uses same Mistral key)
 *
 * Environment variables:
 * - GH_MODELS_PAT — GitHub Models token (covers GPT, Llama, Phi, Cohere, etc.)
 * - GEMINI_API_KEY or VITE_GEMINI_API_KEY — Google Gemini API key
 * - GROQ_API_KEY — Groq Cloud API key (optional, for extra capacity)
 * - OPENROUTER_API_KEY — OpenRouter API key (optional, for extra capacity)
 * - CEREBRAS_API_KEY — Cerebras API key (optional, ultra-fast inference)
 * - TOGETHER_API_KEY — Together AI API key (optional, free tier)
 * - FIREWORKS_API_KEY — Fireworks AI API key (optional, free tier)
 * - NVIDIA_NIM_API_KEY — NVIDIA NIM API key (optional, free tier)
 * - HUGGINGFACE_API_KEY — HuggingFace API key (optional, free tier)
 * - SAMBANOVA_API_KEY — SambaNova Cloud API key (optional, ultra-fast free tier)
 * - COHERE_API_KEY — Cohere API key (optional, free trial tier)
 * - CF_API_TOKEN — Cloudflare Workers AI bearer token (optional, free tier)
 * - CF_ACCOUNT_ID — Cloudflare account ID (required with CF_API_TOKEN)
 * - MISTRAL_API_KEY — Mistral AI API key (optional, free tier)
 */

// ── Model catalog ────────────────────────────────────────────
export const AI_MODELS = Object.freeze({
  // ── GitHub Models (OpenAI-compatible, shared GH_MODELS_PAT) ──
  // Each model has its own daily limit (UserByModelByDay)
  // Verified 2026-03-14 via live API calls
  GPT4O:            'gpt-4o',
  GPT4O_MINI:       'gpt-4o-mini',
  LLAMA_4_MAVERICK: 'Llama-4-Maverick-17B-128E-Instruct-FP8',
  LLAMA_4_SCOUT:    'Llama-4-Scout-17B-16E-Instruct',
  LLAMA_3_3_70B:    'Llama-3.3-70B-Instruct',
  LLAMA_3_1_405B:   'Meta-Llama-3.1-405B-Instruct',
  LLAMA_3_1_8B:     'Meta-Llama-3.1-8B-Instruct',
  PHI_4:            'Phi-4',
  DEEPSEEK_R1:      'DeepSeek-R1',
  COHERE_CMD_R_PLUS:'Cohere-command-r-plus-08-2024',
  CODESTRAL:        'Codestral-2501',
  GPT_4_1:          'gpt-4.1',
  GPT_4_1_MINI:     'gpt-4.1-mini',
  GPT_4_1_NANO:     'gpt-4.1-nano',
  COHERE_CMD_R:     'Cohere-command-r-08-2024',
  COHERE_CMD_A:     'Cohere-command-a',
  LLAMA_3_2_90B:    'Llama-3.2-90B-Vision-Instruct',
  DEEPSEEK_V3:      'DeepSeek-V3-0324',
  GPT_5_NANO:       'gpt-5-nano',
  GPT_5_MINI:       'gpt-5-mini',
  O4_MINI:          'o4-mini',
  O3_MINI:          'o3-mini',
  DEEPSEEK_R1_0528: 'DeepSeek-R1-0528',
  MINISTRAL_3B:     'Ministral-3B',
  GPT_5:            'gpt-5',
  GROK_3:           'Grok-3',
  GROK_3_MINI:      'Grok-3-Mini',
  MAI_DS_R1:        'MAI-DS-R1',
  MISTRAL_MEDIUM_3: 'Mistral-Medium-3',
  O1:               'o1',
  O3:               'o3',
  PHI_4_MINI_REASON:'Phi-4-mini-reasoning',
  GPT_5_CHAT:       'gpt-5-chat',
  PHI_4_REASON:     'Phi-4-reasoning',
  PHI_4_MINI_INST:  'Phi-4-mini-instruct',
  JAMBA_1_5_LARGE:  'AI21-Jamba-1.5-Large',
  MISTRAL_SM_31_GH: 'Mistral-Small-3.1',
  O1_MINI:          'o1-mini',

  // ── Google Gemini + Gemma (native API, shared GEMINI_API_KEY) ──
  // Gemma models use the same Gemini API endpoint — 14,400 req/day each!
  GEMINI_FLASH:     'gemini-2.5-flash',
  GEMINI_PRO:       'gemini-2.5-pro',
  GEMINI_2_FLASH:   'gemini-2.0-flash',
  GEMINI_FLASH_LITE:'gemini-2.5-flash-lite',
  // Gemma models via Gemini API — 14,400 req/day each!
  GEMMA_4_31B:      'gemma-4-31b-it',
  GEMMA_4_26B:      'gemma-4-26b-a4b-it',
  GEMMA_3_27B:      'gemma-3-27b-it',
  GEMMA_3_12B:      'gemma-3-12b-it',
  // New Gemini 3.x models (preview)
  GEMINI_3_FLASH:   'gemini-3-flash-preview',
  GEMINI_3_PRO:     'gemini-3-pro-preview',
  GEMINI_31_FLASH_LITE: 'gemini-3.1-flash-lite-preview',
  GEMINI_31_PRO:    'gemini-3.1-pro-preview',

  // ── Groq (OpenAI-compatible, ultra-fast inference) ──
  // Each model: 1000 req/day (free tier)
  GROQ_LLAMA_4_SCT: 'groq/meta-llama/llama-4-scout-17b-16e-instruct',
  GROQ_LLAMA_3_3:   'groq/llama-3.3-70b-versatile',
  GROQ_LLAMA_3_1_8B:'groq/llama-3.1-8b-instant',
  GROQ_QWEN3_32B:   'groq/qwen/qwen3-32b',
  GROQ_KIMI_K2:     'groq/moonshotai/kimi-k2-instruct',
  GROQ_GPT_OSS_120B:'groq/openai/gpt-oss-120b',
  GROQ_GPT_OSS_20B: 'groq/openai/gpt-oss-20b',
  GROQ_LLAMA_4_MAV: 'groq/meta-llama/llama-4-maverick-17b-128e-instruct',
  GROQ_QWQ_32B:     'groq/qwen/qwq-32b',
  GROQ_COMPOUND:    'groq/compound-beta',
  GROQ_COMPOUND_MINI:'groq/compound-mini',
  GROQ_KIMI_K2_0905:'groq/moonshotai/kimi-k2-instruct-0905',
  GROQ_GPT_OSS_SAFE: 'groq/openai/gpt-oss-safeguard-20b',

  // ── OpenRouter (OpenAI-compatible, free models with :free suffix) ──
  // Rate limits: 20 req/min, 200 req/day (free tier, no credit card)
  OR_LLAMA_3_3:     'openrouter/meta-llama/llama-3.3-70b-instruct:free',
  OR_GEMMA_3_27B:   'openrouter/google/gemma-3-27b-it:free',
  OR_MISTRAL_SM:    'openrouter/mistralai/mistral-small-3.1-24b-instruct:free',
  OR_QWEN3_CODER:   'openrouter/qwen/qwen3-coder:free',
  OR_TRINITY:       'openrouter/arcee-ai/trinity-large-preview:free',
  OR_DEEPSEEK_R1Z:  'openrouter/deepseek/deepseek-r1-zero:free',
  OR_MISTRAL_NEMO:  'openrouter/mistralai/mistral-nemo:free',
  OR_NV_NEMOTRON_120B: 'openrouter/nvidia/nemotron-3-super-120b-a12b:free',
  OR_QWEN3_NEXT_80B:   'openrouter/qwen/qwen3-next-80b-a3b-instruct:free',
  OR_STEPFUN_FLASH:    'openrouter/stepfun/step-3.5-flash:free',
  OR_NV_NEMOTRON_30B:  'openrouter/nvidia/nemotron-3-nano-30b-a3b:free',
  OR_MINIMAX_M25:      'openrouter/minimax/minimax-m2.5:free',
  OR_GPT_OSS_120B:     'openrouter/openai/gpt-oss-120b:free',
  OR_HERMES_405B:      'openrouter/nousresearch/hermes-3-llama-3.1-405b:free',
  OR_GLM_45_AIR:       'openrouter/z-ai/glm-4.5-air:free',
  OR_GEMMA_3_12B:      'openrouter/google/gemma-3-12b-it:free',
  OR_NV_NEMOTRON_9B:   'openrouter/nvidia/nemotron-nano-9b-v2:free',
  OR_TRINITY_MINI:     'openrouter/arcee-ai/trinity-mini:free',
  OR_DEEPSEEK_V3:      'openrouter/deepseek/deepseek-chat-v3-0324:free',
  OR_QWEN_2_5_72B:     'openrouter/qwen/qwen-2.5-72b-instruct:free',
  OR_PHI_4:            'openrouter/microsoft/phi-4:free',
  OR_PHI_4_REASON:     'openrouter/microsoft/phi-4-reasoning:free',
  OR_KIMI_K2:          'openrouter/moonshotai/kimi-k2:free',
  OR_DEEPSEEK_R1:      'openrouter/deepseek/deepseek-r1:free',
  OR_LLAMA_4_MAVERICK: 'openrouter/meta-llama/llama-4-maverick-17b-128e-instruct:free',
  OR_MISTRAL_SM_31:    'openrouter/mistralai/mistral-small-3.2-24b-instruct:free',

  // ── OpenRouter additional free models (2026-04) ──
  OR_GEMMA_4_31B:      'openrouter/google/gemma-4-31b-it:free',
  OR_GEMMA_4_26B:      'openrouter/google/gemma-4-26b-a4b-it:free',
  OR_NV_NEMOTRON_12B_VL:'openrouter/nvidia/nemotron-nano-12b-v2-vl:free',
  OR_GPT_OSS_20B:      'openrouter/openai/gpt-oss-20b:free',
  OR_DOLPHIN_24B:      'openrouter/cognitivecomputations/dolphin-mistral-24b-venice-edition:free',
  OR_GEMMA_3N_E4B:     'openrouter/google/gemma-3n-e4b-it:free',

  // ── Groq additional models (OpenAI-compatible, ultra-fast inference) ──
  GROQ_GEMMA2_9B:      'groq/gemma2-9b-it',
  GROQ_LLAMA_3_1_70B:  'groq/llama-3.1-70b-versatile',
  GROQ_LLAMA3_8B:      'groq/llama3-8b-8192',
  GROQ_LLAMA3_70B:     'groq/llama3-70b-8192',

  // ── Cerebras (OpenAI-compatible, ultra-fast inference, free tier) ──
  CB_LLAMA_3_1_8B:  'cerebras/llama3.1-8b',
  CB_LLAMA_3_1_70B: 'cerebras/llama3.1-70b',
  CB_LLAMA_3_3_70B: 'cerebras/llama3.3-70b',
  CB_GPT_OSS_120B:  'cerebras/gpt-oss-120b',
  // New Cerebras preview models (2026-04)
  CB_QWEN3_235B:    'cerebras/qwen-3-235b-a22b-instruct-2507',
  // CB_GLM_47 removed — Cerebras HTTP 404 "Model zai-glm-4.7 does not exist" (2026-04)

  // ── Together AI (OpenAI-compatible, free tier inference) ──
  TGT_MISTRAL_7B:  'together/mistralai/Mistral-7B-Instruct-v0.3',
  TGT_QWEN_2_5_7B: 'together/Qwen/Qwen2.5-7B-Instruct-Turbo',

  // ── Fireworks AI (OpenAI-compatible, free tier inference) ──
  FW_LLAMA_3_1_8B: 'fireworks/accounts/fireworks/models/llama-v3p1-8b-instruct',
  FW_MIXTRAL_8X7B: 'fireworks/accounts/fireworks/models/mixtral-8x7b-instruct',

  // ── NVIDIA NIM (OpenAI-compatible, free tier inference) ──
  NV_NEMOTRON_70B:   'nvidia/nvidia/llama-3.1-nemotron-70b-instruct',   // API: nvidia/llama-3.1-nemotron-70b-instruct
  NV_NEMOTRON_49B:   'nvidia/nvidia/llama-3.3-nemotron-super-49b-v1',   // API: nvidia/llama-3.3-nemotron-super-49b-v1
  NV_LLAMA_3_1_8B:   'nvidia/meta/llama-3.1-8b-instruct',
  NV_PHI_3_MINI:     'nvidia/microsoft/phi-3-mini-4k-instruct',

  // ── HuggingFace Inference Router (OpenAI-compatible, free tier) ──
  HF_MISTRAL_7B:   'hf/mistralai/Mistral-7B-Instruct-v0.3',
  HF_ZEPHYR_7B:    'hf/HuggingFaceH4/zephyr-7b-beta',
  HF_LLAMA_3_3_70B:'hf/meta-llama/Llama-3.3-70B-Instruct',
  HF_QWEN_2_5_72B: 'hf/Qwen/Qwen2.5-72B-Instruct',
  HF_GEMMA_3_27B:  'hf/google/gemma-3-27b-it',
  HF_MISTRAL_SM:   'hf/mistralai/Mistral-Small-3.1-24B-Instruct-2503',

  // ── SambaNova Cloud (OpenAI-compatible, free tier, ultra-fast inference) ──
  // Free tier: rate-limited but no cost. Very fast inference (full-stack silicon)
  SN_LLAMA_4_MAVERICK: 'sn/Meta-Llama-4-Maverick-17B-128E-Instruct',
  SN_LLAMA_3_3_70B:    'sn/Meta-Llama-3.3-70B-Instruct',
  SN_DEEPSEEK_V3:      'sn/DeepSeek-V3-0324',
  SN_QWEN_2_5_72B:     'sn/Qwen2.5-72B-Instruct',

  // ── Cohere Direct (OpenAI-compatible, free trial tier) ──
  // Free trial: 1000 calls/month, 20 req/min for chat
  COH_CMD_A:           'cohere/command-a-03-2025',
  COH_CMD_R_PLUS:      'cohere/command-r-plus-08-2024',
  COH_CMD_R:           'cohere/command-r-08-2024',
  COH_CMD_A_REASON:    'cohere/command-a-reasoning-08-2025',
  COH_CMD_A_TRANSLATE: 'cohere/command-a-translate-08-2025',
  COH_AYA_32B:         'cohere/c4ai-aya-expanse-32b',
  COH_CMD_R7B:         'cohere/command-r7b-12-2024',

  // ── Cloudflare Workers AI (OpenAI-compatible, free tier — 10K neurons/day) ──
  CF_LLAMA_3_3_70B:    'cf/@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  CF_LLAMA_4_SCOUT:    'cf/@cf/meta/llama-4-scout-17b-16e-instruct',
  CF_MISTRAL_SM_31:    'cf/@cf/mistralai/mistral-small-3.1-24b-instruct',
  CF_QWQ_32B:          'cf/@cf/qwen/qwq-32b',
  CF_QWEN3_30B:        'cf/@cf/qwen/qwen3-30b-a3b-fp8',
  CF_GPT_OSS_120B:     'cf/@cf/openai/gpt-oss-120b',
  CF_GPT_OSS_20B:      'cf/@cf/openai/gpt-oss-20b',
  CF_GEMMA_3_12B:      'cf/@cf/google/gemma-3-12b-it',
  CF_GLM_47_FLASH:     'cf/@cf/zai-org/glm-4.7-flash',
  CF_DEEPSEEK_R1_32B:  'cf/@cf/deepseek/deepseek-r1-distill-qwen-32b',
  // New Cloudflare models (2026-04)
  // CF_GEMMA_4_26B removed — returns empty responses (model loads but won't generate, 2026-04)
  // CF_KIMI_K2_5 removed — returns empty responses (model loads but won't generate, 2026-04)
  CF_NV_NEMOTRON_120B: 'cf/@cf/nvidia/nemotron-3-120b-a12b',
  // CF_GRANITE_4_MICRO removed — "No such model @cf/ibm/granite-4.0-h-micro" (2026-04)

  // ── Mistral AI La Plateforme (OpenAI-compatible, free tier — 1B tokens/month) ──
  MISTRAL_SMALL:       'mistral/mistral-small-2506',
  MISTRAL_CODESTRAL:   'mistral/codestral-latest',
  MISTRAL_8B:          'mistral/ministral-8b-latest',
  MISTRAL_NEMO:        'mistral/open-mistral-nemo',

  // ── Mistral Codestral (separate endpoint, separate quota: 2000 req/day) ──
  CDSTRL_LATEST:       'codestral/codestral-latest',
});

/**
 * Default fallback chain — initial quality-based ordering.
 * Dynamically re-sorted by success/failure scores during the run.
 * Each GitHub Models model has its own daily limit (UserByModelByDay),
 * so using 24 GH Models gives us 24× the capacity with one API key.
 * Groq models add ultra-fast inference as fallback (9 models, 1000 req/day each).
 * OpenRouter adds 50 extra free requests per day (7 :free models).
 * Cerebras, Together, Fireworks, NVIDIA, HuggingFace provide additional fallback capacity.
 *
 * Total: 70 models across 9+ providers for maximum translation capacity.
 * Initial order: quality-based (best first), with provider diversity.
 * During a run, models that succeed frequently rise; models that
 * fail repeatedly (rate-limited, down) sink to the bottom.
 */
export const DEFAULT_CHAIN = [
  AI_MODELS.GPT4O,              // 1.  OpenAI flagship        (GitHub Models)
  AI_MODELS.GPT_4_1,            // 2.  GPT 4.1 flagship       (GitHub Models)
  AI_MODELS.GEMMA_4_31B,        // 2b. Gemma 4 31B            (Gemini API — 14,400/day!)
  AI_MODELS.GPT_5,              // 3.  GPT-5 flagship         (GitHub Models)
  AI_MODELS.LLAMA_4_MAVERICK,   // 4.  Meta Llama 4 flagship  (GitHub Models)
  AI_MODELS.GEMINI_FLASH,       // 5.  Google fast            (Gemini API free)
  AI_MODELS.GEMINI_3_PRO,       // 5b. Gemini 3 Pro preview   (Gemini API free)
  AI_MODELS.GEMINI_3_FLASH,     // 5c. Gemini 3 Flash preview (Gemini API free)
  AI_MODELS.O3,                 // 6.  OpenAI o3 reasoning    (GitHub Models)
  AI_MODELS.GROK_3,             // 7.  xAI Grok 3 flagship   (GitHub Models)
  // GROQ_KIMI_K2 removed — Groq returns HTTP 413 consistently (payload too large, 2026-03)
  // SN_LLAMA_4_MAVERICK removed — SambaNova returns HTTP 404 "Model not found" (2026-03)
  AI_MODELS.GPT4O_MINI,           // 9.  OpenAI fast             (GitHub Models)
  AI_MODELS.GPT_5_CHAT,           // 9b. GPT-5 chat             (GitHub Models)
  AI_MODELS.GEMMA_4_26B,          // 9c. Gemma 4 26B MoE        (Gemini API — 14,400/day!)
  AI_MODELS.GROQ_GPT_OSS_120B,  // 10. GPT-OSS 120B          (Groq - ultra fast)
  AI_MODELS.GPT_4_1_MINI,       // 11. GPT 4.1 Mini           (GitHub Models)
  AI_MODELS.LLAMA_3_3_70B,      // 12. Meta 70B               (GitHub Models)
  AI_MODELS.LLAMA_4_SCOUT,      // 13. Meta Llama 4 Scout     (GitHub Models)
  AI_MODELS.GEMMA_3_27B,        // 13b. Gemma 3 27B           (Gemini API — 14,400/day!)
  AI_MODELS.PHI_4_REASON,       // 13c. Phi-4 reasoning       (GitHub Models)
  AI_MODELS.GPT_5_NANO,         // 14. GPT-5 nano reason     (GitHub Models)
  AI_MODELS.COHERE_CMD_A,       // 15. Cohere latest          (GitHub Models)
  AI_MODELS.MISTRAL_SMALL,      // 16. Mistral Small latest   (Mistral AI direct)
  AI_MODELS.GROQ_LLAMA_3_3,     // 17. Llama 3.3 70B          (Groq)
  AI_MODELS.COHERE_CMD_R_PLUS,  // 18. Cohere multilingual    (GitHub Models)
  AI_MODELS.COH_CMD_A,          // 18b. Cohere Command A      (Cohere direct - 1000/month)
  AI_MODELS.GEMINI_31_PRO,      // 18d. Gemini 3.1 Pro preview (Gemini API free)
  AI_MODELS.COH_CMD_R_PLUS,     // 18c. Cohere Command R+     (Cohere direct - 1000/month)
  AI_MODELS.CF_LLAMA_3_3_70B,   // 19. Llama 3.3 70B FP8     (Cloudflare Workers AI)
  AI_MODELS.LLAMA_3_1_405B,     // 20. Meta 405B flagship     (GitHub Models)
  // MISTRAL_MEDIUM_3 removed — GitHub Models HTTP 404 "unknown_model" (2026-04)
  AI_MODELS.GROQ_QWEN3_32B,      // 22. Qwen3 32B              (Groq - ultra fast)
  AI_MODELS.CB_QWEN3_235B,       // 22a. Qwen3 235B frontier   (Cerebras preview — ultra fast)
  // CB_GLM_47 removed — Cerebras HTTP 404 "Model zai-glm-4.7 does not exist" (2026-04)
  AI_MODELS.GEMMA_3_12B,         // 22c. Gemma 3 12B           (Gemini API — 14,400/day!)
  // JAMBA_1_5_LARGE removed — GitHub Models HTTP 400 "unknown_model" (2026-04)
  // SN_LLAMA_3_3_70B removed — SambaNova HTTP 402 PAYMENT_METHOD_REQUIRED (2026-04)
  AI_MODELS.O1,                  // 23. OpenAI o1 reasoning    (GitHub Models)
  AI_MODELS.LLAMA_3_2_90B,      // 24. Llama 3.2 90B           (GitHub Models)
  AI_MODELS.GEMINI_2_FLASH,     // 25. Google 2.0 flash       (Gemini API free)
  AI_MODELS.GEMINI_31_FLASH_LITE, // 25b. Gemini 3.1 Flash Lite (Gemini API free)
  AI_MODELS.MISTRAL_CODESTRAL,  // 26. Codestral latest       (Mistral AI direct)
  AI_MODELS.GPT_5_MINI,         // 27. GPT-5 mini reason     (GitHub Models)
  AI_MODELS.CF_LLAMA_4_SCOUT,   // 28. Llama 4 Scout          (Cloudflare Workers AI)
  // CF_GEMMA_4_26B removed — returns empty responses (2026-04)
  // CF_KIMI_K2_5 removed — returns empty responses (2026-04)
  AI_MODELS.CF_NV_NEMOTRON_120B,// 28c. Nemotron 120B MoE     (Cloudflare Workers AI)
  AI_MODELS.DEEPSEEK_V3,        // 29. DeepSeek V3            (GitHub Models)
  AI_MODELS.OR_LLAMA_3_3,       // 30. Llama 3.3 70B          (OpenRouter free)
  AI_MODELS.CF_GPT_OSS_120B,    // 31. GPT-OSS 120B           (Cloudflare Workers AI)
  AI_MODELS.PHI_4,              // 32. Microsoft Phi-4        (GitHub Models)
  AI_MODELS.GPT_4_1_NANO,       // 33. GPT 4.1 Nano           (GitHub Models)
  AI_MODELS.GEMINI_PRO,         // 34. Google pro             (Gemini API free)
  AI_MODELS.CF_QWQ_32B,         // 35. QwQ 32B reasoning      (Cloudflare Workers AI)
  AI_MODELS.GROQ_GPT_OSS_20B,   // 36. GPT-OSS 20B           (Groq - ultra fast)
  // CB_LLAMA_3_3_70B removed — Cerebras 404 (model deprecated 2026-03)
  AI_MODELS.GROK_3_MINI,        // 37. xAI Grok 3 Mini       (GitHub Models)
  AI_MODELS.COH_CMD_A_REASON,   // 38. Cohere reasoning       (Cohere direct)
  AI_MODELS.OR_GEMMA_3_27B,     // 39. Gemma 3 27B instruct   (OpenRouter free)
  // CB_LLAMA_3_1_70B removed — Cerebras 404 (model deprecated 2026-03)
  AI_MODELS.COH_CMD_A_TRANSLATE,// 40. Cohere translate       (Cohere direct)
  AI_MODELS.COHERE_CMD_R,       // 41. Cohere Command R       (GitHub Models)
  AI_MODELS.COH_CMD_R,          // 41b. Cohere Command R      (Cohere direct - 1000/month)
  // GROQ_LLAMA_3_1_70B removed — decommissioned 2026-03 (HTTP 422 from Groq)
  AI_MODELS.CF_MISTRAL_SM_31,   // 42. Mistral Small 3.1      (Cloudflare Workers AI)
  AI_MODELS.DEEPSEEK_R1_0528,   // 43. DeepSeek R1 0528       (GitHub Models)
  AI_MODELS.DEEPSEEK_R1,        // 44. DeepSeek R1 reasoning  (GitHub Models)
  AI_MODELS.GROQ_LLAMA_4_SCT,   // 45. Llama 4 Scout          (Groq)
  AI_MODELS.COH_AYA_32B,        // 46. Aya Expanse 32B        (Cohere direct)
  AI_MODELS.OR_GEMMA_4_31B,     // 47. Gemma 4 31B             (OpenRouter free — replaces Mistral Small 3.1)
  // OR_MISTRAL_SM removed from OpenRouter free list (2026-04)
  // MAI_DS_R1 removed — GitHub Models HTTP 400 "unknown_model" (2026-04)
  AI_MODELS.O4_MINI,            // 49. OpenAI o4-mini reason  (GitHub Models)
  AI_MODELS.CODESTRAL,          // 50. Mistral Codestral      (GitHub Models)
  AI_MODELS.GEMINI_FLASH_LITE,  // 51. Google flash lite      (Gemini API free)
  AI_MODELS.CF_QWEN3_30B,       // 52. Qwen3 30B              (Cloudflare Workers AI)
  AI_MODELS.OR_QWEN3_CODER,     // 53. Qwen3 Coder            (OpenRouter free)
  // CB_GPT_OSS_120B removed — Cerebras HTTP 404 "Model gpt-oss-120b does not exist" (2026-04)
  // GROQ_GEMMA2_9B removed — Groq HTTP 400 "model has been decommissioned" (2026-04)
  AI_MODELS.GROQ_LLAMA_3_1_8B,  // 54. Llama 3.1 8B instant   (Groq)
  AI_MODELS.GROQ_GPT_OSS_SAFE,  // 54b. GPT-OSS Safeguard 20B (Groq — 1000/day)
  // MISTRAL_SM_31_GH removed — GitHub Models HTTP 404 "unknown_model" (2026-04)
  AI_MODELS.PHI_4_MINI_INST,    // 54d. Phi-4 mini instruct   (GitHub Models)
  // SN_DEEPSEEK_V3 removed — SambaNova HTTP 402 PAYMENT_METHOD_REQUIRED (2026-04)
  // SN_QWEN_2_5_72B removed — SambaNova HTTP 402 PAYMENT_METHOD_REQUIRED (2026-04)
  AI_MODELS.OR_GEMMA_4_26B,     // 55. Gemma 4 26B MoE         (OpenRouter free — replaces DeepSeek R1 Zero)
  // OR_DEEPSEEK_R1Z removed from OpenRouter free list (2026-04)
  // GROQ_COMPOUND_MINI removed — Groq HTTP 404 "model compound-mini does not exist" (2026-04)
  AI_MODELS.LLAMA_3_1_8B,       // 56. Meta 8B fast           (GitHub Models)
  AI_MODELS.MINISTRAL_3B,       // 57. Mistral 3B fast        (GitHub Models)
  AI_MODELS.CF_GPT_OSS_20B,     // 58. GPT-OSS 20B            (Cloudflare Workers AI)
  AI_MODELS.O3_MINI,            // 59. OpenAI o3-mini reason  (GitHub Models)
  AI_MODELS.O1_MINI,            // 59b. OpenAI o1-mini reason (GitHub Models)
  // CDSTRL_LATEST removed — codestral.mistral.ai endpoint returns HTTP 401
  // Unauthorized (stale Codestral key, distinct from MISTRAL_API_KEY). Tracked
  // in run 25874585556 (2026-05-14). MISTRAL_CODESTRAL on Mistral La Plateforme
  // (same key, different endpoint) still works and remains in the chain.
  AI_MODELS.MISTRAL_NEMO,       // 59d. Mistral Nemo          (Mistral AI direct)
  AI_MODELS.PHI_4_MINI_REASON,  // 63. Phi-4 mini reasoning   (GitHub Models)
  AI_MODELS.OR_TRINITY,         // 64. Arcee Trinity Large    (OpenRouter free)
  AI_MODELS.MISTRAL_8B,         // 65. Ministral 8B latest    (Mistral AI direct)
  AI_MODELS.OR_DOLPHIN_24B,     // 66. Dolphin Mistral 24B     (OpenRouter free — replaces Mistral Nemo)
  // OR_MISTRAL_NEMO removed from OpenRouter free list (2026-04)
  AI_MODELS.CF_GEMMA_3_12B,     // 67. Gemma 3 12B             (Cloudflare Workers AI)
  AI_MODELS.CB_LLAMA_3_1_8B,    // 68. Llama 3.1 8B           (Cerebras - ultra fast)
  // TGT_QWEN_2_5_7B removed — Together AI HTTP 401 (account unauthorized 2026-03)
  // TGT_MISTRAL_7B removed — Together AI HTTP 401 (account unauthorized 2026-03)
  // FW_LLAMA_3_1_8B removed — Fireworks AI HTTP 404 (model not found 2026-03)
  // FW_MIXTRAL_8X7B removed — Fireworks AI HTTP 404 (model not found 2026-03)
  // NV_NEMOTRON_70B removed — NVIDIA NIM HTTP 404 (model not found 2026-03)
  AI_MODELS.CF_GLM_47_FLASH,    // 69. GLM 4.7 Flash           (Cloudflare Workers AI)
  AI_MODELS.NV_NEMOTRON_49B,     // 70. Nemotron 49B           (NVIDIA NIM direct)
  AI_MODELS.NV_LLAMA_3_1_8B,    // 71. Llama 3.1 8B           (NVIDIA NIM)
  AI_MODELS.NV_PHI_3_MINI,      // 72. Phi-3 Mini             (NVIDIA NIM)
  AI_MODELS.CF_DEEPSEEK_R1_32B, // 73. DeepSeek R1 32B        (Cloudflare Workers AI)
  // CF_GRANITE_4_MICRO removed — "No such model @cf/ibm/granite-4.0-h-micro" (2026-04)
  // HF_MISTRAL_7B removed — HuggingFace HTTP 400 "not a chat model" (2026-04)
  // HF_ZEPHYR_7B removed — HuggingFace HTTP 400 "not supported by any provider" (2026-04)
  // ── Extended capacity: new OpenRouter free models (200 req/day each) ──
  AI_MODELS.OR_NV_NEMOTRON_120B, // 74. NVIDIA Nemotron 120B   (OpenRouter free)
  AI_MODELS.OR_QWEN3_NEXT_80B,   // 75. Qwen3 Next 80B         (OpenRouter free)
  AI_MODELS.OR_STEPFUN_FLASH,    // 76. StepFun 3.5 Flash       (OpenRouter free)
  AI_MODELS.OR_NV_NEMOTRON_30B,  // 77. NVIDIA Nemotron 30B    (OpenRouter free)
  AI_MODELS.OR_MINIMAX_M25,      // 78. MiniMax M2.5            (OpenRouter free)
  AI_MODELS.OR_GPT_OSS_120B,     // 79. GPT-OSS 120B            (OpenRouter free)
  AI_MODELS.OR_HERMES_405B,      // 80. Hermes 3 405B           (OpenRouter free)
  AI_MODELS.OR_GLM_45_AIR,       // 81. GLM 4.5 Air             (OpenRouter free)
  AI_MODELS.OR_GEMMA_3_12B,      // 82. Gemma 3 12B             (OpenRouter free)
  AI_MODELS.OR_NV_NEMOTRON_9B,   // 83. NVIDIA Nemotron 9B     (OpenRouter free)
  AI_MODELS.OR_TRINITY_MINI,     // 84. Arcee Trinity Mini      (OpenRouter free)
  // ── Extended capacity: additional Groq models (1000 req/day each) ──
  AI_MODELS.GROQ_LLAMA3_8B,      // 85. Llama 3 8B              (Groq)
  AI_MODELS.GROQ_LLAMA3_70B,     // 86. Llama 3 70B             (Groq)
  AI_MODELS.GROQ_KIMI_K2_0905,   // 87. Kimi K2 0905            (Groq)
  // ── Extended capacity: new models (2026-04) ──
  AI_MODELS.COH_CMD_R7B,         // 88. Cohere R7B              (Cohere direct)
  // ── Extended capacity: new OpenRouter free models (2026-04, replacing removed models) ──
  AI_MODELS.OR_GPT_OSS_20B,      // 89. GPT-OSS 20B              (OpenRouter free — replaces DeepSeek V3)
  AI_MODELS.OR_NV_NEMOTRON_12B_VL, // 90. Nemotron 12B VL         (OpenRouter free — replaces Qwen 2.5 72B)
  AI_MODELS.OR_GEMMA_3N_E4B,     // 91. Gemma 3n E4B              (OpenRouter free — replaces Phi-4)
  // OR_DEEPSEEK_V3, OR_QWEN_2_5_72B, OR_PHI_4, OR_PHI_4_REASON removed from OpenRouter free list (2026-04)
  // OR_KIMI_K2, OR_DEEPSEEK_R1, OR_LLAMA_4_MAVERICK, OR_MISTRAL_SM_31 removed from OpenRouter free list (2026-04)
  AI_MODELS.GROQ_LLAMA_4_MAV,    // 92. Llama 4 Maverick          (Groq)
  AI_MODELS.GROQ_QWQ_32B,        // 93. QwQ 32B reasoning         (Groq)
  AI_MODELS.GROQ_COMPOUND,       // 94. Compound Beta             (Groq)
  AI_MODELS.HF_LLAMA_3_3_70B,    // 95. Llama 3.3 70B             (HuggingFace)
  AI_MODELS.HF_QWEN_2_5_72B,     // 96. Qwen 2.5 72B              (HuggingFace)
  AI_MODELS.HF_GEMMA_3_27B,      // 97. Gemma 3 27B               (HuggingFace)
  // HF_MISTRAL_SM removed — HuggingFace HTTP 400 "not a chat model" (2026-04)
];

// ── Provider constants ───────────────────────────────────────
const PROVIDER = Object.freeze({
  GITHUB:      'github',
  GEMINI:      'gemini',
  GROQ:        'groq',
  OPENROUTER:  'openrouter',
  CEREBRAS:    'cerebras',
  TOGETHER:    'together',
  FIREWORKS:   'fireworks',
  NVIDIA:      'nvidia',
  HUGGINGFACE: 'huggingface',
  SAMBANOVA:   'sambanova',
  COHERE:      'cohere',
  CLOUDFLARE:  'cloudflare',
  MISTRAL:     'mistral',
  CODESTRAL:   'codestral',
});

// ── Endpoints ────────────────────────────────────────────────
const GH_MODELS_BASE      = 'https://models.inference.ai.azure.com/chat/completions';
const GEMINI_API_BASE     = 'https://generativelanguage.googleapis.com/v1beta/models';
const GROQ_API_BASE       = 'https://api.groq.com/openai/v1/chat/completions';
const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1/chat/completions';
const CEREBRAS_API_BASE   = 'https://api.cerebras.ai/v1/chat/completions';
const TOGETHER_API_BASE   = 'https://api.together.xyz/v1/chat/completions';
const FIREWORKS_API_BASE  = 'https://api.fireworks.ai/inference/v1/chat/completions';
const NVIDIA_API_BASE     = 'https://integrate.api.nvidia.com/v1/chat/completions';
const HUGGINGFACE_API_BASE = 'https://router.huggingface.co/v1/chat/completions';
const SAMBANOVA_API_BASE   = 'https://api.sambanova.ai/v1/chat/completions';
const COHERE_API_BASE      = 'https://api.cohere.ai/compatibility/v1/chat/completions';
const MISTRAL_API_BASE     = 'https://api.mistral.ai/v1/chat/completions';
const CODESTRAL_API_BASE   = 'https://codestral.mistral.ai/v1/chat/completions';

// ── API keys (lazy-loaded from environment) ──────────────────
function getGhModelsPat()       { return (process.env.GH_MODELS_PAT || '').trim(); }
function getGeminiApiKey()      { return (process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || '').trim(); }
function getGroqApiKey()        { return (process.env.GROQ_API_KEY || '').trim(); }
function getOpenRouterApiKey()  { return (process.env.OPENROUTER_API_KEY || '').trim(); }
function getCerebrasApiKey()    { return (process.env.CEREBRAS_API_KEY || '').trim(); }
function getTogetherApiKey()    { return (process.env.TOGETHER_API_KEY || '').trim(); }
function getFireworksApiKey()   { return (process.env.FIREWORKS_API_KEY || '').trim(); }
function getNvidiaApiKey()      { return (process.env.NVIDIA_API_KEY || process.env.NVIDIA_NIM_API_KEY || '').trim(); }
function getHuggingFaceApiKey() { return (process.env.HUGGINGFACE_API_KEY || '').trim(); }
function getSambaNovaApiKey()  { return (process.env.SAMBANOVA_API_KEY || '').trim(); }
function getCohereApiKey()    { return (process.env.COHERE_API_KEY || '').trim(); }
function getCloudflareApiToken() { return (process.env.CF_API_TOKEN || '').trim(); }
function getCfAccountId()    { return (process.env.CF_ACCOUNT_ID || '').trim(); }
function getMistralApiKey()  { return (process.env.MISTRAL_API_KEY || '').trim(); }
function getCodestralApiKey() { return getMistralApiKey(); }  // Same key, separate endpoint

// ── Provider detection ───────────────────────────────────────
/**
 * Determine which provider hosts the given model.
 * - `groq/*` → Groq Cloud (ultra-fast inference, free tier)
 * - `openrouter/*` → OpenRouter (free models with :free suffix)
 * - `gemini-*` / `gemma-*` → Google Gemini (free tier, includes Gemma models)
 * - `cerebras/*` → Cerebras (ultra-fast inference, free tier)
 * - `together/*` → Together AI (free tier)
 * - `fireworks/*` → Fireworks AI (free tier)
 * - `nvidia/*` → NVIDIA NIM (free tier)
 * - `hf/*` → HuggingFace Inference Router (free tier)
 * - `sn/*` → SambaNova Cloud (ultra-fast free tier inference)
 * - `cohere/*` → Cohere Direct (free trial tier)
 * - `cf/*` → Cloudflare Workers AI (free tier, 10K neurons/day)
 * - `mistral/*` → Mistral AI La Plateforme (free tier, 1B tokens/month)
 * - `codestral/*` → Mistral Codestral (separate endpoint, 2000 req/day)
 * - Everything else → GitHub Models (GPT, Llama, Mistral, Cohere, Phi — all free)
 */
function getProvider(model) {
  if (model.startsWith('groq/'))        return PROVIDER.GROQ;
  if (model.startsWith('openrouter/'))  return PROVIDER.OPENROUTER;
  if (model.startsWith('gemini-') || model.startsWith('gemma-')) return PROVIDER.GEMINI;
  if (model.startsWith('cerebras/'))    return PROVIDER.CEREBRAS;
  if (model.startsWith('together/'))    return PROVIDER.TOGETHER;
  if (model.startsWith('fireworks/'))   return PROVIDER.FIREWORKS;
  if (model.startsWith('nvidia/'))      return PROVIDER.NVIDIA;
  if (model.startsWith('hf/'))          return PROVIDER.HUGGINGFACE;
  if (model.startsWith('sn/'))          return PROVIDER.SAMBANOVA;
  if (model.startsWith('cohere/'))     return PROVIDER.COHERE;
  if (model.startsWith('cf/'))         return PROVIDER.CLOUDFLARE;
  if (model.startsWith('codestral/'))  return PROVIDER.CODESTRAL;
  if (model.startsWith('mistral/'))    return PROVIDER.MISTRAL;
  return PROVIDER.GITHUB;
}

/**
 * Strip provider prefix from model ID to get the API model name.
 * e.g. 'groq/llama-3.3-70b-versatile' → 'llama-3.3-70b-versatile'
 *      'openrouter/meta-llama/llama-3.3-70b-instruct:free' → 'meta-llama/llama-3.3-70b-instruct:free'
 *      'cerebras/llama3.3-70b' → 'llama3.3-70b'
 *      'together/mistralai/Mistral-7B-Instruct-v0.3' → 'mistralai/Mistral-7B-Instruct-v0.3'
 *      'fireworks/accounts/fireworks/models/...' → 'accounts/fireworks/models/...'
 *      'nvidia/meta/llama-3.1-8b-instruct' → 'meta/llama-3.1-8b-instruct'
 *      'hf/mistralai/Mistral-7B-Instruct-v0.3' → 'mistralai/Mistral-7B-Instruct-v0.3'
 *      'cf/@cf/meta/llama-3.3-70b-instruct-fp8-fast' → '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
 *      'mistral/mistral-small-latest' → 'mistral-small-latest'
 *      'codestral/codestral-latest' → 'codestral-latest'
 *      'gpt-4o' → 'gpt-4o' (no prefix)
 */
function getApiModelId(model) {
  if (model.startsWith('groq/'))        return model.slice(5);   // 5 chars: "groq/"
  if (model.startsWith('openrouter/'))  return model.slice(11);  // 11 chars: "openrouter/"
  if (model.startsWith('cerebras/'))    return model.slice(9);   // 9 chars: "cerebras/"
  if (model.startsWith('together/'))    return model.slice(8);   // 8 chars: "together/"
  if (model.startsWith('fireworks/'))   return model.slice(10);  // 10 chars: "fireworks/"
  if (model.startsWith('nvidia/'))      return model.slice(7);   // 7 chars: "nvidia/"
  if (model.startsWith('hf/'))          return model.slice(3);   // 3 chars: "hf/"
  if (model.startsWith('sn/'))          return model.slice(3);   // 3 chars: "sn/"
  if (model.startsWith('cohere/'))     return model.slice(7);   // 7 chars: "cohere/"
  if (model.startsWith('cf/'))         return model.slice(3);   // 3 chars: "cf/" → "@cf/..."
  if (model.startsWith('codestral/'))  return model.slice(10);  // 10 chars: "codestral/"
  if (model.startsWith('mistral/'))    return model.slice(8);   // 8 chars: "mistral/"
  return model;
}

/** Get the API key for a given provider */
function getApiKeyForProvider(provider) {
  switch (provider) {
    case PROVIDER.GITHUB:      return getGhModelsPat();
    case PROVIDER.GEMINI:      return getGeminiApiKey();
    case PROVIDER.GROQ:        return getGroqApiKey();
    case PROVIDER.OPENROUTER:  return getOpenRouterApiKey();
    case PROVIDER.CEREBRAS:    return getCerebrasApiKey();
    case PROVIDER.TOGETHER:    return getTogetherApiKey();
    case PROVIDER.FIREWORKS:   return getFireworksApiKey();
    case PROVIDER.NVIDIA:      return getNvidiaApiKey();
    case PROVIDER.HUGGINGFACE: return getHuggingFaceApiKey();
    case PROVIDER.SAMBANOVA:   return getSambaNovaApiKey();
    case PROVIDER.COHERE:      return getCohereApiKey();
    // Cloudflare needs BOTH token AND account ID to construct the endpoint
    case PROVIDER.CLOUDFLARE:  return (getCloudflareApiToken() && getCfAccountId()) ? getCloudflareApiToken() : '';
    case PROVIDER.MISTRAL:     return getMistralApiKey();
    case PROVIDER.CODESTRAL:   return getCodestralApiKey();
    default: return '';
  }
}

// Backward-compatible helpers (kept for external code)
function isGitHubModel(model) { return getProvider(model) === PROVIDER.GITHUB; }
function isGeminiModel(model) { return getProvider(model) === PROVIDER.GEMINI; }

// ── Default options ──────────────────────────────────────────
const DEFAULT_OPTS = {
  temperature: 0.2,
  maxTokens: 4096,
  jsonMode: false,
  /**
   * Optional JSON-Schema to enforce on the model output. When provided AND the
   * underlying provider supports schema-mode, the schema is forwarded to the
   * API (OpenAI: `response_format.json_schema` strict; Gemini:
   * `generationConfig.responseSchema`) so required fields can no longer be
   * silently omitted. Providers without schema-mode support gracefully fall
   * back to plain `jsonMode` (json_object) — the per-call retry loop in
   * create-article.mjs continues to act as a safety net for those.
   *
   * Shape: `{ name: string, schema: object }` where `schema` is a standard
   * JSON-Schema fragment (subset compatible with OpenAI strict mode: object
   * `type`/`properties`/`required`/`additionalProperties:false`).
   */
  jsonSchema: undefined,
  timeout: 30_000,
  maxRetriesPerModel: 2,   // FRO-325: reduced from 5 — failing models drain quota fast
  backoffMs: 2500,
  /** Override the default fallback chain */
  chain: undefined,
};

/**
 * Providers known to honor OpenAI's `response_format: { type: 'json_schema' }`
 * strict-mode contract. For the rest we fall back to either `json_object`
 * (forces JSON output but cannot enforce field presence) or plain text — the
 * caller's per-call retry loop covers those.
 *
 * Verified per-provider (2026-05-14, run 25874585556 fallout):
 * - GitHub: proxies OpenAI gpt-4o/4.1/5/o-series → strict json_schema ✅
 * - OpenRouter: OpenAI-compat layer; routes to OpenAI/Anthropic/Mistral.
 *   Most free models tolerate `response_format: { type: 'json_schema' }`,
 *   the rare ones that don't fall back via the retry loop anyway ✅
 * - Mistral: La Plateforme accepts the OpenAI-compatible shape ✅
 * - Groq REMOVED: HTTP 400 "This model does not support response format
 *   `json_schema`" on llama-3.3-70b-versatile, qwen3-32b, llama-3.1-8b-instant,
 *   compound-beta. Even when Groq accepts the shape it ignores `strict`.
 * - Cohere, Anthropic, Gemini, Together, Fireworks, NVIDIA, HuggingFace,
 *   SambaNova, Cloudflare, Cerebras NOT included — either different syntax
 *   (Cohere uses `{ type: 'json_object', schema }`, Gemini uses Proto), or
 *   they 400 on `response_format` entirely. Gemini's native schema path is
 *   wired separately in _callGeminiRaw via `generationConfig.responseSchema`.
 */
const PROVIDERS_WITH_STRICT_JSON_SCHEMA = new Set(['GitHub', 'OpenRouter', 'Mistral']);

/**
 * Global schema-mode toggle for ops control. Driven by AI_MODELS_SCHEMA_MODE env
 * (workflow-level safeguard). Lets ops flip the whole feature off without a code
 * change if a new provider/model regression breaks generation again.
 *
 *   - 'auto' (default): honor PROVIDERS_WITH_STRICT_JSON_SCHEMA per provider
 *   - 'force':          forward jsonSchema to EVERY provider (research/probe only)
 *   - 'off':            never forward jsonSchema; fall back to json_object/text
 */
function getSchemaMode() {
  const v = (process.env.AI_MODELS_SCHEMA_MODE || 'auto').toLowerCase().trim();
  if (v === 'force' || v === 'off') return v;
  return 'auto';
}

/**
 * Decide whether to forward `opts.jsonSchema` to a given provider.
 *
 *  - mode=off    → never
 *  - mode=force  → always (probe-only; most providers will 400)
 *  - mode=auto   → OpenAI-compat providers in PROVIDERS_WITH_STRICT_JSON_SCHEMA,
 *                  plus Gemini (which uses its own native responseSchema path,
 *                  not the OpenAI response_format shape — handled in _callGeminiRaw)
 *
 * Exported for tests / smoke probes.
 */
export function shouldUseSchemaMode(providerName, hasSchema = true) {
  if (!hasSchema) return false;
  const mode = getSchemaMode();
  if (mode === 'off') return false;
  if (mode === 'force') return true;
  if (providerName === 'Gemini') return true;
  return PROVIDERS_WITH_STRICT_JSON_SCHEMA.has(providerName);
}

/**
 * Strip JSON-Schema keywords that Gemini's `responseSchema` rejects.
 * Gemini accepts an OpenAPI-3.0 subset only ($schema/$ref/oneOf/anyOf/allOf,
 * additionalProperties, patternProperties, const, etc. are NOT supported and
 * will fail with HTTP 400 INVALID_ARGUMENT).
 */
function sanitizeSchemaForGemini(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeSchemaForGemini);
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === '$schema' || k === '$ref' || k === '$defs' || k === 'definitions') continue;
    if (k === 'additionalProperties') continue;
    if (k === 'oneOf' || k === 'anyOf' || k === 'allOf' || k === 'not') continue;
    if (k === 'const' || k === 'patternProperties') continue;
    out[k] = (v && typeof v === 'object') ? sanitizeSchemaForGemini(v) : v;
  }
  return out;
}

// ── Run-level state (reset only between process invocations) ─
const _exhaustedModels = new Set();

// FRO-325: Track consecutive 429s per model — exhaust after 2
/** @type {Map<string, number>} model → consecutive 429 count */
const _consecutive429 = new Map();
const MAX_CONSECUTIVE_429 = 2;

// Track consecutive content-quality failures (HTTP 200 but malformed/incomplete
// JSON from the model). callLLM itself only sees HTTP success, so without this
// counter a weak model can keep winning the fallback chain while every output
// gets rejected downstream by JSON.parse / schema validation.
/** @type {Map<string, number>} model → consecutive content-quality failure count */
const _consecutiveContentFailures = new Map();
const MAX_CONSECUTIVE_CONTENT_FAILURES = 2;

// Provider-level cooldown: when a provider returns 429, all its models
// get a temporary cooldown to avoid wasting retries on sibling models.
// Maps provider name → cooldown-until timestamp (ms).
const _providerCooldown = new Map();
const PROVIDER_COOLDOWN_MS = 60_000; // 1 minute cooldown after 429

function isProviderCoolingDown(provider) {
  const until = _providerCooldown.get(provider);
  if (!until) return false;
  if (Date.now() >= until) {
    _providerCooldown.delete(provider);
    return false;
  }
  return true;
}

function cooldownProvider(provider) {
  const until = Date.now() + PROVIDER_COOLDOWN_MS;
  _providerCooldown.set(provider, until);
  console.warn(`🧊 Provider ${provider} cooled down for ${PROVIDER_COOLDOWN_MS / 1000}s (rate-limited)`);
}

const _stats = {
  calls: 0,
  successes: 0,
  retries: 0,
  fallbacks: 0,
  exhausted: 0,
  providerCooldowns: 0,
  errors: [],
};

// ── Firestore-backed persistent score store ──────────────────
// Scores are persisted to Firestore collection `ai_model_scores`
// so all workflows (jobs crawler, article generator, company
// parser, etc.) share live model intelligence across processes
// and CI runners.
//
// On init:  load all docs, apply time-decay, seed _modelScores
// On mutation: debounced batch write (every 10 changes or 30s)
// On exit:  flush final state
// Fallback: if Firestore unavailable, pure in-memory (no breakage)
//
// Scoring rules:
//   +2  on success
//   -3  on retryable failure (rate-limit, 5xx, timeout)
//   -10 on non-retryable failure (context limit, unknown model)
//   -50 on daily limit exhaustion
//
// Time-decay on load:
//   < 1h old:   100% of stored score
//   1-6h old:   75% of stored score
//   6-24h old:  50% of stored score
//   > 24h old:  10% of stored score
//
// The initial order uses DEFAULT_CHAIN index as a tiebreaker,
// so quality-based ordering is preserved until real data shifts it.

const FIRESTORE_COLLECTION = 'ai_model_scores';
// All per-model state lives inside this single aggregate doc as a `models`
// map (encoded modelId → state). Loading the whole store costs 1 Firestore
// read instead of N (one per model variant). The collection layout is kept
// only as a one-time migration source for installs that still have the old
// per-model docs.
const FIRESTORE_AGGREGATE_DOC = '_all';

// Firestore field names cannot contain `/`. The original modelId may include
// slashes (e.g. `openrouter/meta-llama/llama-3.3-70b:free`) so we encode them
// with the same `__` substitution the legacy per-doc layout used.
function _encodeModelId(modelId) {
  return modelId.replace(/\//g, '__');
}

/** @type {Map<string, number>} model → cumulative score */
const _modelScores = new Map();

/** @type {Map<string, {successes: number, failures: number}>} per-model detailed counters */
const _modelDetails = new Map();

/** @type {Set<string>} models whose score changed since last persist */
const _dirtyModels = new Set();

let _firestoreDb = null;     // Firestore instance (null until initScoreStore)
let _storeInitialized = false;
let _persistTimer = null;    // Debounce timer
let _mutationCount = 0;      // Mutations since last persist
let _exitHooked = false;     // Whether process exit hook is registered

const PERSIST_DEBOUNCE_MS    = 30_000;  // Flush every 30s
const PERSIST_MUTATION_THRESHOLD = 10;  // Or after 10 mutations

const SCORE_SUCCESS          =   2;
const SCORE_RETRYABLE_FAIL   =  -3;
const SCORE_NON_RETRYABLE    = -10;
const SCORE_EXHAUSTED        = -50;

// ── Time-decay for persisted scores ──────────────────────────

/** Apply time-based decay to a persisted score */
function _decayScore(score, lastUsedISO) {
  if (!lastUsedISO || !score) return 0;
  const ageMs = Date.now() - new Date(lastUsedISO).getTime();
  const ageH = ageMs / (1000 * 60 * 60);
  if (ageH < 1)  return Math.round(score * 1.0);   // < 1h: full score
  if (ageH < 6)  return Math.round(score * 0.75);  // 1-6h: 75%
  if (ageH < 24) return Math.round(score * 0.50);  // 6-24h: 50%
  return Math.round(score * 0.10);                  // > 24h: 10%
}

// ── Dynamic OpenRouter free model discovery ──────────────────
/**
 * Fetch current free models from OpenRouter API and append any new
 * ones to the DEFAULT_CHAIN. This avoids manually maintaining the
 * OR free model list — new models are auto-discovered each run.
 *
 * - Queries GET /api/v1/models, filters for IDs ending in `:free`
 * - Skips models already in the chain (static entries)
 * - Skips tiny models (context_length < 8192) — not useful for translation
 * - Appends new models as `openrouter/{id}` entries
 * - Caches result for the process lifetime
 * - Falls back silently to static list if API is unreachable
 *
 * Call from initScoreStore() or before first callLLM().
 */
let _orDiscoveryDone = false;
const _dynamicOrModels = [];

export async function discoverOpenRouterFreeModels() {
  if (_orDiscoveryDone) return _dynamicOrModels;
  _orDiscoveryDone = true;

  const apiKey = getOpenRouterApiKey();
  if (!apiKey) {
    console.warn('⚠️  [OR-Discovery] No OPENROUTER_API_KEY — skipping dynamic discovery');
    return _dynamicOrModels;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://frontaliereticino.ch',
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`⚠️  [OR-Discovery] API returned ${res.status} — using static list`);
      return _dynamicOrModels;
    }

    const data = await res.json();
    const freeModels = (data.data || []).filter(m => m.id.endsWith(':free'));

    // Build set of existing OR models in the chain
    const existingIds = new Set(
      DEFAULT_CHAIN
        .filter(m => m.startsWith('openrouter/'))
        .map(m => m.slice(11)) // strip "openrouter/" prefix to get bare ID
    );

    let added = 0;
    for (const m of freeModels) {
      if (existingIds.has(m.id)) continue;
      // Skip tiny models — not useful for translation/article generation
      if ((m.context_length || 0) < 8192) continue;

      const fullId = `openrouter/${m.id}`;
      _dynamicOrModels.push(fullId);
      DEFAULT_CHAIN.push(fullId);
      added++;
    }

    // Also mark OR models in chain that are no longer free
    const currentFreeIds = new Set(freeModels.map(m => m.id));
    let staleCount = 0;
    for (const model of DEFAULT_CHAIN) {
      if (!model.startsWith('openrouter/')) continue;
      const bareId = model.slice(11);
      if (!currentFreeIds.has(bareId)) {
        // Pre-emptively exhaust stale models so they're skipped
        markModelExhausted(model);
        staleCount++;
      }
    }

    if (added > 0 || staleCount > 0) {
      console.log(`🔍 [OR-Discovery] ${freeModels.length} free models found, ${added} new added to chain, ${staleCount} stale pre-exhausted`);
    }
    return _dynamicOrModels;
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'timeout' : e.message;
    console.warn(`⚠️  [OR-Discovery] Failed (${msg}) — using static list`);
    return _dynamicOrModels;
  }
}

// ── Firestore init & load ────────────────────────────────────

/**
 * Initialize the persistent score store from Firestore.
 * Call this once at the start of a workflow BEFORE any callLLM().
 *
 * - Loads all model scores from Firestore with time-decay
 * - Restores exhausted models whose daily limit hasn't reset yet
 * - Registers process exit hooks for final flush
 * - Falls back gracefully to in-memory if Firestore is unavailable
 *
 * Safe to call multiple times (idempotent).
 */
export async function initScoreStore() {
  if (_storeInitialized) return;
  _storeInitialized = true;

  try {
    // Lazy-import firebase-admin (same pattern as load-rc-env.mjs)
    const adminMod = await import('firebase-admin');
    const admin = adminMod.default || adminMod;
    if (!admin.apps.length) {
      if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        console.warn('⚠️  [ScoreStore] No GOOGLE_APPLICATION_CREDENTIALS — using in-memory scores only');
        return;
      }
      admin.initializeApp({ credential: admin.credential.applicationDefault() });
    }
    _firestoreDb = admin.firestore();

    // Load all persisted scores from the single aggregate doc (1 read).
    // If the aggregate doesn't exist yet, fall back to the legacy per-model
    // collection so the very first run after this refactor migrates state
    // forward — the next flush() rewrites everything into the aggregate doc.
    const now = new Date();
    let loaded = 0;
    let decayed = 0;
    let exhaustedRestored = 0;
    let source = 'aggregate';

    const aggregateRef = _firestoreDb
      .collection(FIRESTORE_COLLECTION)
      .doc(FIRESTORE_AGGREGATE_DOC);
    const aggregateSnap = await aggregateRef.get();
    const aggregateData = aggregateSnap.exists ? aggregateSnap.data() : null;
    const aggregateModels = aggregateData?.models;

    /** @type {Array<[string, any]>} */
    let entries = [];

    if (aggregateModels && Object.keys(aggregateModels).length > 0) {
      // Field names use the encoded form; the original id is stored alongside.
      entries = Object.entries(aggregateModels).map(([encId, data]) => [
        data?.modelId || encId.replace(/__/g, '/'),
        data || {},
      ]);
    } else {
      // One-time migration path: read the legacy per-model docs.
      source = 'legacy-collection';
      const snapshot = await _firestoreDb.collection(FIRESTORE_COLLECTION).get();
      for (const doc of snapshot.docs) {
        if (doc.id === FIRESTORE_AGGREGATE_DOC) continue;
        const data = doc.data();
        const modelId = data?.modelId || doc.id.replace(/__/g, '/');
        entries.push([modelId, data]);
        // Mark every migrated model as dirty so the next flush rewrites it
        // into the aggregate doc — after which the legacy docs become
        // unused snapshots and can be deleted out-of-band.
        _dirtyModels.add(modelId);
      }
    }

    for (const [modelId, data] of entries) {
      const rawScore = data.score || 0;
      const decayedScore = _decayScore(rawScore, data.lastUsed);
      if (decayedScore !== 0) {
        _modelScores.set(modelId, decayedScore);
        loaded++;
        if (decayedScore !== rawScore) decayed++;
      }

      if (data.successes || data.failures) {
        _modelDetails.set(modelId, {
          successes: data.successes || 0,
          failures: data.failures || 0,
        });
      }

      if (data.exhaustedUntil) {
        const resetTime = data.exhaustedUntil.toDate
          ? data.exhaustedUntil.toDate()   // Firestore Timestamp
          : new Date(data.exhaustedUntil); // ISO string fallback
        if (resetTime > now) {
          _exhaustedModels.add(modelId);
          exhaustedRestored++;
          console.warn(`🚫 [ScoreStore] ${modelId} still exhausted until ${resetTime.toISOString().slice(0, 16)}`);
        }
      }
    }

    console.log(`☁️  [ScoreStore] Loaded ${loaded} model scores from Firestore [${source}] (${decayed} decayed, ${exhaustedRestored} still exhausted)`);

    // Register exit hooks for final flush
    _registerExitHooks();

  } catch (err) {
    console.warn(`⚠️  [ScoreStore] Firestore unavailable — using in-memory scores only: ${err?.message || err}`);
    _firestoreDb = null;
  }

  // Discover new OpenRouter free models (non-blocking, fire-and-forget on error)
  try {
    await discoverOpenRouterFreeModels();
  } catch {
    // Already logged inside discoverOpenRouterFreeModels
  }
}

// ── Firestore persist (debounced) ────────────────────────────

/**
 * Write all dirty model scores into the single aggregate doc.
 *
 * Uses `set({models: {...}}, {merge: true})`: Firestore deep-merges the
 * `models` map, so unspecified entries stay untouched and concurrent
 * writers from other workflows don't clobber each other's models.
 */
async function _persistScoresToFirestore() {
  if (!_firestoreDb || _dirtyModels.size === 0) return;

  const now = new Date().toISOString();
  const toPersist = [..._dirtyModels];
  _dirtyModels.clear();
  _mutationCount = 0;

  /** @type {Record<string, any>} */
  const modelsDelta = {};
  for (const modelId of toPersist) {
    const details = _modelDetails.get(modelId) || { successes: 0, failures: 0 };
    const score = _modelScores.get(modelId) || 0;

    const entry = {
      modelId,                 // Original model ID (with slashes)
      score,
      successes: details.successes,
      failures: details.failures,
      lastUsed: now,
      updatedAt: now,
    };

    // If model is exhausted, persist the reset time (next midnight UTC)
    if (_exhaustedModels.has(modelId)) {
      const tomorrow = new Date();
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      tomorrow.setUTCHours(0, 0, 0, 0);
      entry.exhaustedUntil = tomorrow.toISOString();
    } else {
      entry.exhaustedUntil = null;
    }

    modelsDelta[_encodeModelId(modelId)] = entry;
  }

  try {
    const ref = _firestoreDb
      .collection(FIRESTORE_COLLECTION)
      .doc(FIRESTORE_AGGREGATE_DOC);
    await ref.set({ models: modelsDelta, updatedAt: now }, { merge: true });
  } catch (err) {
    console.warn(`⚠️  [ScoreStore] Persist failed: ${err?.message || err}`);
    // Re-add dirty models so next flush retries them
    for (const m of toPersist) _dirtyModels.add(m);
  }
}

/** Schedule a debounced persist (resets timer on each call) */
function _schedulePersist() {
  _mutationCount++;

  // Immediate flush if mutation threshold reached
  if (_mutationCount >= PERSIST_MUTATION_THRESHOLD) {
    if (_persistTimer) { clearTimeout(_persistTimer); _persistTimer = null; }
    _persistScoresToFirestore().catch(() => {});
    return;
  }

  // Otherwise debounce
  if (!_persistTimer) {
    _persistTimer = setTimeout(() => {
      _persistTimer = null;
      _persistScoresToFirestore().catch(() => {});
    }, PERSIST_DEBOUNCE_MS);
    if (typeof _persistTimer?.unref === 'function') _persistTimer.unref();
  }
}

/** Flush all pending scores immediately (use before process exit) */
export async function flushScores() {
  if (_persistTimer) { clearTimeout(_persistTimer); _persistTimer = null; }
  await _persistScoresToFirestore();
}

/** Register process exit hooks for final flush */
function _registerExitHooks() {
  if (_exitHooked) return;
  _exitHooked = true;

  const flush = () => {
    // Synchronous-ish: we can't truly await in exit handlers,
    // but we fire the persist and give it a moment
    if (_dirtyModels.size > 0 && _firestoreDb) {
      _persistScoresToFirestore().catch(() => {});
    }
  };

  process.on('beforeExit', async () => { await flushScores(); });
  process.on('SIGINT', () => { flush(); process.exit(130); });
  process.on('SIGTERM', () => { flush(); process.exit(143); });
}

// ── Score mutation (with Firestore persistence) ──────────────

/** Record a model success — boosts its rank and persists to Firestore */
export function recordModelSuccess(modelId) {
  _modelScores.set(modelId, (_modelScores.get(modelId) || 0) + SCORE_SUCCESS);
  const d = _modelDetails.get(modelId) || { successes: 0, failures: 0 };
  d.successes++;
  _modelDetails.set(modelId, d);
  _dirtyModels.add(modelId);
  _consecutiveContentFailures.delete(modelId);
  _schedulePersist();
}

/**
 * Penalize a model whose API call succeeded (HTTP 200) but whose payload was
 * rejected by downstream validation (JSON parse error, schema mismatch, missing
 * required fields). Applies the standard retryable-failure score penalty and,
 * after `MAX_CONSECUTIVE_CONTENT_FAILURES` consecutive content failures for the
 * same model, marks it exhausted for the rest of this process so subsequent
 * callLLM invocations skip it and try the next-best model in the chain.
 */
export function recordModelContentFailure(modelId) {
  if (!modelId) return;
  recordModelFailure(modelId);
  const count = (_consecutiveContentFailures.get(modelId) || 0) + 1;
  _consecutiveContentFailures.set(modelId, count);
  if (count >= MAX_CONSECUTIVE_CONTENT_FAILURES) {
    markModelExhausted(modelId);
    _stats.exhausted++;
    console.warn(`🚫 [${modelId}] Exhausted after ${count} consecutive content-quality failures`);
  }
}

/** Record a model failure — lowers its rank and persists to Firestore */
export function recordModelFailure(modelId, { nonRetryable = false, exhausted = false } = {}) {
  const penalty = exhausted ? SCORE_EXHAUSTED
                : nonRetryable ? SCORE_NON_RETRYABLE
                : SCORE_RETRYABLE_FAIL;
  _modelScores.set(modelId, (_modelScores.get(modelId) || 0) + penalty);
  const d = _modelDetails.get(modelId) || { successes: 0, failures: 0 };
  d.failures++;
  _modelDetails.set(modelId, d);
  _dirtyModels.add(modelId);
  _schedulePersist();
}

/**
 * Get a snapshot of the current model scoreboard.
 * Useful for observability / end-of-run diagnostics.
 * Returns entries sorted by score descending, with detailed stats.
 */
export function getScoreBoard() {
  return [..._modelScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([model, score]) => {
      const d = _modelDetails.get(model);
      return { model, score, ...(d ? { successes: d.successes, failures: d.failures } : {}) };
    });
}

/**
 * Sort a chain of models by their accumulated score.
 * Models with higher scores come first.
 * Within equal scores, the original chain order is preserved (stable sort).
 */
function sortChainByScore(chain) {
  // Build index map for tiebreaker (lower index = better in original order)
  const indexMap = new Map(chain.map((m, i) => [m, i]));
  return [...chain].sort((a, b) => {
    const sa = _modelScores.get(a) || 0;
    const sb = _modelScores.get(b) || 0;
    if (sb !== sa) return sb - sa; // higher score first
    return (indexMap.get(a) || 0) - (indexMap.get(b) || 0); // tiebreak by original order
  });
}

// ── Public state helpers ─────────────────────────────────────
/**
 * Mark a model as exhausted (daily limit reached).
 * It will be skipped for the remainder of this process
 * and persisted to Firestore so other workflows also skip it.
 */
export function markModelExhausted(modelId) {
  _exhaustedModels.add(modelId);
  _dirtyModels.add(modelId);
  _schedulePersist();
  console.warn(`🚫 Model ${modelId} marked as exhausted — will be skipped for rest of run`);
}

/** Check whether a model is still usable this run */
export function isModelAvailable(modelId) {
  if (_exhaustedModels.has(modelId)) return false;
  // Check that we have the API key for the model's provider
  return !!getApiKeyForProvider(getProvider(modelId));
}

/**
 * Check whether ANY model in the default chain is available.
 * Use this instead of directly checking GEMINI_API_KEY || GH_MODELS_PAT,
 * so that all 13 providers (GitHub Models, Gemini, Groq, OpenRouter, Cerebras,
 * Together AI, Fireworks AI, NVIDIA NIM, HuggingFace, SambaNova, Cohere,
 * Cloudflare Workers AI, Mistral AI) are considered.
 */
export function isAnyModelAvailable() {
  return DEFAULT_CHAIN.some(m => isModelAvailable(m));
}

/** Return usage stats for this run (includes model scoreboard and store status) */
export function getStats() {
  return {
    ..._stats,
    exhaustedModels: [..._exhaustedModels],
    consecutive429s: Object.fromEntries(_consecutive429),  // FRO-325
    activeCooldowns: Object.fromEntries([..._providerCooldown].map(([p, t]) => [p, Math.max(0, Math.ceil((t - Date.now()) / 1000))])),
    scoreBoard: getScoreBoard(),
    storeBackend: _firestoreDb ? 'firestore' : 'memory',
    dirtyModels: _dirtyModels.size,
  };
}

/**
 * FRO-325: Print a human-readable end-of-run summary to console.
 * Call this at the end of a crawler run for visibility into AI usage.
 */
export function printRunSummary() {
  const s = getStats();
  const lines = [
    `\n📊 AI Model Run Summary`,
    `   Calls: ${s.calls} | Successes: ${s.successes} | Retries: ${s.retries} | Fallbacks: ${s.fallbacks}`,
    `   Exhausted: ${s.exhausted} models [${s.exhaustedModels.join(', ') || 'none'}]`,
    `   Provider cooldowns: ${s.providerCooldowns}`,
  ];
  if (Object.keys(s.consecutive429s).length > 0) {
    lines.push(`   429 streak: ${Object.entries(s.consecutive429s).map(([m, c]) => `${m}=${c}`).join(', ')}`);
  }
  if (s.errors.length > 0) {
    lines.push(`   Errors: ${s.errors.length}`);
  }
  console.log(lines.join('\n'));
}

/** Reset exhausted models and scores (useful for long-running processes or tests) */
export function resetState() {
  _exhaustedModels.clear();
  _providerCooldown.clear();
  _modelScores.clear();
  _modelDetails.clear();
  _dirtyModels.clear();
  _mutationCount = 0;
  if (_persistTimer) { clearTimeout(_persistTimer); _persistTimer = null; }
  _stats.calls = 0;
  _stats.successes = 0;
  _stats.retries = 0;
  _stats.fallbacks = 0;
  _stats.exhausted = 0;
  _stats.errors = [];
}

/** Remove a specific model from the exhausted set so it can be retried */
export function resetExhaustedModel(modelId) {
  _exhaustedModels.delete(modelId);
}

// ── Internal helpers ─────────────────────────────────────────

function isRetryableError(status, bodyText = '') {
  if (status === 429 || status === 503) return true;
  if (status >= 500 && status < 600) return true;
  const b = String(bodyText).toLowerCase();
  return (
    b.includes('resource exhausted') ||
    b.includes('rate limit') ||
    b.includes('too many requests') ||
    b.includes('temporarily unavailable') ||
    b.includes('model is overloaded') ||
    b.includes('busy')
  );
}

function isDailyLimitError(status, bodyText = '') {
  if (status !== 429) return false;
  const b = String(bodyText).toLowerCase();
  return (
    b.includes('userbymodelbyday') ||       // GitHub Models
    b.includes('daily limit') ||            // Generic
    b.includes('daily quota') ||            // Generic
    b.includes('exceeded your current quota') || // Gemini/OpenAI-style quota exhaustion
    b.includes('check your plan and billing details') || // Gemini/OpenAI-style quota exhaustion
    b.includes('free-models-per-day') ||    // OpenRouter free-tier hard cap
    b.includes('free models per day') ||    // OpenRouter variants
    b.includes('tokens_remaining_day')      // Groq daily
  );
}

/**
 * Detect permanent client errors that should NOT be retried.
 * - unknown_model: model doesn't exist on the provider (mark exhausted)
 * - context length / too many tokens: prompt too large for this model
 * Returns { nonRetryable: boolean, markExhausted: boolean }
 */
function classifyNonRetryableError(status, bodyText = '') {
  const b = String(bodyText).toLowerCase();

  // HTTP 413 — payload too large / token limit reached
  // GitHub Models returns 413 with tokens_limit_reached when the request
  // body exceeds the model's input token limit. Retrying the identical
  // prompt will always fail, so skip this model for this request.
  if (status === 413 || b.includes('tokens_limit_reached')) {
    return { nonRetryable: true, markExhausted: false };
  }

  // HTTP 401 — stale / invalid credentials for this provider. Retrying the same
  // key against the same endpoint will always 401. Mark the model exhausted for
  // this run so the chain falls through cleanly (e.g. codestral.mistral.ai with
  // a stale Codestral key, HuggingFace with a deprovisioned key, etc.).
  if (status === 401) {
    return { nonRetryable: true, markExhausted: true };
  }

  // HTTP 402 — depleted monthly credits / payment required. The model will not
  // recover until the billing window resets, so mark exhausted for this run.
  // Examples: HuggingFace hf/google/gemma-3-27b-it monthly credit depletion;
  // SambaNova PAYMENT_METHOD_REQUIRED.
  if (status === 402) {
    return { nonRetryable: true, markExhausted: true };
  }

  // HTTP 404 — model not found (Cerebras, Groq, OpenRouter return 404 for invalid model IDs)
  if (status === 404) {
    if (b.includes('model_not_found') || b.includes('not_found_error') || b.includes('does not exist')) {
      return { nonRetryable: true, markExhausted: true };
    }
    return { nonRetryable: true, markExhausted: false };
  }

  if (status !== 400) return { nonRetryable: false, markExhausted: false };

  // Model doesn't exist — mark exhausted for entire run
  // Cloudflare returns 400 with "No such model", others use "unknown_model" / "does not exist"
  if (
    b.includes('unknown_model') || b.includes('unknown model') ||
    b.includes('no such model') || b.includes('does not exist')
  ) {
    return { nonRetryable: true, markExhausted: true };
  }
  // Model temporarily unavailable — skip but don't exhaust (it may come back)
  if (b.includes('unavailable_model') || b.includes('unavailable model')) {
    return { nonRetryable: true, markExhausted: false };
  }
  // Provider-side deprecation/removal — retrying the same model is always useless
  if (
    b.includes('decommissioned') ||
    b.includes('no longer supported') ||
    b.includes('deprecated') ||
    b.includes('model_not_found')
  ) {
    return { nonRetryable: true, markExhausted: true };
  }
  // Prompt too large — skip model for this request but don't exhaust globally
  if (
    b.includes('maximum context length') ||
    b.includes('context_length_exceeded') ||
    b.includes('too many tokens') ||
    b.includes('max tokens must be less than') ||
    b.includes('max_tokens` must be less than') ||
    b.includes('max_tokens must be less than') ||
    b.includes('must be less than or equal to `8192`')
  ) {
    return { nonRetryable: true, markExhausted: false };
  }
  // Unsupported parameter (e.g. max_tokens on newer OpenAI models, or Groq
  // models that don't support response_format=json_schema, or Gemini models
  // rejecting an unknown response_schema field). The model is reachable but
  // refuses *this* request shape — skip without exhausting so it can still be
  // used by other callers without jsonSchema. The schema-mode allowlist in
  // shouldUseSchemaMode() prevents most of these at send-time.
  if (
    b.includes('unsupported parameter') ||
    b.includes('does not support response format') ||
    b.includes('response_format') && b.includes('not support') ||
    b.includes("unknown name 'type' at 'generation_config.response_schema") ||
    b.includes('response_schema.properties')
  ) {
    return { nonRetryable: true, markExhausted: false };
  }
  return { nonRetryable: false, markExhausted: false };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Strip <think>...</think> reasoning tags from model output.
 * Reasoning models (DeepSeek-R1, Qwen3) wrap their chain-of-thought
 * in these tags. We only want the final answer.
 */
function stripThinkTags(text) {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
}

/** Set of model IDs known to include <think> tags in their output */
const REASONING_MODELS = new Set([
  'DeepSeek-R1',
  'DeepSeek-R1-0528',
  'deepseek-reasoner',
  'deepseek/deepseek-r1-zero',  // OpenRouter DeepSeek R1 Zero (API model ID after prefix strip)
  'o4-mini',
  'o3-mini',
  'qwen/qwen3-32b',     // Groq Qwen3 uses <think> tags
]);

/**
 * Models that use `max_completion_tokens` instead of `max_tokens`.
 * Newer OpenAI models (o-series, gpt-5) reject `max_tokens` with HTTP 400:
 * "Unsupported parameter: 'max_tokens' is not supported with this model."
 */
const MAX_COMPLETION_TOKENS_MODELS = new Set([
  'gpt-5-nano',
  'gpt-5-mini',
  'gpt-5',
  'gpt-5-chat',
  'o4-mini',
  'o3-mini',
  'o1',
  'o1-mini',
  'o3',
  'Grok-3',
  'Grok-3-Mini',
  'MAI-DS-R1',
  'Phi-4-mini-reasoning',
  'Phi-4-reasoning',
]);

/**
 * Per-model REQUEST (input + output) token caps for HTTP 413 / "request body
 * too large" pre-check. When the estimated prompt size approaches one of these
 * limits, callLLM skips the model BEFORE making the HTTP call — otherwise the
 * call would 413 and the fallback chain would burn retries on the same payload.
 *
 * Verified 2026-05-14 from run 25874585556 failures:
 *   - GitHub Models o-series + gpt-5-* family enforce 4000-token request bodies
 *   - DeepSeek R1/V3 and gpt-4o-mini also cap at 4000 on GitHub Models
 *   - Phi-4 / Cohere-command-a / Cohere-command-r-plus-08-2024 /
 *     Llama-3.2-90B-Vision-Instruct / cerebras/llama3.1-8b cap at 8000
 *
 * Heuristic: estimated_tokens = chars / 4 + safety_margin (500).
 * If the estimate exceeds MODEL_MAX_REQUEST_TOKENS[apiModelId], skip the model.
 *
 * Conservative caps: a few of these limits are higher in practice but the
 * tightest observed 413 boundary wins. False-positive cost is one skipped
 * model; false-negative cost is a 413 + a wasted retry slot.
 */
const MODEL_MAX_REQUEST_TOKENS = {
  // GitHub Models — o-series + gpt-5-* family + 4o-mini (4000)
  'o1':                4000,
  'o1-mini':           4000,
  'o3-mini':           4000,
  'o4-mini':           4000,
  'gpt-5-nano':        4000,
  'gpt-5-mini':        4000,
  'gpt-5-chat':        4000,
  'gpt-4o-mini':       4000,
  'DeepSeek-R1':       4000,
  'DeepSeek-R1-0528':  4000,
  'DeepSeek-V3-0324':  4000,
  // 8000-token bracket
  'Phi-4':                              8000,
  'Cohere-command-a':                   8000,
  'Cohere-command-r-plus-08-2024':      8000,
  'Llama-3.2-90B-Vision-Instruct':      8000,
  // cerebras/* models — apiModelId is stripped of the provider prefix
  'llama3.1-8b':                        8000,
};

/**
 * Estimate token count for a list of OpenAI-format messages. Uses the standard
 * chars/4 ≈ tokens heuristic — accurate enough for "is this prompt going to
 * blow past 4000?" decisions. Adds a 500-token safety margin to account for
 * the response prefix, role markers, and tokenizer variance.
 *
 * Exported for tests / smoke probes.
 */
export function estimateRequestTokens(messages, opts = {}) {
  const SAFETY_MARGIN = 500;
  let chars = 0;
  for (const m of messages || []) {
    const c = m?.content;
    if (typeof c === 'string') chars += c.length;
    else if (Array.isArray(c)) {
      for (const part of c) {
        if (typeof part === 'string') chars += part.length;
        else if (part?.text) chars += String(part.text).length;
      }
    }
  }
  // jsonSchema is serialized and sent in response_format → counts toward body
  if (opts.jsonSchema?.schema) {
    try { chars += JSON.stringify(opts.jsonSchema.schema).length; } catch { /* noop */ }
  }
  return Math.ceil(chars / 4) + SAFETY_MARGIN;
}

/** Models with lower max output token limits.
 *  Cohere API enforces "max tokens must be less than or equal to 8000"
 *  despite documentation saying 8192 — use 8000 to match actual enforcement. */
const MODEL_MAX_OUTPUT_TOKENS = {
  'Cohere-command-a': 8000,
  'Cohere-command-r-plus-08-2024': 8000,
  'Cohere-command-r-08-2024': 4096,
  // Cohere direct models (same limits)
  'command-a-03-2025': 8000,
  'command-r-plus-08-2024': 8000,
  'command-r-08-2024': 4096,
  'command-a-reasoning-08-2025': 8000,
  'command-a-translate-08-2025': 8000,
  'c4ai-aya-expanse-32b': 8000,
  'command-r7b-12-2024': 4096,
  // Groq Llama 4 family enforces max_tokens <= 8192.
  'meta-llama/llama-4-scout-17b-16e-instruct': 8192,
};

// ── Low-level provider calls ─────────────────────────────────

/**
 * Generic OpenAI-compatible API caller with retry logic.
 * Used for GitHub Models, Groq, and DeepSeek (all share the same API format).
 *
 * @param {string} apiModel — Model ID to send to the API (without provider prefix)
 * @param {Array} messages — OpenAI-format messages
 * @param {object} opts — Merged options
 * @param {object} provider — { endpoint, apiKey, providerName, trackAs, extraHeaders }
 */
async function _callOpenAICompatible(apiModel, messages, opts, { endpoint, apiKey, providerName, trackAs, extraHeaders }) {
  if (!apiKey) throw new Error(`${providerName} API key not set`);
  const modelForTracking = trackAs || apiModel;
  const displayModel = providerName === 'GitHub' ? apiModel : `${providerName}/${apiModel}`;

  // Cap maxTokens to model-specific limits (e.g. Cohere max 8192)
  const modelLimit = MODEL_MAX_OUTPUT_TOKENS[apiModel];
  const effectiveMaxTokens = modelLimit ? Math.min(opts.maxTokens, modelLimit) : opts.maxTokens;

  // Newer OpenAI models (gpt-5-*, o4-mini, o3-mini) require
  // `max_completion_tokens` instead of `max_tokens`
  const useCompletionTokens = MAX_COMPLETION_TOKENS_MODELS.has(apiModel);
  const tokenParam = useCompletionTokens
    ? { max_completion_tokens: effectiveMaxTokens }
    : { max_tokens: effectiveMaxTokens };

  // o-series and gpt-5 reasoning models don't support temperature
  const supportsTemperature = !useCompletionTokens;

  // Prefer strict JSON-Schema mode when the caller provided a schema AND this
  // provider supports it — this is what stops the model from silently dropping
  // required fields like `body2`/`body3`. Falls back to `json_object` mode for
  // providers that don't support strict schema (the per-call retry loop in
  // create-article.mjs continues to cover that case).
  //
  // AI_MODELS_SCHEMA_MODE=off disables schema-mode entirely (ops kill-switch);
  // AI_MODELS_SCHEMA_MODE=force opts in every OpenAI-compat provider (probe
  // mode only — most providers 400 on unsupported response_format types).
  let responseFormat;
  if (shouldUseSchemaMode(providerName, !!opts.jsonSchema)) {
    responseFormat = {
      type: 'json_schema',
      json_schema: {
        name: opts.jsonSchema.name || 'response',
        strict: true,
        schema: opts.jsonSchema.schema,
      },
    };
  } else if (opts.jsonMode || opts.jsonSchema) {
    responseFormat = { type: 'json_object' };
  }

  const body = {
    model: apiModel,
    messages,
    ...(supportsTemperature ? { temperature: opts.temperature } : {}),
    ...tokenParam,
    ...(responseFormat ? { response_format: responseFormat } : {}),
  };

  for (let attempt = 1; attempt <= opts.maxRetriesPerModel; attempt++) {
    _stats.calls++;
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          ...(extraHeaders || {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeout),
      });

      const raw = await res.text().catch(() => '');

      if (!res.ok) {
        // Daily limit — mark exhausted immediately
        if (isDailyLimitError(res.status, raw)) {
          markModelExhausted(modelForTracking);
          _stats.exhausted++;
          throw new Error(`[${displayModel}] Daily request limit reached`);
        }
        // Non-retryable client errors (unknown model, context too small)
        const nrc = classifyNonRetryableError(res.status, raw);
        if (nrc.nonRetryable) {
          if (nrc.markExhausted) {
            markModelExhausted(modelForTracking);
            _stats.exhausted++;
          }
          const err = new Error(`[${displayModel}] HTTP ${res.status}: ${raw.slice(0, 300)}`);
          err.nonRetryable = true;
          throw err;
        }
        // Retryable error — wait and retry (use double backoff for 429 rate limits)
        if (isRetryableError(res.status, raw) && attempt < opts.maxRetriesPerModel) {
          const is429 = res.status === 429;
          // FAST PATH: daily quota exceeded → mark exhausted immediately, don't waste 2 min retrying.
          // These errors won't resolve until the quota resets (typically midnight).
          const isDailyQuota = is429 && /tokens?\s*per\s*day|daily.*limit|quota_exceeded|daily.*quota/i.test(raw);
          if (isDailyQuota) {
            console.log(`🚫 [${displayModel}] Daily quota exhausted — skipping retries`);
            throw Object.assign(new Error(`[${displayModel}] Daily quota: ${raw.slice(0, 150)}`), { exhausted: true });
          }
          _stats.retries++;
          // On 429: cool down the entire provider so sibling models are skipped
          if (is429) {
            cooldownProvider(getProvider(modelForTracking));
            _stats.providerCooldowns++;
          }
          // Respect Retry-After header if present (seconds or HTTP-date)
          // Cap at 2 minutes — some providers (e.g. Cerebras) return Retry-After: 86399 (24h)
          // which would freeze the entire translation pipeline.
          const MAX_RETRY_AFTER_MS = 2 * 60 * 1000;
          const retryAfterHeader = res.headers?.get?.('retry-after');
          const retryAfterRaw = retryAfterHeader ? (Number(retryAfterHeader) > 0 ? Number(retryAfterHeader) * 1000 : 0) : 0;
          const retryAfterMs = Math.min(retryAfterRaw, MAX_RETRY_AFTER_MS);
          const baseWaitMs = is429
            ? attempt * opts.backoffMs * 3   // Triple backoff for rate limits
            : attempt * opts.backoffMs;
          const waitMs = Math.max(baseWaitMs, retryAfterMs);
          console.warn(`⚠️  [${displayModel}] ${res.status} retry ${attempt}/${opts.maxRetriesPerModel} — wait ${waitMs}ms`);
          await sleep(waitMs);
          continue;
        }
        throw new Error(`[${displayModel}] HTTP ${res.status}: ${raw.slice(0, 300)}`);
      }

      // Parse response
      const data = JSON.parse(raw);
      let text = data?.choices?.[0]?.message?.content || '';
      // Strip <think> reasoning tags — apply universally (safe: no valid
      // translation output contains <think> XML; catches models not yet in
      // REASONING_MODELS set that still emit chain-of-thought tags)
      if (text) text = stripThinkTags(text);
      if (!text) {
        if (attempt < opts.maxRetriesPerModel) {
          _stats.retries++;
          console.warn(`⚠️  [${displayModel}] Empty response, retry ${attempt}/${opts.maxRetriesPerModel}`);
          await sleep(attempt * 1200);
          continue;
        }
        throw new Error(`[${displayModel}] Empty response after ${opts.maxRetriesPerModel} attempts`);
      }

      _stats.successes++;
      return text;
    } catch (e) {
      // Re-throw daily limit errors (already marked)
      if (e.message?.includes('Daily request limit')) throw e;
      // Re-throw non-retryable errors immediately (unknown model, context limit)
      if (e.nonRetryable) throw e;
      // Re-throw on last attempt
      if (attempt >= opts.maxRetriesPerModel) throw e;
      // Timeout errors: retry only once (model is likely overloaded, not transiently failing)
      const isTimeout = e.name === 'AbortError' || e.name === 'TimeoutError' || /timeout|aborted/i.test(e.message || '');
      if (isTimeout && attempt >= 2) throw e;
      // Otherwise retry
      _stats.retries++;
      const waitMs = attempt * opts.backoffMs;
      console.warn(`⚠️  [${displayModel}] Error retry ${attempt}/${opts.maxRetriesPerModel}: ${e.message?.slice(0, 150)}`);
      await sleep(waitMs);
    }
  }
  throw new Error(`[${displayModel}] Exhausted after ${opts.maxRetriesPerModel} attempts`);
}

// ── Provider-specific callers ────────────────────────────────

function _callGitHub(model, messages, opts) {
  return _callOpenAICompatible(model, messages, opts, {
    endpoint: GH_MODELS_BASE,
    apiKey: getGhModelsPat(),
    providerName: 'GitHub',
  });
}

/**
 * Call a model on Groq Cloud (OpenAI-compatible, ultra-fast inference).
 * Free tier: 1000 req/day per model.
 */
function _callGroq(model, messages, opts) {
  const apiModel = getApiModelId(model);
  return _callOpenAICompatible(apiModel, messages, opts, {
    endpoint: GROQ_API_BASE,
    apiKey: getGroqApiKey(),
    providerName: 'Groq',
    trackAs: model,  // Stats tracked under the prefixed name
  });
}

/**
 * Call a model on OpenRouter (OpenAI-compatible, free :free models).
 * Free tier: 50 req/day for :free models.
 */
function _callOpenRouter(model, messages, opts) {
  const apiModel = getApiModelId(model);
  return _callOpenAICompatible(apiModel, messages, opts, {
    endpoint: OPENROUTER_API_BASE,
    apiKey: getOpenRouterApiKey(),
    providerName: 'OpenRouter',
    trackAs: model,
    extraHeaders: {
      'HTTP-Referer': 'https://frontaliereticino.ch',
      'X-Title': 'Frontaliere Ticino',
    },
  });
}

/**
 * Call a model on Cerebras Cloud (OpenAI-compatible, ultra-fast inference).
 * Free tier available for supported Llama models.
 */
function _callCerebras(model, messages, opts) {
  const apiModel = getApiModelId(model);
  return _callOpenAICompatible(apiModel, messages, opts, {
    endpoint: CEREBRAS_API_BASE,
    apiKey: getCerebrasApiKey(),
    providerName: 'Cerebras',
    trackAs: model,
  });
}

/**
 * Call a model on Together AI (OpenAI-compatible, free tier).
 */
function _callTogether(model, messages, opts) {
  const apiModel = getApiModelId(model);
  return _callOpenAICompatible(apiModel, messages, opts, {
    endpoint: TOGETHER_API_BASE,
    apiKey: getTogetherApiKey(),
    providerName: 'Together',
    trackAs: model,
  });
}

/**
 * Call a model on Fireworks AI (OpenAI-compatible, free tier).
 */
function _callFireworks(model, messages, opts) {
  const apiModel = getApiModelId(model);
  return _callOpenAICompatible(apiModel, messages, opts, {
    endpoint: FIREWORKS_API_BASE,
    apiKey: getFireworksApiKey(),
    providerName: 'Fireworks',
    trackAs: model,
  });
}

/**
 * Call a model on NVIDIA NIM (OpenAI-compatible, free tier).
 */
function _callNvidia(model, messages, opts) {
  const apiModel = getApiModelId(model);
  return _callOpenAICompatible(apiModel, messages, opts, {
    endpoint: NVIDIA_API_BASE,
    apiKey: getNvidiaApiKey(),
    providerName: 'NVIDIA',
    trackAs: model,
  });
}

/**
 * Call a model on HuggingFace Inference Router (OpenAI-compatible, free tier).
 */
function _callHuggingFace(model, messages, opts) {
  const apiModel = getApiModelId(model);
  return _callOpenAICompatible(apiModel, messages, opts, {
    endpoint: HUGGINGFACE_API_BASE,
    apiKey: getHuggingFaceApiKey(),
    providerName: 'HuggingFace',
    trackAs: model,
  });
}

/**
 * Call a model on SambaNova Cloud (OpenAI-compatible, free tier, ultra-fast).
 */
function _callSambaNova(model, messages, opts) {
  const apiModel = getApiModelId(model);
  return _callOpenAICompatible(apiModel, messages, opts, {
    endpoint: SAMBANOVA_API_BASE,
    apiKey: getSambaNovaApiKey(),
    providerName: 'SambaNova',
    trackAs: model,
  });
}

function _callCohere(model, messages, opts) {
  const apiModel = getApiModelId(model);
  return _callOpenAICompatible(apiModel, messages, opts, {
    endpoint: COHERE_API_BASE,
    apiKey: getCohereApiKey(),
    providerName: 'Cohere',
    trackAs: model,
  });
}

/**
 * Call a model on Cloudflare Workers AI (OpenAI-compatible, free tier).
 * Free tier: 10,000 neurons/day (no credit card needed).
 * Endpoint is dynamic: requires CF_ACCOUNT_ID in the URL.
 */
function _callCloudflare(model, messages, opts) {
  const apiModel = getApiModelId(model);
  const accountId = getCfAccountId();
  if (!accountId) throw new Error('CF_ACCOUNT_ID not set');
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;
  return _callOpenAICompatible(apiModel, messages, opts, {
    endpoint,
    apiKey: getCloudflareApiToken(),
    providerName: 'Cloudflare',
    trackAs: model,
  });
}

/**
 * Call a model on Mistral AI La Plateforme (OpenAI-compatible, free tier).
 * Free tier: 1B tokens/month, 1 req/sec (phone verification required).
 */
function _callMistral(model, messages, opts) {
  const apiModel = getApiModelId(model);
  return _callOpenAICompatible(apiModel, messages, opts, {
    endpoint: MISTRAL_API_BASE,
    apiKey: getMistralApiKey(),
    providerName: 'Mistral',
    trackAs: model,
  });
}

/**
 * Call a model on Mistral Codestral endpoint (separate quota: 30 req/min, 2000 req/day).
 * Uses the same MISTRAL_API_KEY but a separate endpoint with its own rate limits.
 */
function _callCodestral(model, messages, opts) {
  const apiModel = getApiModelId(model);
  return _callOpenAICompatible(apiModel, messages, opts, {
    endpoint: CODESTRAL_API_BASE,
    apiKey: getCodestralApiKey(),
    providerName: 'Codestral',
    trackAs: model,
  });
}

/**
 * Call a single Gemini model with retry.
 * Returns the text content on success.
 */
async function _callGeminiRaw(model, messages, opts) {
  const apiKey = getGeminiApiKey();
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  // Convert OpenAI messages → Gemini format
  const systemParts = messages.filter((m) => m.role === 'system').map((m) => ({ text: m.content }));
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

  // Gemini's schema-mode is server-enforced: when responseSchema is supplied
  // the model cannot omit required fields. We sanitize the schema first to
  // drop JSON-Schema keywords Gemini rejects (additionalProperties, oneOf, etc).
  // Gemini has its own response_schema syntax (Proto-style), so it uses a
  // dedicated allowlist entry below — but it still honors the AI_MODELS_SCHEMA_MODE
  // ops kill-switch via the same `shouldUseSchemaMode('Gemini', …)` check.
  const useGeminiSchema = !!opts.jsonSchema && shouldUseSchemaMode('Gemini', true);
  const geminiSchema = useGeminiSchema ? sanitizeSchemaForGemini(opts.jsonSchema.schema) : null;

  const body = {
    ...(systemParts.length > 0 ? { systemInstruction: { parts: systemParts } } : {}),
    contents,
    generationConfig: {
      temperature: opts.temperature,
      maxOutputTokens: opts.maxTokens,
      ...((opts.jsonMode || useGeminiSchema) ? { responseMimeType: 'application/json' } : {}),
      ...(useGeminiSchema ? { responseSchema: geminiSchema } : {}),
    },
  };

  const endpoint = `${GEMINI_API_BASE}/${model}:generateContent?key=${apiKey}`;

  for (let attempt = 1; attempt <= opts.maxRetriesPerModel; attempt++) {
    _stats.calls++;
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeout),
      });

      const raw = await res.text().catch(() => '');

      if (!res.ok) {
        // Quota / rate-limit — mark exhausted if it looks permanent
        if (isDailyLimitError(res.status, raw)) {
          markModelExhausted(model);
          _stats.exhausted++;
          throw new Error(`[${model}] Daily quota reached`);
        }
        // Non-retryable client errors (unknown model, context too small)
        const nrc = classifyNonRetryableError(res.status, raw);
        if (nrc.nonRetryable) {
          if (nrc.markExhausted) {
            markModelExhausted(model);
            _stats.exhausted++;
          }
          const err = new Error(`[${model}] HTTP ${res.status}: ${raw.slice(0, 300)}`);
          err.nonRetryable = true;
          throw err;
        }
        if (isRetryableError(res.status, raw) && attempt < opts.maxRetriesPerModel) {
          _stats.retries++;
          if (res.status === 429) {
            cooldownProvider(PROVIDER.GEMINI);
            _stats.providerCooldowns++;
          }
          // Respect Retry-After header if present (capped at 2 minutes)
          const MAX_RETRY_AFTER_MS_GEMINI = 2 * 60 * 1000;
          const retryAfterHeader = res.headers?.get?.('retry-after');
          const retryAfterRaw = retryAfterHeader ? (Number(retryAfterHeader) > 0 ? Number(retryAfterHeader) * 1000 : 0) : 0;
          const retryAfterMs = Math.min(retryAfterRaw, MAX_RETRY_AFTER_MS_GEMINI);
          const waitMs = Math.max(attempt * opts.backoffMs, retryAfterMs);
          console.warn(`⚠️  [${model}] ${res.status} retry ${attempt}/${opts.maxRetriesPerModel} — wait ${waitMs}ms`);
          await sleep(waitMs);
          continue;
        }
        throw new Error(`[${model}] HTTP ${res.status}: ${raw.slice(0, 300)}`);
      }

      // Parse response — skip "thought" parts
      const data = JSON.parse(raw);
      const text = data?.candidates?.[0]?.content?.parts?.find((p) => p.text && !p.thought)?.text || '';
      if (!text) {
        if (attempt < opts.maxRetriesPerModel) {
          _stats.retries++;
          console.warn(`⚠️  [${model}] Empty response, retry ${attempt}/${opts.maxRetriesPerModel}`);
          await sleep(attempt * 1200);
          continue;
        }
        throw new Error(`[${model}] Empty response after ${opts.maxRetriesPerModel} attempts`);
      }

      _stats.successes++;
      return text;
    } catch (e) {
      if (e.message?.includes('Daily quota')) throw e;
      if (e.nonRetryable) throw e;
      if (attempt >= opts.maxRetriesPerModel) throw e;
      // Timeout errors: retry only once (model is likely overloaded)
      const isTimeout = e.name === 'AbortError' || e.name === 'TimeoutError' || /timeout|aborted/i.test(e.message || '');
      if (isTimeout && attempt >= 2) throw e;
      _stats.retries++;
      const waitMs = attempt * opts.backoffMs;
      console.warn(`⚠️  [${model}] Error retry ${attempt}/${opts.maxRetriesPerModel}: ${e.message?.slice(0, 150)}`);
      await sleep(waitMs);
    }
  }
  throw new Error(`[${model}] Exhausted after ${opts.maxRetriesPerModel} attempts`);
}

// ── Model routing ────────────────────────────────────────────

/** Route a model call to the correct provider */
function _callModel(model, messages, opts) {
  const provider = getProvider(model);
  switch (provider) {
    case PROVIDER.GITHUB:      return _callGitHub(model, messages, opts);
    case PROVIDER.GEMINI:      return _callGeminiRaw(model, messages, opts);
    case PROVIDER.GROQ:        return _callGroq(model, messages, opts);
    case PROVIDER.OPENROUTER:  return _callOpenRouter(model, messages, opts);
    case PROVIDER.CEREBRAS:    return _callCerebras(model, messages, opts);
    case PROVIDER.TOGETHER:    return _callTogether(model, messages, opts);
    case PROVIDER.FIREWORKS:   return _callFireworks(model, messages, opts);
    case PROVIDER.NVIDIA:      return _callNvidia(model, messages, opts);
    case PROVIDER.HUGGINGFACE: return _callHuggingFace(model, messages, opts);
    case PROVIDER.SAMBANOVA:   return _callSambaNova(model, messages, opts);
    case PROVIDER.COHERE:      return _callCohere(model, messages, opts);
    case PROVIDER.CLOUDFLARE:  return _callCloudflare(model, messages, opts);
    case PROVIDER.MISTRAL:     return _callMistral(model, messages, opts);
    case PROVIDER.CODESTRAL:   return _callCodestral(model, messages, opts);
    default: throw new Error(`[${model}] Unknown provider: ${provider}`);
  }
}

// ── Public API ───────────────────────────────────────────────

/**
 * Call a specific model directly (no fallback chain).
 * Useful when you need a specific model for a task.
 *
 * @param {Array<{role: string, content: string}>} messages — OpenAI-format messages
 * @param {object} opts — Options
 * @param {string} opts.model — Model ID (e.g. AI_MODELS.GPT4O)
 * @param {number} [opts.temperature=0.2]
 * @param {number} [opts.maxTokens=4096]
 * @param {boolean} [opts.jsonMode=false]
 * @param {number} [opts.timeout=30000]
 * @param {number} [opts.maxRetriesPerModel=5]
 * @param {number} [opts.backoffMs=2500]
 * @returns {Promise<string>} — Text content from the model
 */
export async function callSingleModel(messages, opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  const model = o.model || AI_MODELS.GPT4O;

  if (_exhaustedModels.has(model)) {
    throw new Error(`[${model}] Model is exhausted for this run`);
  }

  return _callModel(model, messages, o);
}

/**
 * Call an LLM with automatic fallback chain + scored model selection.
 *
 * The chain is dynamically re-sorted by each model's accumulated score
 * before every call. Models that succeed gain score and float to the top;
 * models that fail lose score and sink to the bottom. This avoids
 * repeatedly trying a model that has been failing (e.g. rate-limited or
 * down), which would slow down the entire crawl.
 *
 * Scores are persisted to Firestore (`ai_model_scores` collection) so
 * all workflows share live model intelligence. If Firestore is unavailable,
 * scoring falls back to in-memory only.
 *
 * On first call, automatically initializes the Firestore score store
 * (if not already initialized via `initScoreStore()`).
 *
 * For each model:
 * 1. If model is exhausted (daily limit), skip it
 * 2. If API key for provider is missing, skip it
 * 3. Try up to `maxRetriesPerModel` times
 * 4. On success, record success score (+2) and return
 * 5. On failure, record failure score (-3/-10/-50) and move to next model
 *
 * Default chain: 55 models across 9 providers (GitHub Models, Gemini, Groq, OpenRouter,
 * Cerebras, Together AI, Fireworks AI, NVIDIA NIM, HuggingFace).
 * Initial order is quality-based (best first), but dynamically adapts as the
 * run progresses based on actual success/failure patterns.
 *
 * @param {Array<{role: string, content: string}>} messages — OpenAI-format messages
 * @param {object} opts — Options (same as callSingleModel, plus `chain`)
 * @param {string} [opts.model] — Starting model (overrides chain start)
 * @param {string[]} [opts.chain] — Custom fallback chain
 * @returns {Promise<string>} — Text content from whichever model succeeded
 */
export async function callLLM(messages, opts = {}) {
  // Auto-init score store on first call (no-op if already initialized)
  if (!_storeInitialized) {
    await initScoreStore();
  }

  const o = { ...DEFAULT_OPTS, ...opts };
  let chain = o.chain || [...DEFAULT_CHAIN];

  // If a specific model is requested, start the chain from that model
  if (o.model) {
    const idx = chain.indexOf(o.model);
    if (idx > 0) {
      chain = chain.slice(idx);
    } else if (idx < 0) {
      // Requested model not in chain — prepend it, keep chain as fallback
      chain = [o.model, ...chain.filter((m) => m !== o.model)];
    }
  }

  // Sort by accumulated score — models that are working well come first,
  // models that have been failing are pushed down.
  // The initial call uses DEFAULT_CHAIN order (all scores 0, tiebreak by index).
  chain = sortChainByScore(chain);

  const errors = [];

  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];

    // Skip exhausted models
    if (_exhaustedModels.has(model)) {
      console.warn(`⏭️  [${model}] Skipped — exhausted (daily limit)`);
      continue;
    }

    // Skip models whose provider is cooling down (recent 429)
    const provider = getProvider(model);
    if (isProviderCoolingDown(provider)) {
      continue;
    }

    // Skip models without API keys
    if (!isModelAvailable(model)) {
      continue;
    }

    // Skip models whose max output token limit is below the requested maxTokens.
    // This avoids wasting API calls that will fail with "max tokens must be less than" errors.
    const apiModelId = getApiModelId(model);
    const modelLimit = MODEL_MAX_OUTPUT_TOKENS[apiModelId];
    if (modelLimit && o.maxTokens > modelLimit) {
      continue;
    }

    // Skip models whose REQUEST (input) token cap is below the estimated prompt
    // size. Without this, models like o1 / gpt-5-mini / Phi-4 get tried with a
    // payload they cannot fit and return HTTP 413, burning a retry slot for
    // every fallback. See MODEL_MAX_REQUEST_TOKENS for the per-model caps.
    const reqLimit = MODEL_MAX_REQUEST_TOKENS[apiModelId];
    if (reqLimit) {
      const estTokens = estimateRequestTokens(messages, o);
      if (estTokens > reqLimit) {
        // One-line log per skip so ops can see the cascade in the workflow output
        console.warn(`⏭️  [${model}] Skipped — request would exceed ${reqLimit}-token limit (estimated ${estTokens})`);
        continue;
      }
    }

    try {
      if (i > 0) {
        _stats.fallbacks++;
        console.warn(`🔄 Falling back to ${model} (score: ${_modelScores.get(model) || 0})...`);
      }

      const result = await _callModel(model, messages, o);

      // ✅ Success — boost this model's score so it stays near the top
      recordModelSuccess(model);
      _consecutive429.delete(model); // FRO-325: reset 429 counter on success

      if (i > 0) {
        console.warn(`✅ Fallback to ${model} succeeded (score → ${_modelScores.get(model) || 0})`);
      }
      // Surface the model used to the caller (out-param) so downstream
      // validation can penalize this specific model if the payload turns
      // out to be malformed despite the HTTP 200 response.
      if (o.modelUsedRef && typeof o.modelUsedRef === 'object') {
        o.modelUsedRef.model = model;
      }
      return result;
    } catch (e) {
      const msg = e?.message || String(e);
      errors.push(`${model}: ${msg.slice(0, 200)}`);

      // ❌ Failure — penalize this model's score so it drops in priority
      const isExhausted =
        msg.includes('Daily request limit') ||
        msg.includes('Daily quota') ||
        msg.toLowerCase().includes('exceeded your current quota') ||
        msg.toLowerCase().includes('plan and billing details');
      // FRO-325: Track consecutive 429s — exhaust model after MAX_CONSECUTIVE_429
      const is429Failure = /429|rate.?limit|resource.?exhausted/i.test(msg);
      if (is429Failure) {
        const count = (_consecutive429.get(model) || 0) + 1;
        _consecutive429.set(model, count);
        if (count >= MAX_CONSECUTIVE_429) {
          markModelExhausted(model);
          _stats.exhausted++;
          console.warn(`🚫 [${model}] Exhausted after ${count} consecutive 429s`);
        }
      } else {
        // Reset counter on non-429 failure (model is reachable but errored differently)
        _consecutive429.delete(model);
      }
      // Timeout circuit breaker: if a model timed out after retries, mark it
      // exhausted so subsequent callLLM invocations skip it entirely.
      const isTimeoutFailure = e.name === 'AbortError' || e.name === 'TimeoutError' || /timeout|aborted/i.test(msg);
      if (isTimeoutFailure) {
        markModelExhausted(model);
        _stats.exhausted++;
      }
      recordModelFailure(model, {
        nonRetryable: !!e.nonRetryable,
        exhausted: isExhausted || isTimeoutFailure,
      });

      console.warn(`❌ [${model}] Failed${isTimeoutFailure ? ' (timeout → exhausted)' : ''} (score → ${_modelScores.get(model) || 0}): ${msg.slice(0, 200)}`);
      // Continue to next model in chain
    }
  }

  // All models failed
  const summary = errors.join(' | ');
  _stats.errors.push(summary);
  // Flush scores before throwing — ensures failure data is persisted
  await flushScores();
  const err = new Error(`All AI models failed. Chain: [${chain.join(' → ')}]. Errors: ${summary}`);
  err.code = 'ALL_MODELS_EXHAUSTED';
  throw err;
}
