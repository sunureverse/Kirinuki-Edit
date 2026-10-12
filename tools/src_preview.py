# -*- coding: utf-8 -*-
"""굽지 않은 미리보기용 원본 사본 (2026-09-29 지시: "추가된 부분 안 굽고 미리 보기에서 적용").

    python tools/src_preview.py <편 폴더> [프로젝트id]

대시보드 미리보기는 컷이 끝난 window_preview.mp4 를 튼다 - 컷에서 빠진 말은 그 안에 없어서 되살리기를 들어 볼 수 없었다.
그래서 **원본 통째의 가벼운 사본**을 한 번 만들어 두고, 미리보기가 "남길 구간"을 차례로 이어 튼다 (shortsmith preview 의 plan).

-> <편 폴더>/src_preview.mp4   원본 전체 화면, 1280 폭 30fps, 0.5초마다 키프레임, AAC
   project.json review.srcPreview = {path, w, h, crop, gmax}  ·  review.clips[i].crop / .gain (조각마다, cuts.json 에서)

소리: 완성본과 같은 크기로 듣게 window.mkv 로 잰 고정 이득(render.mjs 와 같은 식)에 **조각 이득 중 가장 큰 값(gmax)**을
더해 굽는다. 조각마다 이득이 달라서(이 편 0 ~ +4dB) 미리보기가 <Video volume> 로 10^((g - gmax)/20) 만큼 줄인다
(브라우저 볼륨은 1 을 못 넘어서 올릴 수는 없다). 필터는 이득(volume=NdB) 하나뿐이다 (docs/editing-rules.md).
원본이 그대로면 다시 굽지 않는다 (크기 · 수정 시각 · 이득을 src_preview.json 에 적어 둔다).
"""
import io, json, os, re, subprocess, sys

work = os.path.abspath(sys.argv[1])
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(work)
E = json.load(io.open("edit.json", encoding="utf-8"))
SRC = E["source"] if os.path.isabs(E["source"]) else os.path.join(work, E["source"])
CUTS = json.load(io.open("cuts.json", encoding="utf-8"))["pieces"]
crop0 = E.get("crop") or None


def probe(p):
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
                        "-of", "csv=p=0", p], capture_output=True, text=True)
    w, h = r.stdout.strip().split(",")[:2]
    return int(w), int(h)


def loud(p):
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", p, "-af", "ebur128=peak=true", "-f", "null", "-"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    tail = r.stderr.split("Summary")[-1]
    I = re.search(r"I:\s*(-?[\d.]+) LUFS", tail)
    P = re.search(r"Peak:\s*(-?[\d.]+) dBFS", tail)
    return float(I.group(1)), (float(P.group(1)) if P else -99.0)


W0, H0 = probe(SRC)
if not crop0:
    crop0 = {"x": 0, "y": 0, "w": W0, "h": H0}
preset = {}
pp = os.path.join(ROOT, "presets", E.get("preset", ""), "preset.json")
if os.path.exists(pp):
    preset = json.load(io.open(pp, encoding="utf-8"))
A = preset.get("audio") or {}
gmax = max([0.0] + [float(p.get("gainDb") or 0) for p in CUTS])
old = json.load(io.open("src_preview.json", encoding="utf-8")) if os.path.exists("src_preview.json") else None
# 미리보기만 하는 판 (2026-10-02, shortsmith preview): window.mkv 가 없거나 컷보다 옛것이면 그걸로 재지 않는다.
# 전에 구운 사본이 있으면 그 이득을 그대로 (소리 크기는 미리보기용이라 다시 구울 까닭이 없다), 없으면 원본 통째로 잰다 (짐작에 가까움)
stale = not os.path.exists("window.mkv") or os.path.getmtime("window.mkv") < os.path.getmtime("cuts.json")
if stale and old and old.get("src") == SRC and os.path.exists(os.path.join(work, "src_preview.mp4")):
    gain = old["gain"]
    gmax = old.get("gmax", gmax)      # 대시보드가 조각 소리를 10^((이득 - gmax)/20) 로 줄인다 - 구운 사본 기준 값을 그대로
    pg = gain - gmax
else:
    I, TP = loud(SRC if stale else "window.mkv")
    pg = min(A.get("targetLufs", -16) - I, A.get("maxTruePeakDb", -1.5) - TP)      # render.mjs 와 같은 식
    gain = round(pg + gmax, 2)

st = os.stat(SRC)
key = {"src": SRC, "size": st.st_size, "mtime": int(st.st_mtime), "gain": gain, "v": 1}
out = os.path.join(work, "src_preview.mp4")
if {k: v for k, v in (old or {}).items() if k != "gmax"} != key or not os.path.exists(out):
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", SRC, "-vf", "fps=30,scale=1280:-2",
                    "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-g", "15", "-pix_fmt", "yuv420p",
                    "-movflags", "+faststart", "-af", "volume=%.2fdB" % gain, "-c:a", "aac", "-b:a", "160k", out], check=True)
    json.dump(dict(key, gmax=gmax), io.open("src_preview.json", "w", encoding="utf-8"), ensure_ascii=False)
    print("원본 사본 구움: %s (이득 %+.2fdB = 고정 %+.2f + 조각 최대 %+.1f)" % (out, gain, pg, gmax))
else:
    print("원본 사본 그대로 씀: %s" % out)

# ---- 프로젝트에 적는다 (자막 · 쪽지는 안 건드린다) ----
STORE = os.environ.get("KIRINUKI_PROJECTS") or os.path.join(ROOT, "projects")   # 시험용 저장소로 돌릴 때 (2026-10-02)
pid = sys.argv[2] if len(sys.argv) > 2 else None
if not pid:
    for nm in sorted(os.listdir(STORE)):
        pj = os.path.join(STORE, nm, "project.json")
        if nm.startswith("_") or not os.path.isfile(pj):
            continue
        try:
            r = (json.load(io.open(pj, encoding="utf-8")).get("render") or {})
        except ValueError:
            continue
        if os.path.normcase(os.path.join(ROOT, r.get("dir") or "~")) == os.path.normcase(work):
            pid = nm
if not pid:
    sys.exit("프로젝트를 못 찾음 - python tools/src_preview.py <편 폴더> <프로젝트id>")
pj = os.path.join(STORE, pid, "project.json")
cur = json.load(io.open(pj, encoding="utf-8"))
rv = cur.get("review") or {}
rv["srcPreview"] = {"path": out.replace(os.sep, "/"), "w": W0, "h": H0, "crop": crop0, "gmax": gmax}
# 카메라 경로가 있는 편 (댄스, 2026-10-03): 굽지 않은 미리보기도 그 경로로 화면을 잡는다 (Window.tsx PlanRange, body.mjs cameraSpans 와 같은 계산)
cam = (E.get("camera") or {}).get("keys") or []
if cam:
    rv["srcPreview"]["camera"] = [dict({k: round(float(c[k]), 2) for k in ("t", "x", "y", "h")}, **({"in": c["in"]} if c.get("in") else {})) for c in cam]
cl = rv.get("clips") or []
main = [p for p in CUTS if not p.get("source") and not p.get("gap")]
if len(cl) == len(main):
    for k, p in zip(cl, main):
        k["crop"] = p.get("crop") or crop0
        k["gain"] = float(p.get("gainDb") or 0)
else:
    print("알림: 조각 수가 다름 (review %d · cuts %d) - 조각별 크롭 · 이득은 못 적었다" % (len(cl), len(main)))
cur["review"] = rv
io.open(pj, "w", encoding="utf-8").write(json.dumps(cur, ensure_ascii=False, indent=2) + "\n")
print("프로젝트에 적음: %s  (조각 %d)" % (pid, len(cl)))
