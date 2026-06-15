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

Language coverage: Argos ships only xx<->en packages for it/en/de/fr (no direct
it<->de, it<->fr, de<->fr). Argos' translate() auto-PIVOTS through English when a
direct package is absent, so all 12 ordered pairs work as long as every xx<->en
package is installed. install_models() installs exactly those 6 packages.

Usage:
  # install models (idempotent; downloads ~ a few hundred MB once, then cached):
  python3 scripts/local-mt-translate.py --install
  # translate a JSONL stream:
  cat batch.jsonl | python3 scripts/local-mt-translate.py
"""

import argparse
import json
import sys
import time

LOCALES = ("it", "en", "de", "fr")

# Every xx<->en pair we need; Argos pivots the cross pairs (e.g. de->it = de->en->it)
# through English automatically once these are present.
REQUIRED_PAIRS = [
    ("de", "en"), ("en", "de"),
    ("it", "en"), ("en", "it"),
    ("fr", "en"), ("en", "fr"),
]


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def models_ready():
    """True if every locale we need is already installed locally — checked WITHOUT
    any network call. The streaming path uses this to avoid re-hitting
    update_package_index() (a network fetch) on every run: in CI the models are
    installed once in a dedicated `--install` step, so the translate step must
    work fully offline."""
    try:
        import argostranslate.translate as tr
        codes = {l.code for l in tr.get_installed_languages()}
        return all(loc in codes for loc in LOCALES)
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


def translate_stream():
    """Read JSONL translation requests from stdin, emit JSONL responses on
    stdout. Models are loaded ONCE (argostranslate caches them in-process); the
    first translate() call may take a few seconds, the rest are <500ms."""
    import argostranslate.translate as tr

    ok = 0
    failed = 0
    started = time.time()
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
        except Exception as e:  # noqa: BLE001
            failed += 1
            sys.stdout.write(json.dumps({"id": None, "error": f"bad json: {e}"}) + "\n")
            sys.stdout.flush()
            continue

        rid = req.get("id")
        text = req.get("text") or ""
        frm = req.get("from")
        to = req.get("to")
        if not text.strip() or frm not in LOCALES or to not in LOCALES or frm == to:
            failed += 1
            sys.stdout.write(json.dumps({"id": rid, "error": "invalid request"}) + "\n")
            sys.stdout.flush()
            continue

        try:
            out = tr.translate(text, frm, to)
            if not out or not out.strip():
                raise ValueError("empty translation")
            ok += 1
            sys.stdout.write(json.dumps({"id": rid, "text": out}, ensure_ascii=False) + "\n")
        except Exception as e:  # noqa: BLE001
            failed += 1
            sys.stdout.write(json.dumps({"id": rid, "error": str(e)}) + "\n")
        sys.stdout.flush()

    elapsed = time.time() - started
    log(f"🏁 Argos translate: {ok} ok, {failed} failed in {elapsed:.1f}s")


def main():
    ap = argparse.ArgumentParser(description="In-process Argos Translate worker")
    ap.add_argument("--install", action="store_true",
                    help="Install/refresh Argos models and exit")
    args = ap.parse_args()

    if args.install:
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
