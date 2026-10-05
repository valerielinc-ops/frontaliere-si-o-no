#!/usr/bin/env python3
"""
local_mt_translate_batched_test.py — the batched Argos engine of
scripts/local-mt-translate.py (_BatchedEngine).

The real models are not installed here, so argostranslate is replaced by a
fake with the same object graph the engine unwraps (CachedTranslation ->
CompositeTranslation -> PackageTranslation legs with a pkg, a sentencizer,
a tokenizer and a CTranslate2-like translator). The fake's own `translate()`
follows argostranslate 1.11 step by step (paragraphs, sentences, one
translate_batch per paragraph, pivot through English), so "batched equals
legacy" here means the engine reproduces Argos' composition, not that the
real models give the same bytes — that is measured on real models by
.github/workflows/local-mt-bench.yml.
"""

import importlib.util
import io
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[2] / "scripts" / "local-mt-translate.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("local_mt_translate_batched", MODULE_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class _Result:
    def __init__(self, tokens):
        self.hypotheses = [tokens]
        self.scores = [0.0]


class _Translator:
    """Prefixes every token with its direction, so a pivot shows both legs."""

    def __init__(self, tag, stats):
        self.tag = tag
        self.stats = stats

    def translate_batch(self, batch, **kwargs):
        self.stats["calls"].append((self.tag, len(batch), kwargs.get("max_batch_size")))
        self.stats["lengths"].append(sorted({len(tokens) for tokens in batch}))
        self.stats["sentences"][self.tag] = self.stats["sentences"].get(self.tag, 0) + len(batch)
        return [_Result([f"{self.tag}:{tok}" for tok in tokens]) for tokens in batch]


class _Tokenizer:
    def encode(self, sentence):
        return sentence.split()

    def decode(self, tokens):
        # Argos' SentencePiece decode leaves a leading space the caller strips.
        return " " + " ".join(tokens)


class _Sentencizer:
    def split_sentences(self, text):
        parts = [p.strip() for p in text.split(". ")]
        return [p for p in parts if p]


def _install_fake_argos(fail_on=None):
    stats = {"calls": [], "sentences": {}, "lengths": []}
    mod = types.ModuleType("argostranslate.translate")

    class PackageTranslation:
        def __init__(self, frm, to):
            self.pkg = types.SimpleNamespace(
                tokenizer=_Tokenizer(), target_prefix="", package_path=Path("/nonexistent"),
            )
            self.sentencizer = _Sentencizer()
            self.translator = _Translator(f"{frm}{to}", stats)

        def translate(self, text):
            # argostranslate 1.11: split on "\n", one translate_batch per
            # paragraph, tokens of all sentences concatenated, decode,
            # strip the tokenizer's leading space, re-join, lstrip("\n").
            out = []
            for paragraph in text.split("\n"):
                sentences = self.sentencizer.split_sentences(paragraph)
                tokens = []
                if sentences:
                    for result in self.translator.translate_batch(
                            [self.pkg.tokenizer.encode(s) for s in sentences]):
                        tokens.extend(result.hypotheses[0])
                value = self.pkg.tokenizer.decode(tokens)
                if value[:1] == " ":
                    value = value[1:]
                out.append(value)
            return "\n".join(out).lstrip("\n")

    class CachedTranslation:
        def __init__(self, underlying):
            self.underlying = underlying

        def translate(self, text):
            return self.underlying.translate(text)

    class CompositeTranslation:
        def __init__(self, t1, t2):
            self.t1, self.t2 = t1, t2

        def translate(self, text):
            return self.t2.translate(self.t1.translate(text))

    class IdentityTranslation:
        def translate(self, text):
            return text

    legs = {}

    def leg(frm, to):
        if (frm, to) not in legs:
            legs[(frm, to)] = CachedTranslation(PackageTranslation(frm, to))
        return legs[(frm, to)]

    def get_translation_from_codes(frm, to):
        if fail_on and (frm, to) == fail_on:
            raise RuntimeError("boom")
        if frm == to:
            return IdentityTranslation()
        if "en" in (frm, to):
            return leg(frm, to)
        return CompositeTranslation(leg(frm, "en"), leg("en", to))

    def translate(text, frm, to):
        return get_translation_from_codes(frm, to).translate(text)

    mod.PackageTranslation = PackageTranslation
    mod.CachedTranslation = CachedTranslation
    mod.CompositeTranslation = CompositeTranslation
    mod.IdentityTranslation = IdentityTranslation
    mod.get_translation_from_codes = get_translation_from_codes
    mod.translate = translate
    settings = types.ModuleType("argostranslate.settings")
    settings.device = "cpu"
    settings.inter_threads = 1
    settings.intra_threads = 0
    settings.compute_type = "auto"
    settings.beam_size = 4
    pkg = types.ModuleType("argostranslate")
    sys.modules["argostranslate"] = pkg
    sys.modules["argostranslate.translate"] = mod
    sys.modules["argostranslate.settings"] = settings
    return stats


def _uninstall_fake_argos():
    for name in ("argostranslate.settings", "argostranslate.translate", "argostranslate"):
        sys.modules.pop(name, None)


def _run_stream(mod, requests, env=None):
    env = env or {}
    saved = {k: os.environ.get(k) for k in env}
    os.environ.update(env)
    old_stdin, old_stdout, old_stderr = sys.stdin, sys.stdout, sys.stderr
    sys.stdin = io.StringIO("\n".join(json.dumps(r) for r in requests) + "\n")
    sys.stdout = io.StringIO()
    sys.stderr = io.StringIO()
    try:
        mod.translate_stream()
        out, err = sys.stdout.getvalue(), sys.stderr.getvalue()
    finally:
        sys.stdin, sys.stdout, sys.stderr = old_stdin, old_stdout, old_stderr
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
    responses = [json.loads(line) for line in out.strip().split("\n") if line.strip()]
    return {r["id"]: r for r in responses}, err


REQUESTS = [
    {"id": "t-de", "text": "Responsabile vendite", "from": "it", "to": "de"},
    {"id": "t-fr", "text": "Responsabile vendite", "from": "it", "to": "fr"},
    {"id": "t-en", "text": "Responsabile vendite", "from": "it", "to": "en"},
    {"id": "d-de", "text": "## Compiti\n- Gestire i clienti. Seguire gli ordini\n\nSede: Lugano",
     "from": "it", "to": "de"},
    {"id": "d-fr", "text": "## Compiti\n- Gestire i clienti. Seguire gli ordini\n\nSede: Lugano",
     "from": "it", "to": "fr"},
    {"id": "x-it", "text": "Leiter Umweltlabor ZQX0XQZ", "from": "de", "to": "it"},
]


class BatchedEngineMatchesArgosComposition(unittest.TestCase):
    def setUp(self):
        self.mod = _load_module()
        self.addCleanup(_uninstall_fake_argos)

    def test_batched_output_equals_the_legacy_per_unit_path(self):
        _install_fake_argos()
        legacy, _ = _run_stream(self.mod, REQUESTS, {"LOCAL_MT_ENGINE": "legacy", "LOCAL_MT_WORKERS": "1"})
        _uninstall_fake_argos()
        self.mod = _load_module()
        _install_fake_argos()
        batched, err = _run_stream(self.mod, REQUESTS, {"LOCAL_MT_ENGINE": "batched"})
        self.assertEqual(set(batched), {r["id"] for r in REQUESTS}, err)
        for rid, resp in legacy.items():
            self.assertEqual(batched[rid].get("text"), resp.get("text"), rid)
        # The pivot shows both legs, and markdown structure survives.
        self.assertEqual(batched["t-de"]["text"], "ende:iten:Responsabile ende:iten:vendite")
        self.assertTrue(batched["d-fr"]["text"].startswith("## enfr:iten:Compiti\n- "))
        self.assertNotIn("legacy path", err)

    def test_the_pivot_leg_runs_once_for_every_target_locale(self):
        stats = _install_fake_argos()
        _run_stream(self.mod, REQUESTS, {"LOCAL_MT_ENGINE": "batched"})
        # it->en sees each distinct Italian unit once, although it->de, it->fr
        # and it->en all need it: "Responsabile vendite", "Compiti",
        # "Gestire i clienti. Seguire gli ordini" (2 sentences), "Sede: Lugano".
        self.assertEqual(stats["sentences"]["iten"], 5)

    def test_a_batch_holds_only_sentences_of_the_same_length(self):
        # The opt-in mode: no sentence is padded to a longer neighbour.
        stats = _install_fake_argos()
        _run_stream(self.mod, REQUESTS, {"LOCAL_MT_ENGINE": "batched", "LOCAL_MT_BATCH_MODE": "equal-length"})
        self.assertTrue(stats["lengths"])
        for lengths in stats["lengths"]:
            self.assertEqual(len(lengths), 1, stats["lengths"])
        # "Responsabile vendite", "Sede: Lugano" and "Seguire gli ordini"-like
        # sentences share a batch when their token counts match.
        iten = [c for c in stats["calls"] if c[0] == "iten"]
        self.assertLess(len(iten), stats["sentences"]["iten"])

    def test_default_mode_fills_one_batch_whatever_the_lengths(self):
        stats = _install_fake_argos()
        _run_stream(self.mod, REQUESTS, {"LOCAL_MT_ENGINE": "batched", "LOCAL_MT_BATCH_TOKENS": "2048"})
        iten = [c for c in stats["calls"] if c[0] == "iten"]
        self.assertEqual(len(iten), 1)
        self.assertEqual(iten[0][2], 2048)

    def test_legacy_engine_translates_each_unit_on_its_own(self):
        stats = _install_fake_argos()
        _run_stream(self.mod, REQUESTS, {"LOCAL_MT_ENGINE": "legacy", "LOCAL_MT_WORKERS": "1"})
        self.assertGreater(stats["sentences"]["iten"], 5)


class BatchedEngineFallsBackInsteadOfLosingWork(unittest.TestCase):
    def setUp(self):
        self.mod = _load_module()
        self.addCleanup(_uninstall_fake_argos)

    def test_a_failing_chunk_is_translated_by_the_legacy_path(self):
        _install_fake_argos(fail_on=("de", "it"))
        responses, err = _run_stream(self.mod, REQUESTS, {
            "LOCAL_MT_ENGINE": "batched", "LOCAL_MT_BATCH_UNITS": "1",
        })
        self.assertIn("legacy path for these 1 units", err)
        # Only the de->it chunk fell back; the legacy call raises too, so that
        # one request fails, every other request is still translated.
        self.assertEqual(responses["x-it"].get("error"), "translation failed")
        self.assertEqual(responses["t-fr"]["text"], "enfr:iten:Responsabile enfr:iten:vendite")

    def test_an_argos_without_the_expected_classes_uses_the_legacy_path(self):
        fake = types.ModuleType("argostranslate.translate")
        fake.translate = lambda text, frm, to: text.upper()
        sys.modules["argostranslate"] = types.ModuleType("argostranslate")
        sys.modules["argostranslate.translate"] = fake
        responses, err = _run_stream(self.mod, REQUESTS[:1], {"LOCAL_MT_ENGINE": "batched"})
        self.assertIn("batched engine unavailable", err)
        self.assertEqual(responses["t-de"]["text"], "RESPONSABILE VENDITE")


class UnitCacheKeepsInterruptedWork(unittest.TestCase):
    def setUp(self):
        self.mod = _load_module()
        self.addCleanup(_uninstall_fake_argos)
        handle, self.cache = tempfile.mkstemp(suffix=".jsonl")
        os.close(handle)
        os.unlink(self.cache)
        self.addCleanup(lambda: os.path.exists(self.cache) and os.unlink(self.cache))

    def test_a_second_pass_reuses_every_unit_without_running_a_model(self):
        _install_fake_argos()
        first, _ = _run_stream(self.mod, REQUESTS, {"LOCAL_MT_UNIT_CACHE": self.cache})
        self.assertTrue(os.path.getsize(self.cache) > 0)
        _uninstall_fake_argos()
        self.mod = _load_module()
        stats = _install_fake_argos()
        second, err = _run_stream(self.mod, REQUESTS, {"LOCAL_MT_UNIT_CACHE": self.cache})
        self.assertEqual(stats["calls"], [])
        self.assertIn("reused from", err)
        for rid, resp in first.items():
            self.assertEqual(second[rid]["text"], resp["text"], rid)

    def test_the_cache_directory_is_created_on_a_first_run(self):
        # After an actions/cache miss `.cache/local-mt-units/` does not exist.
        root = tempfile.mkdtemp()
        self.addCleanup(lambda: __import__("shutil").rmtree(root, ignore_errors=True))
        cache = os.path.join(root, "local-mt-units", "units.jsonl")
        _install_fake_argos()
        _, err = _run_stream(self.mod, REQUESTS, {"LOCAL_MT_UNIT_CACHE": cache})
        self.assertNotIn("not writable", err)
        self.assertTrue(os.path.getsize(cache) > 0)

    def test_rows_of_another_engine_signature_and_torn_lines_are_ignored(self):
        with open(self.cache, "w", encoding="utf-8") as handle:
            handle.write(json.dumps({"s": "argos-0.0|beam-1", "k": ["Responsabile vendite", "it", "en"], "v": "STALE"}) + "\n")
            handle.write('{"s": "torn')
        stats = _install_fake_argos()
        responses, _ = _run_stream(self.mod, REQUESTS[2:3], {"LOCAL_MT_UNIT_CACHE": self.cache})
        self.assertEqual(responses["t-en"]["text"], "iten:Responsabile iten:vendite")
        self.assertTrue(stats["calls"])


if __name__ == "__main__":
    unittest.main()
