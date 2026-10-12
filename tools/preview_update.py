# -*- coding: utf-8 -*-
"""렌더 없이 미리보기만 갱신 (2026-10-02).

사용자: "매번 렌더링 할게 아니라 마지막에 한 번만 렌더링하고 그 전까지는 미리보기에서만 처리하는 방식으로",
"렌더링 시간이 오래 걸리잖아 토큰도 더 많이 먹고".

    python tools/preview_update.py <편 폴더> [프로젝트id] [--keep-feedback]

edit.json · captions.csv · fx.json 을 고친 뒤 이것만 돌린다:
  1. shortsmith preview  - 컷 (cuts.json) + 장면 (scene.json) 만, 영상은 안 굽는다 (몇 초)
  2. export_shortsmith.py - 대시보드 프로젝트에 반영 (review.unbaked = true -> 미리보기가 원본 사본에서 컷대로 이어 튼다)
완성본은 사용자가 사용자 편집 탭 > 렌더 에서 마지막에 한 번 굽는다 (tools/apply_review.py -> shortsmith build).
--keep-feedback: 쪽지 · 프롬프트를 남긴다 (AI 편집이 끝난 판이면 붙이지 않는다 - 반영한 피드백은 비운다).
AI 편집 순서: 1) python tools/apply_review.py <편 폴더> <projects/id/project.json> (사용자가 고친 컷 · 자막을 편 폴더에 넣는다)
              2) edit.json · captions.csv · fx.json 고침   3) 이 도구. 1 을 빼먹으면 이 도구가 멈춘다 (고친 컷이 사라지지 않게).
"""
import os, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
args = [a for a in sys.argv[1:] if not a.startswith("--")]
if not args:
    sys.exit(__doc__)
work = os.path.abspath(args[0])
# 사용자가 대시보드에서 고친 컷 (사용자 편집 탭 클립 · 낱말 빼기 · 되살리기) 이 편 폴더에 들어갔는지 본다 - 안 들어갔는데 내보내면 사라진다.
# AI 편집은 시작할 때 python tools/apply_review.py <편 폴더> <project.json> 으로 먼저 넣는다 (그 표가 applied_review.json)
import io, json, hashlib
STORE = os.environ.get("KIRINUKI_PROJECTS") or os.path.join(ROOT, "projects")
if len(args) > 1 and "--force" not in sys.argv:
    pj = os.path.join(STORE, args[1], "project.json")
    rv = (json.load(io.open(pj, encoding="utf-8")).get("review") or {}) if os.path.exists(pj) else {}
    w = [[x.get("s"), bool(x.get("restore")), bool(x.get("drop"))] for sg in (rv.get("transcript") or []) for x in (sg.get("words") or [])
         if x.get("restore") or x.get("drop")]
    if rv.get("userClips") or w or rv.get("userLayers") or rv.get("userCaps"):
        sig = hashlib.sha1(json.dumps([rv.get("userClips") or [], w, rv.get("userLayers") or []] + ([rv["userCaps"]] if rv.get("userCaps") else []), sort_keys=True).encode("utf-8")).hexdigest()
        ap = os.path.join(work, "applied_review.json")
        done = json.load(io.open(ap, encoding="utf-8")).get("sig") if os.path.exists(ap) else None
        if done != sig:
            sys.exit("멈춤: 사용자가 대시보드에서 고친 컷이 편 폴더에 안 들어갔습니다 - 먼저 python tools/apply_review.py %s %s 를 돌리고"
                     " 그 위에서 고친 뒤 다시 돌리세요 (버려도 되면 --force)" % (work, pj))
ss = os.path.join(ROOT, "shortsmith")
# shortsmith 는 shortsmith 폴더에서 돌린다 (Remotion 이 실행 폴더에 Chrome 을 새로 받는다 - docs/editing-rules.md)
r = subprocess.run(["node", os.path.join(ss, "bin", "shortsmith.mjs"), "preview", work], cwd=ss)
if r.returncode:
    sys.exit(r.returncode)
r = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "export_shortsmith.py"), work] + args[1:2]
                   + (["--keep-feedback"] if "--keep-feedback" in sys.argv else []))
sys.exit(r.returncode)
