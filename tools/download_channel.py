"""Download public completed YouTube streams with three resumable workers."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import threading

CHANNEL = 'https://www.youtube.com/@OtonoseKanade/streams'
DEFAULT_OUTPUT = r'D:\kirinuki_source\kanade'
VIDEO_ID = re.compile(r'^[A-Za-z0-9_-]{11}$')
PROCESSES = set()
LOCK = threading.Lock()
STOP = threading.Event()
PROGRESS_PREFIX = 'KIRINUKI_PROGRESS '
PROGRESS_TEMPLATE = 'download:' + PROGRESS_PREFIX + json.dumps({
    'status': '%(progress.status)j', 'downloaded': '%(progress.downloaded_bytes)j',
    'total': '%(progress.total_bytes)j', 'estimate': '%(progress.total_bytes_estimate)j',
    'speed': '%(progress.speed)j', 'eta': '%(progress.eta)j', 'vcodec': '%(info.vcodec)j',
}).replace('"%(', '%(').replace(')j"', ')j')


def number(value):
    return float(value) if isinstance(value, (float, int)) else 0


def progress_text(data):
    total = number(data.get('total')) or number(data.get('estimate'))
    percent = min(100, number(data.get('downloaded')) / total * 100) if total else None
    phase = '음성' if data.get('vcodec') == 'none' else '영상'
    value = f'{percent:.1f}%' if percent is not None else f"{number(data.get('downloaded')) / 1048576:.1f}MiB"
    speed = number(data.get('speed')) / 1048576
    eta = data.get('eta')
    remaining = f' | 남은 {int(eta) // 60}:{int(eta) % 60:02d}' if isinstance(eta, (float, int)) else ''
    if data.get('status') == 'finished':
        return f'{phase} 파일 완료 · 합치기/다음 파일 준비'
    return f'{phase} {value} | {speed:.1f}MiB/s{remaining}'


class ProgressDisplay:
    def __init__(self, total, existing):
        self.total = total
        self.existing = existing
        self.finished = existing
        self.success = existing
        self.errors = self.skipped = 0
        self.active = {}
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self.tick, daemon=True)

    def begin(self):
        print(f'[진행] 목록 전체 {self.total}개 | 기존 완료 {self.existing}개 | 이번 대상 {self.total - self.existing}개', flush=True)
        self.thread.start()

    def start(self, video_id):
        with self.lock:
            self.active[video_id] = '준비 중'

    def update(self, video_id, data):
        with self.lock:
            self.active[video_id] = progress_text(data)

    def render(self):
        with self.lock:
            percent = self.finished / self.total * 100 if self.total else 100
            text = (f'[진행] 처리 {self.finished}/{self.total} ({percent:.1f}%) | '
                    f'성공 {self.success} | 에러 {self.errors} | 제외 {self.skipped} | 진행 중 {len(self.active)}')
            print(text, flush=True)
            for video_id, progress in self.active.items():
                print(f'[진행] {video_id} | {progress}', flush=True)

    def tick(self):
        while not self.stop.wait(3):
            self.render()

    def finish(self, video_id, outcome, detail=''):
        with self.lock:
            self.active.pop(video_id, None)
            if outcome == 'stopped':
                return
            self.finished += 1
            if outcome == 'downloaded':
                self.success += 1
                print(f'[성공] {video_id} | 처리 {self.finished}/{self.total}', flush=True)
            elif outcome == 'failed':
                self.errors += 1
                print(f'[에러] {video_id} | {detail or "다운로드 실패"} | 처리 {self.finished}/{self.total}', flush=True)
            else:
                self.skipped += 1
                print(f'[진행] {video_id} | 종료 방송이 아니므로 제외 | 처리 {self.finished}/{self.total}', flush=True)

    def close(self):
        self.stop.set()
        self.thread.join()
        if STOP.is_set():
            with self.lock:
                self.active.clear()
        self.render()


def last_error(path):
    if not path.exists():
        return ''
    for line in reversed(path.read_text(encoding='utf-8', errors='replace').splitlines()):
        if line.startswith('[에러] '):
            return line[len('[에러] '):]
    return ''


def archive_ids(path):
    if not path.exists():
        return set()
    return {line.split()[1] for line in path.read_text(encoding='utf-8').splitlines()
            if len(line.split()) == 2 and line.split()[0].lower() == 'youtube'}


def playlist_ids(data):
    result = []
    seen = set()
    for entry in data.get('entries', []):
        if not entry:
            continue
        video_id = entry.get('id', '')
        if VIDEO_ID.fullmatch(video_id) and video_id not in seen:
            seen.add(video_id)
            result.append(video_id)
    return result


def run_command(command, log, *, on_progress=None):
    with LOCK:
        if STOP.is_set():
            return -1
        kwargs = {'start_new_session': True} if os.name != 'nt' else {}
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                   text=True, encoding='utf-8', errors='replace', bufsize=1,
                                   env=dict(os.environ, PYTHONIOENCODING='utf-8'), **kwargs)
        PROCESSES.add(process)
    try:
        for line in process.stdout:
            line = line.strip()
            if line.startswith(PROGRESS_PREFIX):
                try:
                    data = json.loads(line[len(PROGRESS_PREFIX):])
                except ValueError:
                    continue
                log.write('[진행] ' + progress_text(data) + '\n')
                log.flush()
                if on_progress:
                    on_progress(data)
            elif line.startswith('ERROR:'):
                log.write('[에러] ' + line[len('ERROR:'):].strip() + '\n')
                log.flush()
        return process.wait()
    finally:
        process.stdout.close()
        with LOCK:
            PROCESSES.discard(process)


def stop_downloads():
    STOP.set()
    with LOCK:
        for process in list(PROCESSES):
            if process.poll() is not None:
                continue
            if os.name == 'nt':
                subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            else:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass


def download_one(video_id, output, run=run_command, progress=None):
    if STOP.is_set():
        return 'stopped'
    if progress:
        progress.start(video_id)
    archive = output / 'downloaded.txt'
    logs = output / 'download-logs'
    logs.mkdir(exist_ok=True)
    command = [sys.executable, '-m', 'yt_dlp', '--js-runtimes', 'node',
               '--no-playlist', '--no-simulate', '--newline', '--windows-filenames',
               '--quiet', '--no-warnings', '--no-colors', '--progress', '--progress-delta', '1',
               '--progress-template', PROGRESS_TEMPLATE, '--output-na-placeholder', 'null',
               '--match-filter', "live_status = 'was_live'",
               '--download-archive', str(archive), '--retries', '5', '--fragment-retries', '5',
               '-f', 'bv*[height<=1080]+ba/b[height<=1080]', '--merge-output-format', 'mkv',
               '-P', str(output), '-o', '%(upload_date)s_%(id)s_%(title).100s.%(ext)s',
               'https://www.youtube.com/watch?v=' + video_id]
    with (logs / (video_id + '.log')).open('w', encoding='utf-8') as log:
        callback = (lambda data: progress.update(video_id, data)) if progress else None
        code = run(command, log, on_progress=callback)
    if STOP.is_set():
        return 'stopped'
    if code != 0:
        with (logs / (video_id + '.log')).open('a', encoding='utf-8') as log:
            if not last_error(logs / (video_id + '.log')):
                log.write(f'[에러] 다운로드 실패 (exit {code})\n')
        return 'failed'
    # Filtered videos also exit 0; only the archive establishes a completed download.
    outcome = 'downloaded' if video_id in archive_ids(archive) else 'skipped'
    with (logs / (video_id + '.log')).open('a', encoding='utf-8') as log:
        log.write('[성공] 다운로드 완료\n' if outcome == 'downloaded' else '[진행] 종료 방송이 아니므로 제외\n')
    return outcome


def import_existing(output, ids):
    """Recognize merged files from the user's earlier single-video test."""
    found = set()
    for file in output.iterdir():
        if file.suffix.lower() not in {'.mkv', '.mp4', '.webm'} or not file.is_file():
            continue
        if re.search(r'\.f\d+\.(mp4|webm)$', file.name):
            continue
        for video_id in ids:
            if f'[{video_id}]' not in file.name and f'_{video_id}_' not in file.name:
                continue
            probe = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_type',
                                    '-of', 'json', str(file)], capture_output=True, text=True)
            if probe.returncode == 0:
                try:
                    kinds = {s['codec_type'] for s in json.loads(probe.stdout).get('streams', [])}
                except (ValueError, KeyError):
                    continue
                if {'video', 'audio'} <= kinds:
                    found.add(video_id)
            break
    if found:
        with (output / 'downloaded.txt').open('a', encoding='utf-8') as archive:
            for video_id in sorted(found):
                archive.write('youtube ' + video_id + '\n')
    return found


def preflight():
    for tool in ('node', 'ffmpeg', 'ffprobe'):
        if not shutil.which(tool):
            raise RuntimeError(f'{tool} was not found. Install it and reopen the terminal.')
    version = subprocess.check_output(['node', '--version'], text=True).strip()
    if int(version.lstrip('v').split('.')[0]) < 22:
        raise RuntimeError('Node.js 22 or newer is required; install the current LTS version.')
    check = subprocess.run([sys.executable, '-m', 'yt_dlp', '--version'], capture_output=True)
    if check.returncode:
        raise RuntimeError('Install the downloader first: python -m pip install -U "yt-dlp[default]"')


def main():
    parser = argparse.ArgumentParser(description='Public completed streams: three downloads at a time, resume on rerun.')
    parser.add_argument('--output', default=DEFAULT_OUTPUT)
    parser.add_argument('--channel', default=CHANNEL)
    parser.add_argument('--workers', type=int, choices=(1, 2, 3), default=3)
    args = parser.parse_args()
    preflight()
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    print('[진행] 채널 영상 전체 개수 집계 중…', flush=True)
    # Resolve one list for all workers so changing playlist positions cannot overlap.
    command = [sys.executable, '-m', 'yt_dlp', '--js-runtimes', 'node', '--flat-playlist',
               '--dump-single-json', '--skip-download', '--quiet', '--no-warnings', '--no-colors', args.channel]
    listing = subprocess.run(command, capture_output=True, text=True, encoding='utf-8',
                             env=dict(os.environ, PYTHONIOENCODING='utf-8'))
    if listing.returncode:
        errors = [line for line in listing.stderr.splitlines() if line.startswith('ERROR:')]
        raise RuntimeError((errors[-1].removeprefix('ERROR:').strip() if errors else '') or '채널 목록을 읽을 수 없습니다.')
    data = json.loads(listing.stdout)
    ids = playlist_ids(data)
    if not ids:
        raise RuntimeError('The channel returned no video IDs; nothing was downloaded.')
    (output / 'channel-list.json').write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    done = archive_ids(output / 'downloaded.txt')
    done.update(import_existing(output, set(ids) - done))
    pending = [video_id for video_id in ids if video_id not in done]
    progress = ProgressDisplay(len(ids), len(ids) - len(pending))
    progress.begin()
    counts = {'downloaded': 0, 'failed': 0, 'skipped': 0, 'stopped': 0}
    failed = []
    pool = ThreadPoolExecutor(max_workers=args.workers)
    futures = {pool.submit(download_one, video_id, output, progress=progress): video_id for video_id in pending}
    try:
        for future in as_completed(futures):
            video_id = futures[future]
            try:
                outcome = future.result()
            except Exception as error:
                outcome = 'failed'
                log = output / 'download-logs' / (video_id + '.log')
                log.parent.mkdir(exist_ok=True)
                with log.open('a', encoding='utf-8') as file:
                    file.write('[에러] ' + str(error) + '\n')
            counts[outcome] += 1
            if outcome == 'failed':
                failed.append(video_id)
            progress.finish(video_id, outcome, last_error(output / 'download-logs' / (video_id + '.log')))
    except KeyboardInterrupt:
        print('\n[진행] 중단 중 · 다시 실행하면 이어받습니다.', flush=True)
        stop_downloads()
        for future in futures:
            future.cancel()
    finally:
        pool.shutdown(wait=True, cancel_futures=True)
        progress.close()
        (output / 'last-run.json').write_text(json.dumps({'counts': counts, 'failed': failed,
            'interrupted': STOP.is_set()}, indent=2), encoding='utf-8')
    return 130 if STOP.is_set() else (1 if failed else 0)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (RuntimeError, ValueError, OSError) as error:
        print('[에러]', error, file=sys.stderr)
        sys.exit(1)
