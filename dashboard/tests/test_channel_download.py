import importlib.util
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import tempfile
import sys
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
        def runner(command, log, **kwargs):
            log.write('[진행] 영상 파일 완료\n')
            (self.output / 'downloaded.txt').write_text('youtube ' + VID + '\n')
            self.assertIn('--js-runtimes', command)
            self.assertEqual(command[command.index('--output-na-placeholder') + 1], 'null')
            return 0
        self.assertEqual(download.download_one(VID, self.output, run=runner), 'downloaded')
        self.assertIn('[성공]', (self.output / 'download-logs' / (VID + '.log')).read_text())

    def test_filter_exit_zero_is_not_a_download(self):
        self.assertEqual(download.download_one(VID, self.output, run=lambda *args, **kwargs: 0), 'skipped')

    def test_unavailable_video_failure_does_not_enter_archive(self):
        self.assertEqual(download.download_one(VID, self.output, run=lambda *args, **kwargs: 1), 'failed')
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
        def worker(video_id, output, progress=None):
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

    def test_console_counts_errors_separately_from_success(self):
        display = download.ProgressDisplay(10, 2)
        capture = io.StringIO()
        with redirect_stdout(capture):
            display.start(VID)
            display.update(VID, {'downloaded': 25, 'total': 100, 'speed': 1048576,
                                 'eta': 60, 'vcodec': 'none'})
            display.render()
            display.finish(VID, 'downloaded')
            display.finish('eytPidhJ6cI', 'failed', 'Video unavailable')
            display.render()
        text = capture.getvalue()
        self.assertIn('음성 25.0%', text)
        self.assertIn('처리 4/10 (40.0%) | 성공 3 | 에러 1', text)
        self.assertIn('[에러] eytPidhJ6cI | Video unavailable', text)
        self.assertTrue(all(line.startswith(('[진행]', '[성공]', '[에러]')) for line in text.splitlines()))

    def test_subprocess_stream_filters_noise_but_keeps_live_progress_and_error(self):
        event = {'status': 'downloading', 'downloaded': 50, 'total': 100,
                 'speed': 1048576, 'eta': 3, 'vcodec': 'av1'}
        emitted = download.PROGRESS_PREFIX + json.dumps(event)
        code = 'import sys; print("metadata noise"); print("WARNING: noise"); print(' + repr(emitted) + '); print("ERROR: real failure"); sys.exit(1)'
        events = []
        log_path = self.output / 'filtered.log'
        with log_path.open('w', encoding='utf-8') as log:
            result = download.run_command([sys.executable, '-c', code], log, on_progress=events.append)
        self.assertEqual(result, 1)
        self.assertEqual(events, [event])
        text = log_path.read_text()
        self.assertIn('영상 50.0%', text)
        self.assertIn('[에러] real failure', text)
        self.assertNotIn('noise', text)


if __name__ == '__main__':
    unittest.main()
