"""Download the basic-shorts fonts over verified HTTPS and check pinned SHA-256."""
import hashlib
from pathlib import Path
from urllib.request import urlopen

FONTS = [
    ('BlackHanSans-Regular.ttf', 'https://raw.githubusercontent.com/google/fonts/main/ofl/blackhansans/BlackHanSans-Regular.ttf', '31960809284026681774a8e52dc19ebcad26cf69b0ad9d560f288296fbb52739'),
    ('NanumBrush.ttf', 'https://raw.githubusercontent.com/google/fonts/main/ofl/nanumbrushscript/NanumBrushScript-Regular.ttf', '27ceaf578c96f594cdf07fe0181b251790acbb746a164e45c1f6473f89911a31'),
    ('Pretendard-ExtraBold.otf', 'https://raw.githubusercontent.com/orioncactus/pretendard/main/packages/pretendard/dist/public/static/Pretendard-ExtraBold.otf', 'c35fe941b7568d52a96010561540e47f9d3948dfde66ba25bc1908233e0a40cd'),
]

def main():
    dest = Path(__file__).resolve().parents[1] / 'local-fonts'
    dest.mkdir(exist_ok=True)
    for name, url, expected in FONTS:
        path = dest / name
        if path.exists():
            if hashlib.sha256(path.read_bytes()).hexdigest() == expected:
                print(name, 'OK (cached)')
                continue
            raise RuntimeError(f'{path} already exists with different contents; preserve it before retrying')
        with urlopen(url, timeout=60) as response:
            data = response.read()
        if hashlib.sha256(data).hexdigest() != expected:
            raise RuntimeError(f'{name}: checksum mismatch')
        # Exclusive creation preserves any file created while the download was running.
        with path.open('xb') as output:
            output.write(data)
        print(name, 'OK')

if __name__ == '__main__':
    main()
