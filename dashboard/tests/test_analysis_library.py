import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('analysis_library', Path(__file__).resolve().parents[2] / 'tools/analysis_library.py')
lib = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lib)


class AnalysisLibraryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.video = self.root / 'source.mp4'
        self.video.write_bytes(b'unique fixture media')
        self.folder = lib.initialize(self.root / 'library', self.video, 10)

    def test_identical_copy_reuses_records_but_changed_media_does_not(self):
        lib.record(self.folder, dict(id='c1', kind='candidate', start=1, end=4, note='reaction', basis='fixture'))
        copy = self.root / 'renamed.mp4'
        copy.write_bytes(self.video.read_bytes())
        self.assertEqual(self.folder, lib.initialize(self.root / 'library', copy, 10))
        self.video.write_bytes(b'different media contents')
        self.assertNotEqual(self.folder, lib.initialize(self.root / 'library', self.video, 10))
        self.assertTrue((self.folder / 'records/c1.json').exists())

    def test_stale_source_is_rejected(self):
        self.video.write_bytes(b'changed')
        with self.assertRaises(ValueError):
            lib.validate_source(self.folder)

    def test_offset_idempotence_and_unverified_status(self):
        transcript = self.root / 'speech.json'
        lib.write(transcript, [dict(start=0, end=1, text='test', words=[dict(start=0, end=.5, word='test')])])
        target = lib.import_transcript(self.folder, transcript, 5)
        self.assertEqual(target, lib.import_transcript(self.folder, transcript, 5.0))
        data = lib.read(target)
        self.assertEqual(data['segments'][0]['words'][0]['start'], 5)
        self.assertEqual(data['reviewStatus'], 'unverified-import')
        self.assertEqual(len(list(target.parent.glob('*.json'))), 1)
        with self.assertRaises(ValueError):
            lib.import_transcript(self.folder, transcript, 11)

    def test_records_preserve_history_and_reject_bad_ranges(self):
        e = dict(id='c1', kind='candidate', start=1, end=4, note='reaction', basis='fixture')
        lib.record(self.folder, e)
        with self.assertRaises(FileExistsError):
            lib.record(self.folder, dict(e, note='overwrite'))
        for start, end in [(4, 1), (-1, 4), (1, 11), (float('nan'), 4)]:
            with self.assertRaises(ValueError):
                lib.record(self.folder, dict(e, id='bad', start=start, end=end))
        with self.assertRaises(ValueError):
            lib.record(self.folder, dict(e, id='selection', kind='selection', candidateId='missing'))
        self.assertIn('reaction', lib.report(self.folder).read_text(encoding='utf-8'))


if __name__ == '__main__':
    unittest.main()
