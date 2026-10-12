"""Check CLI language routing and transcript preservation without downloading models."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import wave

SCRIPT = Path(__file__).parents[2] / "tools" / "transcribe_words.py"
FAKE = '''
import json, os
from types import SimpleNamespace as NS
class WhisperModel:
    def __init__(self, *args, **kwargs): pass
    def transcribe(self, wav, **kwargs):
        json.dump(kwargs, open(os.environ['CALL_FILE'], 'w'))
        lang=kwargs['language'] or 'ja'
        text={'ko':'안녕하세요','ja':'こんにちは','en':'hello'}[lang]
        return iter([NS(start=0.2,end=0.8,text=text,words=[NS(start=0.2,end=0.8,word=text)])]), NS(language=lang,language_probability=0.99)
'''


class TranscriptionLanguageTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / "faster_whisper.py").write_text(FAKE)
        with wave.open(str(self.root / "src_loud.wav"), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(16000)
            wav.writeframes(b"\0\0" * 16000)
        self.env = dict(os.environ, ALLOW_AI="1", PYTHONPATH=str(self.root), CALL_FILE=str(self.root / "call.json"))

    def tearDown(self):
        self.temp.cleanup()

    def run_script(self, *args, env=None):
        return subprocess.run([sys.executable, str(SCRIPT), str(self.root), *args], env=env or self.env,
                              capture_output=True, text=True)

    def test_default_detects_language_without_translation(self):
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        call = json.loads((self.root / "call.json").read_text())
        self.assertIsNone(call["language"])
        self.assertEqual(call["task"], "transcribe")
        self.assertTrue(call["multilingual"])
        self.assertTrue(call["word_timestamps"])
        self.assertFalse(call["vad_filter"])

    def test_explicit_languages_preserve_unicode_and_word_times(self):
        for lang, text in [('ko', '안녕하세요'), ('ja', 'こんにちは'), ('en', 'hello')]:
            with self.subTest(language=lang):
                result = self.run_script('--language', lang)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads((self.root / 'call.json').read_text())['language'], lang)
                self.assertFalse(json.loads((self.root / 'call.json').read_text())['multilingual'])
                words = json.loads((self.root / 'word_level_words.json').read_text())[0]['words']
                self.assertEqual(words, [{'start': 0.2, 'end': 0.8, 'word': text}])

    def test_existing_transcript_needs_no_model_or_ai_permission(self):
        rows = [{'start': 0.2, 'end': 0.8, 'text': 'hello', 'words': [{'start': 0.2, 'end': 0.8, 'word': 'hello'}]}]
        (self.root / 'existing.json').write_text(json.dumps(rows))
        (self.root / 'faster_whisper.py').write_text('raise AssertionError("model must not be imported")')
        env = dict(self.env)
        env.pop('ALLOW_AI')
        result = self.run_script('--from', 'existing.json', '--language', 'en', env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads((self.root / 'word_level_words.json').read_text()), rows)

    def test_non_korean_timestamps_are_not_redistributed_by_hangul_counts(self):
        # Korean correction would move the word edges to 0.3/0.7 here.
        (self.root / 'speech_map.json').write_text('[[0.3, 0.7]]')
        for lang in ('ja', 'en'):
            with self.subTest(language=lang):
                result = self.run_script('--language', lang)
                self.assertEqual(result.returncode, 0, result.stderr)
                word = json.loads((self.root / 'word_level_words.json').read_text())[0]['words'][0]
                self.assertEqual((word['start'], word['end']), (0.2, 0.8))
                self.assertNotIn('whisper', word)


if __name__ == '__main__':
    unittest.main()
