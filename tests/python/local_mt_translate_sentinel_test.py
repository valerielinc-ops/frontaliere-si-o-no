#!/usr/bin/env python3
"""
local_mt_translate_sentinel_test.py — #5587 item1.

WHAT THIS PROVES, AND WHAT IT DOES NOT.
----------------------------------------
scripts/local-mt-translate.py is the Argos Translate worker for the highest-
volume translation tier (see its own header: "this tier produces the BULK of
the mop-up-translated corpus"). The gender-trigraph guard
(scripts/lib/translation-glossary.mjs, #5562) masks a DACH gender code like
"(m/w/d)" into an opaque sentinel `ZQX<n>XQZ` on the Node side BEFORE handing
text to this worker, and restores it afterwards. Before this test, NOTHING
exercised local-mt-translate.py itself against a sentinel-bearing string: the
file has zero references to ZQX/sentinel/truecase, and no test — JS or
Python — ever ran its actual segmentation/dedup/reassembly code on one.

Argos Translate is NOT installed in this environment (no network budget to
download the CTranslate2 models here), so `argostranslate.translate.translate`
is replaced with a FAKE for every test below. That means these tests prove:
  1. `_segment()` treats a sentinel exactly like any other prose content — it
     is not a "marker" line, so it is NOT skipped/preserved verbatim; it is
     handed to the (fake) translator as part of the unit's `content` string.
  2. `translate_stream()`'s OWN code — segmentation, dedup-by-content, the
     thread-pool/sequential dispatch, and reassembly — passes a sentinel
     through byte-identical to whatever the (fake) translator returns for it.
     I.e. THIS WRAPPER introduces no truecasing/tokenization/whitespace
     corruption of its own.
  3. The two engine variables the reassembly logic responds to — an engine
     that echoes the sentinel unchanged, and one that mangles ONLY the
     sentinel's case/spacing (a plausible tokenizer artifact) — both flow
     through to the JSONL response's `text` field unmodified by THIS script;
     recovery from that mangling is the Node-side `restoreProtectedTokens`'s
     job (scripts/lib/translation-glossary.mjs), already covered by
     tests/translation-protected-tokens.test.ts ("survives a translator that
     lower-cases or pads the sentinel").

WHAT REMAINS UNVERIFIED (stated here, not hidden): whether the REAL Argos
Translate models (CTranslate2 int8, loaded via `tr.translate()`) themselves
corrupt a `ZQX<n>XQZ` token during actual inference — e.g. by splitting it at
subword-tokenizer boundaries, translating fragments of it as if they were
words, or normalizing its case — is NOT covered by this file and cannot be
covered without the real models installed (~hundreds of MB download, not
available in this sandbox). That is the genuine end-to-end gap #5587 item1
flags; see the PR body for the explicit disclosure.
"""

import importlib.util
import io
import json
import sys
import types
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[2] / "scripts" / "local-mt-translate.py"

SENTINEL = "ZQX0XQZ"


def _load_module():
    """Fresh import of local-mt-translate.py by file path (it is not a
    package member — it lives directly under scripts/, invoked as a script)."""
    spec = importlib.util.spec_from_file_location("local_mt_translate", MODULE_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _install_fake_argos(engine):
    """Inject a fake `argostranslate.translate` module into sys.modules so
    `import argostranslate.translate as tr` inside translate_stream() resolves
    to `engine` instead of requiring the real (uninstalled) package.

    @param engine: callable(text, from_code, to_code) -> str
    @returns: list that will be appended to with every string the fake
              translator was called with (in call order) — the test's window
              into exactly what this script handed to "Argos".
    """
    seen = []

    def _fake_translate(text, frm, to):
        seen.append(text)
        return engine(text, frm, to)

    fake_translate_mod = types.ModuleType("argostranslate.translate")
    fake_translate_mod.translate = _fake_translate
    fake_pkg = types.ModuleType("argostranslate")
    sys.modules["argostranslate"] = fake_pkg
    sys.modules["argostranslate.translate"] = fake_translate_mod
    return seen


def _uninstall_fake_argos():
    sys.modules.pop("argostranslate.translate", None)
    sys.modules.pop("argostranslate", None)


def _run_stream(mod, requests):
    """Feed `requests` (list of dicts) as JSONL on stdin, capture JSONL stdout,
    return the parsed response list. Restores real stdin/stdout afterwards."""
    old_stdin, old_stdout = sys.stdin, sys.stdout
    sys.stdin = io.StringIO("\n".join(json.dumps(r) for r in requests) + "\n")
    sys.stdout = io.StringIO()
    try:
        mod.translate_stream()
        out = sys.stdout.getvalue()
    finally:
        sys.stdin, sys.stdout = old_stdin, old_stdout
    return [json.loads(line) for line in out.strip().split("\n") if line.strip()]


class SegmentationDoesNotShieldOrMangleSentinel(unittest.TestCase):
    """_segment() alone, no Argos involved: what does the wrapper DO with a
    sentinel before it ever reaches a translator?"""

    def setUp(self):
        self.mod = _load_module()

    def test_a_sentinel_bearing_line_is_a_translatable_unit_not_a_preserved_marker(self):
        text = f"Leiter Umweltlabor {SENTINEL}"
        segments, units = self.mod._segment(text)
        self.assertEqual(len(segments), 1)
        kind, idx = segments[0]
        self.assertEqual(kind, "unit")  # NOT "lit" — it is handed to the translator
        self.assertIn(SENTINEL, units[idx]["content"])

    def test_the_unit_content_carries_the_sentinel_byte_identical(self):
        text = f"Leiter Umweltlabor {SENTINEL}"
        _, units = self.mod._segment(text)
        self.assertEqual(units[0]["content"], text)  # no prefix on a non-bulleted line

    def test_a_sentinel_alone_on_its_own_line_is_still_a_unit_not_a_literal(self):
        # If a masked title were ever split across lines, a sentinel-only line
        # must not be silently classified as a structural marker and skipped
        # (it has letters — z, q, x — so _HAS_LETTERS_RE matches).
        segments, units = self.mod._segment(f"Some prose\n{SENTINEL}\nMore prose")
        kinds = [k for k, _ in segments]
        self.assertEqual(kinds, ["unit", "unit", "unit"])
        self.assertEqual(units[1]["content"], SENTINEL)


class TranslateStreamSentinelPassthrough(unittest.TestCase):
    """Full translate_stream() round trip, Argos faked."""

    def setUp(self):
        self.mod = _load_module()
        self.addCleanup(_uninstall_fake_argos)

    def test_identity_engine_the_wrapper_itself_introduces_no_corruption(self):
        seen = _install_fake_argos(lambda text, frm, to: text)  # identity passthrough
        source = f"Leiter Umweltlabor {SENTINEL}"
        [resp] = _run_stream(self.mod, [{"id": "r0", "text": source, "from": "de", "to": "it"}])

        self.assertEqual(resp["id"], "r0")
        self.assertEqual(resp["text"], source)  # byte-identical round trip
        # The exact string handed to "Argos" carried the sentinel unmodified —
        # this wrapper does no tokenizing/truecasing of its own before the call.
        self.assertTrue(any(SENTINEL in s for s in seen), seen)

    def test_engine_that_translates_prose_but_would_leave_an_unmasked_code_exposed(self):
        # Mirrors the live failure this guard exists for (weekday-expansion of
        # a RAW "(m/w/d)") but proves the SENTINEL survives where the raw code
        # would not have: an engine that translates recognizable German words
        # and leaves anything else (including the sentinel) untouched.
        def engine(text, frm, to):
            return (text.replace("Leiter", "Responsabile")
                        .replace("Umweltlabor", "del Laboratorio Ambientale"))

        _install_fake_argos(engine)
        source = f"Leiter Umweltlabor {SENTINEL}"
        [resp] = _run_stream(self.mod, [{"id": "r0", "text": source, "from": "de", "to": "it"}])
        self.assertIn(SENTINEL, resp["text"])
        self.assertEqual(resp["text"], f"Responsabile del Laboratorio Ambientale {SENTINEL}")

    def test_an_engine_that_mangles_only_the_sentinel_case_and_spacing_still_flows_through_unblocked(self):
        # Simulates a plausible (not confirmed) tokenizer artifact: the engine
        # lower-cases and adds a space inside the sentinel, but this script has
        # no restore logic of its own — restoring is the Node-side's job
        # (translation-glossary.mjs::restoreProtectedTokens, already proven
        # tolerant of exactly this shape of damage in
        # tests/translation-protected-tokens.test.ts). This test documents
        # that the mangled text reaches the JSONL output UNRECOVERED by this
        # script — proving the boundary, not papering over it.
        def engine(text, frm, to):
            return text.replace(SENTINEL, "zqx 0 xqz")

        _install_fake_argos(engine)
        source = f"Leiter Umweltlabor {SENTINEL}"
        [resp] = _run_stream(self.mod, [{"id": "r0", "text": source, "from": "de", "to": "it"}])
        self.assertIn("zqx 0 xqz", resp["text"])
        self.assertNotIn(SENTINEL, resp["text"])  # this script does not repair it — Node does

    def test_dedup_across_requests_still_carries_the_sentinel_to_every_dependent(self):
        # The dedup path (identical (text, from, to) units translated once,
        # fanned out) must not special-case or drop a sentinel-bearing unit.
        _install_fake_argos(lambda text, frm, to: text)
        source = f"Leiter Umweltlabor {SENTINEL}"
        responses = _run_stream(self.mod, [
            {"id": "r0", "text": source, "from": "de", "to": "it"},
            {"id": "r1", "text": source, "from": "de", "to": "it"},  # exact dup
        ])
        self.assertEqual({r["id"] for r in responses}, {"r0", "r1"})
        for r in responses:
            self.assertEqual(r["text"], source)


if __name__ == "__main__":
    unittest.main()
