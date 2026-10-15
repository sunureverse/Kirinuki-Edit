"""Local, content-addressed video research records. No ASR or rendering side effects."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import tempfile
from datetime import datetime, timezone

DEFAULT_ROOT = Path(__file__).resolve().parents[1] / 'analysis-library'


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda: f.read(4 * 1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def stamp(path):
    s = Path(path).stat()
    return [s.st_size, s.st_mtime_ns]


def write(path, data):
    path = Path(path)
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix='.tmp')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2, allow_nan=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if Path(tmp).exists():
            Path(tmp).unlink()


def interval(start, end, duration):
    if not all(isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)
               for x in [start, end, duration]) or not 0 <= start < end <= duration:
        raise ValueError('Invalid source-relative interval')


def initialize(root, source, duration):
    source = Path(source).resolve(strict=True)
    interval(0, duration, duration)
    before = stamp(source)
    sha = digest(source)
    if before != stamp(source):
        raise ValueError('Source changed while hashing; retry after export completes')
    folder = Path(root) / sha
    folder.mkdir(parents=True, exist_ok=True)
    meta = folder / 'source.json'
    if meta.exists():
        old = read(meta)
        if abs(old['duration'] - duration) > .001:
            raise ValueError('Existing duration differs; verify source metadata')
    else:
        old = {'schemaVersion': 1, 'sha256': sha, 'duration': duration,
               'clock': 'supplied-video-seconds', 'locations': {}}
    # Identical copies share analysis. Old locations remain available.
    old['locations'][str(source)] = before
    write(meta, old)
    return folder


def validate_source(folder):
    meta = read(Path(folder) / 'source.json')
    for name, saved in meta['locations'].items():
        p = Path(name)
        if p.is_file():
            before = stamp(p)
            if before == saved:
                return meta
            if digest(p) == meta['sha256'] and before == stamp(p):
                return meta
    raise ValueError('Source missing or changed; register the actual video again')


def import_transcript(folder, source, offset=0):
    folder = Path(folder)
    meta = validate_source(folder)
    source = Path(source).resolve(strict=True)
    raw = read(source)
    if not isinstance(raw, list) or not raw:
        raise ValueError('Expected a non-empty segment list')
    segments = []
    for row in raw:
        s, e = row['start'] + offset, row['end'] + offset
        interval(s, e, meta['duration'])
        if not isinstance(row['text'], str):
            raise ValueError('Segment text must be a string')
        words = []
        for w in row.get('words', []):
            ws, we = w['start'] + offset, w['end'] + offset
            # ASR can emit zero-length tokens; retain them without treating as coverage.
            if ws != we:
                interval(ws, we, meta['duration'])
            elif not math.isfinite(ws) or not 0 <= ws <= meta['duration']:
                raise ValueError('Invalid word timestamp')
            words.append(dict(w, start=ws, end=we))
        segments.append(dict(row, start=s, end=e, words=words))
    key = hashlib.sha256((digest(source) + ':' + str(float(offset))).encode()).hexdigest()
    dest = folder / 'transcripts'
    dest.mkdir(exist_ok=True)
    target = dest / (key + '.json')
    if not target.exists():
        write(target, {'origin': str(source), 'offsetApplied': offset,
                       'reviewStatus': 'unverified-import', 'segments': segments})
    return target


def record(folder, entry):
    folder = Path(folder)
    meta = validate_source(folder)
    kind = entry.get('kind')
    if kind not in ['candidate', 'review', 'selection']:
        raise ValueError('kind must be candidate, review, or selection')
    interval(entry['start'], entry['end'], meta['duration'])
    for field in ['id', 'note', 'basis']:
        if not isinstance(entry.get(field), str) or not entry[field].strip():
            raise ValueError('Missing ' + field)
    if Path(entry['id']).name != entry['id'] or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-' for c in entry['id']):
        raise ValueError('Use a simple ASCII record id')
    if kind == 'review' and entry.get('mode') not in ['audio', 'video', 'audio-video', 'historical-record']:
        raise ValueError('Review needs an explicit mode')
    if kind == 'selection':
        candidate = folder / 'records' / (entry.get('candidateId', '') + '.json')
        if candidate.parent != folder / 'records' or not candidate.is_file() or read(candidate)['kind'] != 'candidate':
            raise ValueError('Selection must reference an existing candidate')
    dest = folder / 'records'
    dest.mkdir(exist_ok=True)
    target = dest / (entry['id'] + '.json')
    payload = dict(entry, recordedAt=datetime.now(timezone.utc).isoformat())
    # Exclusive creation: never overwrite earlier conclusions or user selections.
    with target.open('x', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=2, allow_nan=False)
    return target


def report(folder):
    folder = Path(folder)
    meta = validate_source(folder)
    lines = ['# 영상 분석 보관함', '', f"영상: {next(iter(meta['locations']))}",
             f"길이: {meta['duration']}초", '시간 기준: 제공된 영상의 시작 = 0초', '',
             '받아쓰기 파일이 있다는 것만으로 전체 영상을 확인했다는 뜻은 아닙니다.',
             '가져온 대사는 미검수 상태입니다. 확인 기록의 범위와 근거를 따로 확인하세요.', '', '## 대사 자료', '']
    for p in sorted((folder / 'transcripts').glob('*.json')):
        data = read(p)
        seg = data['segments']
        lines.append(f"- [{p.name}](transcripts/{p.name}): {len(seg)}개 대사, {min(x['start'] for x in seg):.3f}~{max(x['end'] for x in seg):.3f}초 (중간 미분석 구간 가능, 미검수)")
    for kind, title in [('candidate', '하이라이트 후보'), ('review', '확인 기록'), ('selection', '선택 기록')]:
        lines.extend(['', '## ' + title, ''])
        for p in sorted((folder / 'records').glob('*.json')):
            e = read(p)
            if e['kind'] == kind:
                lines.extend([f"- **{e['id']}** · {e['start']:.3f}~{e['end']:.3f}초 · {e.get('mode', kind)}",
                              '  ' + e['note'], '  근거: ' + e['basis']])
    target = folder / 'summary.md'
    target.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    return target


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest='command', required=True)
    init = sub.add_parser('init')
    init.add_argument('source', type=Path)
    init.add_argument('--duration', required=True, type=float, help='Verified ffprobe duration in seconds')
    init.add_argument('--root', type=Path, default=DEFAULT_ROOT)
    imp = sub.add_parser('import-transcript')
    imp.add_argument('folder', type=Path)
    imp.add_argument('transcript', type=Path)
    imp.add_argument('--offset', type=float, default=0, help='Add only for excerpt-relative ASR timestamps')
    rec = sub.add_parser('record')
    rec.add_argument('folder', type=Path)
    rec.add_argument('entry', type=Path)
    rep = sub.add_parser('report')
    rep.add_argument('folder', type=Path)
    a = p.parse_args()
    try:
        if a.command == 'init':
            result = initialize(a.root, a.source, a.duration)
        elif a.command == 'import-transcript':
            result = import_transcript(a.folder, a.transcript, a.offset)
        elif a.command == 'record':
            result = record(a.folder, read(a.entry))
        else:
            result = report(a.folder)
        print(result)
    except (ValueError, KeyError, OSError, TypeError) as e:
        p.exit(1, str(e) + '\n')


if __name__ == '__main__':
    main()
