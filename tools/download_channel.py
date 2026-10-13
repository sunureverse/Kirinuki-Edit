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


def run_command(command, log):
    with LOCK:
        if STOP.is_set():
            return -1
        kwargs = {'start_new_session': True} if os.name != 'nt' else {}
        process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT,
                                   env=dict(os.environ, PYTHONIOENCODING='utf-8'), **kwargs)
        PROCESSES.add(process)
    try:
        return process.wait()
    finally:
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


def download_one(video_id, output, run=run_command):
    if STOP.is_set():
        return 'stopped'
    print('Downloading:', video_id, flush=True)
    archive = output / 'downloaded.txt'
    logs = output / 'download-logs'
    logs.mkdir(exist_ok=True)
    command = [sys.executable, '-m', 'yt_dlp', '--js-runtimes', 'node',
               '--no-playlist', '--no-simulate', '--newline', '--windows-filenames',
               '--match-filter', "live_status = 'was_live'",
               '--download-archive', str(archive), '--retries', '5', '--fragment-retries', '5',
               '-f', 'bv*[height<=1080]+ba/b[height<=1080]', '--merge-output-format', 'mkv',
               '-P', str(output), '-o', '%(upload_date)s_%(id)s_%(title).100s.%(ext)s',
               'https://www.youtube.com/watch?v=' + video_id]
    with (logs / (video_id + '.log')).open('w', encoding='utf-8') as log:
        code = run(command, log)
    if STOP.is_set():
        return 'stopped'
    if code != 0:
        return 'failed'
    # Filtered videos also exit 0; only the archive establishes a completed download.
    return 'downloaded' if video_id in archive_ids(archive) else 'skipped'


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
    print('Output:', output, flush=True)
    print('Reading the channel list once...', flush=True)
    # Resolve one list for all workers so changing playlist positions cannot overlap.
    command = [sys.executable, '-m', 'yt_dlp', '--js-runtimes', 'node', '--flat-playlist',
               '--dump-single-json', '--skip-download', args.channel]
    listing = subprocess.run(command, capture_output=True, text=True, encoding='utf-8',
                             env=dict(os.environ, PYTHONIOENCODING='utf-8'))
    if listing.returncode:
        raise RuntimeError(listing.stderr.strip() or 'Could not read the channel list.')
    data = json.loads(listing.stdout)
    ids = playlist_ids(data)
    if not ids:
        raise RuntimeError('The channel returned no video IDs; nothing was downloaded.')
    (output / 'channel-list.json').write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    done = archive_ids(output / 'downloaded.txt')
    done.update(import_existing(output, set(ids) - done))
    pending = [video_id for video_id in ids if video_id not in done]
    print(f'Listed: {len(ids)}; already downloaded: {len(ids) - len(pending)}; queued: {len(pending)}; workers: {args.workers}', flush=True)
    counts = {'downloaded': 0, 'failed': 0, 'skipped': 0, 'stopped': 0}
    failed = []
    pool = ThreadPoolExecutor(max_workers=args.workers)
    futures = {pool.submit(download_one, video_id, output): video_id for video_id in pending}
    try:
        for future in as_completed(futures):
            video_id = futures[future]
            try:
                outcome = future.result()
            except Exception as error:
                print(video_id, 'ERROR:', error, flush=True)
                outcome = 'failed'
            counts[outcome] += 1
            if outcome == 'failed':
                failed.append(video_id)
            print(f'[{sum(counts.values())}/{len(pending)}] {video_id}: {outcome}', flush=True)
    except KeyboardInterrupt:
        print('\nStopping. Rerun to resume completed/partial downloads.', flush=True)
        stop_downloads()
        for future in futures:
            future.cancel()
    finally:
        pool.shutdown(wait=True, cancel_futures=True)
        (output / 'last-run.json').write_text(json.dumps({'counts': counts, 'failed': failed,
            'interrupted': STOP.is_set()}, indent=2), encoding='utf-8')
    print('Summary:', counts, flush=True)
    print('Logs:', output / 'download-logs', flush=True)
    return 130 if STOP.is_set() else (1 if failed else 0)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (RuntimeError, ValueError, OSError) as error:
        print('ERROR:', error, file=sys.stderr)
        sys.exit(1)
