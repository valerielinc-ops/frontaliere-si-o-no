#!/usr/bin/env python3
"""
local-mt-translate.py — in-process, $0, no-external-API machine translation for
the job-translation pipeline. Engine: Argos Translate (OpenNMT/CTranslate2 int8
models, the SAME models LibreTranslate wraps) used as a DIRECT PYTHON LIBRARY —
NO HTTP server, NO healthcheck race, models loaded ONCE per process.

Why a library and not the LibreTranslate Docker service: the service container
was 100% dead on the runner (1483 timeouts, 0 successes) because its /languages
healthcheck passes BEFORE models load, so the first /translate cold-load exceeds
the 30s client timeout and the cascade abandons it (death spiral). Loading Argos
in-process eliminates the HTTP layer and the race entirely.

Protocol (so the Node orchestrator owns all slice I/O and the exact
isIncomplete()/needsRetranslation predicate from relocalize-pending-jobs.mjs):
  - stdin:  one JSON request object per line (JSONL):
              {"id": "<opaque>", "text": "<source text>", "from": "it", "to": "de"}
  - stdout: one JSON response object per line (JSONL); match on "id":
              {"id": "<opaque>", "text": "<translated text>"}            (ok)
              {"id": "<opaque>", "error": "<message>"}                   (failed)
  - stderr: human progress + a final summary line.

Throughput design (this is the local-MT WORKHORSE — relocalize-pending-jobs's
cascade leads with the same Opus models but via the much slower onnxruntime; here
CTranslate2 int8 does the bulk). Three multipliers over a naive per-request loop:
  1. STRUCTURE-AWARE segmentation — a job description is split into lines; blank
     lines and leading markdown markers (## headings, -/*/• bullets, "1." lists)
     are preserved VERBATIM and only the prose content of each line is translated.
     The whole-blob translate() flattened that structure (the audit's bullet/
     heading ratchet then re-flagged the job). Each prose line becomes one unit.
  2. DEDUP — boilerplate repeats massively across a company's postings
     ("Cosa offriamo", "Sede di lavoro: Ticino", section headers). Identical
     (text, from, to) units are translated ONCE and fanned back out to every
     request that needs them.
  3. PARALLELISM — CTranslate2 releases the GIL during translate(), so a thread
     pool gives real multi-core speedup on the runner. Models are pre-warmed
     single-threaded first (Argos lazily builds the pivot chain (src→en→tgt) on
     the first call per direction; doing that concurrently races on shared model-
     graph construction). After pre-warm, concurrent calls to tr.translate() are
     safe: CTranslate2 Translator objects are designed for concurrent inference —
     each translate_batch() call allocates its own beam state and the model weights
     are read-only (https://opennmt.net/CTranslate2/parallel.html: "the model is
     thread-safe and can be used simultaneously from multiple threads"). Pivot
     directions (it→de, it→fr) both route internally through the shared it→en
     Translator; this is safe for the same reason — weights are never mutated
     during inference. Set LOCAL_MT_WORKERS=1 to force the sequential path if the
     assumption breaks (e.g. after a CTranslate2 version regression).

Partial-result safety: a request is emitted (and stdout flushed) the moment ALL
of its units have resolved, so when the Node orchestrator kills this process at
its wall-clock budget the maximum number of COMPLETE field translations have
already been written and parsed (mirrors the old streaming guarantee, only now
completion is unit-level rather than strictly input order).

Language coverage: Argos ships only xx<->en packages for it/en/de/fr (no direct
it<->de, it<->fr, de<->fr). Argos' translate() auto-PIVOTS through English when a
direct package is absent, so all 12 ordered pairs work as long as every xx<->en
package is installed. install_models() installs exactly those 6 packages.

Usage:
  # install models (idempotent; downloads ~ a few hundred MB once, then cached):
  python3 scripts/local-mt-translate.py --install
  # translate a JSONL stream:
  cat batch.jsonl | python3 scripts/local-mt-translate.py
Env:
  LOCAL_MT_ENGINE  — `batched` (default) or `legacy`. `legacy` is the per-unit
                     thread-pool path below; `batched` (see _BatchedEngine) feeds
                     CTranslate2 whole chunks of units instead of one line per call.
  LOCAL_MT_WORKERS — thread-pool size of the legacy path (default: CPU count,
                     capped to [1, 8]). Set 1 to force the sequential path.
  LOCAL_MT_BATCH_UNITS  — units per batched chunk (default 256): the emit
                     granularity, so a timeout kill loses at most one chunk.
  LOCAL_MT_BATCH_TOKENS — CTranslate2 max_batch_size in tokens for the batched
                     engine (default 4096). Argos' own default is 32 tokens, i.e.
                     one or two sentences per forward pass.
  LOCAL_MT_UNIT_CACHE — optional JSONL file of already-translated units. Loaded at
                     start (those units are not translated again) and appended
                     after every chunk, so the work a timeout kill interrupts is
                     reused by the next pass (Phase 2c, or the next run when the
                     workflow caches the file) instead of being redone.
"""

import argparse
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

LOCALES = ("it", "en", "de", "fr")

# Every xx<->en pair we need; Argos pivots the cross pairs (e.g. de->it = de->en->it)
# through English automatically once these are present.
REQUIRED_PAIRS = [
    ("de", "en"), ("en", "de"),
    ("it", "en"), ("en", "it"),
    ("fr", "en"), ("en", "fr"),
]

# A line that is ONLY a structural marker + optional content. Group 1 captures the
# leading whitespace + marker (preserved verbatim); group 2 the translatable prose.
# Markers: markdown headings (#..######), bullets (-, *, •), ordered lists (1. / 1)).
_MARKER_RE = re.compile(r"^(\s*(?:#{1,6}\s+|[-*•]\s+|\d+[.)]\s+)?)(.*)$")
# A line with no letters to translate (pure separators/punctuation/numbers) — leave
# it untouched so we never waste a translate() call or corrupt rule lines.
_HAS_LETTERS_RE = re.compile(r"[^\W\d_]", re.UNICODE)


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def _resolve_workers():
    raw = os.environ.get("LOCAL_MT_WORKERS", "").strip()
    if raw:
        try:
            return max(1, min(8, int(raw)))
        except ValueError:
            pass
    return max(1, min(8, os.cpu_count() or 2))


def _env_int(name, default, low, high):
    raw = os.environ.get(name, "").strip()
    try:
        return max(low, min(high, int(raw))) if raw else default
    except ValueError:
        return default


def models_ready():
    """True if every REQUIRED_PAIRS direction is already installed locally — checked
    WITHOUT any network call. The streaming path uses this to avoid re-hitting
    update_package_index() (a network fetch) on every run: in CI the models are
    installed once in a dedicated `--install` step, so the translate step must
    work fully offline.

    Checks installed *packages* (from_code, to_code), not installed *language
    codes*: a partial install (e.g. de->en/it->en/fr->en present but every en->X
    direction missing) still covers every LOCALES code as a language endpoint on
    one side or the other, so a codes-only check would report ready and — once
    that partial state is cached — permanently skip retrying the missing
    directions."""
    try:
        import argostranslate.package as pkg
        installed_pairs = {(p.from_code, p.to_code) for p in pkg.get_installed_packages()}
        return all(pair in installed_pairs for pair in REQUIRED_PAIRS)
    except Exception:  # noqa: BLE001
        return False


def install_models(max_retries=5):
    """Install the xx<->en Argos packages for it/en/de/fr. Idempotent and
    retried — the HuggingFace CDN occasionally drops the TLS connection mid
    download, which must not abort the whole pipeline step."""
    import argostranslate.package as pkg

    pkg.update_package_index()
    available = pkg.get_available_packages()

    def find(frm, to):
        for p in available:
            if p.from_code == frm and p.to_code == to:
                return p
        return None

    installed = 0
    for frm, to in REQUIRED_PAIRS:
        p = find(frm, to)
        if p is None:
            log(f"⚠️  No Argos package for {frm}->{to} — skipping (pivot may degrade)")
            continue
        last_err = None
        for attempt in range(1, max_retries + 1):
            try:
                p.install()
                installed += 1
                log(f"✅ Installed Argos model {frm}->{to}")
                break
            except Exception as e:  # noqa: BLE001 — network errors vary; retry all
                last_err = e
                wait = attempt * 3
                log(f"   retry {frm}->{to} ({attempt}/{max_retries}): "
                    f"{type(e).__name__} — waiting {wait}s")
                time.sleep(wait)
        else:
            log(f"❌ Failed to install {frm}->{to} after {max_retries} attempts: {last_err}")
    log(f"📦 Argos model install complete: {installed}/{len(REQUIRED_PAIRS)} packages ready")
    return installed


def _segment(text):
    """Split a source field into an ordered list of segments. Each segment is
    either a verbatim literal (blank line, marker-only line, or a line with no
    translatable letters) or a translatable unit. Returns (segments, unit_texts)
    where segments is a list of ("lit", str) | ("unit", line_index) and
    unit_texts maps the unit's line_index -> {"prefix", "content"}."""
    segments = []
    units = {}
    for raw_line in text.split("\n"):
        m = _MARKER_RE.match(raw_line)
        prefix, content = (m.group(1), m.group(2)) if m else ("", raw_line)
        if not content.strip() or not _HAS_LETTERS_RE.search(content):
            # Blank line, marker-only line, or separators/numbers: keep verbatim.
            segments.append(("lit", raw_line))
            continue
        idx = len(units)
        units[idx] = {"prefix": prefix, "content": content}
        segments.append(("unit", idx))
    return segments, units


class _BatchedEngine:
    """Argos' own translation chain, run on whole chunks of units.

    Why. `tr.translate()` turns every unit into its own CTranslate2
    `translate_batch` call (one or two sentences, max_batch_size=32 tokens),
    plus one Stanza pass per unit, and a pivot direction (it->de) re-runs the
    it->en leg once per target locale. On the corpus run 37272320066
    (2026-10-05) the 4-thread pool resolved ~2.5 units/s: 4169 of 14512
    requests in 70 minutes, against 134072 unique units queued.

    What stays identical. The same installed packages, the same chain Argos
    resolves for (from, to) (CachedTranslation / CompositeTranslation unwrapped
    to its PackageTranslation legs), the same sentencizer, the same
    tokenizer, the same translate_batch options (beam_size, length_penalty,
    replace_unknowns, target_prefix, num_hypotheses=1) and the same decode and
    paragraph joining as argostranslate 1.11 apply_packaged_translation(). What
    changes: many sentences per forward pass, one Stanza call per chunk
    (documents batched), and each leg's output memoised per (package, text), so
    the it->en leg of it->de and it->fr is computed once.

    Any exception building the chain or running a leg is raised to the caller,
    which falls back to the legacy per-unit path for that chunk."""

    def __init__(self, tr, batch_tokens, settings=None):
        self.tr = tr
        self.batch_tokens = batch_tokens
        self._chains = {}
        self._memo = {}   # (leg key, text) -> translated text
        for name in ("get_translation_from_codes", "CachedTranslation",
                     "CompositeTranslation", "IdentityTranslation", "PackageTranslation"):
            if not hasattr(tr, name):
                raise AttributeError(f"argostranslate.translate.{name} missing")
        if settings is None:
            import argostranslate.settings as settings
        self.settings = settings

    def _legs(self, translation):
        tr = self.tr
        if isinstance(translation, tr.CachedTranslation):
            return self._legs(translation.underlying)
        if isinstance(translation, tr.CompositeTranslation):
            return self._legs(translation.t1) + self._legs(translation.t2)
        if isinstance(translation, tr.IdentityTranslation):
            return []
        if isinstance(translation, tr.PackageTranslation):
            return [translation]
        raise TypeError(f"unsupported Argos translation {type(translation).__name__}")

    def chain(self, frm, to):
        key = (frm, to)
        if key not in self._chains:
            translation = self.tr.get_translation_from_codes(frm, to)
            if translation is None:
                raise LookupError(f"no Argos translation {frm}->{to}")
            legs = self._legs(translation)
            if not legs:
                raise LookupError(f"empty Argos chain {frm}->{to}")
            self._chains[key] = legs
        return self._chains[key]

    def _translator(self, leg):
        if leg.translator is None:
            import ctranslate2
            s = self.settings
            leg.translator = ctranslate2.Translator(
                str(leg.pkg.package_path / "model"),
                device=s.device,
                inter_threads=s.inter_threads,
                intra_threads=s.intra_threads,
                compute_type=s.compute_type,
            )
        return leg.translator

    def _split_many(self, leg, paragraphs):
        """Sentence lists for many paragraphs; one Stanza call when the leg's
        sentencizer is Stanza (documents are segmented independently), else the
        sentencizer per paragraph exactly as Argos calls it."""
        sentencizer = leg.sentencizer
        pipeline = getattr(sentencizer, "lazy_pipeline", None)
        if pipeline is None:
            return [sentencizer.split_sentences(p) for p in paragraphs]
        out = [[] for _ in paragraphs]
        live = [i for i, p in enumerate(paragraphs) if p.strip()]
        if live:
            import stanza
            docs = pipeline()([stanza.Document([], text=paragraphs[i]) for i in live])
            for i, doc in zip(live, docs):
                out[i] = [sent.text for sent in doc.sentences]
        return out

    def _run_leg(self, leg, texts):
        """Translate distinct texts through one PackageTranslation leg."""
        pkg = leg.pkg
        # Argos splits every input on "\n" (CachedTranslation, then
        # PackageTranslation) and translates each paragraph on its own.
        paragraphs = []
        owners = []
        for t_index, text in enumerate(texts):
            for paragraph in text.split("\n"):
                owners.append(t_index)
                paragraphs.append(paragraph)
        sentence_lists = self._split_many(leg, paragraphs)
        flat = []
        flat_owner = []
        for p_index, sentences in enumerate(sentence_lists):
            for sentence in sentences:
                flat.append(pkg.tokenizer.encode(sentence))
                flat_owner.append(p_index)
        tokens_by_paragraph = [[] for _ in paragraphs]
        if flat:
            target_prefix = [[pkg.target_prefix]] * len(flat) if pkg.target_prefix != "" else None
            results = self._translator(leg).translate_batch(
                flat,
                target_prefix=target_prefix,
                replace_unknowns=True,
                max_batch_size=self.batch_tokens,
                batch_type="tokens",
                beam_size=max(1, self.settings.beam_size),
                num_hypotheses=1,
                length_penalty=0.2,
                return_scores=True,
            )
            for p_index, result in zip(flat_owner, results):
                tokens_by_paragraph[p_index].extend(result.hypotheses[0])
        values = []
        for tokens in tokens_by_paragraph:
            value = pkg.tokenizer.decode(tokens)
            if pkg.target_prefix != "" and value.startswith(pkg.target_prefix):
                value = value[len(pkg.target_prefix):]
            if len(value) > 0 and value[0] == " ":
                value = value[1:]
            values.append(value)
        joined = [[] for _ in texts]
        for t_index, value in zip(owners, values):
            joined[t_index].append(value)
        return ["\n".join(parts).lstrip("\n") for parts in joined]

    def translate_keys(self, keys):
        """keys: [(content, from, to)] -> {key: translated text}."""
        chains = {key: self.chain(key[1], key[2]) for key in keys}
        current = {key: key[0] for key in keys}
        depth = max((len(legs) for legs in chains.values()), default=0)
        for level in range(depth):
            pending = {}  # leg -> [text]
            for key, legs in chains.items():
                if level >= len(legs):
                    continue
                leg = legs[level]
                memo_key = (id(leg), current[key])
                if memo_key not in self._memo:
                    bucket = pending.setdefault(id(leg), (leg, []))[1]
                    bucket.append(current[key])
            for leg, texts in pending.values():
                distinct = list(dict.fromkeys(texts))
                for text, out in zip(distinct, self._run_leg(leg, distinct)):
                    self._memo[(id(leg), text)] = out
            for key, legs in chains.items():
                if level < len(legs):
                    current[key] = self._memo[(id(legs[level]), current[key])]
        return current


def _load_unit_cache(path, signature):
    cache = {}
    if not path or not os.path.exists(path):
        return cache
    try:
        with open(path, "r", encoding="utf-8") as handle:
            for line in handle:
                try:
                    row = json.loads(line)
                except Exception:  # noqa: BLE001 — a torn last line after a kill
                    continue
                if row.get("s") != signature:
                    continue
                key = row.get("k")
                out = row.get("v")
                if isinstance(key, list) and len(key) == 3 and isinstance(out, str) and out.strip():
                    cache[tuple(key)] = out
    except OSError as e:
        log(f"⚠️  unit cache unreadable ({e}) — starting empty")
    return cache


def _engine_signature():
    """Units cached under another engine/model setup are not reused."""
    try:
        from importlib.metadata import version
        argos = version("argostranslate")
    except Exception:  # noqa: BLE001
        argos = "unknown"
    beam = os.environ.get("ARGOS_BEAM_SIZE", "4")
    return f"argos-{argos}|beam-{beam}"


def translate_stream():
    """Read JSONL translation requests from stdin, emit JSONL responses on stdout.

    Pipeline: segment every request (structure-aware) → collect unique
    (content, from, to) units → pre-warm directions single-threaded → translate
    unique units across a thread pool → reassemble + flush each request as soon
    as all its units resolve (partial-result safe under an external timeout kill).
    Models load ONCE (argostranslate caches them in-process).

    Cache-hit offline guarantee (verified against argostranslate 1.11.0 source,
    follow-up to #3334): tr.translate() -> get_translation_from_codes() ->
    get_installed_languages() builds its language/pivot graph from
    package.get_installed_packages(), which scans the on-disk package dirs
    directly. It never reads settings.local_package_index — that file (and the
    in-memory list get_available_packages() parses from it) is only touched by
    update_package_index()/install_models(), used solely to discover packages
    to INSTALL. So skipping update_package_index() on a models_ready() cache
    hit cannot desync translate_stream(): the two paths don't share state."""
    import argostranslate.translate as tr

    started = time.time()

    # ── Read + segment all requests ─────────────────────────────────────────
    requests = []   # {id, from, to, segments, units}
    bad = 0
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
        except Exception as e:  # noqa: BLE001
            bad += 1
            sys.stdout.write(json.dumps({"id": None, "error": f"bad json: {e}"}) + "\n")
            sys.stdout.flush()
            continue
        rid = req.get("id")
        text = req.get("text") or ""
        frm = req.get("from")
        to = req.get("to")
        if not text.strip() or frm not in LOCALES or to not in LOCALES or frm == to:
            bad += 1
            sys.stdout.write(json.dumps({"id": rid, "error": "invalid request"}) + "\n")
            sys.stdout.flush()
            continue
        segments, units = _segment(text)
        requests.append({"id": rid, "from": frm, "to": to,
                         "segments": segments, "units": units})

    # ── Collect unique translation units across all requests (dedup) ────────
    # key = (content, from, to) → translated text (filled below).
    unit_cache = {}
    for req in requests:
        for u in req["units"].values():
            unit_cache.setdefault((u["content"], req["from"], req["to"]), None)

    directions = {(frm, to) for (_c, frm, to) in unit_cache}
    engine = os.environ.get("LOCAL_MT_ENGINE", "batched").strip().lower() or "batched"
    workers = _resolve_workers()

    # Units already translated by an earlier pass (Phase 2a for Phase 2c, or a
    # previous run when the workflow caches the file): resolved without Argos.
    cache_path = os.environ.get("LOCAL_MT_UNIT_CACHE", "").strip()
    signature = _engine_signature()
    stored = _load_unit_cache(cache_path, signature)
    reused = 0
    for key in unit_cache:
        if key in stored:
            unit_cache[key] = stored[key]
            reused += 1
    if cache_path and os.path.exists(cache_path):
        # Compact: keep only the rows this queue still needs. A unit whose
        # slots were written is no longer queued, so the file stays bounded by
        # the pending work instead of growing run after run.
        tmp = f"{cache_path}.{os.getpid()}.tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as handle:
                for key, out in unit_cache.items():
                    if out is not None:
                        handle.write(json.dumps({"s": signature, "k": list(key), "v": out},
                                                ensure_ascii=False) + "\n")
            os.replace(tmp, cache_path)
        except OSError as e:
            log(f"⚠️  unit cache not compacted ({e})")
            try:
                os.unlink(tmp)
            except OSError:
                pass
    log(f"🐍 Argos: {len(requests)} requests · {len(unit_cache)} unique units · "
        f"{len(directions)} directions · engine {engine}"
        + (f" · {workers} workers" if engine == "legacy" else "")
        + (f" · {reused} units reused from {os.path.basename(cache_path)}" if cache_path else ""))

    def _prewarm():
        # Argos lazily builds the pivot chain (src→en→tgt) on the FIRST translate()
        # for a direction; doing that concurrently races on shared model-graph
        # construction state. Warm each direction sequentially so that by the
        # time the thread pool starts, all lazy chain construction is complete and
        # subsequent tr.translate() calls only perform inference — which IS
        # thread-safe (CTranslate2 Translator: read-only weights, per-call beam state).
        for frm, to in directions:
            try:
                tr.translate("test", frm, to)
            except Exception as e:  # noqa: BLE001
                log(f"⚠️  warmup {frm}->{to} failed: {type(e).__name__}: {e}")

    # ── Translate unique units (parallel; CTranslate2 releases the GIL) ──────
    # Safe: pre-warm resolved all lazy chain builds; CTranslate2 Translator is
    # documented thread-safe for concurrent inference (read-only weights, each
    # call owns its beam state). Pivot directions sharing the it→en Translator
    # (e.g. it→de and it→fr) are not a concern — same thread-safety guarantee.
    def _do(key):
        content, frm, to = key
        try:
            out = tr.translate(content, frm, to)
            return key, (out or "")
        except Exception:  # noqa: BLE001
            return key, ""

    # INCREMENTAL EMIT (partial-result safety, #2212): a request is reassembled
    # and flushed the MOMENT all of its units resolve — interleaved with the pool,
    # NOT in a final loop after the whole batch. So a timeout kill mid-pool still
    # leaves every already-complete request written to stdout and parseable by the
    # orchestrator's timedOut branch (the dedup-batch restructure would otherwise
    # have buffered every emit until the end and lost the whole batch on a kill).
    ok = 0
    failed = 0

    def _emit(req):
        nonlocal ok, failed
        rid, frm, to = req["id"], req["from"], req["to"]
        parts = []
        unit_total = 0
        unit_failed = 0
        for kind, payload in req["segments"]:
            if kind == "lit":
                parts.append(payload)
                continue
            u = req["units"][payload]
            unit_total += 1
            out = unit_cache.get((u["content"], frm, to)) or ""
            if out.strip():
                parts.append(u["prefix"] + out.strip())
            else:
                # Unit failed: keep the source content so the field stays readable;
                # downstream contamination/length gates re-flag if it's too weak.
                unit_failed += 1
                parts.append(u["prefix"] + u["content"])
        text = "\n".join(parts).strip()
        # Reject if nothing translated or >50% of units failed (a mostly-source
        # blob would just get re-flagged — emit an error so the orchestrator's
        # "never write a source copy" guard isn't even exercised).
        if not text or (unit_total > 0 and unit_failed * 2 > unit_total):
            failed += 1
            sys.stdout.write(json.dumps({"id": rid, "error": "translation failed"}) + "\n")
        else:
            ok += 1
            sys.stdout.write(json.dumps({"id": rid, "text": text}, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    # Dependency map: request -> set of still-unresolved unit keys; key -> the
    # requests waiting on it. A request emits as soon as its pending set empties.
    pending = {}   # id(req) -> set(key) | None (None = already emitted)
    key_deps = {}  # key -> [req, ...]
    for req in requests:
        ks = {(u["content"], req["from"], req["to"]) for u in req["units"].values()}
        pending[id(req)] = ks
        for k in ks:
            key_deps.setdefault(k, []).append(req)
        if not ks:
            # All-literal request (no translatable content): emit immediately.
            pending[id(req)] = None
            _emit(req)

    def _resolve(key, out):
        unit_cache[key] = out
        for req in key_deps.get(key, ()):
            s = pending.get(id(req))
            if s is None:
                continue
            s.discard(key)
            if not s:
                pending[id(req)] = None  # guard against a second emit
                _emit(req)

    cache_out = None
    if cache_path:
        try:
            torn = False
            if os.path.exists(cache_path) and os.path.getsize(cache_path) > 0:
                with open(cache_path, "rb") as handle:
                    handle.seek(-1, os.SEEK_END)
                    torn = handle.read(1) != b"\n"
            cache_out = open(cache_path, "a", encoding="utf-8")
            if torn:
                # A kill mid-write left half a row: start ours on a new line.
                cache_out.write("\n")
        except OSError as e:
            log(f"⚠️  unit cache not writable ({e}) — continuing without it")

    def _store(key, out):
        if cache_out is None or not out.strip():
            return
        cache_out.write(json.dumps({"s": signature, "k": list(key), "v": out},
                                   ensure_ascii=False) + "\n")

    # Cached units first: their requests emit before any model runs.
    keys = []
    for key, out in list(unit_cache.items()):
        if out is None:
            keys.append(key)
        else:
            _resolve(key, out)

    def _run_legacy(chunk_keys):
        if workers <= 1 or len(chunk_keys) <= 1:
            for key in chunk_keys:
                _, out = _do(key)
                _store(key, out)
                _resolve(key, out)
        else:
            with ThreadPoolExecutor(max_workers=workers) as pool:
                for key, out in (f.result() for f in as_completed(
                        [pool.submit(_do, k) for k in chunk_keys])):
                    _store(key, out)
                    _resolve(key, out)

    translated_units = 0
    batch = None
    if engine != "legacy":
        try:
            batch = _BatchedEngine(tr, _env_int("LOCAL_MT_BATCH_TOKENS", 4096, 64, 65536))
        except Exception as e:  # noqa: BLE001
            log(f"⚠️  batched engine unavailable ({type(e).__name__}: {e}) — legacy path")
    if batch is None:
        _prewarm()
        _run_legacy(keys)
        translated_units = len(keys)
    else:
        chunk_units = _env_int("LOCAL_MT_BATCH_UNITS", 256, 1, 100000)
        fallback_warmed = False
        last_report = time.time()
        # Units keep request order (titles first, traffic order inside), so the
        # chunks finish requests in the order the orchestrator queued them.
        for start in range(0, len(keys), chunk_units):
            chunk_keys = keys[start:start + chunk_units]
            try:
                outs = batch.translate_keys(chunk_keys)
            except Exception as e:  # noqa: BLE001
                log(f"⚠️  batched chunk failed ({type(e).__name__}: {e}) — "
                    f"legacy path for these {len(chunk_keys)} units")
                if not fallback_warmed:
                    _prewarm()
                    fallback_warmed = True
                _run_legacy(chunk_keys)
            else:
                for key in chunk_keys:
                    out = outs.get(key) or ""
                    _store(key, out)
                    _resolve(key, out)
            translated_units += len(chunk_keys)
            if cache_out is not None:
                cache_out.flush()
            if time.time() - last_report >= 60:
                last_report = time.time()
                rate = translated_units / max(1e-6, time.time() - started)
                log(f"   … {translated_units}/{len(keys)} units · {ok} requests done · {rate:.1f} units/s")

    if cache_out is not None:
        cache_out.close()
    elapsed = time.time() - started
    log(f"🏁 Argos translate: {ok} ok, {failed + bad} failed in {elapsed:.1f}s "
        f"({len(unit_cache)} unique units across {len(requests)} requests; "
        f"{translated_units} translated, {reused} reused; "
        f"{translated_units / max(1e-6, elapsed):.1f} units/s)")


def main():
    ap = argparse.ArgumentParser(description="In-process Argos Translate worker")
    ap.add_argument("--install", action="store_true",
                    help="Install/refresh Argos models and exit")
    args = ap.parse_args()

    if args.install:
        # OFFLINE check first: a restored actions/cache of package_data_dir makes
        # get_installed_languages() report every locale already present, so we can
        # skip install_models() entirely — it otherwise re-hits update_package_index()
        # (network) and re-downloads every .argosmodel unconditionally (Package.install()
        # always calls download(), which only skips the fetch if the file is already in
        # settings.downloads_dir — a separate, uncached directory — not package_data_dir).
        if models_ready():
            log("✅ All Argos models already installed (cache hit) — skipping install_models()")
            sys.exit(0)
        installed = install_models()
        sys.exit(0 if installed > 0 else 1)

    # Ensure models are present before streaming. Prefer the OFFLINE check: if all
    # locales are already installed (the normal CI case after the `--install`
    # step) we never touch the network. Only fall back to install_models() — which
    # does a network index fetch — when something is genuinely missing.
    if not models_ready():
        log("ℹ️  Models not all present — installing before streaming...")
        install_models()
    translate_stream()


if __name__ == "__main__":
    main()
