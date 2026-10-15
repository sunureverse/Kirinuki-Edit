import csv
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class TitleEditingTests(unittest.TestCase):
    def apply_title(self, text, speaker='제목', original=None):
        with tempfile.TemporaryDirectory() as folder:
            work = Path(folder)
            edit = {'source': 'unused.mp4', 'keep': [{'s': 10, 'e': 15}],
                    'captions': 'captions.csv', 'captionClock': 'output', 'fx': 'fx.json'}
            (work / 'edit.json').write_text(json.dumps(edit), encoding='utf-8')
            (work / 'fx.json').write_text(json.dumps({'title': 'old title', 'fx': []}), encoding='utf-8')
            (work / 'captions.csv').write_text('start,end,speaker,kind,text,tf\n', encoding='utf-8')
            dialogue = {'s': 1, 'e': 2, 'speaker': '카나데', 'kind': '기본', 'text': '대사', 'by': 'codex'}
            title = {'s': 0, 'e': 5, 'speaker': speaker, 'kind': '기본', 'text': text, 'by': 'user'}
            if original is not None:
                title['orig'] = original
            project = {'review': {'captions': [dialogue, title], 'clips': []}}
            (work / 'project.json').write_text(json.dumps(project), encoding='utf-8')
            result = subprocess.run([sys.executable, str(ROOT / 'tools/apply_review.py'),
                                     str(work), str(work / 'project.json')], capture_output=True, text=True,
                                    encoding='utf-8', env=dict(os.environ, PYTHONIOENCODING='utf-8'))
            self.assertEqual(result.returncode, 0, result.stderr)
            fx = json.loads((work / 'fx.json').read_text(encoding='utf-8'))
            with (work / 'captions.csv').open(encoding='utf-8-sig') as f:
                rows = list(csv.DictReader(f))
            self.assertEqual(fx['title'], text)
            self.assertEqual(rows[0]['speaker'], speaker)
            self.assertEqual(rows[0]['text'], text)
            self.assertEqual(rows[1]['text'], '대사')
            self.assertEqual(json.loads((work / 'edit.json').read_text())['keep'], edit['keep'])
            self.assertEqual(fx['fx'], [])

    def test_scene_only_title_can_be_saved_without_an_original_caption_row(self):
        self.apply_title('무한레로레로')

    def test_clearing_title_removes_the_fx_title_instead_of_restoring_it(self):
        self.apply_title('', original='old title')

    def test_legacy_english_title_and_multiline_highlight_survive_render_handoff(self):
        self.apply_title('첫 줄\n«둘째 줄|yellow»', speaker='title', original='old title')


if __name__ == '__main__':
    unittest.main()
