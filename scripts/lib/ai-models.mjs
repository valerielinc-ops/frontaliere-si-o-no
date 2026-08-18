/**
 * Centralized AI Model Service — v15 (free-only, 115+ models, 14 providers)
 *
 * Single source of truth for all LLM calls across scripts (jobs crawler,
 * article generator, company parser, etc.).
 *
 * Features:
 * - Extended fallback chain with 115+ FREE models across 14 providers
 * - **Dynamic multi-provider discovery**: auto-detects new free models at
 *   runtime from every provider that exposes an OpenAI-compatible
 *   `GET /v1/models` listing (OpenRouter, Groq, Cerebras, Mistral)
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
  // LLAMA_3_1_405B removed — GitHub Models HTTP 400 "unknown_model: Meta-Llama-3.1-405B-Instruct" (2026-07-05, confirmed retired live against the real inference endpoint, 20x in 30-run sample)
  // LLAMA_3_1_8B removed — GitHub Models HTTP 400 "unknown_model: Meta-Llama-3.1-8B-Instruct" (2026-07-05, confirmed retired live against the real inference endpoint, 20x in 30-run sample). NB: GROQ_LLAMA_3_1_8B/CB_LLAMA_3_1_8B/FW_LLAMA_3_1_8B/NV_LLAMA_3_1_8B are separate, still-alive constants on other providers.
  PHI_4:            'Phi-4',
  DEEPSEEK_R1:      'DeepSeek-R1',
  // COHERE_CMD_R_PLUS removed — GitHub Models HTTP 400 "unknown_model: Cohere-command-r-plus-08-2024" (2026-07-05, confirmed retired live against the real inference endpoint, 14x in 30-run sample)
  CODESTRAL:        'Codestral-2501',
  GPT_4_1:          'gpt-4.1',
  GPT_4_1_MINI:     'gpt-4.1-mini',
  GPT_4_1_NANO:     'gpt-4.1-nano',
  // COHERE_CMD_R removed — GitHub Models HTTP 400 "unknown_model: Cohere-command-r-08-2024" (2026-07-05, confirmed retired live against the real inference endpoint)
  COHERE_CMD_A:     'Cohere-command-a',
  // LLAMA_3_2_90B removed — GitHub Models HTTP 400 "unknown_model: Llama-3.2-90B-Vision-Instruct" (2026-07-05, confirmed retired live against the real inference endpoint, 12x in 30-run sample)
  DEEPSEEK_V3:      'DeepSeek-V3-0324',
  // GPT_5_NANO removed — GitHub Models HTTP 400 "unavailable_model" (2026-05-18)
  // GPT_5_MINI removed — GitHub Models HTTP 400 "unavailable_model" (2026-05-18)
  // O4_MINI removed — GitHub Models HTTP 400 "unavailable_model" (2026-05-18)
  DEEPSEEK_R1_0528: 'DeepSeek-R1-0528',
  MINISTRAL_3B:     'Ministral-3B',
  // GPT_5 removed — GitHub Models HTTP 400 "unavailable_model" (2026-05-18)
  // GROK_3 removed — GitHub Models HTTP 400 "unknown_model: grok-3" (2026-05-18)
  // GROK_3_MINI removed — GitHub Models HTTP 400 "unknown_model: grok-3-mini" (2026-05-18)
  MAI_DS_R1:        'MAI-DS-R1',
  MISTRAL_MEDIUM_3: 'Mistral-Medium-3',
  // O1 removed — GitHub Models HTTP 400 "unavailable_model" (2026-05-18)
  PHI_4_MINI_REASON:'Phi-4-mini-reasoning',
  // GPT_5_CHAT removed — GitHub Models HTTP 400 "unavailable_model" (2026-05-18)
  PHI_4_REASON:     'Phi-4-reasoning',
  PHI_4_MINI_INST:  'Phi-4-mini-instruct',
  JAMBA_1_5_LARGE:  'AI21-Jamba-1.5-Large',
  MISTRAL_SM_31_GH: 'Mistral-Small-3.1',
  // O1_MINI removed — GitHub Models HTTP 400 "unavailable_model" (2026-05-18)
  // Gemma models use the same Gemini API endpoint — 14,400 req/day each!
  GEMINI_FLASH:     'gemini-2.5-flash',
  GEMINI_PRO:       'gemini-2.5-pro',
  // gemini-2.0-flash e' RITIRATO: l'API risponde HTTP 404 "This model models/gemini-2.0-flash is
  //                       no longer available" (2026-08-14, run 31823202761, 8 hit). Resta in
  //                       roster di proposito: dal fix al matcher del 404 qui sotto viene marcato
  //                       esaurito al PRIMO 404 e non piu' richiamato per il resto della run.
  //                       Curare il roster a mano e' cio' che ha gia' fallito una volta (vedi
  //                       GEMINI_31_FLASH_LITE piu' sotto): la lista rimarcisce, il matcher no.
  GEMINI_2_FLASH:   'gemini-2.0-flash',
  GEMINI_FLASH_LITE:'gemini-2.5-flash-lite',
  // Gemma models via Gemini API — 14,400 req/day each!
  GEMMA_4_31B:      'gemma-4-31b-it',
  GEMMA_4_26B:      'gemma-4-26b-a4b-it',
  // GEMMA_3_27B removed — Gemini API HTTP 404 "models/gemma-3-27b-it is not found" (2026-05-18,
  //                       Google dropped Gemma 3.x from the Gemini API in favour of Gemma 4 MoE).
  //                       OpenRouter/HuggingFace mirrors of the same weights remain reachable as
  //                       OR_GEMMA_3_27B / HF_GEMMA_3_27B.
  // GEMMA_3_12B removed — Gemini API HTTP 404 (same Google deprecation 2026-05-18); mirrors
  //                       OR_GEMMA_3_12B / CF_GEMMA_3_12B remain available.
  // New Gemini 3.x models (preview)
  GEMINI_3_FLASH:   'gemini-3-flash-preview',
  // gemini-3-pro-preview e' RITIRATO (HTTP 404 "no longer available", 2026-08-14, 4 hit). Stessa
  //                       nota di GEMINI_2_FLASH sopra: se ne occupa il matcher, non la lista.
  GEMINI_3_PRO:     'gemini-3-pro-preview',
  // GEMINI_31_FLASH_LITE removed — Gemini API HTTP 404 "models/gemini-3.1-flash-lite-preview is no longer available" (2026-05-27, run 26534353239).
  //                       The GA replacement `gemini-3.1-flash-lite` is exposed below as GEMINI_31_FLASH_LITE_GA and stays in the chain.
  GEMINI_31_PRO:    'gemini-3.1-pro-preview',
  // Gemini "always latest stable" aliases (discovered 2026-05-18) — point at current
  // production endpoint so we follow Google's promotions without code changes.
  GEMINI_FLASH_LATEST:        'gemini-flash-latest',
  GEMINI_FLASH_LITE_LATEST:   'gemini-flash-lite-latest',
  GEMINI_PRO_LATEST:          'gemini-pro-latest',
  // gemini-2.0-flash-lite e' RITIRATO (HTTP 404 "no longer available", 2026-08-14, 10 hit — il
  //                       fallimento piu' frequente di quella run). Stessa nota.
  GEMINI_2_FLASH_LITE:        'gemini-2.0-flash-lite',
  GEMINI_31_FLASH_LITE_GA:    'gemini-3.1-flash-lite',

  // ── Groq (OpenAI-compatible, ultra-fast inference) ──
  // Each model: 1000 req/day (free tier)
  GROQ_LLAMA_4_SCT: 'groq/meta-llama/llama-4-scout-17b-16e-instruct',
  GROQ_LLAMA_3_3:   'groq/llama-3.3-70b-versatile',
  GROQ_LLAMA_3_1_8B:'groq/llama-3.1-8b-instant',
  GROQ_QWEN3_32B:   'groq/qwen/qwen3-32b',
  // GROQ_KIMI_K2 removed — Groq HTTP 404 "model `moonshotai/kimi-k2-instruct` does not exist" (2026-06-15). Was already out of DEFAULT_CHAIN (HTTP 413, see below) and its last runtime user (create-article MIN_WORDS_MODEL_ROTATION) was repointed to GROQ_GPT_OSS_120B. A dead id here only resurfaces as a 404 via Groq discovery.
  GROQ_GPT_OSS_120B:'groq/openai/gpt-oss-120b',
  GROQ_GPT_OSS_20B: 'groq/openai/gpt-oss-20b',
  // Discovered 2026-05-18: full compound family (non-mini variant of compound-beta).
  // Note the double "groq/" — Groq's own catalog id is "groq/compound" and our wrapper
  // strips one "groq/" prefix before sending to the API, so the stored id needs both.
  GROQ_COMPOUND_FULL: 'groq/groq/compound',
  // GROQ_LLAMA_4_MAV removed — Groq HTTP 404 "model `meta-llama/llama-4-maverick-17b-128e-instruct` does not exist" (2026-05-18)
  // GROQ_QWQ_32B removed — Groq HTTP 404 "model `qwen/qwq-32b` does not exist" (2026-05-18)
  GROQ_COMPOUND:    'groq/compound-beta',
  GROQ_COMPOUND_MINI:'groq/compound-mini',
  // GROQ_KIMI_K2_0905 removed — Groq HTTP 404 "model `moonshotai/kimi-k2-instruct-0905` does not exist" (2026-05-18)
  GROQ_GPT_OSS_SAFE: 'groq/openai/gpt-oss-safeguard-20b',
  // GROQ_LLAMA_3_3_SPEC removed — Groq HTTP 400 "model `llama-3.3-70b-specdec` has been decommissioned" (2026-05-27, run 26537033519).
  //                       Decommissioned in Groq's catalog; non-spec variant GROQ_LLAMA_3_3 (llama-3.3-70b-versatile) remains in the chain.

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
  // ── OpenRouter free models discovered 2026-05-18 (replace removed Chutes/dead OR ids) ──
  OR_DEEPSEEK_V4_FLASH: 'openrouter/deepseek/deepseek-v4-flash:free',
  OR_LLAMA_3_2_3B:      'openrouter/meta-llama/llama-3.2-3b-instruct:free',

  // ── Groq additional models (OpenAI-compatible, ultra-fast inference) ──
  GROQ_GEMMA2_9B:      'groq/gemma2-9b-it',
  GROQ_LLAMA_3_1_70B:  'groq/llama-3.1-70b-versatile',
  // GROQ_LLAMA3_8B removed — Groq HTTP 400 "model `llama3-8b-8192` has been decommissioned" (2026-05-18)
  // GROQ_LLAMA3_70B removed — Groq HTTP 400 "model `llama3-70b-8192` has been decommissioned" (2026-05-18)
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
  // NV_NEMOTRON_70B removed — NVIDIA NIM HTTP 404 "Not Found for account" (2026-06-15, run 27544487773). No longer served on this NVIDIA account; was already out of DEFAULT_CHAIN (see "NV_NEMOTRON_70B removed" comment in the chain). The bare-"nemotron" token in NVIDIA_ALLOW_FAMILY_RE was re-injecting it via discovery, so a dead static id here is moot, but removing it keeps the catalog honest.
  // NV_NEMOTRON_49B removed — NVIDIA NIM HTTP 404 "Not Found for account" (2026-06-15, run 27544487773). No longer served on this NVIDIA account. Dropped from DEFAULT_CHAIN in the same change.
  NV_LLAMA_3_1_8B:   'nvidia/meta/llama-3.1-8b-instruct',
  // NV_PHI_3_MINI removed — NVIDIA NIM HTTP 404 "404 page not found" (2026-05-18)
  // NV_MISTRAL_SM_4 / NV_NEMOTRON_NANO_9B added — verified translating de↔it 2026-06-15 via
  // live integrate.api.nvidia.com calls (replacements for the NV_NEMOTRON_70B/49B that 404'd
  // on this account in #2196). Neither matches NVIDIA_ALLOW_FAMILY_RE (no nemotron-at-slash /
  // llama-3.x token), so dynamic discovery does NOT auto-inject them — the static pin is
  // genuinely additive and survives a discovery timeout/outage. NVIDIA NIM = free tier.
  NV_MISTRAL_SM_4:      'nvidia/mistralai/mistral-small-4-119b-2603',     // API: mistralai/mistral-small-4-119b-2603 — fast (<1s), clean it/de
  NV_NEMOTRON_NANO_9B:  'nvidia/nvidia/nvidia-nemotron-nano-9b-v2',       // API: nvidia/nvidia-nemotron-nano-9b-v2 — correct it/de, slower (~29s)
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
  // CF_LLAMA_4_SCOUT removed — Cloudflare returns a non-string payload that crashes
  //                            the response handler with "text.replace is not a function"
  //                            on every call (runs 27951273347 / 27957791379 — dozens of
  //                            failures/run, never marked exhausted because the crash is a
  //                            JS exception, not a 4xx). Same wrapper-shape bug as the
  //                            removed CF_QWEN_25_CODER_32B (see below). Re-evaluate once
  //                            `_callCloudflareRaw` hardens its response decoding.
  CF_MISTRAL_SM_31:    'cf/@cf/mistralai/mistral-small-3.1-24b-instruct',
  CF_QWQ_32B:          'cf/@cf/qwen/qwq-32b',
  CF_QWEN3_30B:        'cf/@cf/qwen/qwen3-30b-a3b-fp8',
  CF_GPT_OSS_120B:     'cf/@cf/openai/gpt-oss-120b',
  CF_GPT_OSS_20B:      'cf/@cf/openai/gpt-oss-20b',
  // CF_GEMMA_3_12B removed — Cloudflare Workers AI HTTP 400 "Model has been deprecated: This model was deprecated on 2026-05-30." (2026-06-15, run 27544487773). OpenRouter mirror OR_GEMMA_3_12B remains available.
  CF_GLM_47_FLASH:     'cf/@cf/zai-org/glm-4.7-flash',
  // CF_DEEPSEEK_R1_32B removed — Cloudflare HTTP 400 "No such model @cf/deepseek/deepseek-r1-distill-qwen-32b" (2026-05-18)
  // CF_GEMMA_4_26B removed — returns empty responses (model loads but won't generate, 2026-04)
  // CF_KIMI_K2_5 removed — returns empty responses (model loads but won't generate, 2026-04)
  CF_NV_NEMOTRON_120B: 'cf/@cf/nvidia/nemotron-3-120b-a12b',
  // ── CF additions (2026-05-27) — candidates pending smoke-test validation ──
  // These ride into the chain so the smoke-test-models workflow can record their
  // status. If any returns 404/empty, follow up with a removal comment per the
  // pattern above. Picked because they appear in Cloudflare's free catalog docs
  // and the existing chain has no Llama 3.2 (1B/3B) or Qwen 2.5 coder coverage.
  CF_LLAMA_3_2_3B:     'cf/@cf/meta/llama-3.2-3b-instruct',
  CF_LLAMA_3_2_1B:     'cf/@cf/meta/llama-3.2-1b-instruct',
  // CF_QWEN_25_CODER_32B removed — Cloudflare returned non-string payload that crashed the response handler with
  //                                 "text.replace is not a function" (2026-05-27, run 26537033519). Model loads
  //                                 but emits a shape our wrapper doesn't unpack. Re-evaluate once `_callCloudflareRaw`
  //                                 hardens its response decoding.
  // CF_GRANITE_4_MICRO removed — "No such model @cf/ibm/granite-4.0-h-micro" (2026-04)

  // ── Mistral AI La Plateforme (OpenAI-compatible, free tier — 1B tokens/month) ──
  MISTRAL_SMALL:       'mistral/mistral-small-2506',
  MISTRAL_CODESTRAL:   'mistral/codestral-latest',
  MISTRAL_8B:          'mistral/ministral-8b-latest',
  MISTRAL_NEMO:        'mistral/open-mistral-nemo',
  // Mistral additions discovered 2026-05-18 — all share the 1B-token/month tier
  // but add variety so a single model's quota dip doesn't stall the chain.
  MISTRAL_MEDIUM:           'mistral/mistral-medium-latest',
  MISTRAL_MAGISTRAL_SMALL:  'mistral/magistral-small-latest',
  MISTRAL_DEVSTRAL_MEDIUM:  'mistral/devstral-medium-latest',
  MISTRAL_3B:               'mistral/ministral-3b-latest',

  // ── Mistral Codestral (separate endpoint, separate quota: 2000 req/day) ──
  CDSTRL_LATEST:       'codestral/codestral-latest',

  // ── Chutes.ai (OpenAI-compatible, PAID per-token — verified 2026-05-18) ──
  // Smoke test returned HTTP 402 "balance $0.0". Chutes is NOT free; it bills
  // TAO/USD per token. Real model IDs use the `-TEE` (Trusted Execution Env)
  // suffix. Listed here so the provider machinery + correct IDs are ready IF
  // the account is funded; NOT in DEFAULT_CHAIN to avoid burning fallback
  // slots on 402 errors.
  CH_DEEPSEEK_V32:     'chutes/deepseek-ai/DeepSeek-V3.2-TEE',
  CH_KIMI_K26:         'chutes/moonshotai/Kimi-K2.6-TEE',
  CH_GLM_5:            'chutes/zai-org/GLM-5-TEE',
  CH_QWEN_3_5_397B:    'chutes/Qwen/Qwen3.5-397B-A17B-TEE',
  CH_MINIMAX_M25:      'chutes/MiniMaxAI/MiniMax-M2.5-TEE',

  // ── Z.AI (Zhipu, OpenAI-compatible — added 2026-05-18) ──
  // Smoke test: only `glm-4.5-flash` is in the free tier with this key.
  // `glm-4.6`, `glm-4.5-air`, `glm-4.5-airx`, `glm-4.5v` all return
  // HTTP 429 "no resource package" → paid plan required.
  ZAI_GLM_45_FLASH:    'zai/glm-4.5-flash',

  // ── Extended OpenRouter free models (2026-05) ──
  // OR_QWEN3_CODER_PLUS removed — OpenRouter HTTP 404 "No endpoints found for qwen/qwen3-coder-plus:free" (2026-05-18)
  // OR_KIMI_K2_0905 removed — OpenRouter HTTP 404 "No endpoints found for moonshotai/kimi-k2-0905:free" (2026-05-18)
  // OR_GLM_46 removed — OpenRouter HTTP 404 "No endpoints found for z-ai/glm-4.6:free" (2026-05-18)
  // OR_DEEPSEEK_V32 removed — OpenRouter HTTP 404 "No endpoints found for deepseek/deepseek-v3.2-exp:free" (2026-05-18)
  // OR_MERIDIAN_8B removed — OpenRouter HTTP 400 "cognitivecomputations/meridian-8b:free is not a valid model ID" (2026-05-18)
  // GROQ_LLAMA_4_MAV_INSTR removed — Groq HTTP 404 "model `…-128e-instruct-fp8` does not exist" (2026-05-18)
  // CB_QWEN3_CODER_480B removed — Cerebras HTTP 404 "Model qwen-3-coder-480b does not exist" (2026-05-18)
  // CB_GPT_OSS_20B_2 removed — Cerebras HTTP 404 "Model gpt-oss-20b does not exist" (2026-05-18)

  // ── Local open-source fallback (opt-in, last-resort) ──
  // Routed to a local llama.cpp/ollama server. Inert unless LOCAL_LLM_ENABLED is
  // set (isModelAvailable returns false otherwise → silently skipped). Pinned to
  // the bottom of every chain by sortChainByScore so it never displaces a working
  // remote API — it only runs when all remote providers are exhausted.
  LOCAL_FALLBACK:      'local/fallback',

  // ── Claude CLI Haiku fallback (opt-in via Remote Config) ── Routed through
  // the local `claude` CLI subprocess using the existing CLAUDE_CODE_OAUTH_TOKEN
  // (Max subscription — $0 marginal cost, same auth already used by
  // pr-review-loop.yml/issue-fix.yml). Inert unless ENABLE_HAIKU_ARTICLE_FALLBACK
  // is set (see load-rc-env.mjs) AND the token is present. Since 2026-07-29
  // (AI_COMPETING_TIERS) this tier is tier-0 BY DEFAULT — it competes with
  // every normal model on real score, not pinned last. See _lastResortTier /
  // AI_COMPETING_TIERS below for the ramp-up mechanics; set
  // AI_COMPETING_TIERS='' to restore the old pinned-last behavior.
  // Uses the CLI's own 'haiku' alias (confirmed live: `claude --model haiku`
  // resolves to claude-haiku-4-5-20251001 today) instead of a dated snapshot
  // id, so this tracks whatever Anthropic ships as "current Haiku" without
  // needing a code change on every Haiku release.
  CLAUDE_CLI_HAIKU:    'claude-cli/haiku',

  // ── OmniRoute (self-hosted local AI gateway, opt-in) ── Single node using
  // OmniRoute's own "auto" routing sentinel — OmniRoute fans out across its
  // ~78-100+ locally-registered providers internally, so this deliberately
  // does NOT enumerate those providers as separate chain entries (that would
  // duplicate routing logic OmniRoute already does, and the roster is a
  // developer-local runtime concern, not a stable identity). Inert unless
  // OMNIROUTE_ENABLED is set. Since 2026-07-29 (AI_COMPETING_TIERS) this tier
  // is tier-0 BY DEFAULT — see CLAUDE_CLI_HAIKU comment above, same mechanism.
  // See PROVIDER.OMNIROUTE / _callOmniRoute.
  OMNIROUTE_AUTO:      'omniroute/auto',
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
  // AI_MODELS.GPT_5 removed — GitHub Models HTTP 400 "unavailable_model" (2026-05-18)
  AI_MODELS.LLAMA_4_MAVERICK,   // 4.  Meta Llama 4 flagship  (GitHub Models)
  AI_MODELS.GEMINI_FLASH,       // 5.  Google fast            (Gemini API free)
  AI_MODELS.GEMINI_3_PRO,       // 5b. Gemini 3 Pro preview   (ritirato — vedi nota su AI_MODELS)
  AI_MODELS.GEMINI_3_FLASH,     // 5c. Gemini 3 Flash preview (Gemini API free)
  // AI_MODELS.O3 removed — GitHub Models HTTP 400 "unavailable_model" (2026-05-18)
  // AI_MODELS.GROK_3 removed — GitHub Models HTTP 400 "unknown_model: grok-3" (2026-05-18)
  // GROQ_KIMI_K2 removed — Groq returns HTTP 413 consistently (payload too large, 2026-03)
  // SN_LLAMA_4_MAVERICK removed — SambaNova returns HTTP 404 "Model not found" (2026-03)
  AI_MODELS.GPT4O_MINI,           // 9.  OpenAI fast             (GitHub Models)
  // AI_MODELS.GPT_5_CHAT removed — GitHub Models HTTP 400 "unavailable_model" (2026-05-18)
  AI_MODELS.GEMMA_4_26B,          // 9c. Gemma 4 26B MoE        (Gemini API — 14,400/day!)
  AI_MODELS.GROQ_GPT_OSS_120B,  // 10. GPT-OSS 120B          (Groq - ultra fast)
  AI_MODELS.GPT_4_1_MINI,       // 11. GPT 4.1 Mini           (GitHub Models)
  AI_MODELS.LLAMA_3_3_70B,      // 12. Meta 70B               (GitHub Models)
  AI_MODELS.LLAMA_4_SCOUT,      // 13. Meta Llama 4 Scout     (GitHub Models)
  // GEMMA_3_27B removed from chain — Gemini API dropped Gemma 3.x (2026-05-18); OR_GEMMA_3_27B mirror still in chain at #39
  AI_MODELS.PHI_4_REASON,       // 13c. Phi-4 reasoning       (GitHub Models)
  // AI_MODELS.GPT_5_NANO removed — GitHub Models HTTP 400 "unavailable_model" (2026-05-18)
  AI_MODELS.COHERE_CMD_A,       // 15. Cohere latest          (GitHub Models)
  AI_MODELS.MISTRAL_SMALL,      // 16. Mistral Small latest   (Mistral AI direct)
  AI_MODELS.GROQ_LLAMA_3_3,     // 17. Llama 3.3 70B          (Groq)
  // AI_MODELS.COHERE_CMD_R_PLUS removed chain — GitHub Models HTTP 400 "unknown_model: Cohere-command-r-plus-08-2024" (2026-07-05, confirmed retired live, 14x in 30-run sample)
  AI_MODELS.COH_CMD_A,          // 18b. Cohere Command A      (Cohere direct - 1000/month)
  AI_MODELS.GEMINI_31_PRO,      // 18d. Gemini 3.1 Pro preview (Gemini API free)
  AI_MODELS.COH_CMD_R_PLUS,     // 18c. Cohere Command R+     (Cohere direct - 1000/month)
  AI_MODELS.CF_LLAMA_3_3_70B,   // 19. Llama 3.3 70B FP8     (Cloudflare Workers AI)
  // AI_MODELS.LLAMA_3_1_405B removed chain — GitHub Models HTTP 400 "unknown_model: Meta-Llama-3.1-405B-Instruct" (2026-07-05, confirmed retired live, 20x in 30-run sample)
  // MISTRAL_MEDIUM_3 removed — GitHub Models HTTP 404 "unknown_model" (2026-04)
  AI_MODELS.GROQ_QWEN3_32B,      // 22. Qwen3 32B              (Groq - ultra fast)
  AI_MODELS.CB_QWEN3_235B,       // 22a. Qwen3 235B frontier   (Cerebras preview — ultra fast)
  // CB_GLM_47 removed — Cerebras HTTP 404 "Model zai-glm-4.7 does not exist" (2026-04)
  // GEMMA_3_12B removed from chain — Gemini API dropped Gemma 3.x (2026-05-18); OR_GEMMA_3_12B / CF_GEMMA_3_12B mirrors still in chain
  // JAMBA_1_5_LARGE removed — GitHub Models HTTP 400 "unknown_model" (2026-04)
  // SN_LLAMA_3_3_70B removed — SambaNova HTTP 402 PAYMENT_METHOD_REQUIRED (2026-04)
  // AI_MODELS.O1 removed — GitHub Models HTTP 400 "unavailable_model" (2026-05-18)
  // AI_MODELS.LLAMA_3_2_90B removed chain — GitHub Models HTTP 400 "unknown_model: Llama-3.2-90B-Vision-Instruct" (2026-07-05, confirmed retired live, 12x in 30-run sample)
  AI_MODELS.GEMINI_2_FLASH,     // 25. Google 2.0 flash       (ritirato — vedi nota su AI_MODELS)
  // AI_MODELS.GEMINI_31_FLASH_LITE removed — Gemini API HTTP 404 "models/gemini-3.1-flash-lite-preview is no longer available" (2026-05-27, run 26534353239).
  //                                 The deprecated preview kept winning the fallback selector because 404 didn't mark it exhausted, causing the
  //                                 entire blog-generator workflow to fail with 50+ retries against the dead endpoint. The GA non-preview model
  //                                 `gemini-3.1-flash-lite` (AI_MODELS.GEMINI_31_FLASH_LITE_GA) is already in the chain below at the "replacements" block.
  AI_MODELS.MISTRAL_CODESTRAL,  // 26. Codestral latest       (Mistral AI direct)
  // AI_MODELS.GPT_5_MINI removed — GitHub Models HTTP 400 "unavailable_model" (2026-05-18)
  // CF_LLAMA_4_SCOUT removed — wrapper crash "text.replace is not a function" (runs 27951273347 / 27957791379)
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
  // AI_MODELS.GROK_3_MINI removed — GitHub Models HTTP 400 "unknown_model: grok-3-mini" (2026-05-18)
  AI_MODELS.COH_CMD_A_REASON,   // 38. Cohere reasoning       (Cohere direct)
  AI_MODELS.OR_GEMMA_3_27B,     // 39. Gemma 3 27B instruct   (OpenRouter free)
  // CB_LLAMA_3_1_70B removed — Cerebras 404 (model deprecated 2026-03)
  AI_MODELS.COH_CMD_A_TRANSLATE,// 40. Cohere translate       (Cohere direct)
  // AI_MODELS.COHERE_CMD_R removed — GitHub Models HTTP 400 "unknown_model: Cohere-command-r-08-2024" (2026-07-05, confirmed retired live)
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
  // AI_MODELS.O4_MINI removed — GitHub Models HTTP 400 "unavailable_model" (2026-05-18)
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
  // AI_MODELS.LLAMA_3_1_8B removed chain — GitHub Models HTTP 400 "unknown_model: Meta-Llama-3.1-8B-Instruct" (2026-07-05, confirmed retired live, 20x in 30-run sample)
  AI_MODELS.MINISTRAL_3B,       // 57. Mistral 3B fast        (GitHub Models)
  AI_MODELS.CF_GPT_OSS_20B,     // 58. GPT-OSS 20B            (Cloudflare Workers AI)
  // AI_MODELS.O3_MINI removed — GitHub Models HTTP 400 "unavailable_model" (2026-05-18)
  // AI_MODELS.O1_MINI removed — GitHub Models HTTP 400 "unavailable_model" (2026-05-18)
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
  // CF_GEMMA_3_12B removed — Cloudflare Workers AI HTTP 400 "Model has been deprecated: This model was deprecated on 2026-05-30." (2026-06-15, run 27544487773); OR_GEMMA_3_12B mirror still in chain
  AI_MODELS.CB_LLAMA_3_1_8B,    // 68. Llama 3.1 8B           (Cerebras - ultra fast)
  // TGT_QWEN_2_5_7B removed — Together AI HTTP 401 (account unauthorized 2026-03)
  // TGT_MISTRAL_7B removed — Together AI HTTP 401 (account unauthorized 2026-03)
  // FW_LLAMA_3_1_8B removed — Fireworks AI HTTP 404 (model not found 2026-03)
  // FW_MIXTRAL_8X7B removed — Fireworks AI HTTP 404 (model not found 2026-03)
  // NV_NEMOTRON_70B removed — NVIDIA NIM HTTP 404 (model not found 2026-03)
  AI_MODELS.CF_GLM_47_FLASH,    // 69. GLM 4.7 Flash           (Cloudflare Workers AI)
  // NV_NEMOTRON_49B removed — NVIDIA NIM HTTP 404 "Not Found for account" (2026-06-15, run 27544487773); no longer served on this NVIDIA account
  AI_MODELS.NV_LLAMA_3_1_8B,    // 71. Llama 3.1 8B           (NVIDIA NIM)
  AI_MODELS.NV_MISTRAL_SM_4,     // 71b. Mistral Small 4 119B  (NVIDIA NIM — added, verified translating it↔de 2026-06-15; fast <1s)
  AI_MODELS.NV_NEMOTRON_NANO_9B, // 71c. Nemotron Nano 9B v2   (NVIDIA NIM — added, verified translating it↔de 2026-06-15; slower ~29s)
  // AI_MODELS.NV_PHI_3_MINI removed — NVIDIA NIM HTTP 404 "404 page not found" (2026-05-18)
  // AI_MODELS.CF_DEEPSEEK_R1_32B removed — Cloudflare HTTP 400 "No such model @cf/deepseek/deepseek-r1-distill-qwen-32b" (2026-05-18)
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
  // AI_MODELS.GROQ_LLAMA3_8B removed — Groq HTTP 400 "model `llama3-8b-8192` has been decommissioned" (2026-05-18)
  // AI_MODELS.GROQ_LLAMA3_70B removed — Groq HTTP 400 "model `llama3-70b-8192` has been decommissioned" (2026-05-18)
  // AI_MODELS.GROQ_KIMI_K2_0905 removed — Groq HTTP 404 "model `moonshotai/kimi-k2-instruct-0905` does not exist" (2026-05-18)
  // ── Extended capacity: new models (2026-04) ──
  AI_MODELS.COH_CMD_R7B,         // 88. Cohere R7B              (Cohere direct)
  // ── Extended capacity: new OpenRouter free models (2026-04, replacing removed models) ──
  AI_MODELS.OR_GPT_OSS_20B,      // 89. GPT-OSS 20B              (OpenRouter free — replaces DeepSeek V3)
  AI_MODELS.OR_NV_NEMOTRON_12B_VL, // 90. Nemotron 12B VL         (OpenRouter free — replaces Qwen 2.5 72B)
  AI_MODELS.OR_GEMMA_3N_E4B,     // 91. Gemma 3n E4B              (OpenRouter free — replaces Phi-4)
  // OR_DEEPSEEK_V3, OR_QWEN_2_5_72B, OR_PHI_4, OR_PHI_4_REASON removed from OpenRouter free list (2026-04)
  // OR_KIMI_K2, OR_DEEPSEEK_R1, OR_LLAMA_4_MAVERICK, OR_MISTRAL_SM_31 removed from OpenRouter free list (2026-04)
  // AI_MODELS.GROQ_LLAMA_4_MAV removed — Groq HTTP 404 "model `meta-llama/llama-4-maverick-17b-128e-instruct` does not exist" (2026-05-18)
  // AI_MODELS.GROQ_QWQ_32B removed — Groq HTTP 404 "model `qwen/qwq-32b` does not exist" (2026-05-18)
  AI_MODELS.GROQ_COMPOUND,       // 94. Compound Beta             (Groq)
  AI_MODELS.HF_LLAMA_3_3_70B,    // 95. Llama 3.3 70B             (HuggingFace)
  AI_MODELS.HF_QWEN_2_5_72B,     // 96. Qwen 2.5 72B              (HuggingFace)
  AI_MODELS.HF_GEMMA_3_27B,      // 97. Gemma 3 27B               (HuggingFace)
  // HF_MISTRAL_SM removed — HuggingFace HTTP 400 "not a chat model" (2026-04)

  // ── Chutes.ai: SKIPPED — paid per-token; smoke test returned HTTP 402
  // ("balance $0.0"). Re-add CH_DEEPSEEK_V32 / CH_KIMI_K26 / CH_GLM_5 /
  // CH_QWEN_3_5_397B / CH_MINIMAX_M25 here once the account is funded.

  // ── Z.AI GLM free tier (added + verified 2026-05-18) ──
  // Only glm-4.5-flash is free with the issued key; smoke test 200 OK.
  AI_MODELS.ZAI_GLM_45_FLASH,    // 98. GLM 4.5 Flash              (Z.AI free)

  // ── Extended OpenRouter 2026-05 free additions ──
  // AI_MODELS.OR_QWEN3_CODER_PLUS removed — OpenRouter HTTP 404 "No endpoints found for qwen/qwen3-coder-plus:free" (2026-05-18)
  // AI_MODELS.OR_KIMI_K2_0905 removed — OpenRouter HTTP 404 "No endpoints found for moonshotai/kimi-k2-0905:free" (2026-05-18)
  // AI_MODELS.OR_GLM_46 removed — OpenRouter HTTP 404 "No endpoints found for z-ai/glm-4.6:free" (2026-05-18)
  // AI_MODELS.OR_DEEPSEEK_V32 removed — OpenRouter HTTP 404 "No endpoints found for deepseek/deepseek-v3.2-exp:free" (2026-05-18)
  // AI_MODELS.OR_MERIDIAN_8B removed — OpenRouter HTTP 400 "cognitivecomputations/meridian-8b:free is not a valid model ID" (2026-05-18)

  // ── Extended Groq 2026-05 additions ──
  // AI_MODELS.GROQ_LLAMA_4_MAV_INSTR removed — Groq HTTP 404 "model `…-128e-instruct-fp8` does not exist" (2026-05-18)
  // AI_MODELS.GROQ_DEEPSEEK_R1_DIST removed — Groq HTTP 400 "model `deepseek-r1-distill-llama-70b` has been decommissioned" (2026-05-18)

  // ── Extended Cerebras 2026-05 additions ──
  // AI_MODELS.CB_QWEN3_CODER_480B removed — Cerebras HTTP 404 "Model qwen-3-coder-480b does not exist" (2026-05-18)
  // AI_MODELS.CB_GPT_OSS_20B_2 removed — Cerebras HTTP 404 "Model gpt-oss-20b does not exist" (2026-05-18)

  // ── Replacements for the 33 models pruned 2026-05-18 (each smoke-tested live) ──
  // Gemini "always latest stable" aliases — auto-follow Google's promotions.
  AI_MODELS.GEMINI_FLASH_LATEST,        // alias → today's stable flash
  AI_MODELS.GEMINI_FLASH_LITE_LATEST,   // alias → today's stable flash-lite
  AI_MODELS.GEMINI_PRO_LATEST,          // alias → today's stable pro
  AI_MODELS.GEMINI_2_FLASH_LITE,        // Gemini 2.0 flash lite (ritirato — vedi nota su AI_MODELS)
  AI_MODELS.GEMINI_31_FLASH_LITE_GA,    // Gemini 3.1 flash lite GA (non-preview)
  // Groq compound full (not just mini)
  AI_MODELS.GROQ_COMPOUND_FULL,
  // OpenRouter free additions
  AI_MODELS.OR_DEEPSEEK_V4_FLASH,       // DeepSeek V4 flash on OR :free
  AI_MODELS.OR_LLAMA_3_2_3B,            // Llama 3.2 3B small/fast on OR :free
  // Mistral La Plateforme (shares 1B-token/month bucket — adds model variety)
  AI_MODELS.MISTRAL_MEDIUM,             // mistral-medium-latest
  AI_MODELS.MISTRAL_MAGISTRAL_SMALL,    // magistral-small (reasoning)
  AI_MODELS.MISTRAL_DEVSTRAL_MEDIUM,    // devstral medium (code)
  AI_MODELS.MISTRAL_3B,                 // ministral 3B (small/fast)

  // ── Candidate additions (2026-05-27) — pending smoke-test validation ──
  // Added to widen provider coverage. The smoke-test-models workflow records
  // pass/fail per id; failures get the standard "removed — HTTP NNN" comment
  // and are dropped in a follow-up. Until then they live here so dispatching
  // the smoke test reports their real status.
  AI_MODELS.CF_LLAMA_3_2_3B,            // Llama 3.2 3B               (Cloudflare Workers AI)
  AI_MODELS.CF_LLAMA_3_2_1B,            // Llama 3.2 1B small/fast    (Cloudflare Workers AI)
  // AI_MODELS.CF_QWEN_25_CODER_32B removed — wrapper crash "text.replace is not a function" (2026-05-27, run 26537033519).
  // AI_MODELS.GROQ_LLAMA_3_3_SPEC removed — Groq HTTP 400 "decommissioned" (2026-05-27, run 26537033519).

  // Last-resort local model. Always sorted below every real remote API
  // (sortChainByScore / _lastResortTier — local/ is never a member of
  // AI_COMPETING_TIERS, see that const's doc comment) and skipped entirely
  // unless LOCAL_LLM_ENABLED — so when every remote provider above is
  // daily-exhausted, generation still produces instead of deferring.
  AI_MODELS.LOCAL_FALLBACK,

  // Self-hosted local AI gateway (OmniRoute), opt-in pilot. Since 2026-07-29
  // (AI_COMPETING_TIERS default) this tier is PROMOTED to tier-0 — it competes
  // on real Firestore score against every normal model above, it does NOT get
  // sorted relative to LOCAL_FALLBACK/CLAUDE_CLI_HAIKU by tier rank anymore.
  // Bottom-of-array position here is deliberate ramp-up: initial score 0 +
  // index tiebreak means it starts BEHIND models with accumulated positive
  // score, rising only through real successes (see _lastResortTier /
  // AI_COMPETING_TIERS doc comment). Set AI_COMPETING_TIERS='' to fall back to
  // the pre-2026-07-29 pinned-last-resort behavior (order still governed by
  // AI_LAST_RESORT_ORDER in that mode). Skipped entirely unless
  // OMNIROUTE_ENABLED is set.
  AI_MODELS.OMNIROUTE_AUTO,

  // Claude CLI Haiku, opt-in via Remote Config + CLAUDE_CODE_OAUTH_TOKEN.
  // Since 2026-07-29 (AI_COMPETING_TIERS default) also PROMOTED to tier-0 —
  // same mechanism as OMNIROUTE_AUTO above, same bottom-of-array ramp-up
  // rationale. Additionally capped by CLAUDE_CLI_MAX_CALLS_PER_RUN (default
  // 25/run) since this tier burns the shared Max-subscription quota that also
  // powers pr-review-loop.yml/issue-fix.yml — see the callLLM loop's cap
  // check. Set AI_COMPETING_TIERS='' to restore pinned-last-resort behavior.
  AI_MODELS.CLAUDE_CLI_HAIKU,
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
  CHUTES:      'chutes',
  ZAI:         'zai',
  // Local OpenAI-compatible server (llama.cpp / ollama) on the CI runner or a
  // self-hosted VM. Opt-in last-resort: when EVERY remote free-tier provider is
  // daily-exhausted (the recurring "tutti i modelli esauriti" defer), generation
  // would otherwise produce 0 articles for that window. A local open-source model
  // (e.g. Qwen2.5) keeps the funnel producing at $0/zero-quota. See _callLocal.
  LOCAL:       'local',
  // Claude CLI subprocess (Haiku), opt-in via Remote Config. Tier-0 (competing)
  // by default since 2026-07-29 — see AI_MODELS.CLAUDE_CLI_HAIKU /
  // AI_COMPETING_TIERS. _isLastResortProvider() still exempts it from
  // markModelExhausted/429-ban regardless of tier rank (technical property:
  // no daily-quota concept for a local CLI call, not a rank statement).
  // See AI_MODELS.CLAUDE_CLI_HAIKU / _callClaudeCli.
  CLAUDE_CLI:  'claude_cli',
  // Self-hosted local AI gateway (OmniRoute — Homebrew CLI, OpenAI-compatible
  // /v1/chat/completions on http://localhost:20128). Opt-in pilot, tier-0
  // (competing) by default since 2026-07-29 — see AI_COMPETING_TIERS. Single
  // model id calls with model:"auto" so OmniRoute does its OWN internal
  // multi-provider fallback across whatever it
  // has registered — we deliberately don't mirror its provider roster here.
  // See AI_MODELS.OMNIROUTE_AUTO / _callOmniRoute.
  OMNIROUTE:   'omniroute',
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
const CHUTES_API_BASE      = 'https://llm.chutes.ai/v1/chat/completions';
const ZAI_API_BASE         = 'https://api.z.ai/api/paas/v4/chat/completions';

// ── Local LLM (llama.cpp / ollama, OpenAI-compatible) ────────
// Opt-in: inert unless LOCAL_LLM_ENABLED is truthy. Default endpoint targets a
// llama.cpp `--server` (port 8080); ollama users set LOCAL_LLM_URL to its
// :11434/v1 endpoint. The served model name is a free-text label — the actual
// weights are whatever the local server has loaded — so we keep a stable id.
const LOCAL_LLM_DEFAULT_URL   = 'http://127.0.0.1:8080/v1/chat/completions';
const LOCAL_LLM_DEFAULT_MODEL = 'local-fallback';
export function isLocalLlmEnabled()  { return /^(1|true|yes|on)$/i.test((process.env.LOCAL_LLM_ENABLED || '').trim()); }
function getLocalLlmUrl()     { return (process.env.LOCAL_LLM_URL || LOCAL_LLM_DEFAULT_URL).trim(); }
function getLocalLlmModelId() { return (process.env.LOCAL_LLM_MODEL || LOCAL_LLM_DEFAULT_MODEL).trim(); }
// llama.cpp/ollama ignore the key, but _callOpenAICompatible requires a non-empty
// one; allow an override for servers behind an auth proxy.
function getLocalLlmApiKey()  { return (process.env.LOCAL_LLM_API_KEY || 'local-no-key').trim(); }
// CPU inference is slow; give the local call a generous floor (overridable).
// Fallback-of-fallback only: the generate-article.yml workflow always exports
// LOCAL_LLM_TIMEOUT_MS explicitly when LOCAL_LLM_ENABLED, so this default only
// fires for ad-hoc/manual invocations without that env var set. Kept in sync
// with the workflow's explicit value (1_500_000, sized 2026-07-06 for the
// qwen2.5:14b upgrade) rather than the old 7b-era 600_000 — a smaller floor
// here would silently under-time a 14b call in exactly that manual scenario.
function getLocalLlmTimeoutMs() {
  const v = parseInt((process.env.LOCAL_LLM_TIMEOUT_MS || '').trim(), 10);
  return Number.isFinite(v) && v > 0 ? v : 1_500_000; // 25 min default — see comment above
}

// Tetto per una singola chiamata locale, per quanto grande sia l'allowance
// residua — stesso ruolo di CLAUDE_CLI_MAX_TIMEOUT_MS (vedi il commento sopra
// CLAUDE_CLI_MIN_TIMEOUT_MS: "il floor faceva da soffitto"). Senza un tetto
// che PUO' crescere sopra getLocalLlmTimeoutMs(), quel floor smette di essere
// un minimo e torna a essere l'unico valore possibile anche quando
// l'allowance residua e' molto piu' ampia — stesso pattern segnalato dalla
// review di #451 su _callClaudeCli, non toccato allora perche' fuori dal
// finding originale. Piu' alto del tetto CLI perche' l'inferenza CPU locale
// e' strutturalmente piu' lenta — il floor stesso e' gia' 1.500.000ms (25min)
// di default, contro i 180.000ms del CLI.
const LOCAL_LLM_MAX_TIMEOUT_MS = 3_000_000; // 50 min, 2x il floor di default

// Quota dell'allowance residua concessa a UNA chiamata locale — stessa forma
// e stesso razionale di CLAUDE_CLI_ALLOWANCE_SHARE (vedi quel commento).
// Nessuna evidenza diagnostica di troncamento live come per claude-cli (la
// review di #451 lo nota esplicitamente), ma l'asimmetria "floor che non
// cresce mai dentro l'allowance" e' la stessa per costruzione.
const LOCAL_LLM_ALLOWANCE_SHARE = 1 / 3;

// ── OmniRoute (self-hosted local AI gateway, OpenAI-compatible) ──────
// Opt-in: inert unless OMNIROUTE_ENABLED is truthy. OmniRoute runs
// persistently on the host (Homebrew CLI v3.8.48+, http://localhost:20128)
// with ~78-100+ individually-registered providers and does its OWN internal
// provider fallback when given the literal model id "auto" — confirmed live
// (2026-07-27): a bare {"model":"auto"} POST to /v1/chat/completions is
// accepted as a routing sentinel, even though "auto" itself never appears as
// a literal entry in /v1/models' catalog (only auto/<combo> shortcuts do).
// We intentionally use ONE stable model id here instead of mirroring
// OmniRoute's registered providers as separate AI_MODELS/DEFAULT_CHAIN
// entries — that roster is a developer-local runtime concern (CI registers
// only a small curated set; see scripts/ci/omniroute-poc-register.mjs), not a
// stable identity worth pinning chain entries to, and duplicating it here
// would just re-implement routing OmniRoute already does internally.
const OMNIROUTE_DEFAULT_URL = 'http://127.0.0.1:20128/v1/chat/completions';
export function isOmniRouteEnabled() { return /^(1|true|yes|on)$/i.test((process.env.OMNIROUTE_ENABLED || '').trim()); }
function getOmniRouteUrl() { return (process.env.OMNIROUTE_URL || OMNIROUTE_DEFAULT_URL).trim(); }
// OmniRoute's /v1/chat/completions is unauthenticated by default (session
// cookie only gates /api/* management routes — see
// omniroute-poc-register.mjs); _callOpenAICompatible requires a non-empty
// key, so keep a sentinel, same pattern as Local/getLocalLlmApiKey.
function getOmniRouteApiKey() { return (process.env.OMNIROUTE_API_KEY || 'omniroute-no-key').trim(); }

// ── Claude CLI Haiku fallback (opt-in via RC, absolute last resort) ──
// ENABLE_HAIKU_ARTICLE_FALLBACK is loaded from Firebase Remote Config by
// load-rc-env.mjs (default unset → OFF). Gated on BOTH the flag and the OAuth
// token so a flag flipped on without the workflow secret wired doesn't attempt
// (and fail) every run.
function isClaudeCliFallbackEnabled() {
  return /^(1|true|yes|on)$/i.test((process.env.ENABLE_HAIKU_ARTICLE_FALLBACK || '').trim());
}
function hasClaudeCodeOauthToken() {
  return !!(process.env.CLAUDE_CODE_OAUTH_TOKEN || '').trim();
}
const CLAUDE_CLI_BIN = (process.env.CLAUDE_CLI_BIN || 'claude').trim();
// Flipped true on the first `spawn claude ENOENT` (see the catch block in
// callLLM's fallback loop). Process-local, never persisted — see that comment
// for why this isn't routed through markModelExhausted.
let _claudeCliBinaryMissing = false;
// Same process-local, never-persisted pattern as _claudeCliBinaryMissing, but
// for a timeout storm instead of a missing binary (run 29824354962: 159/162
// claude-cli/haiku calls hit the hard 60s timeout — CI-runner CPU contention
// from N parallel `claude` subprocesses each cold-loading this repo's full
// CLAUDE.md/AGENTS.md + SessionStart hook, ~30min of the run burned on calls
// that were never going to finish in time). claude-cli/haiku is exempt from
// the normal markModelExhausted timeout circuit breaker (_isLastResortProvider,
// see the comment above that function) because for most callers a single
// timeout is a transient blip worth retrying next call. But once several
// timeouts land back-to-back within one run, that's not a blip — it's the
// subprocess itself unable to finish in time — and every further attempt is
// a guaranteed 120s loss for a fallback that already has a template result
// ready. Trip after CLAUDE_CLI_TIMEOUT_STORM_THRESHOLD consecutive timeouts.
//
// The threshold was 8, sized off the 159/162 incident above where volume was
// never the constraint. Issue #432 (2026-08-18) measured the opposite shape:
// runs that only ever offer claude-cli/haiku 2-4 times *total*, each one a
// 120000ms timeout with zero stdout bytes — the counter never gets anywhere
// near 8, so the breaker can't trip at the volume these runs actually
// produce, and every run repays the full storm cost from zero. 3 keeps a
// single transient blip from tripping it (the exemption above still holds:
// one timeout is not a storm) while matching the low end of the observed
// per-run volume, so a 4-attempt storm run now spares its last attempt
// instead of paying for all of them every time.
let _claudeCliConsecutiveTimeouts = 0;
let _claudeCliTimeoutStormDetected = false;
const CLAUDE_CLI_TIMEOUT_STORM_THRESHOLD = 3;

// Same in-run, never-persisted breaker shape as _claudeCliTimeoutStormDetected
// above, omniroute/auto. _isLastResortProvider() exempts OmniRoute from
// markModelExhausted on EVERY failure class (timeout, 429, nonretryable) — no
// daily-quota concept a local gateway. Consequence measured live, run
// 30427526187 (send-newsletter, 2026-07-29): 97 attempts, 0 successes, 74 of
// them 30s timeouts + HTTP 400 "Invalid model name passed in
// model=claude-fable-5" (gateway's own auto-routing picked a model its key
// can't serve). Nothing ever stopped retrying it: ~37min of a 50min job
// burned, score sank -3921. One failure IS worth retrying (gateway
// re-routes internally next call); N back-to-back is the gateway itself
// unusable this run, so stop paying the timeout. Reset on any success.
let _omniRouteConsecutiveFailures = 0;
let _omniRouteFailureStormDetected = false;
const OMNIROUTE_FAILURE_STORM_THRESHOLD = 5;

// Dedicated in-process concurrency cap for claude-cli subprocesses — separate
// from any caller's own concurrency (e.g. send-newsletter.mjs's
// AI_CONCURRENCY=5 pMap, which this file never sees or gates). T2 diagnosis
// (2026-07-28, run 30333856358/30243975255: 0/19 successes, always the hard
// 60s timeout): a solo cold-start measured only ~6-12s wall time locally for
// a matching small/large prompt with the exact production flags — so
// per-call latency alone doesn't explain the timeouts. The pre-existing
// comment above already nails the real cause: run 29824354962 hit 159/162
// timeouts specifically under AI_CONCURRENCY=5 — N heavy `claude` Node
// subprocesses fighting for CPU on a resource-constrained CI runner. Capping
// in-process concurrency here (independent of the consumer) attacks that
// root cause without touching send-newsletter.mjs. Extra callers queue FIFO
// via _withClaudeCliSlot and never deadlock: the slot is always released in
// a `finally`, including on throw/reject.
const CLAUDE_CLI_MAX_CONCURRENCY = 2;

// Per-call timeout FLOOR for the claude CLI subprocess (raised 60s → 120s by
// the T2 diagnosis, see _callClaudeCli). Shared so _hardCallCapMs sizes its
// backstop off the same floor instead of a second copy of the literal.
//
// ── 120s → 180s, E SOPRATTUTTO: IL FLOOR ERA IL SOFFITTO (2026-08-18) ───────
//
// Il nome dice «floor», ma nel percorso dominante questa costante agiva da
// TETTO. In _callClaudeCli il timeout era
//
//     min( max(opts.timeout, FLOOR), remaining )
//
// e per la generazione articolo `opts.timeout` e' 90s: il `max` dava sempre
// 120s, e il `min` con `remaining` non mordeva quasi mai perche' `remaining`
// e' dell'ordine dei 600-1000s. Risultato: ogni chiamata riceveva 120s tondi
// mentre l'allowance residua ne offriva quasi mille.
//
//   run 32161215947 (corpus, 2026-08-18 16:36Z), tre timeout su tre:
//     ⏳ in-flight 60s (hard cap 1020s) → ucciso a 120s   ← 900s inutilizzati
//     ⏳ in-flight 60s (hard cap  630s)
//
// Cosa dice la diagnostica di #441/#6034 (`--output-format stream-json`), che
// prima non c'era. I tre timeout NON erano chiamate mute:
//
//     173 eventi, fermo dopo system/thinking_tokens a 119522ms, stdout 3525 B
//     123 eventi, fermo dopo assistant           a  94721ms, stdout 71169 B
//     175 eventi, fermo dopo assistant           a  87255ms, stdout 84574 B
//
// primo evento a 620-1013ms, `rate_limit_event status=allowed tipo=five_hour`
// in tutti e tre. Non e' quota, non e' rate limit, non e' un CLI che non
// parte: e' una chiamata che sta lavorando e viene troncata. Il primo caso
// emetteva ancora a 478ms dal cap. Il vecchio «stdout: 0 bytes» dei log
// precedenti era un artefatto del buffering di `--output-format json`, non la
// prova di un subprocess bloccato — vedi createClaudeCliStreamTrace.
//
// Misurato in locale sullo stesso prompt-articolo, flag di produzione, laptop
// scarico (2026-08-18): una chiamata SANA e riuscita ha impiegato 116,9s
// (primo byte 1836ms, 72 KB) — 3,1s sotto il cap — e una seconda stava ancora
// emettendo a 300s (127 KB) quando l'ho fermata io. Il caso sano non e' «~45s»:
// e' molto variabile e sfiora o supera i 120s gia' senza contesa. Un cap fisso
// a 120s taglia quindi a meta' la distribuzione dei casi sani.
//
// ── PERCHE' NON BASTA UN NUMERO FISSO PIU' GRANDE ──────────────────────────
//
// L'allowance non e' una costante: e' `remaining` del budget di sezione, e nello
// STESSO run vale 1020s e 630s (decade mentre la run brucia budget; la serie
// osservata nel run 32147257594 e' 1020→900→865→854→775→758→685→586→496→392→
// 302→136). Un fisso grande sfonda quando l'allowance residua e' piccola, un
// fisso piccolo spreca quando e' grande. Da qui la forma: la chiamata prende
// una QUOTA dell'allowance residua, con questo valore come minimo vero e
// CLAUDE_CLI_MAX_TIMEOUT_MS come tetto. Vedi _callClaudeCli.
//
// 180s e non di piu' come minimo: e' il minimo a valere anche quando
// l'allowance e' quasi finita, dove la quota e' piccola e vince lui. Tenerlo
// basso e' cio' che impedisce a `CLAUDE_CLI_TIMEOUT_STORM_THRESHOLD` timeout
// consecutivi di divorare una sezione corta — con 120s il caso peggiore era
// 3×120=360s, con 180s e' 3×180=540s, e la clamp a `remaining` in
// _callClaudeCli lo tiene comunque dentro l'allowance per costruzione.
const CLAUDE_CLI_MIN_TIMEOUT_MS = 180_000;

// Tetto per una singola chiamata al CLI, per quanto grande sia l'allowance
// residua. Serve a impedire che una sezione lunga (allowance 2400s) regali
// 800s a UNA chiamata: oltre i 600s una chiamata che non ha finito non e' piu'
// «lenta», e la cascata ha bisogno del budget che resta per i modelli dopo.
// Sopra la piu' lunga osservata (>300s in locale) con margine ~2x.
const CLAUDE_CLI_MAX_TIMEOUT_MS = 600_000;

// Quota dell'allowance residua concessa a UNA chiamata del CLI.
//
// 1/3 e non 1/2: il breaker scatta a CLAUDE_CLI_TIMEOUT_STORM_THRESHOLD (3)
// timeout consecutivi, quindi il caso peggiore e' una serie geometrica
//
//     1/3 + (2/3)(1/3) + (2/3)²(1/3) = 1 - (2/3)³ = 19/27 ≈ 0,704
//
// cioe' una tempesta piena lascia comunque ~30% del budget di sezione alla
// cascata dei modelli successivi. (Questa riga diceva 0,578 e ~42%: numero
// sbagliato, trovato dalla review del sito #6045. Verificato sulla serie
// osservata, 1020s → 340+227+151 = 718s, cioe' 70,3%. Il test simula la
// formula vera e misura ~73%, non la serie idealizzata.) A 1/2 la stessa
// serie fa 1 - (1/2)³ = 0,875 e la sezione resterebbe senza tempo per il
// fallback. Sull'allowance osservata: 1020s → 340s a chiamata (2,8x
// l'odierno), 630s → 210s.
const CLAUDE_CLI_ALLOWANCE_SHARE = 1 / 3;
let _claudeCliInFlight = 0;
const _claudeCliWaiters = [];

async function _withClaudeCliSlot(fn) {
  if (_claudeCliInFlight >= CLAUDE_CLI_MAX_CONCURRENCY) {
    await new Promise((resolve) => { _claudeCliWaiters.push(resolve); });
  }
  _claudeCliInFlight++;
  try {
    return await fn();
  } finally {
    _claudeCliInFlight--;
    const next = _claudeCliWaiters.shift();
    if (next) next();
  }
}

// Per-run call CAP on claude-cli/* (distinct from CLAUDE_CLI_MAX_CONCURRENCY
// above, which bounds simultaneous subprocesses, not total calls over a run).
// Safety net for 2026-07-29's AI_COMPETING_TIERS promotion: CLAUDE_CODE_OAUTH_TOKEN
// powers pr-review-loop.yml/issue-fix.yml/post-merge-followup.yml too — a
// crawler run now free to call claude-cli/* as often as any tier-0 model
// could otherwise burn the SAME shared Max-subscription quota those workflows
// need, stalling the review/auto-merge pipeline. Counted per-process (module
// state), reset by resetState().
//
// ── 25 → 40 (2026-08-18) ───────────────────────────────────────────────────
//
// 25 e' stato dimensionato quando claude-cli era solo un tier promosso che
// nessuno chiamava mai davvero (vedi applyPreferOverride: «not reached this
// run» su 6 run su 6). Con `opts.prefer` sulla generazione del corpo, ogni
// tentativo di generazione lo chiama per davvero, e il numero di tentativi per
// run e' misurato, non stimato:
//
//   run 32107646060 — 20 tentativi di generazione in una sola run
//                     (news 1..6, news 1..6, evergreen 1..2, evergreen 1..6)
//
// 20 tentativi × fino a 2 chiamate preferite ciascuno = 40. Le due chiamate
// sono la generazione e la sua RIGENERAZIONE repair-aware sullo stesso prompt
// quando il JSON torna malformato (create-article.mjs, il retry con
// `maxTokens=retryTokens` subito dopo il `JSON.parse` fallito): stesso call
// site, stessa preferenza. Da qui il numero — e' il caso peggiore osservato
// moltiplicato per il fan-out reale del call site, non un margine tondo.
//
// A 25 la run peggiore si sarebbe fermata a meta' strada, ricadendo sui modelli
// free proprio per i tentativi finali — quelli che partono gia' con meno fonte
// (la scala di riduzione morde di piu' ai retry) e producono il thin-content che
// la preferenza esiste per evitare.
//
// Il fact-check NON entra in questo conto: resta deliberatamente sui modelli
// free. E' un consenso fra verificatori indipendenti, e preferire un solo
// modello per tutti i membri collasserebbe l'indipendenza che il guard
// `local/fallback cannot self-verify` esiste per difendere.
//
// NON alzarlo a 300 come `translate-pending.yml` del sito (#5885): li' il tetto
// e' dimensionato su 900 job in un workflow di traduzione, qui su una singola
// run di generazione. La quota del piano Max e' CONDIVISA con pr-review-loop.yml
// e issue-fix.yml, quindi ogni rialzo qui e' quota tolta al ciclo dei merge —
// e' una leva di costo dichiarata, si alza solo con la misura in mano.
const DEFAULT_CLAUDE_CLI_MAX_CALLS_PER_RUN = 40;
let _claudeCliCallsThisRun = 0;
let _claudeCliMaxCallsWarned = false;
let _claudeCliUnlimitedWarned = false;

/**
 * CLAUDE_CLI_MAX_CALLS_PER_RUN — max claude-cli/* calls this process attempts
 * before skipping it for the rest of the run (see the cap check in callLLM's
 * main loop). Unset/blank → DEFAULT_CLAUDE_CLI_MAX_CALLS_PER_RUN above.
 * "0" explicitly DISABLES the cap (unlimited) — checked via Number.isInteger
 * + >=0, not `Number.parseInt(x) || default`, because that idiom can't
 * distinguish a real 0 from "unparseable". Malformed value (non-integer,
 * negative) → falls back to the default and warns ONCE per process.
 *
 * ── `0` NON E' UN KILL SWITCH, E SEMBRA ESSERLO ────────────────────────────
 *
 * E' la trappola di questa variabile: la lettura naturale di «cap = 0» su un
 * modello a pagamento e' «zero chiamate», e la semantica reale e' l'opposto
 * esatto — illimitate. Chi la usa per spegnere Haiku in fretta toglie l'unico
 * tetto che c'era.
 *
 * NON e' stata cambiata in «0 = nessuna chiamata», per tre motivi:
 *   1. e' la convenzione gia' documentata e testata su questo file, che e'
 *      `mode: identical` col gemello del sito — invertirla di soppiatto qui
 *      renderebbe i due lati d'accordo sul testo e in disaccordo sui fatti;
 *   2. `0 = illimitato` e' la stessa convenzione degli altri cap del file, e
 *      spezzarla in un punto solo e' peggio che tenerla;
 *   3. spegnere Haiku ha gia' due leve vere (vedi il warn qui sotto), quindi
 *      questa non deve diventarne una terza con una semantica sua.
 *
 * Resta pero' il fatto che un `0` messo per sbaglio non lascia traccia. Da qui
 * il warn-once: non blocca niente, ma mette nel log della run la riga che
 * distingue «l'ho voluto» da «pensavo di aver spento».
 */
function _getClaudeCliMaxCallsPerRun() {
  const raw = (process.env.CLAUDE_CLI_MAX_CALLS_PER_RUN || '').trim();
  if (!raw) return DEFAULT_CLAUDE_CLI_MAX_CALLS_PER_RUN;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 0) {
    if (n === 0 && !_claudeCliUnlimitedWarned) {
      _claudeCliUnlimitedWarned = true;
      console.warn(
        '⚠️ CLAUDE_CLI_MAX_CALLS_PER_RUN="0" = cap DISATTIVATO (chiamate claude-cli ILLIMITATE '
        + 'in questa run), non "nessuna chiamata". Per spegnere davvero la preferenza Haiku: '
        + 'AI_MODELS_PREFER="" (leva di rollback, vale anche sul prefer per-chiamata) oppure '
        + 'ENABLE_HAIKU_ARTICLE_FALLBACK non impostata (toglie del tutto il provider).',
      );
    }
    return n;
  }
  if (!_claudeCliMaxCallsWarned) {
    _claudeCliMaxCallsWarned = true;
    console.warn(`⚠️ CLAUDE_CLI_MAX_CALLS_PER_RUN="${raw}" invalid (expected a non-negative integer, 0 = unlimited) — using default ${DEFAULT_CLAUDE_CLI_MAX_CALLS_PER_RUN}.`);
  }
  return DEFAULT_CLAUDE_CLI_MAX_CALLS_PER_RUN;
}

/**
 * True se `model` non puo' PIU' essere servito in questa run perche' il cap di
 * chiamate per-run del suo provider e' esaurito. Oggi solo `claude-cli/*` ha un
 * cap per-run (CLAUDE_CLI_MAX_CALLS_PER_RUN); per ogni altro provider e' false.
 *
 * ── PERCHE' E' ESPORTATA, E NON SOLO UN `if` DENTRO callLLM ────────────────
 *
 * Stessa ragione di `getDeclaredRequestTokenLimit`: un chiamante deve poter
 * chiedere «questo modello mi rispondera' davvero?» PRIMA di costruire il
 * prompt, e la risposta deve venire da questa stessa funzione — non da una
 * copia che scivola.
 *
 * Il caso concreto e' `_preferisceModelloSenzaCap` in `create-article.mjs`, che
 * salta la scala di riduzione del prompt quando il preferito non dichiara un
 * cap di input. `isModelAvailable` non conosce questo cap (guarda solo
 * exhausted + presenza della chiave), quindi superate le N chiamate haiku
 * spariva dalla catena mentre la guardia continuava a rispondere «c'e'»: per
 * ogni headline successiva prompt intero (~9500 token), tutti i modelli free
 * scartati dal pre-flight, tentativo 1 morto con ALL_MODELS_EXHAUSTED e
 * recupero solo al tentativo 2 via `err.retryRequestTokenBudget`. Esattamente
 * il tentativo sprecato che quella guardia esiste per evitare.
 *
 * NB: non e' `isModelAvailable` a essere stata estesa. «Disponibile» li'
 * significa configurato e non bruciato, ed e' letta anche da chi conta i
 * modelli configurati (`isAnyModelAvailable`): infilarci un contatore che
 * cambia a meta' run renderebbe quella domanda non piu' rispondibile.
 */
export function isPerRunCallCapReached(model) {
  if (getProvider(model) !== PROVIDER.CLAUDE_CLI) return false;
  const cap = _getClaudeCliMaxCallsPerRun();
  return cap > 0 && _claudeCliCallsThisRun >= cap;
}

// ── API keys (lazy-loaded from environment) ──────────────────
function getGhModelsPat()       { return (process.env.GH_MODELS_PAT || '').trim(); }
// GitHub Models free-tier rate limits are PER-ACCOUNT (per PAT), not per-model,
// and all ~25 GitHub-hosted models in the chain share that one account budget.
// Supplying PATs from additional free GitHub accounts (GH_MODELS_PAT_2/3/…) and
// rotating on daily-limit/429 multiplies the free generation quota at $0.
// Returns the primary first, then numbered extras (deduped). Single-PAT setups
// get a 1-element array → identical behaviour to before.
export function getGhModelsPats() {
  const pats = [];
  const primary = (process.env.GH_MODELS_PAT || '').trim();
  if (primary) pats.push(primary);
  for (let i = 2; i <= 9; i++) {
    const extra = (process.env[`GH_MODELS_PAT_${i}`] || '').trim();
    if (extra && !pats.includes(extra)) pats.push(extra);
  }
  return pats;
}
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
// Cloudflare Workers AI is DISABLED by default ($0 policy). Its "free" tier is a
// hard 10K-neurons/day cap; every neuron past it bills at $0.011/1K (the
// "Regular Twitch Neurons" line on the CF bill — measured ~50-86K neurons/day
// = ~$0.50-0.84/day overage from the crawler/article LLM fallback chain). The
// other 100+ free models across 13 providers cover all fallback need, so cf/*
// stays off unless explicitly opted back in via CF_WORKERS_AI_ENABLED=1.
function isCloudflareWorkersAiEnabled() {
  return /^(1|true|yes|on)$/i.test((process.env.CF_WORKERS_AI_ENABLED || '').trim());
}
function getMistralApiKey()  { return (process.env.MISTRAL_API_KEY || '').trim(); }
function getCodestralApiKey() { return getMistralApiKey(); }  // Same key, separate endpoint
function getChutesApiKey()   { return (process.env.CHUTES_API_KEY || '').trim(); }
function getZaiApiKey()      { return (process.env.ZAI_API_KEY || process.env.ZHIPU_API_KEY || '').trim(); }

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
  if (model.startsWith('chutes/'))     return PROVIDER.CHUTES;
  if (model.startsWith('zai/'))        return PROVIDER.ZAI;
  if (model.startsWith('local/'))      return PROVIDER.LOCAL;
  if (model.startsWith('claude-cli/')) return PROVIDER.CLAUDE_CLI;
  if (model.startsWith('omniroute/'))  return PROVIDER.OMNIROUTE;
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
  if (model.startsWith('chutes/'))     return model.slice(7);   // 7 chars: "chutes/"
  if (model.startsWith('zai/'))        return model.slice(4);   // 4 chars: "zai/"
  if (model.startsWith('local/'))      return getLocalLlmModelId(); // served-model label is runtime-configured
  if (model.startsWith('claude-cli/')) return model.slice(11);  // 11 chars: "claude-cli/"
  if (model.startsWith('omniroute/'))  return model.slice(10);  // 10 chars: "omniroute/" → "auto"
  return model;
}

/** Get the API key for a given provider */
function getApiKeyForProvider(provider) {
  switch (provider) {
    // First available PAT (primary or any extra) — so a config that supplies
    // only GH_MODELS_PAT_2 still registers GitHub as available to the gate.
    case PROVIDER.GITHUB:      return getGhModelsPats()[0] || '';
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
    // Cloudflare needs BOTH token AND account ID to construct the endpoint — and
    // is off by default ($0 policy; see isCloudflareWorkersAiEnabled). Returning
    // '' marks every cf/* model unavailable, so the chain never selects it.
    case PROVIDER.CLOUDFLARE:  return (isCloudflareWorkersAiEnabled() && getCloudflareApiToken() && getCfAccountId()) ? getCloudflareApiToken() : '';
    case PROVIDER.MISTRAL:     return getMistralApiKey();
    case PROVIDER.CODESTRAL:   return getCodestralApiKey();
    case PROVIDER.CHUTES:      return getChutesApiKey();
    case PROVIDER.ZAI:         return getZaiApiKey();
    // Local server needs no real key; gate purely on the opt-in flag. Returning
    // a sentinel marks local/* available so the chain can reach it as last resort
    // (and '' when disabled → every local/* model is skipped). Mirrors Cloudflare.
    case PROVIDER.LOCAL:       return isLocalLlmEnabled() ? 'local-no-key' : '';
    // No real key — auth is the CLAUDE_CODE_OAUTH_TOKEN env var, read directly
    // by the `claude` CLI subprocess. Gate on RC flag + token presence so the
    // chain only offers this model when both are actually usable. Mirrors Local.
    case PROVIDER.CLAUDE_CLI:  return (!_claudeCliBinaryMissing && !_claudeCliTimeoutStormDetected && isClaudeCliFallbackEnabled() && hasClaudeCodeOauthToken()) ? 'claude-cli-no-key' : '';
    // OmniRoute needs no real key from us either; gate purely on the opt-in
    // flag, same sentinel pattern as Local. '' when disabled → every
    // omniroute/* model is skipped.
    case PROVIDER.OMNIROUTE:   return (!_omniRouteFailureStormDetected && isOmniRouteEnabled()) ? getOmniRouteApiKey() : '';
    default: return '';
  }
}

/**
 * True for opt-in providers (local CPU fallback, Claude CLI Haiku, OmniRoute —
 * see AI_MODELS.LOCAL_FALLBACK / CLAUDE_CLI_HAIKU / OMNIROUTE_AUTO) that must
 * never be marked exhausted/banned. Local and Claude CLI have no daily-quota
 * concept at all, so persisting a ban just guarantees zero output for the
 * rest of the budget. OmniRoute's reasoning is distinct but lands on the same
 * exemption: the CI pilot instance is EPHEMERAL — a fresh, empty sqlite
 * provider DB every run (scripts/ci/omniroute-poc-register.mjs re-registers
 * from scratch each boot) — so a Firestore-persisted "exhausted until
 * midnight" ban computed from one run's registered providers is meaningless
 * (and actively harmful) for a different run's freshly-provisioned instance.
 * Centralizes what were several separate `!== PROVIDER.LOCAL` checks so
 * adding further last-resort tiers didn't require touching each one.
 *
 * Orthogonal to AI_COMPETING_TIERS (2026-07-29): this is about a PROVIDER's
 * technical properties (no real quota / ephemeral instance), not its current
 * tier RANK. omniroute/claude-cli stay exempt here even while promoted to
 * tier-0 — the 60s per-provider cooldown (cooldownProvider(), unconditional,
 * see the main callLLM loop) plus ordinary score-based sinking on failure
 * already bound the "retry forever" risk without needing the ban too.
 */
function _isLastResortProvider(modelId) {
  const p = getProvider(modelId);
  return p === PROVIDER.LOCAL || p === PROVIDER.CLAUDE_CLI || p === PROVIDER.OMNIROUTE;
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
  /**
   * Preferenza DURA per questa singola chiamata: array di id (o CSV) spostati
   * in testa alla catena DOPO l'ordinamento per punteggio, quindi vincente
   * anche contro un modello con storico molto migliore. Riordina e basta: la
   * catena resta intera dietro, e un preferito che fallisce cade sul fallback
   * che si sarebbe usato comunque.
   *
   * Da usare SOLO sui punti critici dove il modello free non e' affidabile — la
   * quota del piano Max e' condivisa con pr-review-loop.yml e issue-fix.yml.
   * Vedi il blocco di commento su applyPreferOverride.
   */
  prefer: undefined,
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
 * - Local (ollama, _callLocal → _callOpenAICompatible with providerName:
 *   'Local'): ollama's OpenAI-compat endpoint honors the same strict
 *   json_schema contract (verified 2026-07-05 against a local ollama
 *   v0.31.1 + qwen2.5:0.5b using the exact production article schema from
 *   buildArticleJsonSchema() — HTTP 200, valid JSON, all required keys
 *   present). Without this, local/fallback only got generic `json_object`
 *   mode (valid JSON syntax, no shape guarantee), which is the direct cause
 *   of the recurring "content.it non normalizzabile" / JSON parse failures
 *   logged whenever the cascade reached local/fallback (e.g. run
 *   28744325535's `imageAlt` object left dangling mid-payload).
 * - OmniRoute deliberately NOT included: model:"auto" means WE don't control
 *   which upstream provider actually serves a given request, so unlike every
 *   other entry above there's no single verified backend to point this
 *   decision at — it can silently vary per call across OmniRoute's ~78-100+
 *   registered providers. Falls back to the safe `json_object` default;
 *   revisit only if/when OmniRoute normalizes schema support across backends.
 */
const PROVIDERS_WITH_STRICT_JSON_SCHEMA = new Set(
  [PROVIDER.GITHUB, PROVIDER.OPENROUTER, PROVIDER.MISTRAL, PROVIDER.LOCAL].map(_normalizeProviderKey),
);

/**
 * Canonicalize a provider identifier so the SAME set above can be queried with
 * either spelling this module uses for a provider:
 *
 *   - the PROVIDER.* constant returned by getProvider() — lowercase, e.g. 'groq'
 *   - the human `providerName` string each _call*() hands to
 *     _callOpenAICompatible() — e.g. 'Groq', 'OpenRouter', 'Z.AI'
 *
 * Those two spellings are why this normalization is not cosmetic. The set used
 * to hold display names ONLY, so `shouldUseSchemaMode(getProvider(model))`
 * returned false for every provider on earth — including the four that DO
 * receive the schema. Any caller reaching for the send-time decision from the
 * getProvider() side (estimateRequestTokens' pre-flight call site does exactly
 * that) would have silently under-counted GitHub/OpenRouter/Mistral/Local
 * instead of over-counting Groq: same bug, opposite sign, and the file's own
 * cost model rates that direction worse (a wrong pass costs a guaranteed 413,
 * a wrong skip costs one chain step).
 *
 * Stripping non-alphanumerics — not a bare toLowerCase() — because 'Z.AI'
 * lowercases to 'z.ai' while its constant is 'zai'. Applied to BOTH the set's
 * contents and every lookup, so the two spellings collapse onto one key and no
 * second list has to be kept in sync.
 */
function _normalizeProviderKey(provider) {
  return String(provider ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

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
 *                  not the OpenAI response_format shape — handled in _callGeminiRaw),
 *                  minus any model in _learnedSchemaIncompatible (runtime-learned
 *                  per-model 400 on schema mode — see _learnSchemaIncompatible)
 *
 * `modelForTracking`, when given, is checked against _learnedSchemaIncompatible
 * so a single model within a provider that 400s on schema mode (e.g. a
 * GitHub-hosted Ministral/Codestral/Phi-4 variant) stops being offered it,
 * without punishing the rest of that provider's models.
 *
 * `providerName` accepts either spelling — the display name used at send time
 * ('GitHub') or the PROVIDER.* constant returned by getProvider() ('github').
 * See _normalizeProviderKey.
 *
 * THIS IS THE SINGLE SOURCE OF TRUTH for "does this provider receive the
 * schema". Both halves that need the answer ask it: the send side
 * (_callOpenAICompatible / _callGeminiRaw, which build the request body) and
 * the estimate side (estimateRequestTokens, which sizes that same body for the
 * pre-flight skip-guard). Do not re-derive the answer from
 * PROVIDERS_WITH_STRICT_JSON_SCHEMA at a new call site: the two halves
 * disagreeing is precisely the defect this function was widened to close —
 * the estimator used to add the serialized schema unconditionally, so Groq
 * (not in the set, never sent the schema) was pre-flight-skipped on ~516
 * phantom tokens it would never have received.
 *
 * Exported for tests / smoke probes.
 */
export function shouldUseSchemaMode(providerName, hasSchema = true, modelForTracking = undefined) {
  if (!hasSchema) return false;
  const mode = getSchemaMode();
  if (mode === 'off') return false;
  if (mode === 'force') return true;
  if (modelForTracking && _learnedSchemaIncompatible.has(modelForTracking)) return false;
  const key = _normalizeProviderKey(providerName);
  if (key === _normalizeProviderKey(PROVIDER.GEMINI)) return true;
  return PROVIDERS_WITH_STRICT_JSON_SCHEMA.has(key);
}

/**
 * Strip JSON-Schema keywords that Gemini's `responseSchema` rejects.
 * Gemini accepts an OpenAPI-3.0 subset only ($schema/$ref/oneOf/anyOf/allOf,
 * additionalProperties, patternProperties, const, etc. are NOT supported and
 * will fail with HTTP 400 INVALID_ARGUMENT).
 *
 * Also normalizes JSON-Schema nullable unions (`type: ['string', 'null']`) into
 * Gemini's OpenAPI form (`type: 'string', nullable: true`). Without this the
 * proto-map parser on Gemini's side rejects the inner `type` field with
 * `Unknown name "type" at 'generation_config.response_schema.properties[N].value'`
 * (root cause of run 26534353239 falling through to fallback chain exhaustion).
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
    if (k === 'type' && Array.isArray(v)) {
      const nonNull = v.filter((t) => t !== 'null');
      out.type = nonNull.length > 0 ? nonNull[0] : 'string';
      if (v.includes('null')) out.nullable = true;
      continue;
    }
    out[k] = (v && typeof v === 'object') ? sanitizeSchemaForGemini(v) : v;
  }
  return out;
}

// ── Run-level state (reset only between process invocations) ─
const _exhaustedModels = new Set();
// GitHub Models PAT indices that hit their per-account daily limit this run, so
// subsequent GitHub calls skip them and go straight to a fresh account's PAT.
// Reset per run (resetState) — daily limits reset on the provider side anyway.
const _ghExhaustedPats = new Set();
// modelId → reason it was exhausted ('quota' | 'timeout' | 'content' | 'stale' |
// 'nonretryable'). Gates the GitHub multi-PAT skip-exemption (quota only).
const _exhaustReason = new Map();
// modelId → optional free-text detail for that reason, e.g. 'HTTP 402'. Kept
// separate from _exhaustReason so the coarse reason values the multi-PAT
// exemption compares against (`=== 'quota'`) stay a closed set, while the skip
// message can still name the actual status. See _exhaustSkipCause.
const _exhaustDetail = new Map();
// Tracks which exhausted models have already been logged this run, so a model
// that's been exhausted since startup doesn't produce a "Skipped — exhausted"
// line every time the fallback chain ticks past it.
const _exhaustedLogged = new Set();

// Same flood-avoidance discipline as _exhaustedLogged above, for the OTHER
// pre-flight skip filters in callLLM's main loop (provider cooldown, missing
// API key, max-output-token cap) — those used to be silent (errors.push only,
// no console.warn), so a whole last-resort tier could vanish from a run's
// output with zero trace unless the entire chain failed. Keyed `${model}:${cause}`
// so distinct causes for the same model each still get their one log line.
const _preflightSkipLogged = new Set();
function _logPreflightSkipOnce(model, cause, message) {
  const key = `${model}:${cause}`;
  if (_preflightSkipLogged.has(key)) return;
  _preflightSkipLogged.add(key);
  console.warn(`⏭️  [${model}] Skipped — ${message}`);
}

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

// ── Adaptive per-call timeout ceiling ────────────────────────
/**
 * A call that HANGS burns the caller's full per-request timeout before the
 * cascade is allowed to move on, and that wait is the single largest piece of
 * dead wall-clock a healthy run still pays.
 *
 * The measurement (generate-article.yml, 14 consecutive `success` runs,
 * 2026-08-18 09:01-11:06 UTC): 4 of the 14 lost 60,0 ± 0,003 s each to ONE
 * hung call, always on `nvidia/meta/llama-3.1-8b-instruct` — 240 s over 14
 * runs, 17,1 s/run, 4,3 % of run duration. The 60,0 s is the caller's own
 * `timeout: 60_000` (the fact-check call), not a retry loop: both provider
 * retry loops already refuse to retry a timeout, and the hard cap never fired.
 *
 * Why the two mechanisms that look like they should catch it do not:
 *
 *  - The score ledger DOES record it — the timeout reaches
 *    `recordModelFailure(model, { exhausted: true })`, i.e. SCORE_EXHAUSTED
 *    (-50), and that is persisted. It is arithmetically INERT: the same
 *    model's persisted score is +36819 (172.042 successes / 3.286 failures,
 *    read from `ai_model_scores/_all` on 2026-08-18 11:25 Z), so -50 moves it
 *    by 0,14 % and it stays rank 1 of 340 — the runner-up sits at +120.
 *    Nothing observed recently can outvote an UNBOUNDED cumulative sum, so
 *    "make the ledger notice" is not available as a fix here.
 *
 *  - Banning or demoting the model would be wrong on the evidence: 98,1 %
 *    lifetime success, ~26 successful calls in the very run that then lost 60 s
 *    to one hang, and a direct probe of integrate.api.nvidia.com (5 calls,
 *    ~2400-token prompt, max_tokens 4000) answered 5/5 in 1,2-5,3 s. This is a
 *    live endpoint that occasionally hangs, not a dead one — exactly the case
 *    a persisted exhaustion must never be allowed to punish.
 *
 * So the recoverable waste is not WHICH model, it is HOW LONG we keep waiting
 * on a model we have already watched answer fast in this same process. The
 * ceiling below is derived from that model's own observed successful latency
 * and is deliberately weak in every direction that could hurt:
 *
 *   - it only ever LOWERS the caller's timeout, never raises it;
 *   - it needs ADAPTIVE_TIMEOUT_MIN_SAMPLES successful calls before it says
 *     anything at all (an unobserved model keeps the caller's number);
 *   - it tracks the MAXIMUM successful latency, never a mean, and that maximum
 *     only ever grows within a process — the ceiling can widen, never narrow;
 *   - it never goes below ADAPTIVE_TIMEOUT_FLOOR_MS, whatever the samples say;
 *   - last-resort tiers are exempt: `_callLocal` deliberately raises the
 *     timeout floor for slow CPU inference and claude-cli has a cold start, so
 *     "fast so far" is not a promise either of them makes;
 *   - and a timeout that fires under a ceiling WE narrowed does not mark the
 *     model exhausted on its own (see ADAPTIVE_TIMEOUT_MAX_CLAMPED_FAILURES
 *     and the timeout circuit-breaker in callLLM). That is the graceful
 *     degradation: if the guess is wrong the run loses one call, not its
 *     best model for the remaining wall-clock budget.
 *
 * Expected saving, stated as the conditional it is: the ceiling becomes
 * `max(FLOOR, MULT × observedMax)`, so it recovers `60 s − that` per hang and
 * recovers nothing once `MULT × observedMax ≥ 60 s`. With the latency profile
 * measured above (1,2-5,3 s) the ceiling lands on the 20 s floor, i.e. ~40 s
 * per event → the 17,1 s/run tax falls to ~5,7 s/run. It is a modest,
 * bounded win on a 4,3 % problem; it is NOT a fix for a dead endpoint,
 * because the measurement says there isn't one.
 */
const ADAPTIVE_TIMEOUT_MIN_SAMPLES = _envInt('AI_ADAPTIVE_TIMEOUT_MIN_SAMPLES', 10);
const ADAPTIVE_TIMEOUT_MULT = _envInt('AI_ADAPTIVE_TIMEOUT_MULT', 4);
const ADAPTIVE_TIMEOUT_FLOOR_MS = _envInt('AI_ADAPTIVE_TIMEOUT_FLOOR_MS', 20_000);
/**
 * How many timeouts under a ceiling THIS module narrowed a model may collect
 * before the normal timeout circuit-breaker applies to it after all. 1 means
 * "the first one is on us, the second is on the model": a single clamped
 * timeout is as likely to be our multiplier being too tight as it is to be the
 * provider hanging, and banning the run's best model on our own guess is the
 * failure mode this whole block exists to avoid.
 */
const ADAPTIVE_TIMEOUT_MAX_CLAMPED_FAILURES = _envInt('AI_ADAPTIVE_TIMEOUT_MAX_CLAMPED_FAILURES', 1);

/** @type {Map<string, {samples: number, maxMs: number}>} model → observed successful-call latency */
const _callLatency = new Map();
/** @type {Map<string, number>} model → timeouts served under a ceiling we narrowed */
const _clampedTimeouts = new Map();

/** Read a positive integer override from the environment, else the default. */
function _envInt(name, fallback) {
  const v = parseInt((process.env[name] || '').trim(), 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * The per-call timeout a model has EARNED, given what it has been observed to
 * do. Pure on purpose (no clock, no maps, no env): the whole point of the
 * block above is that every guard is checkable in isolation.
 *
 * @param {{samples: number, maxMs: number}|undefined} observed
 * @param {number} requestedMs the caller's own timeout — the hard ceiling
 * @param {{minSamples?: number, mult?: number, floorMs?: number}} [knobs]
 * @returns {number} ms; equal to `requestedMs` whenever the evidence is thin
 */
export function computeAdaptiveTimeoutMs(observed, requestedMs, knobs = {}) {
  const minSamples = knobs.minSamples ?? ADAPTIVE_TIMEOUT_MIN_SAMPLES;
  const mult = knobs.mult ?? ADAPTIVE_TIMEOUT_MULT;
  const floorMs = knobs.floorMs ?? ADAPTIVE_TIMEOUT_FLOOR_MS;
  if (!(requestedMs > 0)) return requestedMs;
  if (!observed || !(observed.samples >= minSamples) || !(observed.maxMs > 0)) return requestedMs;
  const earned = Math.max(floorMs, Math.ceil(observed.maxMs * mult));
  return Math.min(requestedMs, earned);
}

/** Record one SUCCESSFUL call's wall-clock latency for a model. */
function _recordCallLatency(model, ms) {
  if (!model || !(ms >= 0)) return;
  const cur = _callLatency.get(model) || { samples: 0, maxMs: 0 };
  cur.samples++;
  if (ms > cur.maxMs) cur.maxMs = ms;
  _callLatency.set(model, cur);
}

/** Observability + test seam for the latency evidence behind the ceiling. */
export function getCallLatencyStats() {
  return Object.fromEntries([..._callLatency.entries()].map(([m, v]) => [m, { ...v }]));
}

// Provider-level cooldown: when a provider returns 429, all its models
// get a temporary cooldown to avoid wasting retries on sibling models.
// Maps provider name → cooldown-until timestamp (ms).
const _providerCooldown = new Map();
const PROVIDER_COOLDOWN_MS = 60_000; // 1 minute cooldown after 429

// Ceiling applied to a provider's `Retry-After` header (some return 86399 =
// 24h, which would freeze the pipeline). Read in two places that must never
// drift apart: the 429 backoff in _callOpenAICompatible, and _hardCallCapMs
// below, which sizes the per-call hard cap off this same worst-case wait.
const MAX_RETRY_AFTER_MS = 2 * 60 * 1000;

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

// Single source of truth for what counts a "last-resort" model and its
// prefix (AGENTS.md #6 — do not re-declare 'local/'/'omniroute/'/'claude-cli/'
// yet again below). Declared here, ahead of _freshLastResortStats, because
// _stats (below) builds its lastResort bucket eagerly at module-load time —
// a later declaration would TDZ-crash on first import.
const LAST_RESORT_TIER_PREFIXES = Object.freeze({
  omniroute: 'omniroute/',
  local: 'local/',
  'claude-cli': 'claude-cli/',
});

// Fresh last-resort-tier stats bucket. Factory (not an inline literal reused
// two places) keeps the initial shape and resetState()'s reset in sync — one
// source of truth, no drift between the two (AGENTS.md #6). Keys driven by
// LAST_RESORT_TIER_PREFIXES instead of a separate hardcoded name list.
function _freshLastResortStats() {
  const stats = {};
  for (const name of Object.keys(LAST_RESORT_TIER_PREFIXES)) {
    stats[name] = { served: 0, failed: 0, skipped: 0, skipReasons: {} };
  }
  return stats;
}

const _stats = {
  calls: 0,
  successes: 0,
  retries: 0,
  fallbacks: 0,
  exhausted: 0,
  providerCooldowns: 0,
  cacheHits: 0,
  errors: [],
  // Visibility into the 3 opt-in last-resort tiers (local/, omniroute/,
  // claude-cli/): calls served, calls attempted-but-failed, calls skipped
  // pre-flight with aggregated cause. See printRunSummary()'s compact
  // "last-resort: ..." line and _recordLastResortSkip/_recordLastResortOutcome
  // below. Added after run 30333856358 (2026-07-28) went 11× claude-cli
  // timeout with omniroute/auto never even attempted and zero trace of why —
  // root cause there turned out to be a chain-membership gap (fixed in PR
  // #4836, unrelated to this file), but the run had NO signal to distinguish
  // that from a skip-logic bug. These counters make that distinction visible
  // without needing to grep raw logs / gh run download next time.
  lastResort: _freshLastResortStats(),
};

// ── In-process response cache (opt-in via opts.cache === true) ────
// Dedups IDENTICAL deterministic prompts WITHIN a single run. The cache is
// OPT-IN per call: creative generation (varying temperature / model rotation /
// min-words retries) must NEVER be cached or it would return the same too-short
// or identical output and defeat the retry. Only callers that pass deterministic
// inputs (temperature 0 fact-check verdicts, page classification) opt in.
//
// Scope is per-run only (no cross-run persistence): the cross-run repetition
// case is already covered elsewhere by the jobs crawler's committed content-hash
// cache (data/jobs-ai-cache.json). create-article's amplifier waste is intra-run
// (fact-check re-checking the same body across outer regeneration attempts), so
// a per-run map captures it at zero infra cost and zero staleness risk.
const _responseCache = new Map();
const RESPONSE_CACHE_MAX = 500;

// Tiny dependency-free hash (FNV-1a, 32-bit). This module deliberately avoids
// static imports (it is loaded in varied contexts incl. Firebase Functions);
// crypto is only ever dynamic-imported. For ≤500 deterministic entries the
// collision probability is negligible, and the key includes the full opts so a
// collision would still require an identical prompt+model+params tuple.
// NOT a duplicate of scripts/lib/fnv1a.mjs's `fnv1a32` (AGENTS.md #6 dedup):
// this is a different shift-based mixing step with no static import, kept
// separate on purpose for the Firebase Functions constraint above.
function _fnv1aHex(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}

function _responseCacheKey(messages, o) {
  // Only fields that change the model OUTPUT belong in the key.
  // bypassForceChain and the current AI_MODELS_FORCE_CHAIN state alter which
  // model actually answers: a forced call (bypassForceChain=false) and a bypass
  // call (bypassForceChain=true) with identical prompt+model+params can produce
  // different outputs → they must map to different cache entries. Without these
  // fields, a forced-local response could be served to the fact-check bypass
  // path, short-circuiting remote verification (circular self-consensus).
  return _fnv1aHex(JSON.stringify({
    m: messages,
    t: o.temperature,
    mt: o.maxTokens,
    j: o.jsonMode,
    s: o.jsonSchema || null,
    model: o.model || null,
    ns: o.cacheNamespace || '',
    bfc: !!o.bypassForceChain,
    fc: (process.env.AI_MODELS_FORCE_CHAIN || '').trim(),
    // Same argument as `fc` one line up: a preference changes WHICH model
    // answers an otherwise identical request, so a preferred and a
    // non-preferred call must not share a cache entry. Both layers are keyed:
    // `pf` the process-wide env opt-in, `pfo` the per-call opts.prefer. Without
    // `pfo` the body call (which prefers claude-cli/haiku) and any other call
    // with the same prompt+params would collide, and the preferred call would
    // be served a response a free model produced — the exact defect the
    // preference exists to avoid.
    pf: (process.env.AI_MODELS_PREFER || '').trim(),
    pfo: _normalizePrefer(o.prefer).join(','),
  }));
}

/** Clear the in-process response cache (used by tests / long-lived processes). */
export function clearResponseCache() {
  _responseCache.clear();
}

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

/**
 * Per-model successes/failures accumulated since the LAST SUCCESSFUL persist —
 * the delta, not the total. This is what goes to Firestore, as an atomic
 * `FieldValue.increment`, and it exists because the aggregate doc is shared by
 * every workflow of both repos while `_modelDetails` is a per-process total.
 *
 * The failure mode it removes (measured 2026-08-18 on `claude-cli/haiku`, run
 * 32134269129): two runs overlap, both load `successes: N`, one adds 4 and
 * writes N+4, the other adds a failure and writes N — a textbook lost update.
 * `{merge: true}` does not help here: it merges different FIELDS, so a second
 * writer naming the same field still wins outright with a stale absolute value.
 * An increment carries no baseline, so there is nothing stale to write back.
 *
 * Cleared only when the write lands; restored on failure, exactly like
 * `_dirtyModels` (see _persistScoresToFirestore).
 * @type {Map<string, {successes: number, failures: number}>}
 */
const _pendingCounterDeltas = new Map();

/**
 * Per-model outcomes of THIS run — never cleared by a persist, which is the
 * whole point: `_modelScores` is preloaded from Firestore at startup, so a
 * scoreboard built from it lists ~270 models most of which this run never
 * touched. printRunSummary() reads this map so "which models actually worked"
 * is answerable from the run log instead of from the ledger.
 * @type {Map<string, {successes: number, failures: number}>}
 */
const _runOutcomes = new Map();

let _firestoreDb = null;     // Firestore instance (null until initScoreStore)
let _firestoreFieldValue = null; // admin.firestore.FieldValue (atomic increments)
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

// ── Prompt budget: the ONE number discovery and pre-flight share ─────────────
/**
 * Largest request (input) payload the pre-flight skip-guard will let through,
 * in tokens. Not an aspiration — the fleet's actual ceiling: every entry in
 * DEFAULT_REQUEST_TOKENS_BY_PROVIDER is this number, and 8000 is also the
 * HIGHEST value in the hand-curated MODEL_MAX_REQUEST_TOKENS map (whose other
 * entries are 4000 and 3000). A prompt estimated above this is therefore
 * refused by EVERY model in DEFAULT_CHAIN that declares a cap at all; the
 * models that don't declare one aren't "accepting" it, they're unvalidated and
 * take the 413 at runtime instead.
 *
 * Scope: this covers the two STATIC sources (MODEL_MAX_REQUEST_TOKENS and the
 * provider map). _learnedRequestTokenLimits can record a HIGHER ceiling at
 * runtime when a provider states one in a 413 body, so this is the ceiling
 * known at module load, not an invariant of every call. The budget reported on
 * ALL_MODELS_EXHAUSTED is therefore computed from the limits actually observed
 * during that cascade, never from this constant.
 *
 * Runs 31385602513 / 31396507348 / 31402084443 (2026-08-10) are why this symbol
 * exists: the news branch assembled a ~9431-token prompt, no capped model could
 * take it, 39-58 models per run were marked exhausted (and markModelExhausted
 * PERSISTS, so each run poisoned the next), and the runs produced 0 articles in
 * 27-40 minutes each.
 */
export const MAX_PREFLIGHT_REQUEST_TOKENS = 8000;

/**
 * Minimum advertised context window a discovered model must report to be worth
 * injecting into DEFAULT_CHAIN. Derived rather than picked: a context window
 * has to hold the prompt AND the completion, so the floor is the largest prompt
 * pre-flight will pass plus the default completion budget.
 *
 * This replaces six unrelated `8192` literals that used to sit inline in the
 * per-provider `pick()` filters below. 8192 sat BELOW the payload this same
 * file would later refuse (8000 + a 4096 completion = 12096), so discovery kept
 * admitting models that pre-flight then skipped for an input cap, or that
 * answered HTTP 400 "maximum context length is 8192 tokens" at call time —
 * discovery and pre-flight were not talking about the same quantity.
 *
 * DEFAULT_OPTS.maxTokens is the honest output term here: discovery runs once
 * per process, before any caller has stated its own maxTokens, so the default
 * is the only completion budget knowable at that point. Callers asking for MORE
 * output stay covered by the separate MODEL_MAX_OUTPUT_TOKENS pre-flight skip.
 */
export const MIN_DISCOVERY_CONTEXT_TOKENS = MAX_PREFLIGHT_REQUEST_TOKENS + DEFAULT_OPTS.maxTokens;

// ── Dynamic free-model discovery (multi-provider) ────────────
/**
 * Auto-discover currently-available free models from every provider that
 * exposes an OpenAI-compatible `GET /v1/models` listing, and append any new
 * ones to DEFAULT_CHAIN. This avoids hand-maintaining each provider's model
 * list — new models are picked up automatically every run, so the chain
 * grows as providers ship models instead of waiting for a manual edit.
 *
 * Every provider's `pick()` enforces the SAME context floor,
 * MIN_DISCOVERY_CONTEXT_TOKENS (see its declaration above) — never a local
 * literal, so discovery can't drift below what pre-flight will accept.
 *
 * Covered providers (each attempted ONLY when its API key is present):
 * - OpenRouter — keeps IDs ending in `:free`, context_length ≥ the floor.
 * - Groq       — all listed models are free-tier; skips audio/guard/embedding
 *   models and anything with context_window below the floor.
 * - Cerebras   — all listed models are free-tier text models.
 * - Mistral    — free tier covers chat models; skips embedding/OCR/moderation
 *   and models whose capabilities exclude chat completion.
 * - NVIDIA / SambaNova / Together / Fireworks / Cohere — broad catalogs that
 *   mix free + paid without a free flag; non-chat models are filtered out and a
 *   per-provider `maxAdd` cap bounds how many fallbacks each can inject.
 *
 * markStale (OpenRouter, Groq, Cerebras, Mistral): for providers whose listing
 * authoritatively reflects what's usable, a static chain id absent from the live
 * listing is decommissioned and gets pre-exhausted for this run — but ONLY when
 * the listing returned ≥1 usable model, so a 200-with-empty-body glitch can't
 * nuke a whole provider. The broad catalogs above keep markStale OFF (a missing
 * id there just means "not in the free slice", handled by the 402/404 path).
 *
 * Self-healing safety net: even if a filter lets a non-chat or dead id slip
 * through, the per-model fallback loop in callLLM() marks it exhausted on the
 * first 400/404/decommissioned response, so a bad discovery never wedges the
 * pipeline — it just costs one skipped attempt.
 *
 * Falls back silently to the static DEFAULT_CHAIN on any network/API error,
 * and isolates providers so one failure can't block the others.
 * Call from initScoreStore() (or before the first callLLM()).
 */
// `reward` / `parse` added 2026-06-15 (run 27544487773): NVIDIA discovery was
// auto-injecting nvidia/nemotron-4-340b-reward (a REWARD model → HTTP 404 + wrong
// type) and nvidia/nemotron-parse (a DOCUMENT PARSER → HTTP 400 "Content cannot be
// a plain string. The model does not support text input."). Both matched the bare
// "nemotron" token in NVIDIA_ALLOW_FAMILY_RE but are not chat models. `embed` /
// `rerank` (the other non-chat types) were already covered above.
// `content-safety` added 2026-07-02 (run 28611052353): nvidia/nemotron-3-content-safety,
// nemotron-3.5-content-safety, nemotron-content-safety-reasoning-4b are MODERATION
// CLASSIFIERS (single-turn safety-label output), not chat models — they always
// 400 "Conversation roles must alternate user/assistant/...". Same
// broad-"nemotron"-match slip-through as the reward/parse case above; these three
// got retried on every one of ~30 cascade passes in the run, costing real wall-clock
// for a call type that can never succeed.
const NON_CHAT_MODEL_RE = /whisper|tts|text-to-speech|\bspeech\b|\baudio\b|embed|moderation|guard|\bocr\b|playai|rerank|reranking|\breward\b|\bparse\b|content-safety|stable-diffusion|sdxl|\bflux\b|nemoretriever/i;

// NVIDIA's /v1/models lists its ENTIRE historical NIM catalog with no
// free/served flag, and the bulk of it (legacy + vision + code-only families:
// yi-large, fuyu-8b, jamba-1.5-*, codegemma, deplot, gemma-2b, codellama,
// llama2-70b, kosmos-2, phi-3-vision, granite-code, starcoder2, dbrx, …) is no
// longer served on integrate.api.nvidia.com → every one 404s on the chat
// endpoint. Discovering them flooded the chain with 24 dead 404 ids (run
// 27198839248), wasting a fallback attempt each in the blog generator (#1335)
// and spamming the smoke-test dead-model table (#1357). A blanket
// NON_CHAT_MODEL_RE can't catch these — they parse as "chat" by name. So NVIDIA
// discovery is gated to this positive allowlist of currently-served general-chat
// instruct families (Nemotron, current Llama 3.x/4 instruct, Gemma 3n/4, Phi-4,
// DeepSeek V4, Qwen). New families NVIDIA actually serves get added here in a
// one-line follow-up; the static AI_MODELS NV_* entries are unaffected (this
// only bounds what AUTO-discovery injects). Module-level (not a cfg `this`
// property) so the filter never depends on how cfg.pick is invoked.
const NVIDIA_ALLOW_FAMILY_RE = /(?:^|\/)(?:llama-3\.[13]-nemotron|nemotron|llama-3\.3-|llama-3\.1-(?:8b|70b|405b)|llama-4-|gemma-3n-|gemma-4-|phi-4|deepseek-v4|qwen)/i;
// Vision/code-only specialisations even within an allowed family are not general
// chat (e.g. llama-3.2-*-vision-instruct, *-code-instruct).
const NVIDIA_SPECIALISED_RE = /vision|\bcode\b|codegemma|codellama|starcoder/i;
// Specific Nemotron / Llama-Nemotron ids NVIDIA advertises in /v1/models but this
// account is NOT entitled to call → HTTP 404 "Not found for account …" on every
// request (runs 27949428878 / 27957791379). They parse as allowed chat families
// (NVIDIA_ALLOW_FAMILY_RE matches "nemotron" / "llama-3.1-nemotron"), so the
// allowlist lets them through and discovery re-injects them every run; per-run
// exhaustion only skips them AFTER the first wasted 404, then they return next
// run. Deny up-front. Scoped tightly to the observed-dead sizes so live siblings
// (e.g. nvidia/llama-3.3-nemotron-super-49b-v1, nemotron-3.5-content-safety, and
// non-nemotron meta/llama-3.1-70b-instruct) keep flowing. If NVIDIA later serves
// these to the account, drop the relevant alternation (one-liner) — same
// maintenance pattern as the allowlist above.
const NVIDIA_DEAD_RE = /nemotron-4-340b|nemotron-nano-3-30b|llama-3\.1-nemotron-(?:ultra-253b|70b|51b)/i;

// Exported for unit testing provider `pick`/alias matching (issue #892).
export const DISCOVERY_PROVIDERS = Object.freeze([
  {
    name: 'OpenRouter',
    prefix: 'openrouter/',
    getKey: getOpenRouterApiKey,
    url: 'https://openrouter.ai/api/v1/models',
    extraHeaders: { 'HTTP-Referer': 'https://frontaliereticino.ch' },
    markStale: true,
    pick(m) {
      const id = m?.id;
      if (!id || !id.endsWith(':free')) return null;
      // Skip tiny models — not useful for translation/article generation
      if ((m.context_length || 0) < MIN_DISCOVERY_CONTEXT_TOKENS) return null;
      return id;
    },
  },
  {
    name: 'Groq',
    prefix: 'groq/',
    getKey: getGroqApiKey,
    url: 'https://api.groq.com/openai/v1/models',
    markStale: true,
    pick(m) {
      const id = m?.id;
      if (!id || m.active === false) return null;
      if (NON_CHAT_MODEL_RE.test(id)) return null;
      if ((m.context_window || m.context_length || 0) < MIN_DISCOVERY_CONTEXT_TOKENS) return null;
      return id;
    },
  },
  {
    name: 'Cerebras',
    prefix: 'cerebras/',
    getKey: getCerebrasApiKey,
    url: 'https://api.cerebras.ai/v1/models',
    markStale: true,
    pick(m) {
      const id = m?.id;
      if (!id || NON_CHAT_MODEL_RE.test(id)) return null;
      return id;
    },
  },
  {
    name: 'Mistral',
    prefix: 'mistral/',
    getKey: getMistralApiKey,
    url: 'https://api.mistral.ai/v1/models',
    markStale: true,
    pick(m) {
      const id = m?.id;
      if (!id || NON_CHAT_MODEL_RE.test(id)) return null;
      // Mistral "Labs" models (e.g. labs-leanstral-2603) are gated: calling them
      // returns HTTP 403 "Labs model. To use Labs models, an admin must enable
      // them in your organization settings" (runs 27949428878 / 27957791379).
      // Not entitled on this account → deny so discovery stops re-injecting them.
      if (/(?:^|\/)labs-/i.test(id)) return null;
      // Mistral exposes per-model capabilities; require chat completion when present.
      if (m.capabilities && m.capabilities.completion_chat === false) return null;
      if ((m.max_context_length || m.context_length || 0) < MIN_DISCOVERY_CONTEXT_TOKENS) return null;
      return id;
    },
  },

  // ── Broad multi-tenant providers (OpenAI-compatible /v1/models) ──
  // Their catalogs mix free + paid and don't flag free-ness, so: markStale OFF
  // (a missing id ≠ "decommissioned free model"; the runtime 402/404 handler
  // skips anything unusable) and a maxAdd cap so one provider can't flood the
  // chain. Key-gated, so absent keys make each a no-op. Shapes verified live by
  // smoke-test-ai-models.yml after merge.
  {
    name: 'NVIDIA',
    prefix: 'nvidia/',
    getKey: getNvidiaApiKey,
    url: 'https://integrate.api.nvidia.com/v1/models',
    markStale: false,
    maxAdd: 40,
    // Gated to a positive allowlist of currently-served general-chat instruct
    // families — see NVIDIA_ALLOW_FAMILY_RE above for the full rationale (#1335 /
    // #1357 dead-404 flood). NON_CHAT_MODEL_RE alone can't catch these legacy ids.
    pick(m) {
      const id = m?.id;
      if (!id || NON_CHAT_MODEL_RE.test(id)) return null;
      if (NVIDIA_SPECIALISED_RE.test(id)) return null;
      if (NVIDIA_DEAD_RE.test(id)) return null;
      if (!NVIDIA_ALLOW_FAMILY_RE.test(id)) return null;
      // Context floor. Every other provider in this list has always had one;
      // NVIDIA was the single discovery channel with NO context check at all,
      // and with maxAdd: 40 it is also the widest. That is how
      // nvidia/nemotron-3-ultra-550b-a55b — matched by NVIDIA_ALLOW_FAMILY_RE's
      // "nemotron" alternation, never smoke-tested — reached the chain and
      // became the writer by omission in run 31402084443, returning 1448
      // characters against a 2500-character minimum.
      //
      // Deliberately PRESENT-ONLY, unlike the strict `(m.context_length || 0) <`
      // form the providers above use. Measured against the live endpoint on
      // 2026-08-10: integrate.api.nvidia.com/v1/models returns 101 entries whose
      // key union is exactly {id, object, created, owned_by} — not one context
      // field anywhere (the fixture in
      // tests/scripts/ai-models-nvidia-discovery-allowlist.test.ts mirrors that
      // shape). A strict filter would therefore reject the ENTIRE catalog and
      // silently delete NVIDIA from the chain — trading one bug for a worse one.
      //
      // So today this line is a forward guard, not the operative fix: it starts
      // filtering the day NVIDIA publishes a size, and until then every
      // allowlisted id is caught one layer later instead, by
      // DEFAULT_REQUEST_TOKENS_BY_PROVIDER[PROVIDER.NVIDIA] at pre-flight —
      // which is the half that actually closes the hole now.
      const ctx = m?.context_length ?? m?.max_model_len ?? m?.context_window;
      if (typeof ctx === 'number' && ctx < MIN_DISCOVERY_CONTEXT_TOKENS) return null;
      return id;
    },
  },
  {
    name: 'SambaNova',
    prefix: 'sn/',
    getKey: getSambaNovaApiKey,
    url: 'https://api.sambanova.ai/v1/models',
    markStale: false,
    maxAdd: 25,
    pick(m) {
      const id = m?.id;
      if (!id || NON_CHAT_MODEL_RE.test(id)) return null;
      if ((m.context_length || 0) < MIN_DISCOVERY_CONTEXT_TOKENS) return null;
      return id;
    },
  },
  {
    name: 'Together',
    prefix: 'together/',
    getKey: getTogetherApiKey,
    url: 'https://api.together.xyz/v1/models',
    markStale: false,
    maxAdd: 40,
    pick(m) {
      const id = m?.id;
      if (!id || NON_CHAT_MODEL_RE.test(id)) return null;
      // Together tags each model with a type; keep only text-generation ones.
      if (m.type && !['chat', 'language', 'code'].includes(m.type)) return null;
      if ((m.context_length || 0) < MIN_DISCOVERY_CONTEXT_TOKENS) return null;
      return id;
    },
  },
  {
    name: 'Fireworks',
    prefix: 'fireworks/',
    getKey: getFireworksApiKey,
    url: 'https://api.fireworks.ai/inference/v1/models',
    markStale: false,
    maxAdd: 40,
    pick(m) {
      const id = m?.id;
      if (!id || NON_CHAT_MODEL_RE.test(id)) return null;
      if ((m.context_length || 0) < MIN_DISCOVERY_CONTEXT_TOKENS) return null;
      return id;
    },
  },
  {
    name: 'Cohere',
    prefix: 'cohere/',
    getKey: getCohereApiKey,
    // Cohere's native listing (distinct from the OpenAI-compat chat endpoint)
    // returns { models: [{ name, endpoints, context_length }] }.
    url: 'https://api.cohere.com/v1/models',
    markStale: false,
    maxAdd: 15,
    getList: (data) => (Array.isArray(data?.models) ? data.models : []),
    pick(m) {
      const id = m?.name;
      if (!id || NON_CHAT_MODEL_RE.test(id)) return null;
      // Keep only models that expose the chat endpoint.
      const eps = m.endpoints;
      if (Array.isArray(eps) && eps.length && !eps.includes('chat')) return null;
      return id;
    },
  },

  // HuggingFace deliberately NOT auto-discovered: router.huggingface.co/v1/models
  // is an unbounded multi-tenant catalog (thousands of models, most requiring
  // credits) with no free-tier flag — discovery would flood the chain with
  // unusable ids. HF stays statically curated in AI_MODELS/DEFAULT_CHAIN.
]);

let _discoveryDone = false;
const _dynamicModels = [];
// modelId → provider name, for ids pruned from DEFAULT_CHAIN because the provider stopped
// offering them (see the markStale block in _discoverProvider). Diagnostics + re-entry
// audit only: nothing reads it to make a routing decision, and it is per-process.
const _prunedStale = new Map();

/** Ids pruned from the roster this process because their provider decommissioned them. */
export function prunedStaleModels() {
  return [..._prunedStale.keys()];
}

/**
 * Build the set of bare model ids a provider currently offers from its live
 * listing. The canonical id comes from `cfg.pick(m)`; in addition, when a model
 * passes the filter we also register any aliases the provider attaches to it.
 *
 * Why aliases matter for markStale (issue #892): Mistral's `/v1/models` exposes
 * `-latest` tags (e.g. `codestral-latest`, `ministral-8b-latest`,
 * `mistral-medium-latest`) as entries in an `aliases[]` array on a versioned
 * model (e.g. `{ id: 'mistral-small-2506', aliases: ['codestral-latest'] }`),
 * not as top-level `m.id`. Our static chain stores those `-latest` ids
 * verbatim. If only `m.id` were collected, the `-latest` chain entries would be
 * absent from offeredIds and the markStale loop would pre-exhaust them for the
 * whole UTC day even though they are live — shortening the chain and degrading
 * generation availability. Collecting aliases keeps the match robust.
 *
 * Groq/Cerebras echo their ids verbatim as `m.id` (no alias layer), so for those
 * the alias pass is a harmless no-op (`m.aliases` undefined).
 *
 * Aliases are only registered for models that already pass `cfg.pick` — an alias
 * never resurrects a model the filter rejected (non-chat, too small, inactive).
 * Exported for unit testing the id-match cases.
 */
export function collectOfferedIds(cfg, list) {
  const offeredIds = new Set();
  for (const m of list) {
    const id = cfg.pick(m);
    if (!id) continue;
    offeredIds.add(id);
    // Register aliases (Mistral `-latest` tags) so a live model surfaced only
    // via aliases[] isn't treated as decommissioned by the markStale loop.
    const aliases = m?.aliases;
    if (Array.isArray(aliases)) {
      for (const alias of aliases) {
        if (typeof alias === 'string' && alias) offeredIds.add(alias);
      }
    }
  }
  return offeredIds;
}

/**
 * Discover usable models for a single provider config and merge them into
 * DEFAULT_CHAIN. Returns { added, stale }. Throws on network/API error so the
 * caller can isolate and log per-provider.
 *
 * Exported for unit tests that pin the discovery safety-nets (issue #893):
 * listing shape auto-detect, the `maxAdd` cap, and the `offeredIds.size > 0`
 * markStale guard. Production callers go through `discoverFreeModels`.
 */
export async function _discoverProvider(cfg) {
  const apiKey = cfg.getKey();
  if (!apiKey) return { added: 0, stale: 0 };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  let res;
  try {
    res = await fetch(cfg.url, {
      headers: { Authorization: `Bearer ${apiKey}`, ...(cfg.extraHeaders || {}) },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    console.warn(`⚠️  [Discovery:${cfg.name}] API returned ${res.status} — using static list`);
    return { added: 0, stale: 0 };
  }

  const data = await res.json();
  // Provider listings come in three shapes: OpenAI-compatible `{data:[…]}`
  // (most), a bare top-level array (Together), or `{models:[…]}` (Cohere
  // native). A cfg.getList() override wins; otherwise auto-detect.
  const list = cfg.getList
    ? (cfg.getList(data) || [])
    : (Array.isArray(data) ? data
      : Array.isArray(data?.data) ? data.data
      : Array.isArray(data?.models) ? data.models
      : []);

  // Bare IDs the provider currently offers that pass the chat/size filter,
  // including any `-latest`-style aliases the listing attaches to a versioned
  // entry (Mistral). Without this, a usable model exposed only via `aliases[]`
  // (e.g. `codestral-latest` on `id: mistral-small-2506`) is absent from
  // offeredIds and wrongly pre-exhausted by the markStale loop below.
  const offeredIds = collectOfferedIds(cfg, list);

  // Existing chain entries for this provider (prefix stripped to bare id).
  const prefixLen = cfg.prefix.length;
  const existingIds = new Set(
    DEFAULT_CHAIN
      .filter(m => m.startsWith(cfg.prefix))
      .map(m => m.slice(prefixLen)),
  );

  // Cap how many new models a single provider can inject per run. Bounded,
  // curated-free catalogs (OR/Groq/Cerebras/Mistral) leave this unset; the
  // broad multi-tenant routers (NVIDIA, etc.) set it so one provider can't
  // flood the chain with hundreds of fallbacks and slow every crawl.
  let added = 0;
  for (const id of offeredIds) {
    if (existingIds.has(id)) continue;
    if (cfg.maxAdd && added >= cfg.maxAdd) {
      console.error(`🔍 [Discovery:${cfg.name}] hit maxAdd cap (${cfg.maxAdd}) — remaining discovered models skipped`);
      break;
    }
    const fullId = `${cfg.prefix}${id}`;
    _dynamicModels.push(fullId);
    DEFAULT_CHAIN.push(fullId);
    added++;
  }

  // Pre-exhaust AND PRUNE chain models the provider no longer offers (markStale
  // providers): a static id absent from the live listing is decommissioned, so it must
  // not cost a fallback attempt. GUARD: only when the listing returned at least one
  // usable model — a 200 with an empty/garbage body is an API glitch, not "every model
  // vanished", and must not nuke the whole provider.
  //
  // Marking alone was not enough (2026-08-13). `markModelExhausted(model, 'stale')` only
  // sets the in-run skip: `_exhaustReason` distinguishes it from `'quota'`, and only
  // `'quota'` persists an `exhaustedUntil` to midnight UTC (see the guard in
  // markModelExhausted / initScoreStore). That asymmetry is correct — a decommissioned id
  // has nothing to do with a daily budget — but it left the dead ids IN the roster, so
  // every run re-walked them, re-marked them, and any code path that reads the chain
  // before discovery finishes tried them for real. Measured per run: `stale` 22-44,
  // `quota` 0 — i.e. the whole exhaustion volume of a run was decommissioned ids being
  // rediscovered, over and over.
  //
  // RE-ENTRY POLICY, by evidence and never by timer: pruning is in-memory and
  // process-scoped (DEFAULT_CHAIN is rebuilt from the static list by every new process),
  // so a listing glitch can cost at most the current run — nothing is persisted, no id is
  // ever deleted from `AI_MODELS`. A pruned id returns the moment the provider offers it
  // again: it is then absent from `existingIds` above, so the add loop re-injects it on
  // the next discovery. `markModelExhausted` is kept alongside the prune so anything
  // holding a pre-prune copy of the chain (callLLM snapshots it with `[...DEFAULT_CHAIN]`)
  // still skips the id for this run instead of paying its 404.
  let stale = 0;
  if (cfg.markStale && offeredIds.size > 0) {
    const staleIds = DEFAULT_CHAIN.filter(
      (m) => m.startsWith(cfg.prefix) && !offeredIds.has(m.slice(prefixLen)),
    );
    for (const model of staleIds) {
      markModelExhausted(model, 'stale');
      _prunedStale.set(model, cfg.name);
      stale++;
    }
    if (staleIds.length) {
      // Splice in place: DEFAULT_CHAIN is an exported live array (callers snapshot it),
      // so reassigning it would silently orphan every importer.
      const drop = new Set(staleIds);
      for (let i = DEFAULT_CHAIN.length - 1; i >= 0; i--) {
        if (drop.has(DEFAULT_CHAIN[i])) DEFAULT_CHAIN.splice(i, 1);
      }
      for (let i = _dynamicModels.length - 1; i >= 0; i--) {
        if (drop.has(_dynamicModels[i])) _dynamicModels.splice(i, 1);
      }
    }
  }

  if (added > 0 || stale > 0) {
    // stderr, not stdout: smoke-test-ai-models.mjs redirects this module's stdout
    // into a JSON file, so a stray stdout line here corrupts that payload.
    console.error(`🔍 [Discovery:${cfg.name}] ${offeredIds.size} usable models, ${added} new added to chain, ${stale} stale pruned from the chain (re-added automatically if the provider offers them again)`);
  }
  return { added, stale };
}

/**
 * Run dynamic discovery across all configured providers in parallel.
 * Idempotent for the process lifetime; never throws.
 */
export async function discoverFreeModels() {
  if (_discoveryDone) return _dynamicModels;
  _discoveryDone = true;

  await Promise.all(DISCOVERY_PROVIDERS.map(async (cfg) => {
    try {
      await _discoverProvider(cfg);
    } catch (e) {
      const msg = e?.name === 'AbortError' ? 'timeout' : (e?.message || String(e));
      console.warn(`⚠️  [Discovery:${cfg.name}] Failed (${msg}) — using static list`);
    }
  }));

  return _dynamicModels;
}

/**
 * Backward-compatible alias. Older call sites referenced the OpenRouter-only
 * discovery; it now triggers the full multi-provider sweep (still idempotent).
 */
export async function discoverOpenRouterFreeModels() {
  return discoverFreeModels();
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
    // Atomic counter increments (see _pendingCounterDeltas). Captured here and
    // not re-imported at write time because this is the only place that already
    // holds the admin module. There is no REST fallback to worry about: unlike
    // load-rc-env.mjs, this store has NO REST path — when `import('firebase-admin')`
    // fails the catch below sets `_firestoreDb = null` and the run is memory-only,
    // so `FieldValue` is available on exactly the paths that persist at all.
    _firestoreFieldValue = admin.firestore?.FieldValue || null;

    // Load all persisted scores from the single aggregate doc (1 read).
    // If the aggregate doesn't exist yet, fall back to the legacy per-model
    // collection so the very first run after this refactor migrates state
    // forward — the next flush() rewrites everything into the aggregate doc.
    const now = new Date();
    let loaded = 0;
    let decayed = 0;
    let exhaustedRestored = 0;
    let learnedLimitsRestored = 0;
    let schemaIncompatibleRestored = 0;
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

      // Local CPU fallback has no daily-quota concept (unlike a remote API
      // account) — a stale content/timeout failure from hours ago says
      // nothing about whether the local server will fail again right now.
      // Skip restoring any persisted ban for it so it's always eligible as
      // last resort every run. See markModelExhausted / _persistScoresToFirestore.
      if (data.exhaustedUntil && !_isLastResortProvider(modelId)) {
        const resetTime = data.exhaustedUntil.toDate
          ? data.exhaustedUntil.toDate()   // Firestore Timestamp
          : new Date(data.exhaustedUntil); // ISO string fallback
        if (resetTime > now) {
          _exhaustedModels.add(modelId);
          // Persisted exhaustedUntil is the daily-limit (quota) path → eligible
          // for the GitHub multi-PAT skip-exemption.
          _exhaustReason.set(modelId, 'quota');
          exhaustedRestored++;
          console.warn(`🚫 [ScoreStore] ${modelId} still exhausted until ${resetTime.toISOString().slice(0, 16)}`);
        }
      }

      // Runtime-learned request-token ceiling (see _learnRequestTokenLimit) —
      // unlike exhaustedUntil this isn't a daily quota, it's a static size
      // limit, so it restores unconditionally for every provider including
      // local/fallback.
      if (typeof data.maxRequestTokens === 'number' && data.maxRequestTokens > 0) {
        _learnedRequestTokenLimits.set(modelId, data.maxRequestTokens);
        learnedLimitsRestored++;
      }

      // Runtime-learned schema-mode incompatibility (see _learnSchemaIncompatible)
      // — same unconditional-restore reasoning as maxRequestTokens above.
      if (data.schemaIncompatible === true) {
        _learnedSchemaIncompatible.add(modelId);
        schemaIncompatibleRestored++;
      }
    }

    console.log(`☁️  [ScoreStore] Loaded ${loaded} model scores from Firestore [${source}] (${decayed} decayed, ${exhaustedRestored} still exhausted, ${learnedLimitsRestored} learned token limits, ${schemaIncompatibleRestored} schema-incompatible)`);

    // Register exit hooks for final flush
    _registerExitHooks();

  } catch (err) {
    console.warn(`⚠️  [ScoreStore] Firestore unavailable — using in-memory scores only: ${err?.message || err}`);
    _firestoreDb = null;
  }

  // Discover new free models across all providers (each isolated; logs its own errors)
  try {
    await discoverFreeModels();
  } catch {
    // Already logged inside discoverFreeModels
  }
}

/**
 * Test seam: install a stand-in Firestore client without going through
 * `initScoreStore()`.
 *
 * It exists because the store has exactly one door and it is nailed shut for a
 * test: `initScoreStore()` imports firebase-admin and, when that import or the
 * credential is missing, sets `_firestoreDb = null` and returns — so a test
 * process silently exercises the memory-only path and every assertion about
 * persistence passes vacuously. That is the shape of bug this module just had
 * (a write that never happened, with nothing red), so the coverage has to reach
 * the real write path, not a mock of it.
 *
 * Deliberately does NOT call `_registerExitHooks()`: a test must not leave
 * signal handlers behind. Pair it with `resetState()`.
 *
 * @param {any} db          object with .collection(name).doc(id).set(data, opts)
 * @param {any} [fieldValue] object with .increment(n); null exercises the
 *                           absolute-write degraded path on purpose
 */
export function __installScoreStoreForTests(db, fieldValue = null) {
  _firestoreDb = db;
  _firestoreFieldValue = fieldValue;
  _storeInitialized = true;
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
  // Snapshot the counter deltas alongside the dirty set: both are cleared here
  // and both are restored together if the write fails, so a retry cannot double
  // count and a failed write cannot silently swallow a success.
  /** @type {Map<string, {successes: number, failures: number}>} */
  const deltaSnapshot = new Map();
  for (const modelId of toPersist) {
    const d = _pendingCounterDeltas.get(modelId);
    if (d && (d.successes || d.failures)) deltaSnapshot.set(modelId, { ...d });
    _pendingCounterDeltas.delete(modelId);
  }

  /** @type {Record<string, any>} */
  const modelsDelta = {};
  for (const modelId of toPersist) {
    const details = _modelDetails.get(modelId) || { successes: 0, failures: 0 };
    const score = _modelScores.get(modelId) || 0;

    const entry = {
      modelId,                 // Original model ID (with slashes)
      score,
      lastUsed: now,
      updatedAt: now,
    };

    // successes/failures go out as an ATOMIC INCREMENT of this process's delta,
    // never as the absolute total (see _pendingCounterDeltas for the measured
    // lost update this replaces). A model can be dirty for a reason that is not
    // an outcome — a learned token limit, a schema incompatibility — and then it
    // has no delta: the counter fields are OMITTED rather than written as 0,
    // because restating a stale absolute is exactly the defect being removed.
    const counterDelta = deltaSnapshot.get(modelId);
    if (counterDelta) {
      if (_firestoreFieldValue && typeof _firestoreFieldValue.increment === 'function') {
        if (counterDelta.successes) entry.successes = _firestoreFieldValue.increment(counterDelta.successes);
        if (counterDelta.failures) entry.failures = _firestoreFieldValue.increment(counterDelta.failures);
      } else {
        // Unreachable on the firebase-admin path (initScoreStore captures
        // FieldValue from the same module that produced the client, and there is
        // no REST path for this store). Kept so a future client without the
        // sentinel degrades to the old absolute write instead of dropping the
        // outcome on the floor.
        entry.successes = details.successes;
        entry.failures = details.failures;
      }
    }

    // If model is exhausted, persist the reset time (next midnight UTC) —
    // but ONLY for 'quota' exhaustion, which is the one reason that
    // genuinely lasts until the provider's daily reset. The other breaker
    // reasons (timeout / content / nonretryable) describe a single call's
    // outcome in THIS process: a 20-min article generation that timed out,
    // or two malformed-JSON replies to one big schema prompt, say nothing
    // about the model serving a different workflow's small prompt right
    // now. Persisting those used to ban the model for EVERY workflow until
    // midnight UTC via the shared aggregate doc, silently shrinking the
    // free-tier pool on thin evidence — a driver of the recurring
    // "tutti i modelli esauriti" deferrals that zero article production.
    // In-process the ban still holds for the rest of the run (that's the
    // circuit-breaker working); it just doesn't outlive the process.
    // Local CPU fallback is exempt from persistence entirely: it has no
    // daily-quota concept — see the matching restore-path guard above
    // (initScoreStore), which likewise assumes persisted = quota.
    if (
      _exhaustedModels.has(modelId) &&
      !_isLastResortProvider(modelId) &&
      _exhaustReason.get(modelId) === 'quota'
    ) {
      const tomorrow = new Date();
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      tomorrow.setUTCHours(0, 0, 0, 0);
      entry.exhaustedUntil = tomorrow.toISOString();
    } else {
      entry.exhaustedUntil = null;
    }

    // Runtime-learned request-token ceiling (see _learnRequestTokenLimit).
    // Not a daily quota — no local/fallback exemption needed.
    if (_learnedRequestTokenLimits.has(modelId)) {
      entry.maxRequestTokens = _learnedRequestTokenLimits.get(modelId);
    }

    // Runtime-learned schema-mode incompatibility (see _learnSchemaIncompatible).
    if (_learnedSchemaIncompatible.has(modelId)) {
      entry.schemaIncompatible = true;
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
    // Re-add dirty models so next flush retries them — and give them back their
    // counter deltas, merged onto whatever accumulated while this write was in
    // flight. Without this half the retry would rewrite score and lastUsed while
    // the outcomes it was carrying vanished with the rejected promise.
    for (const m of toPersist) _dirtyModels.add(m);
    for (const [m, d] of deltaSnapshot) {
      const cur = _pendingCounterDeltas.get(m) || { successes: 0, failures: 0 };
      cur.successes += d.successes;
      cur.failures += d.failures;
      _pendingCounterDeltas.set(m, cur);
    }
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

/** How long an exit is allowed to wait for the final ledger write. */
const EXIT_FLUSH_TIMEOUT_MS = 8_000;

/**
 * Flush before leaving the process — the ONE call every exit path goes through.
 *
 * `flushScores()` on its own is the right primitive but the wrong contract for
 * an exit: it can reject (network), and it can hang as long as the Firestore
 * client wants to retry. Either would turn "persist my scores" into "fail or
 * stall the run", which is why the previous exit handlers fired the persist and
 * did NOT await it. Firing without awaiting is not a compromise, though — it is
 * a guaranteed loss, because `_persistScoresToFirestore()` clears `_dirtyModels`
 * before it awaits `ref.set()`: the process leaves with the mutations already
 * marked clean and never written.
 *
 * So: await it, bounded and non-throwing. A timeout logs and gives up rather
 * than holding the runner. Returns true when the write landed, so a caller (and
 * a test) can tell "flushed" from "gave up".
 */
export async function flushScoresBeforeExit(timeoutMs = EXIT_FLUSH_TIMEOUT_MS) {
  if (!_firestoreDb || (_dirtyModels.size === 0 && !_persistTimer)) return true;
  let timer = null;
  const pending = _dirtyModels.size;
  try {
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
      // NOT unref'd: this promise races a write we are deliberately waiting for.
    });
    const outcome = await Promise.race([flushScores().then(() => 'flushed'), timeout]);
    if (outcome === 'timeout') {
      console.warn(`⚠️  [ScoreStore] Final flush timed out after ${timeoutMs}ms — ${pending} model(s) not persisted`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`⚠️  [ScoreStore] Final flush failed: ${err?.message || err}`);
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Register process exit hooks for final flush */
function _registerExitHooks() {
  if (_exitHooked) return;
  _exitHooked = true;

  process.on('beforeExit', async () => { await flushScoresBeforeExit(); });
  // Signal handlers await the same bounded flush before exiting. The old pair
  // called the persist and then `process.exit()` on the very next statement,
  // which cannot ever complete a write — the comment claimed it gave the persist
  // "a moment" and there was no moment. Note this is the LATENT half of the
  // loss, not the dominant one: on the corpus the hard kill of
  // generate-article.yml is SIGKILL, measured 42 times out of 42 with zero
  // SIGTERM, and SIGKILL runs no handler at all. What this fixes is the
  // cooperative stop (a cancelled workflow, a local Ctrl-C).
  process.on('SIGINT', async () => { await flushScoresBeforeExit(); process.exit(130); });
  process.on('SIGTERM', async () => { await flushScoresBeforeExit(); process.exit(143); });
}

// ── Score mutation (with Firestore persistence) ──────────────

/** Record a model success — boosts its rank and persists to Firestore */
export function recordModelSuccess(modelId) {
  _modelScores.set(modelId, (_modelScores.get(modelId) || 0) + SCORE_SUCCESS);
  const d = _modelDetails.get(modelId) || { successes: 0, failures: 0 };
  d.successes++;
  _modelDetails.set(modelId, d);
  _bumpOutcome(modelId, 'successes');
  _dirtyModels.add(modelId);
  _schedulePersist();
}

/**
 * Record one outcome in both the not-yet-persisted delta and the run tally.
 * Two maps and not one because they are cleared by different events: the delta
 * empties on every successful write, the run tally never does (printRunSummary
 * reads it at the very end).
 */
function _bumpOutcome(modelId, field) {
  const pending = _pendingCounterDeltas.get(modelId) || { successes: 0, failures: 0 };
  pending[field]++;
  _pendingCounterDeltas.set(modelId, pending);
  const run = _runOutcomes.get(modelId) || { successes: 0, failures: 0 };
  run[field]++;
  _runOutcomes.set(modelId, run);
}

/**
 * Clear downstream content-quality failures after a caller has parsed and
 * validated the HTTP-200 payload. Plain transport success is not enough: weak
 * models can return malformed JSON forever unless validation owns this reset.
 */
export function recordModelContentSuccess(modelId) {
  if (!modelId) return;
  _consecutiveContentFailures.delete(modelId);
}

/**
 * Penalize a model whose API call succeeded (HTTP 200) but whose payload was
 * rejected by downstream validation (JSON parse error, schema mismatch, missing
 * required fields). Applies the standard retryable-failure score penalty and,
 * after `MAX_CONSECUTIVE_CONTENT_FAILURES` consecutive content failures for the
 * same model, marks it exhausted for the rest of this process so subsequent
 * callLLM invocations skip it and try the next-best model in the chain.
 *
 * Local CPU fallback is exempt from the ban itself (still penalized via
 * recordModelFailure, just never hard-excluded) — same rationale as its
 * Firestore-persistence exemption above (initScoreStore /
 * _persistScoresToFirestore): it has no external quota, so when the remote
 * chain is ALSO exhausted it's the only resource left this run. Banning it
 * after 2 failures doesn't save anything (there's nothing else to fall back
 * to) — it just guarantees the run produces zero output for its remaining
 * wall-clock budget instead of getting more real attempts at the only model
 * still willing to answer. See run 28737038015: local/fallback banned at
 * ~22min into a 30min budget, wasting the remaining ~8min on 5 further
 * outer-retries + additional ranker candidates that were 100% certain to
 * fail (every model already exhausted). deadlineMs (RUN_WALL_BUDGET_MS)
 * already bounds total retry time, so removing the ban here doesn't risk an
 * unbounded loop.
 */
export function recordModelContentFailure(modelId) {
  if (!modelId) return;
  recordModelFailure(modelId);
  const count = (_consecutiveContentFailures.get(modelId) || 0) + 1;
  _consecutiveContentFailures.set(modelId, count);
  if (_isLastResortProvider(modelId)) return;
  if (count >= MAX_CONSECUTIVE_CONTENT_FAILURES) {
    markModelExhausted(modelId, 'content');
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
  _bumpOutcome(modelId, 'failures');
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
// Identity of a model's last-resort tier — order-independent: which bucket
// (local/omniroute/claude-cli) a model belongs to never changes, regardless
// of AI_LAST_RESORT_ORDER below. Reuses LAST_RESORT_TIER_PREFIXES (declared
// near _freshLastResortStats above) instead of re-testing the 3 prefixes here
// a 3rd time (AGENTS.md #6). Returns null for a normal (non-last-resort) model.
function _lastResortTierName(model) {
  for (const [name, prefix] of Object.entries(LAST_RESORT_TIER_PREFIXES)) {
    if (model.startsWith(prefix)) return name;
  }
  return null;
}

// Default priority order for the 3 last-resort tiers (changed 2026-07-28,
// was local-first). Run 30286278791 (omniroute-poc.yml) proved OmniRoute
// reaches a frontier-class model over the network in seconds ("POC OK —
// model used: deepseek-ai/DeepSeek-V3.2", 2020 prompt tokens, real response),
// while run 28802314827 showed LOCAL_FALLBACK's Ollama qwen2.5:14b CPU
// inference on the CI runner costs ~12-17min PER generation — network beats
// CPU wall-clock when both are reachable. claude-cli stays last: it's the
// only subscription-gated tier and has 0 successes across ~20 attempts.
const DEFAULT_LAST_RESORT_ORDER = ['omniroute', 'local', 'claude-cli'];

// Set once a malformed AI_LAST_RESORT_ORDER has been warned about, so the
// warning prints once per process rather than on every callLLM() — this path
// runs unattended every 30min in prod; a noisy repeat warning is as useless
// as a silent one. Reset by resetState() for test isolation.
let _lastResortOrderWarned = false;

/**
 * AI_LAST_RESORT_ORDER — CSV kill-switch overriding the default priority
 * order of the 3 last-resort tiers above, for an instant rollback without a
 * code change/redeploy. Example: "local,omniroute,claude-cli" reproduces the
 * pre-2026-07-28 order exactly (local first, like it always was before
 * OmniRoute got promoted). Unset/empty → DEFAULT_LAST_RESORT_ORDER above.
 * Malformed value (unknown tier name, wrong element count, duplicate entry,
 * garbage string) → falls back to DEFAULT_LAST_RESORT_ORDER and warns ONCE
 * per process (see _lastResortOrderWarned) instead of crashing or silently
 * applying a partial/wrong order.
 */
function _getLastResortOrder() {
  const raw = (process.env.AI_LAST_RESORT_ORDER || '').trim();
  if (!raw) return DEFAULT_LAST_RESORT_ORDER;
  const validNames = Object.keys(LAST_RESORT_TIER_PREFIXES);
  const parsed = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const isValidPermutation = parsed.length === validNames.length
    && new Set(parsed).size === validNames.length
    && parsed.every((n) => validNames.includes(n));
  if (isValidPermutation) return parsed;
  if (!_lastResortOrderWarned) {
    _lastResortOrderWarned = true;
    console.warn(`⚠️ AI_LAST_RESORT_ORDER="${raw}" invalid (expected a permutation of ${validNames.join(',')}) — using default order ${DEFAULT_LAST_RESORT_ORDER.join(',')}.`);
  }
  return DEFAULT_LAST_RESORT_ORDER;
}

// Tiers promoted to tier-0 by default (2026-07-29 — owner decision: OmniRoute
// has ~74 registered providers/~45 unused = real spare capacity, and free-tier
// direct models hit 429/exhaustion often — run 30375068235: 42×429, 3
// cooldowns, 185s pure sleep. Let both compete on real score instead of
// sinking unconditionally). local/ deliberately NOT in this list — CPU
// inference (~12-17min/gen, run 28802314827) must never win a live race
// against a network call regardless of score.
const DEFAULT_COMPETING_TIERS = ['omniroute', 'claude-cli'];

// Set once a malformed AI_COMPETING_TIERS has been warned about — same
// warn-once discipline as _lastResortOrderWarned. Reset by resetState().
let _competingTiersWarned = false;

/**
 * AI_COMPETING_TIERS — CSV of last-resort tier names (LAST_RESORT_TIER_PREFIXES
 * keys) to treat as tier-0 (competing on real score against every normal
 * model) instead of sinking below all of them. Unset → DEFAULT_COMPETING_TIERS
 * above. Explicit empty string ("") → zero competing tiers, i.e. the exact
 * pre-2026-07-29 behavior (all 3 tiers sink, ranked only by
 * _getLastResortOrder()) — this is the instant-rollback lever. Malformed
 * value (unknown tier name, all-empty entries like ",,") → falls back to
 * DEFAULT_COMPETING_TIERS and warns ONCE per process (see
 * _competingTiersWarned), never throws. Tiers NOT listed here keep sinking,
 * ranked relative to each other by _getLastResortOrder() same as before.
 */
function _getCompetingTiers() {
  const raw = process.env.AI_COMPETING_TIERS;
  if (raw === undefined) return DEFAULT_COMPETING_TIERS; // unset → default
  const trimmed = raw.trim();
  if (trimmed === '') return []; // explicit empty → zero competing tiers
  const validNames = Object.keys(LAST_RESORT_TIER_PREFIXES);
  const parsed = [...new Set(trimmed.split(',').map((s) => s.trim()).filter(Boolean))];
  const isValid = parsed.length > 0 && parsed.every((n) => validNames.includes(n));
  if (isValid) return parsed;
  if (!_competingTiersWarned) {
    _competingTiersWarned = true;
    console.warn(`⚠️ AI_COMPETING_TIERS="${raw}" invalid (expected a comma-separated subset of ${validNames.join(',')}) — using default ${DEFAULT_COMPETING_TIERS.join(',')}.`);
  }
  return DEFAULT_COMPETING_TIERS;
}

// Last-resort tiering for sortChainByScore: higher tier always sinks below
// lower tier regardless of score, tier 0 = normal chain model (always ranked
// above all last-resort tiers) OR a tier promoted via AI_COMPETING_TIERS
// (checked first — see its doc comment). Rank among the tiers still sinking
// follows _getLastResortOrder() (default above, or the AI_LAST_RESORT_ORDER
// override) — a model's tier IDENTITY (_lastResortTierName) never changes,
// only its numeric RANK does.
function _lastResortTier(model) {
  const name = _lastResortTierName(model);
  if (!name) return 0;
  if (_getCompetingTiers().includes(name)) return 0; // promoted — competes like a normal model
  return _getLastResortOrder().indexOf(name) + 1; // 1-based; 0 reserved for "not last-resort"
}

// Bump the skip counter + aggregated cause for a last-resort model's bucket.
// No-op for non-last-resort models (normal chain is ~180 models deep; we only
// want tier-level visibility for the 3 opt-in tiers, not every skip ever).
function _recordLastResortSkip(model, cause) {
  const tier = _lastResortTierName(model);
  if (!tier) return;
  const bucket = _stats.lastResort[tier];
  bucket.skipped++;
  bucket.skipReasons[cause] = (bucket.skipReasons[cause] || 0) + 1;
}

// Bump served (success) / failed (attempted, threw) for a last-resort model's
// bucket. No-op for non-last-resort models.
function _recordLastResortOutcome(model, outcome) {
  const tier = _lastResortTierName(model);
  if (tier) _stats.lastResort[tier][outcome]++;
}

function sortChainByScore(chain) {
  // Build index map for tiebreaker (lower index = better in original order)
  const indexMap = new Map(chain.map((m, i) => [m, i]));
  return [...chain].sort((a, b) => {
    const ta = _lastResortTier(a);
    const tb = _lastResortTier(b);
    if (ta !== tb) return ta - tb;
    const sa = _modelScores.get(a) || 0;
    const sb = _modelScores.get(b) || 0;
    if (sb !== sa) return sb - sa; // higher score first
    return (indexMap.get(a) || 0) - (indexMap.get(b) || 0); // tiebreak by original order
  });
}

// ── La preferenza: DOPO il sort, e solo dove qualcuno la chiede ─────────────
//
// Fino al 2026-08-18 il corpus applicava questa preferenza PRIMA di
// sortChainByScore, con `[claude-cli/haiku]` come default. Erano due scelte
// sbagliate insieme, ed e' questa la riconciliazione chiesta dalla issue #402.
//
// PRIMA del sort la preferenza sposta solo il tiebreak d'indice, cioe' conta
// unicamente a parita' di tier e di punteggio. Il punteggio pari non c'e':
//
//   ai_model_scores/_all, letto il 2026-08-18
//     claude-cli/haiku                      35 successi /  41 fallimenti → score   -666
//     nvidia/meta/llama-3.1-8b-instruct 171.181 successi / 3.276 fall.   → score +35.315
//
// Contro un deficit di 35.981 punti il tiebreak d'indice non conta nulla: il
// sort successivo rimanda haiku in coda. Misurato su 6 run su 6 di
// generate-article.yml: «last-resort: omniroute/local/claude-cli not reached
// this run», con il binario `claude 2.1.234` presente sul runner, il token
// presente e zero ENOENT nei log. Raggiungibile e sano, mai chiamato.
//
// Questa e' la preferenza DURA: gira DOPO il sort, quindi vince a prescindere
// dal punteggio. Proprio per questo NON e' mai un default — si attiva solo se
// qualcuno la chiede esplicitamente, in uno dei due modi:
//
//   1. `opts.prefer` su UNA chiamata (create-article.mjs la mette sulla sola
//      generazione del corpo, non su traduzioni/meta/FAQ/classificazione);
//   2. `AI_MODELS_PREFER` impostata a mano da UNO step di workflow — oggi
//      `translate-pending.yml` del sito, che dipende da questa semantica e ha
//      un gate dedicato (`tests/relocalize-traffic-priority.test.ts`).
//
// Il perimetro stretto e' il punto: la quota del piano Max e' CONDIVISA con
// pr-review-loop.yml e issue-fix.yml, e una preferenza dura globale la
// brucerebbe affamando la pipeline dei merge.
//
// Riordina, non tronca: a differenza di AI_MODELS_FORCE_CHAIN (che pinna la
// catena esattamente agli id elencati, buttando ~180 modelli di fallback) e di
// `opts.model` (che fa `chain.slice(idx)`, quindi chiedere l'ultima voce da'
// una catena di un modello solo), qui nulla viene rimosso: se il preferito
// fallisce si cade esattamente sulla catena che si sarebbe usata comunque.
//
// ── E PERCHE' IL DEFAULT E' VUOTO ──────────────────────────────────────────
//
// Il default `[claude-cli/haiku]` non era solo inefficace: era anche attivo
// dove non lo si voleva. Con lo score store irraggiungibile (fallback in
// memoria) TUTTI i punteggi valgono 0, la parita' e' universale, e il tiebreak
// d'indice diventa decisivo — cioe' il default dirottava OGNI chiamata di OGNI
// processo su un modello a pagamento esattamente nel momento in cui il ledger
// non era li' a impedirlo.
//
// Il sito lo aveva gia' scritto come gate: `ai-models-competing-tiers.test.ts`
// pretende che «un tier-0 normale senza punteggio accumulato batta comunque un
// tier appena promosso in parita' a 0». Promuovere un tier toglie la PENALITA'
// di tier, non regala priorita'. Il default violava quella riga, ed e' il
// motivo per cui i due repo non potevano convergere finche' esisteva.
//
// Ora la preferenza e' una sola, esplicita, e vive dove serve: sulla chiamata
// che genera il corpo dell'articolo. `DEFAULT_MODELS_PREFER` resta esportata e
// vuota, come punto unico in cui un default tornerebbe se mai lo si volesse —
// ma chi lo riempie riapre esattamente il buco descritto qui sopra.
export const DEFAULT_MODELS_PREFER = [];

// Set once a prefer list with no usable entries has been warned about — stessa
// disciplina warn-once di _competingTiersWarned. Azzerato da resetState().
let _preferredModelsWarned = false;

/**
 * Normalizza una preferenza per-chiamata: accetta un array di id o una CSV,
 * scarta i vuoti, deduplica preservando l'ordine. Mai lancia — una preferenza
 * malformata degrada a «nessuna preferenza», non a un crash della generazione.
 */
function _normalizePrefer(prefer) {
  if (!prefer) return [];
  const list = Array.isArray(prefer) ? prefer : String(prefer).split(',');
  const out = [];
  for (const item of list) {
    const id = String(item || '').trim();
    if (id && !out.includes(id)) out.push(id);
  }
  if (!out.length && (Array.isArray(prefer) ? prefer.length : String(prefer).trim())) {
    if (!_preferredModelsWarned) {
      _preferredModelsWarned = true;
      console.warn(`⚠️  prefer=${JSON.stringify(prefer)} non ha voci utilizzabili — ignorato.`);
    }
  }
  return out;
}

/**
 * La preferenza in vigore per QUESTA chiamata: `opts.prefer` se c'e',
 * altrimenti l'opt-in esplicito via `AI_MODELS_PREFER`, altrimenti
 * `DEFAULT_MODELS_PREFER` — che e' vuoto, vedi sopra.
 *
 * ── LA LEVA DI ROLLBACK VA LETTA PER PRIMA, O NON E' UNA LEVA ──────────────
 *
 * `AI_MODELS_PREFER=""` (esplicitamente vuota, non «non impostata») spegne OGNI
 * preferenza, compresa quella per-chiamata. Stessa convenzione di
 * AI_COMPETING_TIERS / AI_LAST_RESORT_ORDER, e nessun warning: e' una scelta,
 * non un refuso.
 *
 * L'ordine conta, ed e' stato sbagliato per un giorno. Con il per-call letto
 * per primo la leva copriva solo il ramo env-only — che in produzione non
 * esiste: `create-article.mjs` passa SEMPRE `prefer: PREFERRED_GENERATION_MODELS`
 * su entrambe le chiamate che generano il corpo. Verificato eseguendo il
 * codice: con `AI_MODELS_PREFER=""` nell'ambiente,
 * `applyModelsPrefer(['a','b'], ['claude-cli/haiku'])` tornava
 * `['claude-cli/haiku','a','b']`. Cioe' l'unica leva documentata come «rollback
 * istantaneo» su un modello A PAGAMENTO non fermava il percorso che lo paga.
 *
 * Il costo dell'inversione e' nullo per gli altri chiamanti: `undefined` (il
 * caso normale) non tocca nulla, e un valore non vuoto continua a perdere
 * contro `opts.prefer` — la preferenza per-chiamata resta piu' specifica
 * dell'opt-in di processo. Solo la stringa vuota, che e' un atto deliberato,
 * vince su tutto.
 *
 * NON confondere con `CLAUDE_CLI_MAX_CALLS_PER_RUN`: quella e' un cap, e `0`
 * vale ILLIMITATO (vedi `_getClaudeCliMaxCallsPerRun`). Usarla come interruttore
 * ottiene l'opposto di spegnere.
 */
function _preferFor(optsPrefer) {
  const raw = process.env.AI_MODELS_PREFER;
  if (raw !== undefined && raw.trim() === '') return []; // leva di rollback esplicita
  const perCall = _normalizePrefer(optsPrefer);
  if (perCall.length) return perCall;
  if (raw === undefined) return DEFAULT_MODELS_PREFER;
  return _normalizePrefer(raw);
}

/**
 * Sposta gli id preferiti in TESTA a una catena GIA' ordinata per punteggio,
 * senza rimuovere nulla. Da applicare DOPO sortChainByScore().
 *
 * Un id assente dalla catena viene comunque anteposto — stessa scelta di
 * `opts.model` per un id sconosciuto: preferire un modello che questa catena
 * non elenca e' una preferenza, non un refuso da ignorare in silenzio. (Il
 * corpus lo scartava invece; la scelta del sito vince perche' e' l'unica che
 * garantisce che il preferito venga davvero tentato.)
 *
 * @param {string[]} chain
 * @param {string[]|string} [prefer] preferenza per-chiamata; se omessa vale
 *   l'opt-in via AI_MODELS_PREFER
 * @returns {string[]}
 */
export function applyModelsPrefer(chain, prefer) {
  const preferred = _preferFor(prefer);
  if (!preferred.length) return chain;
  const frontSet = new Set(preferred);
  return [...preferred, ...chain.filter((m) => !frontSet.has(m))];
}

/**
 * Il cap di token di INPUT dichiarato per un modello, o `undefined` se nessuna
 * delle tre fonti ne dichiara uno. Stesso `Math.min` che usa il pre-flight di
 * callLLM (era inline li' dentro): estratto perche' un chiamante deve poter
 * chiedere «questo modello ha un tetto?» PRIMA di costruire il prompt.
 *
 * `undefined` significa «nessun cap dichiarato», non «illimitato»: e' la
 * risposta che serve a create-article.mjs per NON accorciare la fonte quando a
 * servire la chiamata sara' claude-cli/haiku — l'unico membro del roster senza
 * cap di input dichiarato. Se il modello poi rifiuta davvero per dimensione, il
 * rimedio esiste gia' ed e' `err.retryRequestTokenBudget` al throw qui sotto.
 */
export function getDeclaredRequestTokenLimit(model) {
  const apiModelId = getApiModelId(model);
  const knownLimits = [
    MODEL_MAX_REQUEST_TOKENS[apiModelId],
    _learnedRequestTokenLimits.get(model),
    DEFAULT_REQUEST_TOKENS_BY_PROVIDER[getProvider(model)],
  ].filter((v) => typeof v === 'number' && v > 0);
  return knownLimits.length ? Math.min(...knownLimits) : undefined;
}

// ── Public state helpers ─────────────────────────────────────
/**
 * Mark a model as exhausted (daily limit reached).
 * It will be skipped for the remainder of this process
 * and persisted to Firestore so other workflows also skip it.
 */
// `reason` records WHY a model was exhausted so the GitHub multi-PAT exemption
// only resurrects quota/daily-limit exhaustion (account-specific → rotation to a
// fresh PAT can fix it), NOT timeout / content-failure / stale / non-retryable
// exhaustion (account-independent → rotation cannot help, and re-trying would
// neutralise those circuit-breakers). Default 'quota' covers the daily-limit and
// rate-limit paths; the non-quota breakers pass an explicit reason.
export function markModelExhausted(modelId, reason = 'quota', detail = '') {
  _exhaustedModels.add(modelId);
  _exhaustReason.set(modelId, reason);
  if (detail) _exhaustDetail.set(modelId, detail);
  _dirtyModels.add(modelId);
  _schedulePersist();
  console.warn(`🚫 Model ${modelId} marked as exhausted (${reason}) — will be skipped for rest of run`);
}

/**
 * Human-and-classifier readable cause for a model that is being skipped because
 * it is exhausted.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * The skip below used to push one fixed string for every exhausted model:
 *
 *   "skipped — exhausted (daily limit / consecutive 429s / timeout circuit-breaker)"
 *
 * A three-way disjunction, of which two branches are NOT transient. Every model
 * exhausted by a 401 (stale key), a 402 (depleted credits) or a 404 (retired
 * model) — all three classified `nonretryable` right where they are marked, with
 * a comment explaining they must not be labelled quota — reappeared in the
 * aggregate `Errors:` summary claiming a daily limit. `classifyExhaustionCause`
 * then matched it on `daily limit` and counted it TRANSIENT, and
 * `transientExhaustion` decides whether create-article.mjs defers (exit 0,
 * workflow green) or alerts.
 *
 * Measured on run 31823202761: of 104 tallied models, all 54 on the transient
 * side carried this one string, against 49 persistent — so the deferral, and the
 * green run that produced no article, turned on a message that named the wrong
 * cause. The reason was already recorded in `_exhaustReason`; only the message
 * threw it away.
 *
 * The returned phrases are chosen to carry vocabulary `classifyExhaustionCause`
 * already keys on, and the regexes there now name them explicitly rather than
 * matching them by accident.
 */
function _exhaustSkipCause(model) {
  const reason = _exhaustReason.get(model) || 'quota';
  const detail = _exhaustDetail.get(model);
  switch (reason) {
    case 'quota':        return 'daily limit / consecutive 429s';
    case 'timeout':      return 'timeout circuit-breaker';
    // NON "stale credentials": l'unico chiamante che passa 'stale' e'
    // `prunedStaleModels`, e li' significa che il LISTING LIVE del provider non
    // offre piu' quell'id — niente a che vedere con una chiave. Chiamarlo
    // "credenziali" sarebbe una causa inventata, cioe' esattamente il difetto
    // che questa funzione esiste per chiudere. Trovato in review su
    // valerielinc-ops#5903.
    case 'stale':        return 'model no longer offered by provider';
    case 'content':      return 'repeated unusable content';
    case 'nonretryable': return `non-retryable provider error${detail ? ` (${detail})` : ''}`;
    default:             return reason;
  }
}

// Whether the chain runner should SKIP a model because it's exhausted.
// For GitHub models this is NOT just `_exhaustedModels.has(model)`: a persisted
// daily-limit was recorded against ONE GitHub account, but with multiple PATs a
// different account's fresh quota can still serve the model. So while any PAT is
// un-exhausted this run, GitHub models stay eligible — `_callGitHub` rotates to
// the fresh account. Without this, a model marked exhausted by account #1
// earlier today would be skipped on every later run, never reaching rotation.
function _shouldSkipExhausted(model) {
  if (!_exhaustedModels.has(model)) return false;
  // Only QUOTA/daily-limit exhaustion is account-specific and thus fixable by
  // rotating to a fresh PAT. Timeout / content-failure / stale / non-retryable
  // exhaustion would recur on every account, so those keep skipping (otherwise
  // the circuit-breaker is neutralised and full timeouts re-incur per attempt).
  if (getProvider(model) === PROVIDER.GITHUB && _exhaustReason.get(model) === 'quota') {
    const pats = getGhModelsPats();
    if (pats.length > 1 && pats.some((_, i) => !_ghExhaustedPats.has(i))) return false;
  }
  return true;
}

/** Check whether a model is still usable this run */
export function isModelAvailable(modelId) {
  if (_shouldSkipExhausted(modelId)) return false;
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

/**
 * Peek at the model callLLM() would try first right now, given current
 * availability/exhaustion/cooldown state and score ranking — WITHOUT making
 * an API call. Mirrors callLLM()'s non-forced-chain selection (model
 * start-point override + score sort + availability/exhaustion/cooldown
 * filtering); deliberately skips the diagnostic AI_MODELS_FORCE_CHAIN
 * override and the per-request token-limit checks, which don't matter for
 * "which model is currently preferred".
 *
 * Lets a caller build a model-aware persistent cache key WITHOUT spending a
 * call: a lookup keyed on the current preferred model naturally misses once a
 * higher-priority model comes back online, instead of silently reusing a
 * verdict produced by a lower-tier fallback model forever (#3080).
 *
 * @param {{model?: string, chain?: string[], prefer?: string[]|string}} [opts]
 *   `prefer` va passata dallo stesso chiamante che la passera' a callLLM: senza,
 *   la chiave di cache verrebbe costruita sul modello che la catena avrebbe
 *   scelto, non su quello che la preferenza le fa scegliere.
 * @returns {string|null} the model id that would serve the next call, or null
 *   if no configured model is currently available.
 */
export function getPreferredModel({ model: startModel, chain: chainOverride, prefer } = {}) {
  let chain = chainOverride ? [...chainOverride] : [...DEFAULT_CHAIN];
  if (startModel) {
    const idx = chain.indexOf(startModel);
    if (idx > 0) chain = chain.slice(idx);
    else if (idx < 0) chain = [startModel, ...chain.filter((m) => m !== startModel)];
  }
  chain = sortChainByScore(chain);
  // Rispecchia esattamente l'ordine di callLLM: prima il sort, poi la
  // preferenza. Senza questa riga il peek risponderebbe con il modello che la
  // catena avrebbe scelto, non con quello che la preferenza le fa scegliere.
  chain = applyModelsPrefer(chain, prefer);
  for (const m of chain) {
    if (_shouldSkipExhausted(m)) continue;
    if (isProviderCoolingDown(getProvider(m))) continue;
    if (!isModelAvailable(m)) continue;
    return m;
  }
  return null;
}

/** Return usage stats for this run (includes model scoreboard and store status) */
export function getStats() {
  return {
    ..._stats,
    exhaustedModels: [..._exhaustedModels],
    consecutive429s: Object.fromEntries(_consecutive429),  // FRO-325
    activeCooldowns: Object.fromEntries([..._providerCooldown].map(([p, t]) => [p, Math.max(0, Math.ceil((t - Date.now()) / 1000))])),
    scoreBoard: getScoreBoard(),
    runOutcomes: getRunOutcomes(),
    storeBackend: _firestoreDb ? 'firestore' : 'memory',
    dirtyModels: _dirtyModels.size,
  };
}

/**
 * Models this run actually called, with the outcome of each — busiest first.
 *
 * Deliberately NOT `getScoreBoard()`: that one is built from `_modelScores`,
 * which initScoreStore preloads from Firestore (270 entries on 2026-08-18), so
 * it describes the ledger and not the run. This describes the run, which is the
 * question "sta funzionando questo modello?" actually asks.
 */
export function getRunOutcomes() {
  return [..._runOutcomes.entries()]
    .map(([model, o]) => ({ model, successes: o.successes, failures: o.failures }))
    .sort((a, b) => (b.successes + b.failures) - (a.successes + a.failures)
      || b.successes - a.successes
      || a.model.localeCompare(b.model));
}

// Formats one last-resort tier's bucket for printRunSummary()'s compact
// line, e.g. "local 0 served/0 failed/3 skipped(no API key)". Omits the
// "skipped(...)" segment when nothing was skipped — keeps the common
// "reached and worked/failed normally" case from being cluttered. Appends a
// " [competing]" SUFFIX (not a prefix/mid-string insert) when the tier is
// currently promoted via AI_COMPETING_TIERS — a suffix keeps every existing
// `toMatch(/name N served\/M failed/)` test assertion (unanchored substring
// search) intact regardless of promotion state.
function _formatLastResortTier(name, t, isCompeting) {
  const parts = [`${t.served} served`, `${t.failed} failed`];
  if (t.skipped > 0) {
    const reasons = Object.entries(t.skipReasons)
      .sort((a, b) => b[1] - a[1])
      .map(([reason]) => reason)
      .join(', ');
    parts.push(`${t.skipped} skipped(${reasons})`);
  }
  return `${name} ${parts.join('/')}${isCompeting ? ' [competing]' : ''}`;
}

// Max models named on the `models:` line. A run touches a handful (the run
// 32134269129 touched 2); the cap exists so a pathological cascade can't emit a
// 270-entry line into logs that are already large.
const RUN_OUTCOME_LINE_MAX = 24;

/**
 * One compact, grep-able line naming the models this run actually called.
 *
 * Why it exists: until 2026-08-18 a model that succeeded at position 0 of the
 * chain logged NOTHING — `✅ Fallback to X succeeded` only prints when `i > 0` —
 * so "quale modello ha scritto l'articolo" was unanswerable from the run log,
 * and the ledger that should have answered it was wrong (see
 * _pendingCounterDeltas). This line answers it from the log alone.
 *
 * `ok`/`ko` and not ✓/✗ so the line survives `grep` in a terminal that mangles
 * the check marks; the `models:` prefix so it can be pulled out of a 5000-line
 * run with one pattern. The `ledger=` tail is the observer for the loss itself:
 * `pending>0` at summary time means mutations are still unwritten at the moment
 * the run is about to end.
 */
function _formatRunOutcomesLine(s) {
  const outcomes = s.runOutcomes || [];
  const tail = ` [ledger=${s.storeBackend} pending=${s.dirtyModels}]`;
  if (outcomes.length === 0) return `   models: none called this run${tail}`;
  const shown = outcomes.slice(0, RUN_OUTCOME_LINE_MAX)
    .map((o) => `${o.model} ${o.successes}ok/${o.failures}ko`)
    .join(' · ');
  const hidden = outcomes.length - Math.min(outcomes.length, RUN_OUTCOME_LINE_MAX);
  return `   models: ${shown}${hidden > 0 ? ` · +${hidden} more` : ''}${tail}`;
}

/**
 * FRO-325: Print a human-readable end-of-run summary to console.
 * Call this at the end of a crawler run for visibility into AI usage.
 */
export function printRunSummary() {
  const s = getStats();
  const lines = [
    `\n📊 AI Model Run Summary`,
    `   Calls: ${s.calls} | Successes: ${s.successes} | Retries: ${s.retries} | Fallbacks: ${s.fallbacks} | Cache hits: ${s.cacheHits}`,
    `   Exhausted: ${s.exhausted} models [${s.exhaustedModels.join(', ') || 'none'}]`,
    `   Provider cooldowns: ${s.providerCooldowns}`,
  ];
  if (Object.keys(s.consecutive429s).length > 0) {
    lines.push(`   429 streak: ${Object.entries(s.consecutive429s).map(([m, c]) => `${m}=${c}`).join(', ')}`);
  }
  const lr = s.lastResort;
  // Names from LAST_RESORT_TIER_PREFIXES, not a 4th hardcoded copy (AGENTS.md
  // #6). Display order fixed (not driven by AI_LAST_RESORT_ORDER) so the
  // summary line's shape stays grep-able/diffable across runs regardless of
  // which priority order was actually in effect. Line is still labeled
  // "last-resort:" even for tiers currently promoted via AI_COMPETING_TIERS —
  // this is the identity bucket (LAST_RESORT_TIER_PREFIXES), not the current
  // rank; the per-tier " [competing]" suffix (_formatLastResortTier) is what
  // stays truthful about rank across both configurations.
  const lrTiers = Object.keys(LAST_RESORT_TIER_PREFIXES);
  const competing = _getCompetingTiers();
  const lrReached = lrTiers.some((t) => lr[t].served + lr[t].failed + lr[t].skipped > 0);
  lines.push(lrReached
    ? `   last-resort: ${lrTiers.map((t) => _formatLastResortTier(t, lr[t], competing.includes(t))).join(' · ')}`
    : `   last-resort: ${lrTiers.join('/')} not reached this run`);
  lines.push(_formatRunOutcomesLine(s));
  if (s.errors.length > 0) {
    lines.push(`   Errors: ${s.errors.length}`);
  }
  console.log(lines.join('\n'));
}

/** Reset exhausted models and scores (useful for long-running processes or tests) */
export function resetState() {
  _exhaustedModels.clear();
  _ghExhaustedPats.clear();
  _exhaustReason.clear();
  _prunedStale.clear();
  _exhaustedLogged.clear();
  _preflightSkipLogged.clear();
  _providerCooldown.clear();
  _modelScores.clear();
  _modelDetails.clear();
  _dirtyModels.clear();
  _pendingCounterDeltas.clear();
  _runOutcomes.clear();
  _consecutive429.clear();
  _callLatency.clear();
  _clampedTimeouts.clear();
  _consecutiveContentFailures.clear();
  _learnedRequestTokenLimits.clear();
  _learnedSchemaIncompatible.clear();
  _mutationCount = 0;
  if (_persistTimer) { clearTimeout(_persistTimer); _persistTimer = null; }
  _stats.calls = 0;
  _stats.successes = 0;
  _stats.retries = 0;
  _stats.fallbacks = 0;
  _stats.exhausted = 0;
  _stats.cacheHits = 0;
  _stats.errors = [];
  _stats.lastResort = _freshLastResortStats();
  _lastResortOrderWarned = false;
  _competingTiersWarned = false;
  _preferredModelsWarned = false;
  _claudeCliCallsThisRun = 0;
  _claudeCliMaxCallsWarned = false;
  _responseCache.clear();
  _claudeCliBinaryMissing = false;
  _claudeCliConsecutiveTimeouts = 0;
  _claudeCliTimeoutStormDetected = false;
  _omniRouteConsecutiveFailures = 0;
  _omniRouteFailureStormDetected = false;
  _claudeCliInFlight = 0;
  _claudeCliWaiters.length = 0;
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
 * Single source of truth for "the whole free-model pool is TRANSIENTLY
 * unavailable" — every model in the fallback chain failed because of
 * daily-quota / rate-limit / cooldown / timeout exhaustion, NOT a persistent
 * fault and NOT a code/data bug.
 *
 * This is a *transient external capacity* condition: free-tier daily limits
 * reset at 00:00 UTC, so the next scheduled run normally succeeds. Callers use
 * it to defer gracefully (skip this run, retry later) instead of crashing and
 * raising a false-positive "Workflow Failure" Bug issue.
 *
 * IMPORTANT: `callLLM` throws `code = ALL_MODELS_EXHAUSTED` regardless of WHY
 * the chain emptied — a persistent outage (all keys revoked 401, credits gone
 * 402, models removed 404, prompt chronically too large 413, no API keys) also
 * empties it. Deferring on the bare code would silence those real outages
 * forever. So for a structured callLLM error we trust its dominant-cause flag
 * (`transientExhaustion`); only a transient-dominant run defers. Non-callLLM
 * errors (single provider call re-thrown without the code) fall back to the
 * unambiguous quota/rate-limit message substrings.
 */
export function isQuotaExhaustedError(err) {
  if (!err) return false;
  if (err.code === 'ALL_MODELS_EXHAUSTED') return err.transientExhaustion === true;
  const msg = String(err.message || err || '').toLowerCase();
  return (
    msg.includes('daily request limit') ||
    msg.includes('daily limit') ||
    msg.includes('daily quota') ||
    msg.includes('exceeded your current quota') ||
    msg.includes('plan and billing details') ||
    msg.includes('free-models-per-day') ||
    msg.includes('free models per day')
  );
}

/**
 * Detect permanent client errors that should NOT be retried.
 * - unknown_model: model doesn't exist on the provider (mark exhausted)
 * - context length / too many tokens: prompt too large for this model
 * Returns { nonRetryable: boolean, markExhausted: boolean }
 */
export function classifyNonRetryableError(status, bodyText = '') {
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
  //
  // `no longer available` / `no longer supported` are GOOGLE's wording for a
  // retired model — "This model models/gemini-2.0-flash is no longer available.
  // Please update your code to use a newer model". Without them here a retired
  // Gemini model is nonRetryable but NOT exhausted, so it is re-attempted on
  // every pass of every retry instead of being skipped after the first 404.
  //
  // This is the second time. The roster comment on GEMINI_31_FLASH_LITE records
  // the first (2026-05-27, run 26534353239): "The deprecated preview kept winning
  // the fallback selector because 404 didn't mark it exhausted, causing the entire
  // blog-generator workflow to fail with 50+ retries against the dead endpoint."
  // That was fixed by deleting the one model and leaving the matcher alone, so on
  // 2026-08-14 it recurred with three others (gemini-2.0-flash, -flash-lite,
  // gemini-3-pro-preview, 48 futile 404s in run 31823202761). Deleting the models
  // is the symptom; this line is the cause.
  if (status === 404) {
    if (
      b.includes('model_not_found') || b.includes('not_found_error') || b.includes('does not exist')
      || b.includes('no longer available') || b.includes('no longer supported')
    ) {
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
  // Model structurally incompatible with chat-completion turn format (e.g. a
  // moderation/classifier model that slipped past NON_CHAT_MODEL_RE under a
  // name discovery didn't recognize). This is a fixed property of the model,
  // not a per-request fluke — retrying the identical prompt always fails the
  // same way, so mark exhausted immediately rather than re-trying it on every
  // cascade pass for the rest of the run. See run 28611052353.
  if (b.includes('conversation roles must alternate')) {
    return { nonRetryable: true, markExhausted: true };
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
  //
  // 'unsupported parameter' alone (bare, no response_format/schema mention) is
  // the unrelated max_tokens-vs-max_completion_tokens rejection (see
  // MAX_COMPLETION_TOKENS_MODELS) — do NOT tag it schema_unsupported, or
  // _learnSchemaIncompatible would permanently stop offering schema mode to a
  // model whose only real problem is the token-param name.
  const isSchemaFormatRejection =
    b.includes('does not support response format') ||
    (b.includes('response_format') && b.includes('not support')) ||
    b.includes("unknown name 'type' at 'generation_config.response_schema") ||
    b.includes('response_schema.properties');
  if (b.includes('unsupported parameter') || isSchemaFormatRejection) {
    return {
      nonRetryable: true,
      markExhausted: false,
      ...(isSchemaFormatRejection ? { reason: 'schema_unsupported' } : {}),
    };
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
 * Heuristic: estimated_tokens = chars / 3.5 + safety_margin (500).
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
  // NVIDIA small-context models overrun by this codebase's ~8000-token
  // completion budget (run 28732970228, 2026-07-05): both threw HTTP 400
  // "maximum context length is N tokens" against a ~9000-token generation
  // prompt. llama-3.1-nemotron-nano-vl-8b-v1 (context 16384) still has room
  // for a smaller prompt; nemotron-mini-4b-instruct (context 4096) cannot
  // fit any of this codebase's generation prompts regardless of trimming.
  'nvidia/llama-3.1-nemotron-nano-vl-8b-v1': 8000,
  'nvidia/nemotron-mini-4b-instruct':        3000,
};

/**
 * Per-PROVIDER default request-token cap, consulted only when a model has no
 * entry in MODEL_MAX_REQUEST_TOKENS above. MODEL_MAX_REQUEST_TOKENS is a
 * whack-a-mole list grown one incident at a time (each entry added only
 * after that specific model 413'd in production); dozens of models on the
 * same account-wide tier never get added and burn a full 413 round-trip
 * every time the prompt grows past the tier's real ceiling.
 *
 * GitHub Models specifically is verified account-wide, not per-model: runs
 * 28730759322 / 28729689806 (2026-07-05) show Phi-4-mini-reasoning,
 * Meta-Llama-3.1-405B-Instruct, Meta-Llama-3.1-8B-Instruct, Ministral-3B, and
 * Llama-4-Maverick-17B-128E-Instruct-FP8 — five otherwise-unrelated model
 * families — all fail with the byte-identical "Request body too large ...
 * Max size: 8000 tokens" at the same ~9600-token estimate. That is the free
 * tier's request cap, independent of any single model's advertised context
 * window. Applying it as a provider default (instead of waiting to hardcode
 * each new model one incident at a time) lets the pre-flight skip-guard
 * catch the whole family immediately and fall through to a provider that can
 * actually take the payload — most importantly the local fallback, which
 * would otherwise only be reached after burning the entire GitHub Models
 * roster on guaranteed 413s.
 */
const DEFAULT_REQUEST_TOKENS_BY_PROVIDER = {
  [PROVIDER.GITHUB]: MAX_PREFLIGHT_REQUEST_TOKENS,
  // Groq free tier enforces a tokens-per-minute (TPM) cap, not a per-model
  // context limit: run 28732970228 (2026-07-05) shows 4 unrelated Groq
  // models — openai/gpt-oss-120b, qwen/qwen3.6-27b, llama-3.1-8b-instant,
  // openai/gpt-oss-20b — all fail identically with HTTP 413 "Request too
  // large ... on tokens per minute (TPM)" at the same ~8300-token estimate.
  // Same account-wide-cap shape as GitHub Models above.
  [PROVIDER.GROQ]: MAX_PREFLIGHT_REQUEST_TOKENS,
  // NVIDIA. Added because NVIDIA is the one provider whose discovery filter
  // cannot do its job unaided: integrate.api.nvidia.com's /v1/models publishes
  // no context field, so the (present-only) floor in DISCOVERY_PROVIDERS' NVIDIA
  // `pick` sees nothing to filter on and every allowlisted id enters the chain
  // unvalidated. Without an entry here those ids also carry no pre-flight cap,
  // which is the whole "not validated, not accepting" class: they pass the
  // skip-guard and collect the 413 at runtime.
  //
  // 8000 is the evidenced NVIDIA figure, not a guess carried over from the two
  // providers above: MODEL_MAX_REQUEST_TOKENS already pins
  // nvidia/llama-3.1-nemotron-nano-vl-8b-v1 at exactly 8000 after run
  // 28732970228, where NVIDIA models answered HTTP 400 "maximum context length
  // is N tokens" to a ~9000-token generation prompt. The pre-flight takes
  // Math.min across all three sources, so tighter per-model entries (e.g.
  // nvidia/nemotron-mini-4b-instruct at 3000) still win over this default.
  [PROVIDER.NVIDIA]: MAX_PREFLIGHT_REQUEST_TOKENS,
  // Cerebras and Cohere are the same "not validated, not accepting" shape as
  // NVIDIA above: their `pick()` filters in DISCOVERY_PROVIDERS have no
  // context-length check at all (Cerebras' /v1/models entries carry no
  // context field to filter on; Cohere's native listing does expose
  // `context_length`, but `pick` only checks the `chat` endpoint flag, not
  // size), so a discovered id enters DEFAULT_CHAIN with no pre-flight cap and
  // takes its first 413 at runtime instead of being skip-guarded. #5565 closed
  // this hole for NVIDIA with a present-only discovery guard PLUS this
  // provider-wide default; Cerebras/Cohere never got the second half.
  [PROVIDER.CEREBRAS]: MAX_PREFLIGHT_REQUEST_TOKENS,
  [PROVIDER.COHERE]: MAX_PREFLIGHT_REQUEST_TOKENS,
};

/**
 * Runtime-learned per-model request-token ceilings, parsed directly out of a
 * 413/400 error body the first time a model hits one (see
 * _learnRequestTokenLimit below), instead of waiting for a human to notice
 * the pattern in logs and hardcode it into MODEL_MAX_REQUEST_TOKENS /
 * DEFAULT_REQUEST_TOKENS_BY_PROVIDER above. Both of those maps are
 * whack-a-mole: they only cover providers someone already got burned by.
 * This map makes the skip-guard self-correcting for every OTHER provider —
 * Cerebras, Mistral, HuggingFace, Cloudflare, Together, Fireworks,
 * OpenRouter, Gemini, whatever comes next — after its very first failure,
 * in-run immediately and cross-run via the same Firestore aggregate doc
 * already used for scores/exhaustion (see initScoreStore /
 * _persistScoresToFirestore). Keyed by the full chain model id (e.g.
 * 'groq/openai/gpt-oss-120b'), matching _modelScores' keyspace — not by the
 * bare apiModelId, so two providers serving the same bare model id under
 * different tiers don't clobber each other's learned limit.
 */
const _learnedRequestTokenLimits = new Map();

/**
 * Pull a concrete numeric token ceiling out of a 413/400 error body, when the
 * provider states one explicitly. Two known shapes so far:
 *   - Context-length caps (NVIDIA, OpenAI-style):
 *       "maximum context length is 16384 tokens. However, you requested
 *        17397 tokens (9397 in the messages, 8000 in the completion)."
 *     Converted to an input-only ceiling (context − completion) because
 *     estimateRequestTokens() below only estimates input, never completion.
 *   - Request-size / TPM caps (Groq, GitHub Models):
 *       "... Limit 6000, Used 0, Requested 8264 ..." (Groq TPM)
 *       "... Max size: 8000 tokens ..." (GitHub Models)
 *
 * Returns null when the body doesn't match a known shape — the model simply
 * isn't auto-learned this time; static maps / provider defaults still apply.
 */
function _parseRequestTokenLimit(bodyText = '') {
  const b = String(bodyText);

  const ctxMatch = b.match(/maximum context length is (\d+) tokens/i);
  if (ctxMatch) {
    const maxContext = Number(ctxMatch[1]);
    const completionMatch = b.match(/(\d+)\s*in the completion/i);
    const completionTokens = completionMatch ? Number(completionMatch[1]) : 0;
    const inputCeiling = maxContext - completionTokens;
    if (inputCeiling > 0) return inputCeiling;
  }

  const limitMatch = b.match(/\bLimit\s+(\d+)\b/i);
  if (limitMatch) return Number(limitMatch[1]);

  const maxSizeMatch = b.match(/Max size:\s*(\d+)\s*tokens?/i);
  if (maxSizeMatch) return Number(maxSizeMatch[1]);

  return null;
}

/**
 * Cache a freshly-parsed request-token ceiling for `modelForTracking` and
 * mark it dirty for the next Firestore flush (same debounce path as
 * recordModelSuccess/recordModelFailure/markModelExhausted), so future
 * processes start with the limit already known instead of re-discovering it
 * via a wasted 413/400. No-op when the body doesn't match a known shape or
 * the parsed value doesn't change anything already known.
 *
 * This is called for every nonRetryable classification, not just size-related
 * ones (401/402/404 bodies pass through the same call site) — the regexes
 * above are narrow enough that an unrelated error is unlikely to match, but a
 * false-positive match would otherwise persist forever and permanently
 * skip-guard the model out of every future run (the pre-flight guard means it
 * never gets a chance to hit a different, correct error and self-correct).
 * The floor below caps that blast radius: no real provider cap is low enough
 * to reject every prompt this codebase generates (~8-9k tokens), so a parsed
 * value this small is almost certainly a misparse, not a real limit.
 */
function _learnRequestTokenLimit(modelForTracking, bodyText) {
  const limit = _parseRequestTokenLimit(bodyText);
  if (!limit || limit < 500) return;
  if (_learnedRequestTokenLimits.get(modelForTracking) === limit) return;
  _learnedRequestTokenLimits.set(modelForTracking, limit);
  _dirtyModels.add(modelForTracking);
  _schedulePersist();
}

/**
 * Runtime-learned set of models that 400 on strict JSON-schema mode despite
 * being in PROVIDERS_WITH_STRICT_JSON_SCHEMA / the Gemini native path —
 * GitHub Models proxies several sub-model families (Ministral-3B,
 * Codestral-2501, the Phi-4 family) with inconsistent schema support, so a
 * per-provider allowlist alone forces schema mode onto them on every cascade
 * pass, forever, wasting a network round-trip each time
 * (classifyNonRetryableError's 'schema_unsupported' branch). Same
 * self-correcting pattern as _learnedRequestTokenLimits above, keyed the same
 * way (full chain model id, matching _modelScores' keyspace).
 */
const _learnedSchemaIncompatible = new Set();

/**
 * Remember that `modelForTracking` rejected strict JSON-schema mode, so
 * shouldUseSchemaMode() stops requesting it for this model going forward
 * (in-run immediately, cross-run via Firestore). No-op if already known.
 */
function _learnSchemaIncompatible(modelForTracking) {
  if (_learnedSchemaIncompatible.has(modelForTracking)) return;
  _learnedSchemaIncompatible.add(modelForTracking);
  _dirtyModels.add(modelForTracking);
  _schedulePersist();
}

/**
 * Estimate token count for a list of OpenAI-format messages. Uses a chars/3.5
 * ≈ tokens heuristic — accurate enough for "is this prompt going to blow past
 * 4000?" decisions. Adds a 500-token safety margin to account for the
 * response prefix, role markers, and tokenizer variance.
 *
 * Divisor verified 2026-07-05 against run 28732970228: NVIDIA's own tokenizer
 * reported 8771 tokens for a prompt whose chars/4 + 500 estimate came out to
 * only 7785 — a ~13% undercount that let the 8000-token skip-guard under-fire
 * and let a doomed HTTP call through. chars/3.5 + 500 on the same prompt
 * yields ~8826, within 1% of the real count and back over the cap.
 *
 * Tightening chars/4 → chars/3.5 raises EVERY model's estimate uniformly, so
 * issue #3618 item 1 asked whether this pushes some other DEFAULT_CHAIN
 * model — one that was correctly passing before — into a false-positive skip
 * at realistic prompt sizes. Audited by sweeping every model in DEFAULT_CHAIN
 * across chars 4000..35000 (this codebase's real article-generation "Call
 * 1/5" prompt, source text + instructions, is not a fixed 8-10k chars — the
 * same run 28732970228 prompt that motivated this change was itself ~29140
 * chars): old vs new divisor disagree ONLY inside a narrow per-cap window —
 * (12251, 14000] chars for the 4000-token caps, (26251, 30000] chars for the
 * 8000-token caps (the GitHub Models / Groq provider defaults that cover most
 * of the chain). No model has a *different, lower* real limit than these —
 * DEFAULT_REQUEST_TOKENS_BY_PROVIDER's own docstring notes the GitHub 8000
 * cap was verified ACCOUNT-WIDE across five unrelated model families hitting
 * byte-identical 413 text at the same estimate, i.e. token-counting for a
 * given prompt doesn't vary by which model on that provider receives it — so
 * a prompt landing in that window is genuinely at-or-over every model's real
 * cap on that provider, not a false positive for some but not others. Net:
 * no model is incorrectly newly-skipped; the tightened divisor only converts
 * previously-silent false negatives (doomed 413/400 calls) into pre-flight
 * skips, matching the fallback chain's own stated cost model (a wrong skip
 * costs one chain step; a wrong pass costs a guaranteed failed HTTP call).
 * See tests/scripts/ai-models-token-estimate-divisor.test.ts for the
 * regression lock on the divisor value and the boundary math above.
 *
 * `providerName`, when given, makes the jsonSchema term provider-accurate: the
 * serialized schema is only added for providers that actually RECEIVE it, as
 * decided by shouldUseSchemaMode() — the same call the send side makes when it
 * builds the body. Omit it and the schema is counted unconditionally, which is
 * the conservative upper bound across the fleet and preserves the estimate
 * every existing provider-agnostic caller already relies on.
 *
 * Why it matters: this codebase's article schema serializes to ~1805 chars ≈
 * 516 tokens. Groq is deliberately NOT in PROVIDERS_WITH_STRICT_JSON_SCHEMA
 * (it 400s on `response_format: json_schema`), so _callGroq sends plain
 * `json_object` and those 516 tokens never leave the process — yet the
 * pre-flight skip-guard was charging Groq for them and skipping models whose
 * real payload fit under the cap, without ever attempting the call. That is a
 * false-positive skip: the estimate has to describe the body that will
 * actually be sent, not the richest body any provider might get. Passing
 * `modelForTracking` extends the same fidelity to the per-model
 * _learnedSchemaIncompatible set and to the AI_MODELS_SCHEMA_MODE=off
 * kill-switch, both of which also stop the schema from being sent.
 *
 * Exported for tests / smoke probes.
 */
export function estimateRequestTokens(messages, opts = {}, providerName = undefined, modelForTracking = undefined) {
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
  // jsonSchema is serialized and sent in response_format → counts toward body,
  // but ONLY for the providers that receive it. With no providerName the
  // caller is asking a provider-agnostic question, so keep the upper bound.
  const schemaIsSent = providerName === undefined
    || shouldUseSchemaMode(providerName, true, modelForTracking);
  if (opts.jsonSchema?.schema && schemaIsSent) {
    try { chars += JSON.stringify(opts.jsonSchema.schema).length; } catch { /* noop */ }
  }
  return Math.ceil(chars / 3.5) + SAFETY_MARGIN;
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
  // GitHub Models HTTP 400 (run 28732970228, 2026-07-05, 19x in 30-run sample):
  // "max_completion_tokens=8000 cannot be greater than max_model_len=
  // max_total_tokens=4096" — this codebase's default article-generation
  // maxTokens (8000) always overran Phi-4-mini-reasoning's real 4096 limit.
  'Phi-4-mini-reasoning': 4000,
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
async function _callOpenAICompatible(apiModel, messages, opts, { endpoint, apiKey, providerName, trackAs, extraHeaders, extraBody, dispatcher, _suppressExhaustionMark = false }) {
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
  if (shouldUseSchemaMode(providerName, !!opts.jsonSchema, modelForTracking)) {
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
    ...(extraBody || {}),
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
        // Local CPU inference buffers the whole completion before sending
        // headers; without a dispatcher raising undici's 300s headersTimeout,
        // a slow local model dies as `fetch failed` long before the AbortSignal.
        ...(dispatcher ? { dispatcher } : {}),
      });

      // OmniRoute's "auto" combo resolves to one specific underlying provider
      // per call and reports it back via response headers — otherwise
      // invisible from this side (its own DB records it, but CI has no
      // access to that). Surface it here so both local and CI logs show
      // which provider actually served (or failed) each "auto" call.
      if (providerName === 'OmniRoute') {
        const routedProvider = res.headers.get('x-omniroute-provider');
        const routedModel = res.headers.get('x-omniroute-model');
        if (routedProvider || routedModel) {
          console.log(
            `🔀 [ai-models] OmniRoute routed auto → provider=${routedProvider || '?'} model=${routedModel || '?'} ` +
            `status=${res.status} latency=${res.headers.get('x-omniroute-latency-ms') || '?'}ms cache=${res.headers.get('x-omniroute-cache-hit') || '?'}`
          );
        }
      }

      const raw = await res.text().catch(() => '');

      if (!res.ok) {
        // Daily limit — mark exhausted immediately. When a caller still has
        // another credential to try (GitHub multi-PAT: _suppressExhaustionMark),
        // do NOT mark the model globally exhausted — it's only out on THIS
        // account; the error still propagates so the caller can rotate.
        // Same last-resort exemption as the 429/timeout/content-failure
        // circuit breakers elsewhere in this file — _callLocal/_callOmniRoute
        // route through here (trackAs: model), so an HTTP-shaped failure
        // (daily-limit-looking response, stale local/OmniRoute auth 401) must
        // never hard-ban a last-resort provider. See _isLastResortProvider.
        if (isDailyLimitError(res.status, raw)) {
          if (!_suppressExhaustionMark && !_isLastResortProvider(modelForTracking)) {
            markModelExhausted(modelForTracking);
            _stats.exhausted++;
          }
          throw new Error(`[${displayModel}] Daily request limit reached`);
        }
        // Non-retryable client errors (unknown model, context too small)
        const nrc = classifyNonRetryableError(res.status, raw);
        if (nrc.nonRetryable) {
          // Learn the real size cap from `raw` while it's still untruncated —
          // the Error message below slices it to 300 chars (and callers slice
          // further to 200 for logging), which is why this can't be recovered
          // after the fact from logs.
          _learnRequestTokenLimit(modelForTracking, raw);
          // Same reasoning: a 400 with this exact shape only happens when we
          // requested schema mode (responseFormat.type === 'json_schema') and
          // the model rejected it — remember it so future cascade passes stop
          // paying the round-trip for a request shape this model never accepts.
          if (nrc.reason === 'schema_unsupported' && responseFormat?.type === 'json_schema') {
            _learnSchemaIncompatible(modelForTracking);
          }
          if (nrc.markExhausted && !_isLastResortProvider(modelForTracking)) {
            markModelExhausted(modelForTracking, 'nonretryable', `HTTP ${res.status}`);
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
          // On 429: cool down the entire provider so sibling models are skipped.
          // Skip the cooldown when the caller can rotate credentials (GitHub
          // multi-PAT): a 429 on one account must not freeze every GitHub model
          // for the run when another account's quota is still available.
          if (is429 && !_suppressExhaustionMark) {
            cooldownProvider(getProvider(modelForTracking));
            _stats.providerCooldowns++;
          }
          // Respect Retry-After header if present (seconds or HTTP-date)
          // Cap at 2 minutes — some providers (e.g. Cerebras) return Retry-After: 86399 (24h)
          // which would freeze the entire translation pipeline. Shared module
          // constant (MAX_RETRY_AFTER_MS) so the per-call hard cap below can
          // size itself off the same worst-case wait instead of duplicating it.
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
      // Guard: some providers (e.g. Cloudflare) return non-string content (array, object).
      // Surface as a proper error so the retry/exhaustion path handles it instead of crashing
      // with "text.replace is not a function" inside stripThinkTags (observed: CF_LLAMA_4_SCOUT,
      // CF_QWEN_25_CODER_32B — latent for remaining CF models until this guard lands).
      if (text && typeof text !== 'string') throw new Error(`[${displayModel}] non-string content: ${typeof text}`);
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
      // Timeout errors: never retry within this call. A hang against the full
      // opts.timeout budget (default 90s) means the model is dead/overloaded,
      // not transiently failing — retrying burns a second full timeout for
      // near-zero payoff (observed 0/19 timeout retries succeeding in run
      // 28611052353, which spent ~62min re-waiting on already-hung models).
      // The outer callLLM() cascade already marks the model exhausted after a
      // single failure and moves on, so bailing here just lets that happen sooner.
      const isTimeout = e.name === 'AbortError' || e.name === 'TimeoutError' || /timeout|aborted/i.test(e.message || '');
      if (isTimeout) {
        // A client-side abort fires before OmniRoute's response (and its
        // x-omniroute-provider/model headers) ever arrives, so which
        // underlying provider it was attempting is not observable from here.
        if (providerName === 'OmniRoute') {
          console.warn(`⏱️  [ai-models] OmniRoute auto call timed out before a response arrived (no x-omniroute-* headers to log) — check local ~/.omniroute/storage.sqlite call_logs table or the OmniRoute dashboard for which provider it was routing to.`);
        }
        throw e;
      }
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

// Detect a per-account daily/quota/rate-limit failure — the only error class
// that warrants rotating to another GitHub PAT (a different account's separate
// free budget). Unknown-model / bad-request errors are account-independent and
// must NOT trigger rotation (they'd fail identically on every PAT).
function _isGhPatQuotaError(err) {
  if (!err) return false;
  if (err.exhausted) return true;
  const msg = String(err.message || '');
  return /daily request limit|daily quota|rate limit|HTTP 429|too many requests/i.test(msg);
}

async function _callGitHub(model, messages, opts) {
  const pats = getGhModelsPats();
  if (pats.length === 0) throw new Error('GitHub API key not set');
  // Single-PAT (the default): identical behaviour to before — one normal call.
  if (pats.length === 1) {
    return _callOpenAICompatible(model, messages, opts, {
      endpoint: GH_MODELS_BASE,
      apiKey: pats[0],
      providerName: 'GitHub',
    });
  }
  // Multi-PAT: try non-exhausted PATs first; if all are flagged exhausted this
  // run, fall back to trying them all again (a daily limit may have lifted).
  const fresh = pats.map((_, i) => i).filter((i) => !_ghExhaustedPats.has(i));
  const order = fresh.length ? fresh : pats.map((_, i) => i);
  let lastErr;
  for (let j = 0; j < order.length; j++) {
    const idx = order[j];
    const isLast = j === order.length - 1;
    try {
      return await _callOpenAICompatible(model, messages, opts, {
        endpoint: GH_MODELS_BASE,
        apiKey: pats[idx],
        // MUST stay the canonical 'GitHub' so provider-name-keyed logic
        // (shouldUseSchemaMode / strict-JSON-schema, getProvider, cooldown,
        // stats) behaves identically to single-PAT. The PAT index is tracked
        // separately (idx / _ghExhaustedPats), not encoded in the name.
        providerName: 'GitHub',
        // Until the LAST PAT, a daily-limit on this account must NOT mark the
        // model/provider globally exhausted — the model is still usable on the
        // next account's separate quota. The error still propagates so we rotate.
        _suppressExhaustionMark: !isLast,
      });
    } catch (err) {
      lastErr = err;
      if (!isLast && _isGhPatQuotaError(err)) {
        _ghExhaustedPats.add(idx);
        console.error(`🔁 [GitHub] PAT #${idx + 1} esaurito (quota account) — ruoto al PAT #${idx + 2}`);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
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
  // Defense-in-depth: cf/* should already be filtered out as unavailable, but
  // refuse to spend billable neurons if any path reaches here with CF off.
  if (!isCloudflareWorkersAiEnabled()) throw new Error('Cloudflare Workers AI disabled (CF_WORKERS_AI_ENABLED not set) — $0 policy');
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
 * Call a model on Chutes.ai (OpenAI-compatible, generous free tier — added 2026-05-18).
 * Free tier ~200 req/day shared. Requires CHUTES_API_KEY.
 */
function _callChutes(model, messages, opts) {
  const apiModel = getApiModelId(model);
  return _callOpenAICompatible(apiModel, messages, opts, {
    endpoint: CHUTES_API_BASE,
    apiKey: getChutesApiKey(),
    providerName: 'Chutes',
    trackAs: model,
  });
}

/**
 * Call a model on Z.AI (Zhipu, OpenAI-compatible — added 2026-05-18).
 * GLM-4.6 free tier. Requires ZAI_API_KEY (or ZHIPU_API_KEY).
 */
function _callZai(model, messages, opts) {
  const apiModel = getApiModelId(model);
  return _callOpenAICompatible(apiModel, messages, opts, {
    endpoint: ZAI_API_BASE,
    apiKey: getZaiApiKey(),
    providerName: 'Z.AI',
    trackAs: model,
  });
}

/**
 * Call a local OpenAI-compatible server (llama.cpp `--server` or ollama).
 * Last-resort fallback used only when every remote provider is exhausted.
 * Uses a generous timeout floor because CPU inference is slow. The served model
 * name comes from LOCAL_LLM_MODEL (getApiModelId already resolves it).
 */
// Cached undici dispatcher for the local provider. Node's global fetch defaults
// `headersTimeout`/`bodyTimeout` to 300s; non-streaming CPU inference buffers the
// whole completion before sending response headers, so a slow local model (e.g.
// qwen2.5:7b on a CPU runner) trips that 300s limit and surfaces as
// `TypeError: fetch failed` — long before our AbortSignal.timeout fires. Raising
// both undici timeouts to the real local budget lets a full generation complete.
// Keyed by timeout so a changed LOCAL_LLM_TIMEOUT_MS rebuilds the agent. `null`
// memoizes "undici unavailable" → degrade to global fetch defaults (remote-only env).
let _localDispatcher; // undefined = not built; null = unavailable
let _localDispatcherTimeout = 0;
async function _getLocalDispatcher(timeoutMs) {
  if (_localDispatcher !== undefined && _localDispatcherTimeout === timeoutMs) {
    return _localDispatcher || undefined;
  }
  try {
    const { Agent } = await import('undici');
    _localDispatcher = new Agent({
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
      connectTimeout: 10_000,
    });
  } catch {
    _localDispatcher = null; // undici not importable — global fetch defaults apply
  }
  _localDispatcherTimeout = timeoutMs;
  return _localDispatcher || undefined;
}

async function _callLocal(model, messages, opts) {
  const apiModel = getApiModelId(model); // = getLocalLlmModelId()
  // Raise the timeout floor for slow CPU inference (caller's timeout may be ~60s).
  const baseTimeoutMs = Math.max(opts.timeout || 0, getLocalLlmTimeoutMs());
  // Cap to the caller's remaining wall-clock budget (opts.deadlineMs, e.g.
  // create-article.mjs's RUN_WALL_BUDGET_MS). Without this, a single
  // local/fallback call can outlive the overall run deadline by its whole
  // ~10min CPU-inference floor — the per-chain-walk deadline check (see
  // ai-models.mjs's "wall-clock deadline exceeded" branch) only gates
  // whether a NEW cascade walk starts, not how long an already-dispatched
  // local call is allowed to run. Observed run 28744325535: 5 body2-repair
  // retries each re-invoked local/fallback (~6-10min each) past the 30min
  // svizzera budget, leaving zero time for any later fallback attempt.
  // Floor at 15s so a near-expired deadline still gets one honest last try
  // instead of silently degrading to a 0ms request.
  //
  // Stessa forma quota-su-`remaining` di _callClaudeCli (2026-08-18, issue
  // #451 review): baseTimeoutMs sopra non deve MAI restare un tetto quando
  // l'allowance residua e' grande. clamp( max(baseTimeoutMs, min(remaining ×
  // SHARE, MAX)), 15s, remaining ).
  let timeout = baseTimeoutMs;
  if (opts.deadlineMs) {
    const remaining = opts.deadlineMs - Date.now();
    const quota = Math.min(Math.floor(remaining * LOCAL_LLM_ALLOWANCE_SHARE), LOCAL_LLM_MAX_TIMEOUT_MS);
    timeout = Math.max(15_000, Math.min(Math.max(baseTimeoutMs, quota), remaining));
  }
  const dispatcher = await _getLocalDispatcher(timeout);
  return _callOpenAICompatible(apiModel, messages, { ...opts, timeout }, {
    endpoint: getLocalLlmUrl(),
    apiKey: getLocalLlmApiKey(),
    providerName: 'Local',
    trackAs: model,
    dispatcher,
  });
}

/**
 * Call OmniRoute (self-hosted local AI gateway) using its own "auto" routing
 * sentinel — OmniRoute selects and falls back across its own registered
 * providers internally, so this is deliberately a single call with the
 * literal model id "auto" (getApiModelId strips the omniroute/ prefix down
 * to it), not a per-provider fan-out on our side. Opt-in via OMNIROUTE_ENABLED
 * (default OFF). No local-CPU-style timeout floor here (unlike _callLocal):
 * OmniRoute forwards to real network providers, so it behaves like the rest
 * of the remote chain rather than like slow CPU inference. See
 * PROVIDER.OMNIROUTE / AI_MODELS.OMNIROUTE_AUTO.
 */
function _callOmniRoute(model, messages, opts) {
  const apiModel = getApiModelId(model); // = 'auto'
  return _callOpenAICompatible(apiModel, messages, opts, {
    endpoint: getOmniRouteUrl(),
    apiKey: getOmniRouteApiKey(),
    providerName: 'OmniRoute',
    trackAs: model,
    // OmniRoute's "auto" model defaults to SSE streaming when `stream` is
    // omitted — unlike every other OpenAI-compat provider here, which default
    // to a single JSON response. Confirmed via curl: omitting `stream` returns
    // `data: {...}` chunks our non-streaming client never parses, so the call
    // just times out. Force non-streaming explicitly.
    extraBody: { stream: false },
  });
}

/**
 * Call Claude Haiku via the `claude` CLI subprocess (RC-gated, absolute
 * last resort — reuses CLAUDE_CODE_OAUTH_TOKEN, same zero-cost Max-plan auth
 * already wired for pr-review-loop.yml/issue-fix.yml, never a raw
 * ANTHROPIC_API_KEY). `--bare` deliberately NOT used: it requires
 * ANTHROPIC_API_KEY/apiKeyHelper and ignores OAuth. Tool access is disabled
 * via `--tools ""` (per `claude --help`: "Use \"\" to disable all tools") —
 * NOT `--allowedTools`/`--disallowedTools`, which only gate the permission
 * *prompt* for tools that remain available and don't remove them from the
 * built-in set. `--permission-mode bypassPermissions` is kept alongside so
 * the (now empty) tool set never blocks on an interactive prompt in CI; with
 * zero tools available it has nothing else to bypass. This subprocess
 * processes externally-sourced headline/news content and inherits the full
 * CI env (`env: process.env` below, incl. secrets) — `--tools ""` is the
 * flag that actually matters for keeping this a plain one-shot completion
 * with no agentic/tool-call capability, regardless of permission mode.
 * `--safe-mode` disables this repo's own CLAUDE.md/AGENTS.md auto-discovery,
 * hooks (incl. the SessionStart worktree-prune script) and MCP servers
 * (GitNexus) for this subprocess — unlike `--bare` it keeps OAuth auth
 * working. Confirmed live (2026-07-22): without it, a one-shot completion
 * cold-loads ~34K tokens of project system prompt per call (vs ~600-6.7K
 * with `--safe-mode`, most of it dedupable across concurrent calls via
 * prompt caching) and forks the SessionStart hook every invocation; run
 * 29824354962 hit 159/162 hard 60s timeouts under AI_CONCURRENCY=5 on a
 * resource-constrained CI runner, burning roughly half the run's wall clock
 * on calls that could never finish in time.
 */
async function _callClaudeCli(model, messages, opts) {
  const apiModel = getApiModelId(model); // e.g. 'haiku' — CLI resolves the alias to its current model
  const systemPrompt = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const userPrompt = messages.filter((m) => m.role !== 'system').map((m) => m.content).join('\n\n');

  const args = [
    '-p', userPrompt,
    '--model', apiModel,
    // `stream-json` e non `json`: con `json` il CLI non scrive un solo byte
    // finche' non ha finito, ed e' quello che rende «0 byte a 120s»
    // indistinguibile fra tre cause che vogliono rimedi opposti. `--verbose` e'
    // obbligatorio perche' sotto `-p` il CLI emetta davvero gli eventi, ed e'
    // accettato insieme a `-p` (verificato eseguendolo, CLI 2.1.234). Il perche'
    // esteso e le latenze misurate stanno su createClaudeCliStreamTrace.
    '--output-format', 'stream-json', '--verbose',
    '--tools', '',
    '--permission-mode', 'bypassPermissions',
    '--safe-mode',
  ];
  if (systemPrompt) args.push('--system-prompt', systemPrompt);
  if (opts.jsonSchema) args.push('--json-schema', JSON.stringify(opts.jsonSchema.schema || opts.jsonSchema));

  // Floor raised 60s -> 120s (T2 diagnosis, 2026-07-28: run 30333856358 /
  // 30243975255, 0/19 production successes, always the hard 60s timeout). A
  // solo cold-start locally measured only ~6-12s wall time for a matching
  // small/large prompt with these exact flags — single-call latency was
  // never the bottleneck by itself, so the floor alone isn't the fix, but it
  // buys headroom against the CI-runner contention the semaphore below
  // (CLAUDE_CLI_MAX_CONCURRENCY) reduces but may not fully absorb.
  const baseTimeoutMs = Math.max(opts.timeout || 0, CLAUDE_CLI_MIN_TIMEOUT_MS);

  // Acquire the dedicated concurrency slot BEFORE computing the deadlineMs
  // cap below, so time spent queued behind another in-flight claude-cli call
  // counts against the caller's wall-clock budget (correct) while the actual
  // per-process timeout still reflects the true remaining budget at the
  // moment it starts (not at the moment it was queued).
  const { code, stdout, stderr, trace } = await _withClaudeCliSlot(async () => {
    // Same deadline-capping rationale as _callLocal above — cap to the
    // caller's remaining wall-clock budget so a last-resort call can't
    // outlive the run.
    //
    // In piu' (2026-08-18): la chiamata CRESCE dentro l'allowance residua
    // invece di restare inchiodata al minimo. Prima qui c'era
    // `Math.min(baseTimeoutMs, remaining)`, e siccome `baseTimeoutMs` era 120s
    // mentre `remaining` valeva 600-1000s, il minimo faceva da tetto e
    // troncava chiamate che stavano ancora emettendo (vedi il blocco sopra
    // CLAUDE_CLI_MIN_TIMEOUT_MS). Ora il tempo concesso e'
    //
    //     clamp( max(baseTimeoutMs, min(remaining × SHARE, MAX)), 15s, remaining )
    //
    // quindi: mai sotto il minimo, mai sopra il tetto, mai oltre l'allowance —
    // e la clamp finale a `remaining` e' cio' che rende impossibile per
    // costruzione che una tempesta di timeout sfondi il budget di sezione,
    // qualunque valore prendano il minimo e la soglia del breaker.
    let timeoutMs = baseTimeoutMs;
    if (opts.deadlineMs) {
      const remaining = opts.deadlineMs - Date.now();
      const quota = Math.min(Math.floor(remaining * CLAUDE_CLI_ALLOWANCE_SHARE), CLAUDE_CLI_MAX_TIMEOUT_MS);
      timeoutMs = Math.max(15_000, Math.min(Math.max(baseTimeoutMs, quota), remaining));
    }
    return _runClaudeCliProcess(args, timeoutMs);
  });

  // La riga `type:"result"` del JSONL, non piu' l'intero stdout: sotto
  // `stream-json` lo stdout e' una sequenza di eventi e `JSON.parse(stdout)`
  // fallirebbe su ogni chiamata, anche perfettamente riuscita. La riga ha la
  // stessa forma esatta dell'oggetto che `--output-format json` restituiva
  // (`is_error` + `result`), quindi da qui in giu' non cambia niente — ed e'
  // anche la ragione per cui i mock dei test che gia' emettono
  // `{type:'result', …}` continuano a valere.
  const parsed = trace.result;
  if (!parsed) {
    // Nessun evento `result`: qui la diagnosi del flusso serve quanto sul
    // timeout — un processo uscito 0 senza result non e' la stessa cosa di uno
    // che ha scritto spazzatura.
    throw new Error(`[${model}] claude CLI senza evento result (exit ${code})${trace.describe()}: ${(stdout || stderr).slice(0, 300)}`);
  }
  if (code !== 0 || parsed.is_error) {
    throw new Error(`[${model}] claude CLI error: ${String(parsed.result || stderr || 'unknown').slice(0, 300)}`);
  }
  return parsed.result;
}

// Memoize the dynamic import itself (the in-flight promise, not just its
// resolved value) so _runClaudeCliProcess never issues a second literal
// `import('node:child_process')` call. Two callers can now run genuinely
// concurrently (CLAUDE_CLI_MAX_CONCURRENCY above) and both `await` this same
// promise instead of each triggering their own import(). Caught during T2
// (2026-07-28): two truly-simultaneous `import()` calls for the same
// specifier raced Vitest's node:child_process mock — the 2nd resolution fell
// through to the real builtin instead of the mock, spawning a real `claude`
// subprocess mid-test. Not a production hazard by itself (Node's builtin
// module cache has no such race), but memoizing is strictly cheaper too — no
// point re-resolving an already-loaded builtin on every call.
let _childProcessModulePromise = null;
function _getChildProcessModule() {
  if (!_childProcessModulePromise) _childProcessModulePromise = import('node:child_process');
  return _childProcessModulePromise;
}

/**
 * ── DOVE SI E' FERMATO, NON SOLO CHE SI E' FERMATO ──────────────────────────
 *
 * Tracciatore incrementale del flusso `stream-json` del CLI `claude`. Esiste
 * per una ragione sola: rendere DIAGNOSTICABILE il timeout.
 *
 * Con `--output-format json` il CLI non scrive niente su stdout finche' non ha
 * finito — misurato il 2026-08-18 in locale con la CLI 2.1.234 e gli argomenti
 * esatti di produzione: primo byte a 8442ms su una chiamata che chiude a
 * 8995ms. Quindi «0 byte a 120s», la firma IDENTICA di ogni fallimento di
 * `claude-cli/haiku` in produzione (0 successi in assoluto, run 32140876038:
 * tre tentativi alle 13:12/13:32/13:34 del 2026-08-18, tutti a 120000ms esatti,
 * 0 byte, stderr vuoto), non distingue tre cause che vogliono rimedi opposti:
 *
 *   - la CLI non e' mai partita        → il floor non c'entra niente
 *   - l'API stallava dopo l'avvio      → il floor non c'entra niente
 *   - la risposta era solo lenta       → e allora si', il floor e' stretto
 *
 * E' quella cecita' ad aver bruciato tre tentativi alla cieca di fila (floor
 * 60s→120s, semaforo CLAUDE_CLI_MAX_CONCURRENCY, soglia del breaker portata a 3
 * da #438): nessuno dei tre aveva un dato su cui puntare. Questa classe non
 * ripara il difetto, lo rende misurabile — ed e' deliberatamente tutto cio' che
 * fa: nessuna delle tre leve sopra viene toccata nello stesso giro.
 *
 * Con `--output-format stream-json --verbose` il primo byte arriva invece a
 * 942ms, e la sequenza osservata su una chiamata sana e':
 *
 *     942ms  system/init
 *    2699ms  system/thinking_tokens
 *    4009ms  rate_limit_event
 *    5065ms  assistant
 *    5119ms  result/success
 *
 * Da cui le tre risposte che il messaggio di timeout ora puo' dare: «nessun
 * evento» (non e' partita), «fermo dopo system/init a Nms» (stallo a monte),
 * «fermo dopo assistant» (generazione lenta).
 *
 * PERCHE' `rate_limit_event` E' RIPORTATO A PARTE. E' il candidato causale piu'
 * forte oggi invisibile: lo stesso `CLAUDE_CODE_OAUTH_TOKEN` di Max plan e'
 * condiviso con `pr-review-loop`, `issue-fix` e il redflag-fixer, quindi un
 * limite di sessione spiegherebbe esattamente la forma del difetto — funziona
 * in locale, mai in CI. Il campo c'e' SEMPRE, anche quando l'evento non e'
 * comparso ('nessun rate_limit_event'), per la stessa ragione per cui il
 * conteggio dei byte di stdout c'e' anche a zero (vedi il ramo di timeout piu'
 * sotto): un campo che appare solo quando c'e' qualcosa costringe chi legge il
 * prossimo incidente a distinguere «non e' successo» da «non lo guardavamo».
 *
 * PERCHE' UN BUFFER. Le righe JSONL possono arrivare spezzate fra due eventi
 * `data`: un chunk NON e' una riga. Si accumula e si taglia sui `\n`; il
 * residuo senza `\n` finale e' una riga intera solo a processo chiuso (`end()`),
 * mentre a timeout e' precisamente il segnale «stava scrivendo quando l'abbiamo
 * ucciso», e come tale viene riportato invece che parsato.
 *
 * @param {{now?: () => number}} [deps] iniezione dell'orologio, per i test.
 */
export function createClaudeCliStreamTrace({ now = Date.now } = {}) {
  const startedAt = now();
  const state = {
    events: 0,
    malformed: 0,
    firstEventAtMs: null,
    lastEventAtMs: null,
    lastEventLabel: null,
    rateLimit: null,
    result: null,
  };
  let buffer = '';

  function absorbLine(raw) {
    const line = raw.trim();
    if (!line) return;
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      state.malformed += 1;
      return;
    }
    if (!evt || typeof evt !== 'object') {
      state.malformed += 1;
      return;
    }
    const atMs = Math.max(0, now() - startedAt);
    state.events += 1;
    if (state.firstEventAtMs === null) state.firstEventAtMs = atMs;
    state.lastEventAtMs = atMs;
    const type = typeof evt.type === 'string' ? evt.type : 'sconosciuto';
    state.lastEventLabel = typeof evt.subtype === 'string' ? `${type}/${evt.subtype}` : type;
    if (type === 'rate_limit_event') {
      const info = evt.rate_limit_info && typeof evt.rate_limit_info === 'object' ? evt.rate_limit_info : {};
      state.rateLimit = {
        atMs,
        status: typeof info.status === 'string' ? info.status : 'sconosciuto',
        kind: typeof info.rateLimitType === 'string' ? info.rateLimitType : 'sconosciuto',
      };
    }
    if (type === 'result') state.result = evt;
  }

  return {
    state,
    /** Un chunk non e' una riga: si bufferizza e si taglia sui `\n`. */
    feed(chunk) {
      buffer += String(chunk);
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        absorbLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
      }
    },
    /**
     * A processo chiuso il residuo senza `\n` e' una riga intera — e nei mock
     * dei test e' l'unica forma in cui il payload arriva mai.
     */
    end() {
      if (!buffer) return;
      const rest = buffer;
      buffer = '';
      absorbLine(rest);
    },
    /** Byte di una riga non ancora terminata: a timeout vale «stava scrivendo». */
    get pendingBytes() { return buffer.length; },
    /** L'evento `type:"result"`, o null se non e' mai arrivato. */
    get result() { return state.result; },
    /**
     * La frase che va nel messaggio d'errore. Sempre non vuota: anche «non e'
     * arrivato niente» e' un'informazione, ed e' quella che serviva.
     */
    describe() {
      if (state.events === 0) {
        return buffer.length
          ? ` — stream: nessun evento completo, ${buffer.length} byte di riga a meta' (il CLI aveva iniziato a scrivere)`
          : ' — stream: nessun evento (il CLI non ne ha scritto uno solo: si e\' fermato prima di partire)';
      }
      const parti = [
        `${state.events} ${state.events === 1 ? 'evento' : 'eventi'}`,
        `fermo dopo ${state.lastEventLabel} a ${state.lastEventAtMs}ms`,
      ];
      if (state.events > 1) parti.push(`primo evento a ${state.firstEventAtMs}ms`);
      if (buffer.length) parti.push(`${buffer.length} byte di riga a meta'`);
      if (state.malformed) parti.push(`${state.malformed} righe illeggibili`);
      parti.push(state.rateLimit
        ? `rate_limit_event a ${state.rateLimit.atMs}ms (status=${state.rateLimit.status}, tipo=${state.rateLimit.kind})`
        : 'nessun rate_limit_event');
      return ` — stream: ${parti.join(', ')}`;
    },
  };
}

/**
 * Spawn the `claude` CLI with stdin closed (its default stdin-wait-then-read
 * behavior adds ~3s latency when nothing is piped in — confirmed via live
 * test) and a hard kill-timeout so a hung subprocess can't outlive the run.
 * On timeout, whatever stderr arrived before the kill is folded into the
 * rejection message (truncated) so the next incident isn't diagnostically
 * blind (T2, 2026-07-28).
 */
async function _runClaudeCliProcess(args, timeoutMs) {
  const { spawn } = await _getChildProcessModule();
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(CLAUDE_CLI_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    // Il tracciatore parte con il processo, non con il primo byte: e' la
    // distanza fra lo spawn e il primo evento a dire se la CLI e' mai partita.
    const trace = createClaudeCliStreamTrace();
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      // Include whatever stderr arrived before the kill — previously
      // discarded on timeout, which left every production incident
      // (T2 diagnosis, 2026-07-28) blind to whether the subprocess was
      // stuck on auth, context loading, or a genuine hang.
      //
      // …e ora anche quanto STDOUT era arrivato, che invece veniva buttato del
      // tutto. Il 2026-08-14 questo ramo e' scattato 10 volte su 10 nella run
      // 31823202761, sempre a 120000 ms esatti, e il messaggio diceva solo
      // «claude CLI timed out after 120000ms»: nessuno stderr (quindi il ramo
      // sopra taceva) e nessuna informazione su stdout. Indistinguibile fra un
      // processo che stava generando lentamente e uno che non ha mai scritto un
      // byte — e le due cose vogliono rimedi opposti.
      //
      // La distinzione conta perche' 120s NON sono pochi: misurato in locale con
      // gli stessi identici flag e un prompt da 10.211 token stimati, una
      // chiamata sana costa 24 secondi (exit 0, 1.925 token di output). Se il
      // prossimo incidente riporta bytes=0 la causa e' a monte della generazione
      // (auth, rete, avvio) e alzare il timeout sarebbe solo tempo sprecato; se
      // riporta un JSON troncato, allora si' che il floor e' stretto.
      const stderrExcerpt = stderr ? ` — stderr: ${stderr.slice(0, 300)}` : '';
      // Sempre presente, anche a zero: e' l'assenza di byte a essere il dato.
      // Un campo che compare solo quando c'e' qualcosa costringe chi legge a
      // distinguere «non e' arrivato niente» da «la diagnostica non c'era».
      const stdoutExcerpt = ` — stdout: ${stdout.length} bytes`
        + (stdout ? `: ${stdout.slice(0, 200)}` : ' (nessun byte scritto dal processo)');
      // …e ora anche DOVE si e' fermato, che e' la domanda a cui il conteggio
      // dei byte da solo non poteva rispondere: sotto `--output-format json` lo
      // stdout resta a 0 byte fino all'ultimo istante di una chiamata
      // perfettamente sana (8442ms su 8995ms, misurato), quindi «0 byte» non
      // era mai stata la prova di «non e' partita». Sotto `stream-json` lo e'.
      // Va per primo perche' e' il campo su cui si decide il prossimo rimedio.
      const streamExcerpt = trace.describe();
      const err = new Error(`claude CLI timed out after ${timeoutMs}ms${streamExcerpt}${stderrExcerpt}${stdoutExcerpt}`);
      err.name = 'TimeoutError';
      reject(err);
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; trace.feed(d); });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // L'ultima riga puo' non avere il `\n`: senza questo flush il `result`
      // resterebbe nel buffer e ogni chiamata riuscita passerebbe per fallita.
      trace.end();
      resolve({ code, stdout, stderr, trace });
    });
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
  const useGeminiSchema = !!opts.jsonSchema && shouldUseSchemaMode('Gemini', true, model);
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
          // Learn the real size cap from `raw` while it's still untruncated —
          // see the matching call in _callOpenAICompatible for why.
          _learnRequestTokenLimit(model, raw);
          if (nrc.reason === 'schema_unsupported' && useGeminiSchema) {
            _learnSchemaIncompatible(model);
          }
          if (nrc.markExhausted) {
            // 'nonretryable', NOT the default 'quota': this is the Gemini twin
            // of the _callOpenAICompatible non-retryable branch, which already
            // labels correctly. Left at the default, a 404/unknown-model here
            // was persisted to the shared Firestore doc until midnight UTC as
            // if it were a daily quota — exactly the over-persistence #4073
            // removed (quota-only persist gate in _persistScoresToFirestore).
            // Review 🔴 on #4073.
            markModelExhausted(model, 'nonretryable', `HTTP ${res.status}`);
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
      // Timeout errors: never retry within this call — see matching comment in
      // _callOpenAICompatible (same rationale, sibling pattern kept in sync).
      const isTimeout = e.name === 'AbortError' || e.name === 'TimeoutError' || /timeout|aborted/i.test(e.message || '');
      if (isTimeout) throw e;
      _stats.retries++;
      const waitMs = attempt * opts.backoffMs;
      console.warn(`⚠️  [${model}] Error retry ${attempt}/${opts.maxRetriesPerModel}: ${e.message?.slice(0, 150)}`);
      await sleep(waitMs);
    }
  }
  throw new Error(`[${model}] Exhausted after ${opts.maxRetriesPerModel} attempts`);
}

// ── Model routing ────────────────────────────────────────────

/**
 * Grace added on top of the computed worst case, so the provider's OWN abort
 * (AbortSignal.timeout / claude-CLI SIGKILL timer) always gets the first shot
 * at ending the call — the hard cap below is the backstop for when it doesn't.
 */
const HARD_CALL_CAP_GRACE_MS = 60_000;

/**
 * Absolute wall-clock ceiling for ONE _callModel invocation, in ms.
 *
 * Every provider already sets its own per-request timeout (AbortSignal.timeout
 * in the fetch callers, a SIGKILL timer in _runClaudeCliProcess), and callLLM
 * re-checks opts.deadlineMs BETWEEN models. Run 30436268314 proved that is not
 * enough: a single call hung 3h36m (08:54:32 → cancelled at 12:30) with ZERO
 * log output — no per-model failure line, no fallback line, no deadline abort —
 * i.e. neither the 90s AbortSignal nor the 55min run deadline ever fired. The
 * between-models deadline check cannot help while one call is in flight, and an
 * in-request signal cannot help if the provider (or a starved/frozen runner)
 * never lets it fire. This cap sits OUTSIDE the call and is the only in-process
 * guard that survives that failure mode; the workflow's `timeout` wrapper in
 * generate-article.yml covers the case where even this timer never fires.
 *
 * Sized to the worst LEGITIMATE case so it never truncates a healthy call: each
 * of the maxRetriesPerModel attempts may burn its full per-request timeout AND
 * a capped Retry-After wait, doubled for headroom, plus grace. For the article
 * generator (timeout 90s, maxRetriesPerModel 2) that is 15min — comfortably
 * above the slowest observed successful call (507s, run 30420300910) and three
 * orders of magnitude below the incident. Providers that legitimately run long
 * (local CPU inference, claude CLI cold start) are sized off their own floors.
 * Finally clamped to the caller's remaining wall-clock budget when it supplied
 * one: nothing should outlive the deadline its caller already declared.
 */
function _hardCallCapMs(model, opts) {
  const provider = getProvider(model);
  let base = Math.max(opts?.timeout || 0, 30_000);
  // Mirror the per-provider timeout ceilings _callLocal / _callClaudeCli can
  // grow to, otherwise the cap would fire before their own timeout ever
  // could. LOCAL: dimensionato sul MASSIMO che _callLocal puo' concedersi
  // (LOCAL_LLM_MAX_TIMEOUT_MS), non sul floor — stessa correzione applicata a
  // CLAUDE_CLI sotto, sizarlo sul floor lascerebbe il backstop sotto il
  // timeout che deve fare da backstop quando la quota supera il floor.
  if (provider === PROVIDER.LOCAL) base = Math.max(base, LOCAL_LLM_MAX_TIMEOUT_MS);
  // CLAUDE_CLI: dimensionato sul MASSIMO che _callClaudeCli puo' concedersi,
  // non sul minimo. Da quando il timeout cresce dentro l'allowance residua
  // (vedi CLAUDE_CLI_ALLOWANCE_SHARE) una chiamata puo' legittimamente durare
  // fino a CLAUDE_CLI_MAX_TIMEOUT_MS: sizarlo sul minimo lascerebbe il backstop
  // sotto il timeout che deve fare da backstop, cioe' il cap scatterebbe per
  // primo su ogni chiamata lunga — esattamente il fallimento che il commento
  // qui sopra («otherwise the cap would fire before their own timeout ever
  // could») esiste per prevenire.
  else if (provider === PROVIDER.CLAUDE_CLI) base = Math.max(base, CLAUDE_CLI_MAX_TIMEOUT_MS);
  const attempts = Math.max(1, opts?.maxRetriesPerModel || 1);
  let cap = attempts * (base + MAX_RETRY_AFTER_MS) * 2 + HARD_CALL_CAP_GRACE_MS;
  if (opts?.deadlineMs) {
    const remaining = opts.deadlineMs - Date.now();
    // Floor at the grace window so an already-expired deadline still gets one
    // honest short attempt instead of an instant 0ms abort.
    cap = Math.min(cap, Math.max(HARD_CALL_CAP_GRACE_MS, remaining + HARD_CALL_CAP_GRACE_MS));
  }
  return cap;
}

/**
 * Interval between in-flight heartbeat lines. A call that outlives one interval
 * prints which model it is waiting on and for how long — run 30436268314 was
 * undiagnosable precisely because 3h36m of silence named no model. Silence that
 * persists even with this heartbeat installed is itself the diagnosis: the
 * event loop is blocked (frozen/starved runner), not an await hanging on I/O.
 */
const HARD_CALL_HEARTBEAT_MS = 60_000;

/**
 * Route a model call to the correct provider, under a hard wall-clock cap.
 *
 * Deliberately the single choke point (both public entry points — callLLM's
 * cascade and callSingleModel — route through here), so no caller can acquire
 * an uncapped model call by construction.
 */
function _callModel(model, messages, opts) {
  // Adaptive ceiling (see ADAPTIVE_TIMEOUT_* above): narrow the caller's
  // per-request timeout to what THIS model has been observed to need, but only
  // on real evidence and never below the floor. `_hardCallCapMs` is sized off
  // the same (possibly narrowed) opts on purpose — it is the backstop for when
  // the per-request abort does not fire, so it must stay above it, not above a
  // number we no longer use.
  const effOpts = _withAdaptiveTimeout(model, opts);
  const clamped = (effOpts?.timeout || 0) < (opts?.timeout || 0);
  const capMs = _hardCallCapMs(model, effOpts || {});
  const started = Date.now();
  let heartbeat;
  let capTimer;
  const call = (async () => _routeModelCall(model, messages, effOpts))();
  const capped = new Promise((_resolve, reject) => {
    capTimer = setTimeout(() => {
      const err = new Error(
        `[${model}] hard cap: no response after ${Math.round(capMs / 1000)}s (provider timeout never fired) — abandoning call`,
      );
      // Named so the existing timeout branches (retry suppression in the
      // provider callers, the timeout circuit-breaker in callLLM's catch)
      // classify it exactly as they classify a provider-side abort.
      err.name = 'TimeoutError';
      reject(err);
    }, capMs);
    capTimer.unref?.();
  });
  heartbeat = setInterval(() => {
    console.warn(`⏳ [${model}] in-flight ${Math.round((Date.now() - started) / 1000)}s (hard cap ${Math.round(capMs / 1000)}s)`);
  }, HARD_CALL_HEARTBEAT_MS);
  heartbeat.unref?.();
  // The abandoned call keeps running until its own socket/subprocess gives up;
  // swallow its eventual settlement so it can never surface as an
  // unhandledRejection after the cascade has already moved on.
  call.catch(() => {});
  return Promise.race([call, capped]).then(
    (result) => {
      // Only SUCCESSFUL calls feed the ceiling: a failure's duration says
      // nothing about how long this model needs to answer. The span measured
      // is the whole _callModel, so a success that arrived after an in-call
      // 429 retry + backoff counts its wait too — that inflates the observed
      // maximum, which WIDENS the ceiling. The error is deliberately on the
      // permissive side; a narrower one would ban healthy calls.
      _recordCallLatency(model, Date.now() - started);
      return result;
    },
    (err) => {
      // Tag a timeout that fired under a ceiling WE narrowed, so the circuit
      // breaker in callLLM can decline to ban the model on our own guess the
      // first time. Untagged timeouts (the caller's own number ran out) keep
      // the pre-existing behaviour exactly.
      if (clamped && _isTimeoutError(err)) {
        // Some abort errors arrive as host objects (DOMException); a frozen or
        // sealed one must not turn a timeout into a different exception.
        try {
          err.adaptiveTimeoutClamped = true;
          err.adaptiveTimeoutMs = effOpts?.timeout;
        } catch { /* untaggable — falls back to the pre-existing behaviour */ }
      }
      throw err;
    },
  ).finally(() => {
    clearTimeout(capTimer);
    clearInterval(heartbeat);
  });
}

/** Is this error the timeout class the retry loops and the breaker recognise? */
function _isTimeoutError(e) {
  return e?.name === 'AbortError' || e?.name === 'TimeoutError' || /timeout|aborted/i.test(e?.message || '');
}

/**
 * Return `opts` with its per-request timeout narrowed to what `model` has
 * earned, or `opts` untouched when the evidence is thin, the caller asked for
 * nothing, or the model is a last-resort tier (whose own floors mean "fast so
 * far" is not a promise it makes — see `_callLocal` / `_callClaudeCli`).
 */
function _withAdaptiveTimeout(model, opts) {
  if (!opts?.timeout || _isLastResortProvider(model)) return opts;
  const eff = computeAdaptiveTimeoutMs(_callLatency.get(model), opts.timeout);
  if (eff >= opts.timeout) return opts;
  return { ...opts, timeout: eff };
}

/** Route a model call to the correct provider */
function _routeModelCall(model, messages, opts) {
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
    case PROVIDER.CHUTES:      return _callChutes(model, messages, opts);
    case PROVIDER.ZAI:         return _callZai(model, messages, opts);
    case PROVIDER.LOCAL:       return _callLocal(model, messages, opts);
    case PROVIDER.CLAUDE_CLI:  return _callClaudeCli(model, messages, opts);
    case PROVIDER.OMNIROUTE:   return _callOmniRoute(model, messages, opts);
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

  if (_shouldSkipExhausted(model)) {
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

  // Opt-in response cache: reuse identical deterministic prompts within the run
  // (e.g. fact-check re-checking an unchanged article body across regeneration
  // attempts). A hit avoids the entire fallback cascade — the dominant intra-run
  // burn — at zero risk, since the key includes the full prompt + model + params.
  const _cacheOn = o.cache === true;
  let _cacheKey = null;
  if (_cacheOn) {
    _cacheKey = _responseCacheKey(messages, o);
    const hit = _responseCache.get(_cacheKey);
    if (hit !== undefined) {
      _stats.cacheHits++;
      if (o.modelUsedRef && typeof o.modelUsedRef === 'object') o.modelUsedRef.model = 'cache';
      return hit;
    }
  }

  let chain = o.chain || [...DEFAULT_CHAIN];

  // Diagnostic override: AI_MODELS_FORCE_CHAIN=local/fallback,gemini-flash-latest
  // pins the chain to exactly these models (in order), bypassing DEFAULT_CHAIN,
  // the o.model start-point, and score sorting. Lets ops validate/measure a
  // specific provider (e.g. the local fallback) on demand without waiting for the
  // remote pool to exhaust. Unknown ids are dropped; empty result → ignore override.
  //
  // `opts.bypassForceChain` exempts a call from the override. The fact-check sets
  // it so that forcing generation onto the local model does NOT also drag the
  // independent verification models onto it — otherwise the model would grade its
  // own output (circular self-consensus) and a forced run could publish unchecked
  // content. With the exemption, generation=local + fact-check=real remote gate.
  const _forceChainRaw = (process.env.AI_MODELS_FORCE_CHAIN || '').trim();
  const _forcedChain = (_forceChainRaw && !o.bypassForceChain)
    ? _forceChainRaw.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  if (_forcedChain.length) {
    console.warn(`🔧 [ai-models] AI_MODELS_FORCE_CHAIN active — chain pinned to: ${_forcedChain.join(' → ')}`);
    chain = _forcedChain;
  }

  // If a specific model is requested, start the chain from that model.
  // Skipped under a forced chain — the override owns the order verbatim.
  if (o.model && !_forcedChain.length) {
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
  // A forced chain keeps its explicit order (no score reshuffle, no preference
  // reorder — the override owns the order verbatim, same as the o.model
  // skip above).
  if (!_forcedChain.length) {
    chain = sortChainByScore(chain);
    // La preferenza DOPO il sort: e' l'unico punto in cui un modello con
    // punteggio negativo puo' comunque uscire primo. Si attiva solo su
    // `opts.prefer` o sull'opt-in esplicito `AI_MODELS_PREFER` — mai da un
    // default, che e' vuoto. Vedi il blocco di commento su applyModelsPrefer.
    chain = applyModelsPrefer(chain, o.prefer);
  }

  const errors = [];
  // Every pre-flight rejection caused by the INPUT size, as { reqLimit, estTokens }.
  // Kept separate from `errors` (free text, only ever regex-tallied by
  // classifyExhaustionCause) because it is the one failure class a caller can
  // actually act on: see the err.retryRequestTokenBudget block at the throw.
  const inputCapSkips = [];

  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];

    // Optional caller-supplied wall-clock deadline (absolute epoch ms). Lets a
    // caller with its own overall time budget (e.g. create-article.mjs's
    // RUN_WALL_BUDGET_MS) bail out of a single cascade walk early instead of
    // unconditionally trying every remaining model in chain. Closes a gap
    // where a budget checked only *between* calls to callLLM() never fires
    // because one call itself walks the whole ~180-model chain — run
    // 28611052353: a single such walk alone consumed most of a 109min run
    // before any between-call check got a chance to run. No-op unless the
    // caller opts in via opts.deadlineMs.
    if (o.deadlineMs && Date.now() > o.deadlineMs) {
      // Wording matters: classifyExhaustionCause()'s transientRe (below) keys off
      // "timeout"/"aborted" to bucket a cascade's errors as transient (recoverable
      // next run) vs persistent (needs intervention). A budget-exhaustion skip is
      // transient by nature, but the original "aborting" (present tense) matched
      // neither regex — when this is the *only* error (deadline already past at
      // i===0, exactly the case this fix targets), that left the cascade
      // unclassified, so create-article.mjs's catch-all treated it as a hard
      // failure (exit 1) instead of a graceful defer. Fixed per PR #3307 review.
      errors.push(`${model}: skipped — wall-clock deadline exceeded (timeout), aborted remaining chain (${chain.length - i} models left)`);
      break;
    }

    // Skip exhausted models. Log each exhausted model at most once per process
    // to avoid log floods like "[mistral/nemo] Skipped — exhausted" repeated
    // 300+ times in a single run (one per fallback attempt × per fact-check
    // retry × per generation retry).
    if (_shouldSkipExhausted(model)) {
      const cause = _exhaustSkipCause(model);
      if (!_exhaustedLogged.has(model)) {
        console.warn(`⏭️  [${model}] Skipped — exhausted (${cause}, future hits silenced)`);
        _exhaustedLogged.add(model);
      }
      // Record the skip reason so the aggregate "All AI models failed … Errors:"
      // message is never empty when every candidate is skipped pre-flight (e.g.
      // a single-model chain whose only model is exhausted, as in the smoke
      // test). Without this the harness surfaces a blank cause — undiagnosable.
      //
      // The cause is the RECORDED one, not a fixed disjunction: see
      // _exhaustSkipCause for why naming it wrong here turned a persistent-fault
      // run into a green deferral 60+ times on 2026-08-14.
      errors.push(`${model}: skipped — exhausted (${cause})`);
      _recordLastResortSkip(model, `exhausted (${cause})`);
      continue;
    }

    // Skip models whose provider is cooling down (recent 429). Was silent
    // (errors.push only) until run 30333856358's investigation — a whole
    // last-resort tier stuck in cooldown left zero trace unless the entire
    // chain also failed. Logged once per model+cause (see _logPreflightSkipOnce).
    const provider = getProvider(model);
    if (isProviderCoolingDown(provider)) {
      _logPreflightSkipOnce(model, 'cooldown', `provider ${provider} cooling down (rate-limited)`);
      errors.push(`${model}: skipped — provider ${provider} cooling down (recent 429)`);
      _recordLastResortSkip(model, 'provider cooling down');
      continue;
    }

    // Skip models without API keys. Distinguish the two reasons isModelAvailable
    // returns false (missing key vs already-exhausted) so the output is actionable.
    // Also was silent pre-flight — see cooldown comment above.
    if (!isModelAvailable(model)) {
      const reason = getApiKeyForProvider(provider)
        ? 'exhausted'
        : `no API key for provider ${provider}`;
      _logPreflightSkipOnce(model, 'availability', reason);
      errors.push(`${model}: skipped — ${reason}`);
      _recordLastResortSkip(model, reason);
      continue;
    }

    // Skip models whose max output token limit is below the requested maxTokens.
    // This avoids wasting API calls that will fail with "max tokens must be less than" errors.
    // Also was silent pre-flight — see cooldown comment above.
    const apiModelId = getApiModelId(model);
    const modelLimit = MODEL_MAX_OUTPUT_TOKENS[apiModelId];
    if (modelLimit && o.maxTokens > modelLimit) {
      _logPreflightSkipOnce(model, 'maxOutput', `model max output ${modelLimit} < requested maxTokens ${o.maxTokens}`);
      errors.push(`${model}: skipped — model max output ${modelLimit} < requested maxTokens ${o.maxTokens}`);
      _recordLastResortSkip(model, 'max output token limit');
      continue;
    }

    // Skip models whose REQUEST (input) token cap is below the estimated prompt
    // size. Without this, models like o1 / gpt-5-mini / Phi-4 get tried with a
    // payload they cannot fit and return HTTP 413, burning a retry slot for
    // every fallback. Three sources, tightest known bound wins: hand-curated
    // MODEL_MAX_REQUEST_TOKENS, runtime-learned _learnedRequestTokenLimits
    // (parsed straight out of a prior 413/400 body — see
    // _learnRequestTokenLimit — and persisted across runs via Firestore, so
    // providers nobody has hardcoded yet still get caught after their first
    // failure), and the provider-wide DEFAULT_REQUEST_TOKENS_BY_PROVIDER.
    //
    // Il `Math.min` sulle tre fonti vive ora in getDeclaredRequestTokenLimit(),
    // esportata: un chiamante deve poter chiedere «questo modello ha un tetto?»
    // PRIMA di costruire il prompt, e la risposta deve venire da questa stessa
    // funzione — non da una copia che scivola.
    const reqLimit = getDeclaredRequestTokenLimit(model);
    if (reqLimit) {
      // `provider` + `model` make the jsonSchema term match the body this
      // model will actually receive: providers outside shouldUseSchemaMode()
      // get `json_object`, not the serialized schema, so charging them for it
      // skipped models whose real request fit under reqLimit.
      const estTokens = estimateRequestTokens(messages, o, provider, model);
      if (estTokens > reqLimit) {
        // One-line log per skip so ops can see the cascade in the workflow output
        console.warn(`⏭️  [${model}] Skipped — request would exceed ${reqLimit}-token limit (estimated ${estTokens})`);
        errors.push(`${model}: skipped — request ~${estTokens} tokens exceeds ${reqLimit}-token input cap`);
        _recordLastResortSkip(model, 'request token limit');
        // Remember the budget this model would have accepted. The cascade can
        // only ever SKIP an oversized payload — it has no way to shrink one —
        // so unless the numbers survive to the throw, the caller learns "too
        // big" without learning "by how much" and retries the identical
        // `messages` array. See the throw site below.
        inputCapSkips.push({ reqLimit, estTokens });
        continue;
      }
    }

    // Per-run call CAP on claude-cli/* (CLAUDE_CLI_MAX_CALLS_PER_RUN, default
    // 25, see its doc comment) — safety net now that AI_COMPETING_TIERS lets
    // this tier compete as freely as any tier-0 model, and it shares the same
    // Max-subscription quota as pr-review-loop.yml/issue-fix.yml. Checked
    // AFTER every other pre-flight skip (so a model that would've been
    // skipped anyway doesn't burn cap budget) and BEFORE the actual call so
    // the counter only tracks real attempts.
    if (provider === PROVIDER.CLAUDE_CLI) {
      const cap = _getClaudeCliMaxCallsPerRun();
      // Il confronto passa da `isPerRunCallCapReached`, non da un `>=` scritto
      // qui: e' la stessa funzione che i chiamanti interrogano PRIMA di
      // costruire il prompt, e due copie della soglia divergerebbero senza che
      // niente lo dica. Vedi il commento della funzione.
      if (isPerRunCallCapReached(model)) {
        _logPreflightSkipOnce(model, 'claudeCliCap', `claude-cli call cap reached (${cap}/run, CLAUDE_CLI_MAX_CALLS_PER_RUN)`);
        errors.push(`${model}: skipped — claude-cli call cap reached (${cap}/run)`);
        _recordLastResortSkip(model, 'claude-cli call cap reached');
        continue;
      }
      _claudeCliCallsThisRun++;
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
      _clampedTimeouts.delete(model); // an answer clears the adaptive-ceiling doubt
      _recordLastResortOutcome(model, 'served');
      if (provider === PROVIDER.CLAUDE_CLI) _claudeCliConsecutiveTimeouts = 0;
      if (provider === PROVIDER.OMNIROUTE) _omniRouteConsecutiveFailures = 0;

      if (i > 0) {
        console.warn(`✅ Fallback to ${model} succeeded (score → ${_modelScores.get(model) || 0})`);
      }
      // Surface the model used to the caller (out-param) so downstream
      // validation can penalize this specific model if the payload turns
      // out to be malformed despite the HTTP 200 response.
      if (o.modelUsedRef && typeof o.modelUsedRef === 'object') {
        o.modelUsedRef.model = model;
      }
      if (_cacheOn && _cacheKey !== null && !_isLastResortProvider(model)) {
        if (_responseCache.size >= RESPONSE_CACHE_MAX) {
          const oldest = _responseCache.keys().next().value;
          if (oldest !== undefined) _responseCache.delete(oldest);
        }
        // Store under a key that reflects the model that ACTUALLY answered —
        // not necessarily o.model, since o.model only sets the fallback
        // chain's start point and a failure there cascades to the next model
        // in the chain (#3080 class: a cache key computed from the requested
        // model, not the served one, lets a lower-tier fallback's output get
        // silently replayed on a later call with the identical o.model/prompt
        // once the requested model is available again).
        const storageKey = model === (o.model || null)
          ? _cacheKey
          : _responseCacheKey(messages, { ...o, model });
        _responseCache.set(storageKey, result);
      }
      return result;
    } catch (e) {
      const msg = e?.message || String(e);
      errors.push(`${model}: ${msg.slice(0, 200)}`);
      _recordLastResortOutcome(model, 'failed');

      // claude CLI binary missing (spawn ENOENT — install step failed/was
      // skipped). Unlike quota/timeout exhaustion this can't self-heal mid-run
      // (every remaining attempt this process is 100% certain to fail the same
      // way), so retrying it on every subsequent callLLM() call only burns the
      // score (run 29632759948: -595 over ~200 identical ENOENT retries).
      // Disable for the rest of THIS process only — not markModelExhausted,
      // which persists to Firestore for quota-style bans that carry across
      // runs; a later run's install step succeeding is a separate event this
      // process has no way to know about, so we don't want to ban it there too.
      if (e.code === 'ENOENT' && provider === PROVIDER.CLAUDE_CLI) {
        _claudeCliBinaryMissing = true;
        console.warn(`🚫 [${model}] claude CLI binary not found on PATH (spawn ENOENT) — disabling claude-cli fallback for the rest of this run`);
      }

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
        // local/fallback is exempt from the hard ban — see the matching
        // PROVIDER.LOCAL carve-out on recordModelContentFailure above: no
        // external quota, so exhausting it mid-run just guarantees zero
        // output for the rest of the wall-clock budget.
        if (count >= MAX_CONSECUTIVE_429 && !_isLastResortProvider(model)) {
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
      // Same PROVIDER.LOCAL exemption as the 429 branch above — _callLocal
      // intentionally raises the timeout floor for slow CPU inference, so a
      // timeout there is expected load, not a dead provider.
      const isTimeoutFailure = e.name === 'AbortError' || e.name === 'TimeoutError' || /timeout|aborted/i.test(msg);
      let markedExhausted = false;
      // A timeout served under a ceiling THIS module narrowed below what the
      // caller asked for is not yet evidence about the model: it is evidence
      // about our multiplier. Banning the run's best model on that would be
      // strictly worse than the 60s it saves — measured 2026-08-18, the model
      // that hangs is also the one with 172.042 successes and rank 1 of 340.
      // So the first such timeout costs one call and nothing else; from
      // ADAPTIVE_TIMEOUT_MAX_CLAMPED_FAILURES onwards the model is treated
      // exactly as before. Timeouts on the caller's OWN number are untagged
      // and keep the pre-existing behaviour with no change at all.
      let spared = false;
      if (isTimeoutFailure && e.adaptiveTimeoutClamped) {
        const n = (_clampedTimeouts.get(model) || 0) + 1;
        _clampedTimeouts.set(model, n);
        if (n <= ADAPTIVE_TIMEOUT_MAX_CLAMPED_FAILURES) {
          spared = true;
          console.warn(`⏱️  [${model}] Timed out at the adaptive ${Math.round((e.adaptiveTimeoutMs || 0) / 1000)}s ceiling (caller asked ${Math.round((o.timeout || 0) / 1000)}s) — not exhausting on our own guess (${n}/${ADAPTIVE_TIMEOUT_MAX_CLAMPED_FAILURES})`);
        }
      }
      if (isTimeoutFailure && !spared && !_isLastResortProvider(model)) {
        markModelExhausted(model, 'timeout');
        _stats.exhausted++;
        markedExhausted = true;
      }
      // claude-cli's own timeout-storm circuit breaker (see
      // _claudeCliTimeoutStormDetected declaration) — separate from the
      // markModelExhausted path above, which _isLastResortProvider exempts
      // claude-cli from.
      if (isTimeoutFailure && provider === PROVIDER.CLAUDE_CLI) {
        _claudeCliConsecutiveTimeouts++;
        if (_claudeCliConsecutiveTimeouts >= CLAUDE_CLI_TIMEOUT_STORM_THRESHOLD) {
          _claudeCliTimeoutStormDetected = true;
          console.warn(`🚫 [${model}] ${_claudeCliConsecutiveTimeouts} consecutive timeouts — disabling claude-cli fallback for the rest of this run`);
        }
      }
      // OmniRoute's own failure-storm breaker (see
      // _omniRouteFailureStormDetected declaration). Counts EVERY failure
      // class, not just timeouts: run 30427526187 alternated 30s timeouts
      // with instant HTTP 400s, so a timeout-only counter would have been
      // reset by each 400 and never tripped.
      if (provider === PROVIDER.OMNIROUTE) {
        _omniRouteConsecutiveFailures++;
        if (_omniRouteConsecutiveFailures >= OMNIROUTE_FAILURE_STORM_THRESHOLD) {
          _omniRouteFailureStormDetected = true;
          console.warn(`🚫 [${model}] ${_omniRouteConsecutiveFailures} consecutive failures — disabling OmniRoute for the rest of this run`);
        }
      }
      recordModelFailure(model, {
        nonRetryable: !!e.nonRetryable,
        exhausted: isExhausted || isTimeoutFailure,
      });

      console.warn(`❌ [${model}] Failed${markedExhausted ? ' (timeout → exhausted)' : ''} (score → ${_modelScores.get(model) || 0}): ${msg.slice(0, 200)}`);
      // Continue to next model in chain
    }
  }

  // All models failed
  const summary = errors.join(' | ');
  _stats.errors.push(summary);
  // Flush scores before throwing — ensures failure data is persisted
  await flushScores();

  // Prompt-budget report. The cascade's only move against an oversized payload
  // is to skip — it cannot shrink one — so when the chain empties partly or
  // wholly on input caps, the caller is the only party that CAN act, and up to
  // now it was told "too big" without a single number. Runs 31385602513 /
  // 31396507348 / 31402084443 (2026-08-10) are the shape of that: a ~9431-token
  // news prompt against a fleet whose highest declared cap is 8000, retried
  // with a byte-identical `messages` array.
  //
  // Why the MAXIMUM refusing cap is the actionable one (and the minimum is
  // merely informational): a retry succeeds as soon as ONE model accepts the
  // payload, so the target to fit under is the most permissive cap that still
  // said no. Fitting under the MINIMUM instead (3000, nvidia/nemotron-mini-4b)
  // would demand a cut ~2.7x deeper than necessary, and for prompts with an
  // irreducible core it can be arithmetically unreachable — the caller would
  // conclude "impossible" about a budget 5000 tokens below the one that would
  // actually have worked. Both are exposed; retryRequestTokenBudget names the
  // one to aim at so a caller need not re-derive the argument above.
  let message = `All AI models failed. Chain: [${chain.join(' → ')}]. Errors: ${summary}`;
  let capReport = null;
  if (inputCapSkips.length) {
    const limits = inputCapSkips.map((s) => s.reqLimit);
    capReport = {
      count: inputCapSkips.length,
      maxSkippedReqLimit: Math.max(...limits),
      minSkippedReqLimit: Math.min(...limits),
      estimatedRequestTokens: Math.max(...inputCapSkips.map((s) => s.estTokens)),
    };
    const over = capReport.estimatedRequestTokens - capReport.maxSkippedReqLimit;
    message += ` | Prompt budget: ${capReport.count} model(s) refused a ~${capReport.estimatedRequestTokens}-token request;`
      + ` the most permissive cap among them is ${capReport.maxSkippedReqLimit} tokens (over by ~${over}).`
      + ` A retry must rebuild the prompt under ${capReport.maxSkippedReqLimit} tokens — resending the same messages cannot succeed.`;
    console.warn(
      `📏 Prompt budget: ~${capReport.estimatedRequestTokens} est. tokens vs a ${capReport.maxSkippedReqLimit}-token best cap`
      + ` (${capReport.count} model(s) skipped on input cap, tightest ${capReport.minSkippedReqLimit}) — shrink by ≥${over} tokens to retry.`,
    );
  }

  const err = new Error(message);
  err.code = 'ALL_MODELS_EXHAUSTED';
  // Always defined (null when no model refused on size), so a caller can branch
  // on presence without probing for undefined properties.
  err.inputCapReport = capReport;
  if (capReport) {
    err.retryRequestTokenBudget = capReport.maxSkippedReqLimit;
    err.maxSkippedReqLimit = capReport.maxSkippedReqLimit;
    err.minSkippedReqLimit = capReport.minSkippedReqLimit;
    err.estimatedRequestTokens = capReport.estimatedRequestTokens;
  }
  // Classify the AGGREGATE cause so callers can distinguish a TRANSIENT pool
  // exhaustion (daily quota / rate-limit / provider cooldown / timeout — self-
  // heals at the next window) from a PERSISTENT fault (stale keys 401, depleted
  // credits 402, removed models 404, chronically oversized payload 413, missing
  // API keys) that needs a human alert. create-article.mjs defers (exit 0) only
  // on a transient-dominant run; a persistent-dominant run still exits non-zero
  // and raises the Workflow-Failure issue, so the safety net from #1652 stays
  // intact for real outages (stale keys, provider down, prompt always too big).
  //
  // The input-cap class stays PERSISTENT on purpose, unchanged by the budget
  // report above: a prompt larger than every declared cap does not get smaller
  // at the next quota window, so deferring on it would loop forever and swallow
  // the alert. The report doesn't reclassify the failure — it hands the caller
  // the number it needs to fix the prompt and try again deliberately.
  err.exhaustionBreakdown = classifyExhaustionCause(errors);
  err.transientExhaustion = err.exhaustionBreakdown.transient > 0
    && err.exhaustionBreakdown.transient >= err.exhaustionBreakdown.persistent;
  throw err;
}

/**
 * Tally per-model failure reasons collected by callLLM into transient vs
 * persistent buckets. Transient = quota/rate/cooldown/timeout/5xx/overloaded
 * (recovers on its own). Persistent = auth/credit/removed-model/payload/no-key
 * (needs intervention). Reasons matching neither are ignored in the tally.
 */
export function classifyExhaustionCause(errors) {
  // `non-retryable provider error`, `no longer offered`, `repeated unusable
  // content` and `no longer available` are the vocabulary _exhaustSkipCause and
  // classifyNonRetryableError emit. They are named here EXPLICITLY rather than
  // left to be caught incidentally by the `\b40[124]\b` alternative: a phrase
  // that classifies correctly only because it happens to contain a status code
  // is one rewording away from silently flipping a persistent fault to
  // transient — which is exactly the failure this pair of regexes suffered.
  const persistentRe = /\b40[124]\b|tokens?_limit_reached|context.?length|maximum context|too many tokens|exceeds .*input cap|max output \d+ <|no API key|unknown.?model|no such model|does not exist|decommissioned|deprecated|no longer supported|no longer available|no longer offered|non-retryable|unusable content|payment|insufficient|credit/i;
  // `timed out` alongside `timeout`: the claude-CLI provider rejects with
  // "claude CLI timed out after 120000ms", which matched NEITHER regex and fell
  // into the ignored ambiguous bucket — leaving the one model that was actually
  // invoked out of the tally entirely (run 31823202761, 10 timeouts, 0 counted).
  const transientRe = /daily (request )?limit|daily quota|exceeded your current quota|plan and billing|free.?models.?per.?day|\b429\b|rate.?limit|resource.?exhausted|cooling down|timeout|timed out|aborted|overloaded|\b5\d\d\b|temporarily/i;
  let transient = 0;
  let persistent = 0;
  for (const reason of errors) {
    const isTransient = transientRe.test(reason);
    const isPersistent = persistentRe.test(reason);
    if (isTransient) transient += 1;
    else if (isPersistent) persistent += 1;
    // neither → ambiguous, left out of the tally
  }
  return { transient, persistent, total: errors.length };
}
