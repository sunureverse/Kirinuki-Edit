import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('channel_download', Path(__file__).parents[2] / 'tools' / 'download_channel.py')
download = importlib.util.module_from_spec(spec)
spec.loader.exec_module(download)
VID = 'QvUi6KG4FRI'


class ChannelDownloadTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.output = Path(self.temp.name)
        download.STOP.clear()

    def tearDown(self):
        self.temp.cleanup()

    def test_list_deduplicates_and_rejects_invalid_ids(self):
        data = {'entries': [None, {'id': VID}, {'id': VID}, {'id': '../../bad'}, {'id': 'eytPidhJ6cI'}]}
        self.assertEqual(download.playlist_ids(data), [VID, 'eytPidhJ6cI'])

    def test_success_requires_archive_and_keeps_individual_log(self):
        def runner(command, log):
            log.write('Merged video and audio\n')
            (self.output / 'downloaded.txt').write_text('youtube ' + VID + '\n')
            self.assertIn('--js-runtimes', command)
            return 0
        self.assertEqual(download.download_one(VID, self.output, run=runner), 'downloaded')
        self.assertIn('Merged', (self.output / 'download-logs' / (VID + '.log')).read_text())

    def test_filter_exit_zero_is_not_a_download(self):
        self.assertEqual(download.download_one(VID, self.output, run=lambda *args: 0), 'skipped')

    def test_unavailable_video_failure_does_not_enter_archive(self):
        self.assertEqual(download.download_one(VID, self.output, run=lambda *args: 1), 'failed')
        self.assertEqual(download.archive_ids(self.output / 'downloaded.txt'), set())

    def test_imports_previous_merged_video_but_not_split_tracks(self):
        final = self.output / ('title [' + VID + '].webm')
        final.write_bytes(b'fixture')
        (self.output / ('title [' + VID + '].f399.mp4')).write_bytes(b'fixture')
        result = type('Probe', (), {'returncode': 0, 'stdout': json.dumps({'streams': [
            {'codec_type': 'video'}, {'codec_type': 'audio'}]})})()
        with patch.object(download.subprocess, 'run', return_value=result) as probe:
            self.assertEqual(download.import_existing(self.output, {VID}), {VID})
            probe.assert_called_once()
        self.assertEqual(download.archive_ids(self.output / 'downloaded.txt'), {VID})

    def test_corrupt_existing_video_is_not_marked_completed(self):
        (self.output / ('title [' + VID + '].webm')).write_bytes(b'broken')
        result = type('Probe', (), {'returncode': 1})()
        with patch.object(download.subprocess, 'run', return_value=result):
            self.assertEqual(download.import_existing(self.output, {VID}), set())
        self.assertFalse((self.output / 'downloaded.txt').exists())

    def test_three_workers_resolve_one_list_skip_archive_and_continue_after_failure(self):
        ids = [f'AAAAAAAAAA{i}' for i in range(7)]
        (self.output / 'downloaded.txt').write_text('youtube ' + ids[0] + '\n')
        listing = type('Listing', (), {'returncode': 0, 'stdout': json.dumps({
            'entries': [{'id': i} for i in ids]}), 'stderr': ''})()
        lock = threading.Lock()
        active = peak = 0
        called = []
        def worker(video_id, output):
            nonlocal active, peak
            with lock:
                active += 1
                peak = max(peak, active)
                called.append(video_id)
            time.sleep(0.02)
            with lock:
                active -= 1
            return 'failed' if video_id == ids[3] else 'downloaded'
        with patch.object(download, 'preflight'), patch.object(download.subprocess, 'run', return_value=listing) as resolve, \
                patch.object(download, 'download_one', side_effect=worker), \
                patch.object(download.sys, 'argv', ['download_channel.py', '--output', str(self.output), '--workers', '3']):
            self.assertEqual(download.main(), 1)
            resolve.assert_called_once()
        self.assertEqual(peak, 3)
        self.assertEqual(set(called), set(ids[1:]))
        summary = json.loads((self.output / 'last-run.json').read_text())
        self.assertEqual(summary['counts']['downloaded'], 5)
        self.assertEqual(summary['failed'], [ids[3]])


if __name__ == '__main__':
    unittest.main()
