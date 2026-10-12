# -*- coding: utf-8 -*-
"""편집 관리 대시보드용 로컬 서버.

정적 파일을 서비스하면서, 대시보드가 만든 작업을 디스크에 떨어뜨린다. 그래야
Codex가 JSON과 지시문을 함께 읽고 작업할 수 있다. 모델 API는 직접 호출하지 않는다.

렌더도 여기서 직접 돌린다 (/api/render). 손댈 것이 없는 렌더까지 사람이나
모델을 기다릴 이유가 없다 - 대시보드가 확정한 타임라인을 프로젝트 폴더의
파이프라인 스크립트에 그대로 넣고 굽는다. 자막 언어가 원본과 달라 번역이
필요한 것만 jobs/ 로 넘어간다.

대시보드와 수명을 맞춘다. 페이지가 열려 있는 동안 몇 초마다 핑을 보내고, 탭을
닫으면 작별 신호를 보낸다. 붙어 있는 페이지가 하나도 없어지면 서버가 스스로
내려간다. 브라우저를 강제 종료해 작별 신호가 오지 않아도 핑이 끊기면 같은
결과가 된다.

    python dashboard/server.py [--port 8899] [--jobs ../jobs] [--open]
"""
import argparse
import json
import os
import shlex
import subprocess
import sys
import tempfile
from urllib.parse import quote
import threading
import time
import webbrowser
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(HERE)          # 작업 폴더 (presets/ · shortsmith/ 가 있다)
ROOT = os.path.dirname(HERE)


def _iso(ts):
    """파일 시각을 대시보드가 읽는 모양(ISO)으로."""
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(ts))

# 페이지가 보내는 핑 간격보다 넉넉히 길어야 한다. 짧으면 탭 전환이나 잠깐의
# 렉으로도 서버가 내려간다.
PING_INTERVAL = 3.0
CLIENT_TTL = 12.0
# 숨은 탭(다른 탭 · 최소화)은 브라우저가 타이머를 1분에 한 번까지 늦추고, 오래 두면 멈춘다 - 12초로 보면
# 탭이 살아 있는데 서버가 내려갔다 (2026-10-01: 브라우저 창이 뒤에 있는 동안 두 번 넘게). 숨었다고 알린 페이지는
# 이만큼 기다린다. 탭을 닫으면 pagehide 의 bye 로 바로 빠지므로 닫기는 그대로 빠르다
HIDDEN_TTL = 2 * 3600.0
# 브라우저가 처음 붙기까지 기다려 주는 시간. 이게 없으면 서버가 뜨자마자
# "붙은 페이지가 없다"며 바로 내려간다.
STARTUP_GRACE = 45.0


class Clients:
    """살아 있는 대시보드 페이지 목록."""

    def __init__(self):
        self._seen = {}
        self._lock = threading.Lock()
        self.started = time.time()
        # 한 번이라도 페이지가 붙었는지. 이게 없으면 페이지가 붙었다 닫힌 뒤에도
        # 시작 유예가 끝날 때까지 서버가 남아 있다 - 닫자마자 내려가야 한다.
        self.had_client = False

    def ping(self, cid, hidden=False):
        with self._lock:
            new = cid not in self._seen
            self._seen[cid] = (time.time(), HIDDEN_TTL if hidden else CLIENT_TTL)
            self.had_client = True
        return new

    def bye(self, cid):
        with self._lock:
            self._seen.pop(cid, None)

    def alive(self):
        now = time.time()
        with self._lock:
            for cid, (t, ttl) in list(self._seen.items()):
                if now - t > ttl:
                    del self._seen[cid]
            return len(self._seen)

    def ever_connected(self):
        # 붙은 적이 있으면 바로 판단하고, 아직 없으면 브라우저가 뜰 때까지 봐준다
        return self.had_client or time.time() - self.started > STARTUP_GRACE


CLIENTS = Clients()


def _slug(s, fallback="job"):
    keep = [c for c in (s or "") if c.isalnum() or c in "-_"]
    return ("".join(keep) or fallback)[:40]


# ==================== 렌더 ====================
# 대시보드가 확정한 타임라인을 프로젝트 폴더의 파이프라인에 그대로 넣고 굽는다.
# 굽는 데 몇 분씩 걸리므로 요청을 붙잡아 두지 않는다 - 스레드에서 돌리고,
# 대시보드가 /api/render/status 로 진행을 물어 간다.

TIMES_FILE = ".render_times.json"


def _times_load(work):
    """이 폴더에서 단계마다 지난번에 몇 초 걸렸는지."""
    try:
        with open(os.path.join(work, TIMES_FILE), encoding="utf-8") as f:
            d = json.load(f)
        return {k: float(v) for k, v in d.items() if isinstance(v, (int, float))}
    except Exception:
        return {}


def _times_save(work, got):
    """이번에 잰 시간을 남긴다. 다음 렌더의 진행률이 이걸 쓴다.

    지난 값과 반씩 섞는다. 한 번 유난히 느렸다고(다른 프로그램이 CPU를 물고
    있었다든가) 다음 진행률이 통째로 어긋나면 곤란하다.
    """
    if not got:
        return
    old = _times_load(work)
    for k, v in got.items():
        if v <= 0:
            continue                  # 0초짜리 단계는 무게가 될 수 없다
        old[k] = round(v if k not in old else (old[k] + v) / 2, 2)
    try:
        with open(os.path.join(work, TIMES_FILE), "w", encoding="utf-8") as f:
            json.dump(old, f, ensure_ascii=False, indent=2, sort_keys=True)
    except Exception:
        pass                      # 진행률은 있으면 좋은 것이지 렌더를 막을 일이 아니다


class Renders:
    """돌아가는(그리고 방금 끝난) 렌더 목록."""

    def __init__(self):
        self._r = {}
        self._lock = threading.Lock()

    def start(self, rid, steps, work=""):
        # 지난번 시간이 있으면 단계마다 무게가 다르다. 영상 굽기가 몇 분인데
        # 컷 반영이 1초라면, 셋을 똑같이 3분의 1로 세는 진행률은 거짓말이다.
        past = _times_load(work)
        with self._lock:
            self._r[rid] = {
                "id": rid, "state": "running", "step": 0, "steps": steps,
                "log": [], "error": None, "outputs": [], "work": work,
                "startedAt": time.time(), "endedAt": None,
                "stepAt": time.time(),          # 지금 단계가 언제 시작했나
                "took": {},                     # 이번에 잰 시간
                "guess": {k: past[k] for k in steps if k in past},
                "skipped": [],                  # 건너뛴 단계 (컷이 그대로일 때)
            }

    def _touch(self, rid, fn):
        with self._lock:
            r = self._r.get(rid)
            if r:
                fn(r)

    def line(self, rid, text):
        text = (text or "").rstrip()
        if not text:
            return
        sys.stderr.write("    | %s\n" % text)
        # 로그가 무한정 늘어나면 상태 응답이 무거워진다. 앞을 버린다.
        def f(r):
            r["log"].append(text)
            if len(r["log"]) > 400:
                del r["log"][:len(r["log"]) - 400]
        self._touch(rid, f)

    def _mark(self, r, now):
        """방금 끝난 단계가 몇 초 걸렸는지 적어 둔다.

        건너뛴 단계는 적지 않는다. 0초로 배워 두면 다음에 컷이 바뀌어 정말로
        영상을 구울 때 "0초짜리 단계"로 세어, 몇 분 동안 막대가 그 자리에
        붙어 있게 된다.
        """
        label = r["steps"][r["step"]]
        if label not in r["skipped"]:
            r["took"][label] = round(now - r["stepAt"], 2)

    def step(self, rid, i):
        def f(r):
            now = time.time()
            if i > r["step"]:
                self._mark(r, now)
            r["step"] = i
            r["stepAt"] = now
        self._touch(rid, f)

    def skip(self, rid, i):
        """이번엔 건너뛴 단계. 무게에서 빼야 진행률이 그 자리에 멈춰 있지 않다."""
        self._touch(rid, lambda r: r["skipped"].append(r["steps"][i]))

    def output(self, rid, path):
        self._touch(rid, lambda r: r["outputs"].append(path))

    def done(self, rid, error=None):
        def f(r):
            now = time.time()
            if not error:
                self._mark(r, now)
            r["state"] = "error" if error else "done"
            r["error"] = error
            r["endedAt"] = now
        self._touch(rid, f)
        r = self.get(rid)
        if r and not error:
            _times_save(r.get("work") or "", r["took"])

    def get(self, rid):
        with self._lock:
            r = self._r.get(rid)
            return dict(r) if r else None

    def report(self, rid):
        """대시보드에 넘길 모양. 진행률을 여기서 낸다 - 한 군데서만 세야
        화면과 로그가 서로 다른 숫자를 말하지 않는다."""
        r = self.get(rid)
        if not r:
            return None
        steps = r["steps"]
        # 단계마다 무게. 지난번에 잰 초가 있으면 그걸 쓴다. 영상 굽기가 몇
        # 분인데 컷 반영이 1초라면, 셋을 똑같이 세는 진행률은 거짓말이다.
        # 아직 아무것도 모르면 초를 지어내지 않고 단계 수로만 센다 - 1초짜리
        # 단계라고 쳐 버리면 몇 분짜리 인코딩이 시작하자마자 100%가 된다.
        guess = r["guess"]
        known = [guess[k] for k in steps if k in guess]
        dflt = (sum(known) / len(known)) if known else 1.0
        w = {}
        for k in steps:
            w[k] = 0.0 if k in r["skipped"] else float(guess.get(k, dflt))
        total = sum(w.values()) or 1.0

        now = r["endedAt"] or time.time()
        done_w = 0.0
        for i, k in enumerate(steps):
            if i < r["step"]:
                done_w += w[k]
        cur = steps[r["step"]] if r["step"] < len(steps) else None
        step_el = now - r["stepAt"]
        if r["state"] == "done":
            done_w = total
        elif r["state"] == "running" and cur:
            # 지금 단계 안에서 얼마나 왔는지는 그 단계를 재 본 적이 있어야
            # 말할 수 있다. 모르면 0으로 두고 단계가 넘어갈 때만 올린다.
            exp = guess.get(cur, 0.0)
            if exp > 0:
                done_w += w[cur] * min(step_el / exp, 0.99)

        pct = round(done_w / total * 100)
        # 끝나기 전에 100%를 보여 주면, 다 됐는데 안 끝나는 것처럼 보인다.
        pct = max(0, min(99 if r["state"] == "running" else 100, pct))

        # 남은 시간은 남은 단계를 전부 재 본 적이 있어야 말할 수 있다.
        # 하나라도 처음 도는 단계가 끼면(이를테면 영상 굽기를 처음 하는
        # 렌더) 평균으로 메운 무게라 몇 분짜리를 몇 초라고 말하게 된다.
        # 그럴 땐 "다음 렌더부터"라고 하는 편이 정직하다.
        left = [k for i, k in enumerate(steps)
                if i >= r["step"] and k not in r["skipped"]]
        sure = bool(known) and all(k in guess for k in left)
        eta = max(0, round(total - done_w)) if (r["state"] == "running" and sure) else None

        r = dict(r)
        r["percent"] = pct
        r["elapsed"] = round(now - r["startedAt"], 1)
        r["stepElapsed"] = round(step_el, 1)
        r["eta"] = eta
        r["estimated"] = sure                 # 남은 시간을 말할 수 있는가
        for k in ("stepAt", "guess", "work"):
            r.pop(k, None)
        return r

    def busy(self):
        """이미 굽고 있는 렌더가 있으면 그 id. 같은 폴더에 둘이 들어가면
        중간 파일(seg_*.mkv, edit_nocap.mkv)을 서로 덮어쓴다."""
        with self._lock:
            for rid, r in self._r.items():
                if r["state"] == "running":
                    return rid
        return None


RENDERS = Renders()


def _run(rid, work, args, extra_env=None):
    """파이썬 스크립트 하나를 돌리고 나오는 말을 그대로 로그에 옮긴다."""
    return _run_cmd(rid, work, [sys.executable, "-u"] + args, extra_env)


def _run_cmd(rid, work, cmd, extra_env=None):
    """명령 하나 (파이썬 · node) 를 돌리고 나오는 말을 그대로 로그에 옮긴다."""
    args = cmd[2:] if cmd[:2] == [sys.executable, "-u"] else cmd
    RENDERS.line(rid, "$ " + " ".join(shlex.quote(a) for a in args))
    # 파이프라인 스크립트가 print 로 한글을 찍는다. 콘솔 코드페이지를 타면
    # cp949 로 깨지므로 자식에게도 UTF-8 을 쓰게 한다.
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
    env.update(extra_env or {})
    p = subprocess.Popen(
        cmd, cwd=work,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace", env=env)
    for ln in p.stdout:
        RENDERS.line(rid, ln)
        # 스크립트가 "updated: <경로>" 로 결과를 알린다. 어디에 나왔는지는
        # 로그를 뒤지지 않아도 보여야 한다.
        t = ln.strip()
        if t.lower().startswith("updated:"):
            RENDERS.output(rid, t.split(":", 1)[1].strip())
    return p.wait()


def _csv_rows(path):
    """번역 CSV 에서 시각과 "무엇을 옮긴 것인지"(src)를 뽑는다.

    src 는 옮기기 전의 원문이다. 이게 있어야 그 번역이 지금 자막에 맞는지
    알 수 있다 - 시각만 견주면 글자만 고친 자막을 못 잡아내고, 낡은 번역이
    그대로 구워진다.
    """
    def secs(t):
        h, m, x = t.split(":")
        return round(int(h) * 3600 + int(m) * 60 + float(x), 3)
    try:
        import csv as _csv
        for enc in ("utf-8-sig", "cp949"):
            try:
                with open(path, encoding=enc) as f:
                    return [{"start": secs(r["start"]), "end": secs(r["end"]),
                             "src": (r.get("src") or "").strip()}
                            for r in _csv.DictReader(f) if r.get("start")]
            except UnicodeDecodeError:
                continue
    except Exception:
        pass
    return None


def _cuts_of(work):
    """지금 파이프라인에 들어 있는 컷 목록 (없으면 None)."""
    fp = os.path.join(work, "pieces_override.json")
    if not os.path.exists(fp):
        return None
    try:
        with open(fp, encoding="utf-8") as f:
            return json.load(f).get("pieces")
    except Exception:
        return None


def render_job(rid, work, project_json, caption_steps, out_dir=""):
    """컷 반영 -> 영상 굽기 -> 자막 굽기.

    영상 굽기는 컷이 바뀌었을 때만 한다. 자막만 고친 렌더까지 전체를 다시
    구우면 몇 분이 몇십 초로 끝날 일이 몇 분이 된다 - edit_nocap.mkv 는
    자막이 없는 중간물이라 컷이 그대로면 그대로 쓸 수 있다.
    """
    # 내보내기 폴더는 환경 변수로 넘긴다. 스크립트가 이 값을 보면 거기에
    # 저장하고, 없으면 자기 안에 적힌 자리로 간다 - 대시보드 없이 손으로
    # 돌려도 그대로 동작해야 한다.
    env = {"DASH_OUT_DIR": out_dir} if out_dir else {}
    try:
        if out_dir:
            os.makedirs(out_dir, exist_ok=True)
            RENDERS.line(rid, "내보내기 폴더: " + out_dir)
        before = _cuts_of(work)
        RENDERS.step(rid, 0)
        if _run(rid, work, ["import_project.py", project_json]) != 0:
            return RENDERS.done(rid, "컷 · 자막을 파이프라인에 넣지 못했습니다")

        after = _cuts_of(work)
        nocap = os.path.join(work, "edit_nocap.mkv")
        RENDERS.step(rid, 1)
        if before is not None and after == before and os.path.exists(nocap):
            RENDERS.line(rid, "컷이 그대로라 영상은 다시 굽지 않는다 (edit_nocap.mkv 재사용)")
            RENDERS.skip(rid, 1)
        else:
            # seg_durs.json 은 지난 렌더에서 잰 클립 길이다. 컷이 바뀌었는데
            # 남겨 두면 timeline 이 옛 길이로 완성본 시각을 계산해 자막이
            # 통째로 밀린다.
            seg = os.path.join(work, "seg_durs.json")
            if os.path.exists(seg):
                os.remove(seg)
                RENDERS.line(rid, "seg_durs.json 을 지웠다 (컷이 바뀌면 다시 재야 한다)")
            if _run(rid, work, ["build_edit.py"]) != 0:
                return RENDERS.done(rid, "영상을 굽지 못했습니다")

        for i, (lang, script) in enumerate(caption_steps):
            RENDERS.step(rid, 2 + i)
            if _run(rid, work, [script], env) != 0:
                return RENDERS.done(rid, "%s 자막을 굽지 못했습니다 (%s)" % (lang, script))
        RENDERS.done(rid)
    except Exception as e:                                  # noqa - 무엇이든 알려야 한다
        RENDERS.line(rid, "%s: %s" % (type(e).__name__, e))
        RENDERS.done(rid, "렌더 중 오류: %s" % e)



def shortsmith_job(rid, work, project_json, pid):
    """AI 없는 렌더 (shortsmith 편, 2026-09-18 사용자 지시 "렌더는 ai 없이 자막 같은거만 반영해서 바로 재 렌더").

    피드백 탭에서 고친 자막 -> captions.csv (+ 연출이 가리키는 줄 이름) -> shortsmith build -> 대시보드 갱신.
    되살리기 · 빼기는 미리보기에서 들은 그대로 edit.json 에 넣는다 (2026-09-29, apply_review.py). 연출 판단은 "편집"(AI). build 는 조각 캐시를 써서 자막만 바뀌면 바뀐 덩어리만 굽는다.
    """
    tools = os.path.join(ROOT_DIR, "tools")
    try:
        RENDERS.step(rid, 0)
        ej = os.path.join(work, "edit.json")
        before = open(ej, "rb").read() if os.path.exists(ej) else b""
        if _run(rid, work, [os.path.join(tools, "apply_review.py"), work, project_json]) != 0:
            return RENDERS.done(rid, "자막을 반영하지 못했습니다")
        RENDERS.step(rid, 1)
        cli = os.path.join(ROOT_DIR, "shortsmith", "bin", "shortsmith.mjs")
        # 되살리기 · 빼기로 edit.json 의 남길 구간이 바뀌었으면 cuts 부터 (build 는 있는 cuts.json 을 그냥 쓴다)
        if os.path.exists(ej) and open(ej, "rb").read() != before:
            if _run_cmd(rid, work, ["node", cli, "cuts", work]) != 0:
                return RENDERS.done(rid, "컷을 다시 계산하지 못했습니다")
        if _run_cmd(rid, work, ["node", cli, "build", work]) != 0:
            return RENDERS.done(rid, "렌더하지 못했습니다")
        RENDERS.step(rid, 2)
        if _run(rid, work, [os.path.join(tools, "export_shortsmith.py"), work, pid, "--keep-feedback"]) != 0:
            return RENDERS.done(rid, "대시보드에 반영하지 못했습니다")
        try:
            with open(os.path.join(work, "edit.json"), encoding="utf-8") as f:
                o = json.load(f).get("out")
            if o:
                RENDERS.output(rid, o if os.path.isabs(o) else os.path.join(work, o))
        except Exception:
            pass
        RENDERS.done(rid)
    except Exception as e:                                  # noqa - 무엇이든 알려야 한다
        RENDERS.line(rid, "%s: %s" % (type(e).__name__, e))
        RENDERS.done(rid, "렌더 중 오류: %s" % e)


class Handler(SimpleHTTPRequestHandler):
    jobs_dir = os.path.join(os.path.dirname(HERE), "jobs")
    projects_dir = os.path.join(os.path.dirname(HERE), "projects")
    server_ref = None

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=HERE, **kw)

    # 기본 로그는 요청마다 한 줄씩 찍어서 핑만으로 화면이 가득 찬다
    def log_message(self, fmt, *args):
        if self.path.startswith("/api/ping"):
            return
        sys.stderr.write("  %s %s\n" % (self.command, self.path))

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return {}

    def do_GET(self):
        if self.path.startswith("/api/media/"):
            return self.media_api()
        if self.path.startswith("/api/file"):
            return self.serve_local_file()
        if self.path.startswith("/api/fonts"):
            return self.list_fonts()
        if self.path.startswith("/api/projects"):
            return self.list_projects()
        if self.path.startswith("/api/styles"):
            return self.list_styles()
        if self.path.startswith("/api/project/thumb"):
            return self.serve_thumb()
        if self.path.startswith("/api/project"):
            return self.read_project()
        if self.path.startswith("/api/render/status"):
            return self.render_status()
        if self.path.startswith("/api/dirs"):
            return self.list_dirs()
        if self.path.startswith("/api/translations"):
            return self.list_translations()
        if self.path.startswith("/api/status"):
            return self._json(200, {
                "ok": True,
                "clients": CLIENTS.alive(),
                "jobsDir": os.path.abspath(self.jobs_dir),
                "projectsDir": os.path.abspath(self.projects_dir),
                "pingInterval": PING_INTERVAL,
            })
        # 편집한 JS/CSS가 캐시에 걸려 반영되지 않는 일이 잦아서 캐시를 끈다
        self.send_header  # noqa - 아래 end_headers 훅에서 처리
        return super().do_GET()

    # 대시보드가 프로젝트를 불러오면 클립에 원본 경로만 남아 있다. 브라우저는
    # 경로만으로 파일을 다시 열 수 없어서 미리보기가 "원본 파일이 연결되지
    # 않았습니다"로 뜬다. 서버가 그 파일을 내주면 사용자가 다시 끌어다 놓지
    # 않아도 된다. 로컬 전용 서버이고 사용자가 직접 고른 파일만 내준다.
    # 정지 그림도 내준다. 롱폼의 인용 카드는 LongBG.jpg 를 배경으로 깔기
    # 때문에, 그림을 못 내주면 미리보기에서 그 장면이 통째로 빈다.
    IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}
    MEDIA_EXT = {".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi",
                 ".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg"}

    def serve_local_file(self):
        from urllib.parse import urlparse, parse_qs, unquote
        q = parse_qs(urlparse(self.path).query)
        path = unquote((q.get("path") or [""])[0])
        if not path:
            return self._json(400, {"ok": False, "error": "path 없음"})
        path = os.path.abspath(path)
        ext = os.path.splitext(path)[1].lower()
        # 장면 미리보기(render/preview)가 scene.json 과 자막 글꼴을 읽어 간다. json 은 scene*.json 만 내준다
        scene_ok = (ext == ".json" and os.path.basename(path).startswith("scene")) or ext in (".otf", ".ttf")
        if ext not in self.MEDIA_EXT and ext not in self.IMAGE_EXT and not scene_ok:
            return self._json(403, {"ok": False,
                                    "error": "영상 · 오디오 · 그림 파일만 내준다"})
        if not os.path.isfile(path):
            return self._json(404, {"ok": False, "error": "파일이 없다: " + path})

        size = os.path.getsize(path)
        ctype = {".mp4": "video/mp4", ".mov": "video/quicktime", ".mkv": "video/x-matroska",
                 ".webm": "video/webm", ".m4v": "video/mp4", ".avi": "video/x-msvideo",
                 ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4",
                 ".aac": "audio/aac", ".flac": "audio/flac",
                 ".ogg": "audio/ogg",
                 ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                 ".png": "image/png", ".webp": "image/webp",
                 ".gif": "image/gif", ".bmp": "image/bmp",
                 ".json": "application/json", ".otf": "font/otf", ".ttf": "font/ttf"}.get(ext,
                                          "application/octet-stream")
        # 범위 요청을 받아야 영상에서 앞뒤로 건너뛸 수 있다
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        if rng and rng.startswith("bytes="):
            a, _, b = rng[6:].partition("-")
            if a:
                start = int(a)
                if b:
                    end = min(int(b), size - 1)
            elif b:
                start = max(0, size - int(b))
        if start > end or start >= size:
            self.send_response(416)
            self.send_header("Content-Range", "bytes */%d" % size)
            self.end_headers()
            return
        length = end - start + 1
        self.send_response(206 if rng else 200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        if rng:
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        # no-store 이면 미리보기가 되감을 때마다 영상을 처음부터 다시 받아 멈칫거렸다. 파일이 바뀌면
        # Last-Modified 로 다시 받게 하고, 그 전에는 브라우저가 들고 있던 것을 쓴다
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Last-Modified", self.date_time_string(int(os.path.getmtime(path))))
        self.end_headers()
        with open(path, "rb") as f:
            f.seek(start)
            left = length
            while left > 0:
                chunk = f.read(min(262144, left))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionAbortedError):
                    return          # 브라우저가 탐색하며 연결을 끊는 건 정상이다
                left -= len(chunk)

    # ------------------------------------------------------------------
    # 사용자 편집 탭 (2026-10-02 둘째): 소스 폴더 · 파형 · 썸네일
    #
    # 사용자: "미디어 · 클립 부분 -> 소스 폴더 추가로 변경", "오디오 부분에 파형 적용 비디오의 경우 일정부분마다 썸네일 캡쳐해서 클립에 적용".
    # 브라우저는 고른 폴더의 진짜 경로를 안 주므로 폴더는 서버가 읽어 보여 준다 (로컬 전용 서버).
    # 파형 · 썸네일은 한 번 만들어 임시 폴더에 둔다 (파일 경로 · 크기 · 수정 시각이 열쇠 - 파일이 바뀌면 새로 만든다).
    # 소리 필터 없음 - 파형은 재는 데만 쓴다 (tools/src_wave.py 와 같은 식: 20ms 최고값 dB -60..0 을 한 바이트).
    # ------------------------------------------------------------------
    MEDIA_V = 1
    THUMB_H = 72          # 썸네일 한 장 높이 (px) - 타임라인 V1 칸에 맞춰 줄여 그린다
    THUMB_COLS = 20       # 한 장에 가로로 20장씩 이어 붙인다 (그림 한 장 = 요청 한 번)

    def _media_key(self, path, tag):
        import hashlib
        st = os.stat(path)
        k = "%s|%d|%d|%s|%d" % (os.path.abspath(path).lower(), st.st_size, int(st.st_mtime), tag, self.MEDIA_V)
        d = os.path.join(tempfile.gettempdir(), "kirinuki_media")
        os.makedirs(d, exist_ok=True)
        return os.path.join(d, hashlib.sha1(k.encode("utf-8")).hexdigest()[:24])

    @staticmethod
    def _probe(path):
        r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height",
                            "-of", "json", path], capture_output=True, text=True, encoding="utf-8", errors="replace")
        try:
            j = json.loads(r.stdout or "{}")
        except ValueError:
            j = {}
        v = [s for s in j.get("streams", []) if s.get("codec_type") == "video"]
        a = [s for s in j.get("streams", []) if s.get("codec_type") == "audio"]
        try:
            dur = float((j.get("format") or {}).get("duration") or 0)
        except ValueError:
            dur = 0.0
        return {"dur": dur, "w": v[0].get("width") if v else None, "h": v[0].get("height") if v else None,
                "video": bool(v), "audio": bool(a)}

    def media_api(self):
        from urllib.parse import urlparse, parse_qs
        u = urlparse(self.path)
        q = parse_qs(u.query)
        what = u.path.rstrip("/").rsplit("/", 1)[-1]
        path = (q.get("path") or [""])[0]
        if what == "browse":
            return self.media_browse(path)
        if what == "list":
            return self.media_list(path)
        if not path or not os.path.isfile(path):
            return self._json(404, {"ok": False, "error": "파일이 없다: " + path})
        ext = os.path.splitext(path)[1].lower()
        if ext not in self.MEDIA_EXT and ext not in self.IMAGE_EXT:
            return self._json(403, {"ok": False, "error": "영상 · 오디오 · 그림 파일만"})
        try:
            if what == "wave":
                if not self._probe(path).get("audio"):     # 소리 없는 영상 (덧 클립 bg.mp4 등) - 오류가 아니라 없음
                    return self._json(200, {"ok": False, "none": True})
                return self._json(200, dict(self.media_wave(path), ok=True))
            if what == "thumbs":
                return self._json(200, dict(self.media_thumbs(path), ok=True))
            if what == "poster":
                return self.media_poster(path)
            if what == "info":                 # 타임라인에 끌어 놓을 때: 길이 · 그림 크기 · 소리 있는지
                p = self._probe(path)
                p["kind"] = self._kind(path)
                return self._json(200, dict(p, ok=True))
        except subprocess.CalledProcessError as e:
            return self._json(500, {"ok": False, "error": (e.stderr or b"")[-400:].decode("utf-8", "replace")})
        return self._json(404, {"ok": False, "error": "모르는 요청: " + what})

    def media_wave(self, path):
        base = self._media_key(path, "wave")
        if os.path.isfile(base + ".json"):
            with open(base + ".json", encoding="utf-8") as f:
                return json.load(f)
        import base64
        import numpy as np
        hz, floor, sr = 50, -60.0, 8000
        raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", str(sr), "-f", "s16le", "-"],
                             capture_output=True, check=True).stdout
        x = np.abs(np.frombuffer(raw, np.int16).astype(np.float32) / 32768.0)
        n = sr // hz
        m = len(x) // n
        peak = x[:m * n].reshape(m, n).max(1) if m else np.zeros(0, np.float32)
        b = np.clip((20 * np.log10(peak + 1e-9) - floor) / -floor * 255, 0, 255).astype(np.uint8)
        out = {"hz": hz, "floor": floor, "b64": base64.b64encode(b.tobytes()).decode("ascii")}
        with open(base + ".json", "w", encoding="utf-8") as f:
            json.dump(out, f)
        return out

    def media_thumbs(self, path):
        """일정 간격 (STEP 초) 마다 한 장씩 뜬 썸네일을 격자 그림 한 장에 담는다.
        k 번째 칸 = 원본 k*STEP 초. 211초 원본(1280폭 30fps 사본) 약 10초 걸린다 (한 번만)."""
        import math
        base = self._media_key(path, "thumbs")
        if os.path.isfile(base + ".json") and os.path.isfile(base + ".jpg"):
            with open(base + ".json", encoding="utf-8") as f:
                return json.load(f)
        p = self._probe(path)
        if not p["video"] or not p["w"]:
            return {"none": True}
        dur = p["dur"] or 1.0
        step = 0.5 if dur <= 300 else math.ceil(dur / 600 * 2) / 2      # 600장을 넘지 않게
        n = max(1, int(math.ceil(dur / step)))
        cols = min(self.THUMB_COLS, n)
        rows = int(math.ceil(n / float(cols)))
        th = self.THUMB_H
        tw = int(round(th * p["w"] / float(p["h"]) / 2) * 2)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", path, "-an", "-sn",
                        "-vf", "fps=1/%g,scale=%d:%d,tile=%dx%d" % (step, tw, th, cols, rows),
                        "-frames:v", "1", "-q:v", "6", base + ".jpg"], capture_output=True, check=True)
        out = {"url": "/api/file?path=" + quote(base + ".jpg"), "step": step, "n": n, "cols": cols,
               "tw": tw, "th": th, "dur": dur}
        with open(base + ".json", "w", encoding="utf-8") as f:
            json.dump(out, f)
        return out

    def media_poster(self, path):
        """소스 목록의 작은 그림 - 영상은 1초 (짧으면 가운데) 한 장, 그림은 줄여서."""
        base = self._media_key(path, "poster")
        jpg = base + ".jpg"
        if not os.path.isfile(jpg):
            ext = os.path.splitext(path)[1].lower()
            if ext in self.IMAGE_EXT:
                cmd = ["ffmpeg", "-v", "error", "-y", "-i", path, "-vf", "scale=160:-2", "-frames:v", "1", jpg]
            else:
                p = self._probe(path)
                if not p["video"]:
                    return self._json(404, {"ok": False, "error": "그림 없음"})
                t = 1.0 if p["dur"] > 2 else p["dur"] / 2
                cmd = ["ffmpeg", "-v", "error", "-y", "-ss", "%.2f" % t, "-i", path, "-vf", "scale=160:-2",
                       "-frames:v", "1", "-q:v", "5", jpg]
            subprocess.run(cmd, capture_output=True, check=True)
        with open(jpg, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "max-age=3600")
        self.end_headers()
        self.wfile.write(data)

    SKIP_DIRS = {"$recycle.bin", "system volume information", "__pycache__", "node_modules", ".git"}

    def _kind(self, name):
        ext = os.path.splitext(name)[1].lower()
        if ext in self.IMAGE_EXT:
            return "image"
        if ext in (".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg"):
            return "audio"
        if ext in self.MEDIA_EXT:
            return "video"
        return None

    def media_browse(self, path):
        """폴더 고르기 창: 하위 폴더와 미디어 파일. 경로가 비면 드라이브 목록."""
        if not path:
            drives = []
            if os.name == "nt":
                import string
                drives = [c + ":\\" for c in string.ascii_uppercase if os.path.isdir(c + ":\\")]
            else:
                drives = ["/"]
            return self._json(200, {"ok": True, "path": "", "parent": None,
                                    "dirs": [{"name": d, "path": d} for d in drives], "files": []})
        path = os.path.abspath(path)
        if not os.path.isdir(path):
            return self._json(404, {"ok": False, "error": "폴더가 없다: " + path})
        dirs, files = [], []
        try:
            for name in sorted(os.listdir(path), key=lambda s: s.lower()):
                full = os.path.join(path, name)
                if name.startswith(".") or name.lower() in self.SKIP_DIRS:
                    continue
                if os.path.isdir(full):
                    dirs.append({"name": name, "path": full})
                elif self._kind(name):
                    files.append({"name": name, "path": full, "kind": self._kind(name), "size": os.path.getsize(full)})
        except OSError as e:
            return self._json(400, {"ok": False, "error": str(e)})
        par = os.path.dirname(path)
        return self._json(200, {"ok": True, "path": path, "parent": "" if par == path else par,
                                "dirs": dirs, "files": files})

    def media_upload(self):
        """바깥 파일 (탐색기에서 끌어 온 것) 을 projects/<id>/media 에 받는다 (2026-10-03) - 브라우저는 경로를 안 주므로 내용을 올린다.
        이름 · 크기가 같은 파일이 이미 있으면 그것을 쓴다."""
        from urllib.parse import urlparse, parse_qs
        import re as _re
        q = parse_qs(urlparse(self.path).query)
        pid = _re.sub(r"[^\w-]", "", (q.get("project") or [""])[0])[:64]
        name = os.path.basename((q.get("name") or [""])[0].replace("\\", "/")).strip()
        n = int(self.headers.get("Content-Length") or 0)
        if not pid or not name or not self._kind(name):
            self.rfile.read(n)
            return self._json(400, {"ok": False, "error": "영상 · 소리 · 그림만 받습니다: " + name})
        d = os.path.join(self.projects_dir, pid, "media")
        os.makedirs(d, exist_ok=True)
        base, ext = os.path.splitext(name)
        dest, k = os.path.join(d, name), 1
        while os.path.exists(dest) and os.path.getsize(dest) != n:
            dest, k = os.path.join(d, "%s (%d)%s" % (base, k, ext)), k + 1
        if os.path.exists(dest):
            left = n
            while left > 0:
                c = self.rfile.read(min(1 << 20, left))
                if not c:
                    break
                left -= len(c)
        else:
            tmp, left = dest + ".part", n
            with open(tmp, "wb") as f:
                while left > 0:
                    c = self.rfile.read(min(1 << 20, left))
                    if not c:
                        break
                    f.write(c)
                    left -= len(c)
            if left:
                os.remove(tmp)
                return self._json(400, {"ok": False, "error": "받다가 끊겼습니다"})
            os.replace(tmp, dest)
            sys.stderr.write("  파일 받음: %s (%d bytes)\n" % (dest, n))
        return self._json(200, {"ok": True, "path": os.path.abspath(dest).replace(os.sep, "/"), "name": os.path.basename(dest),
                                "kind": self._kind(name), "size": n})

    def media_list(self, path):
        """소스 폴더 하나의 미디어 파일 (아래 폴더까지 3단, 800개까지). 이름은 폴더 기준 상대 경로."""
        path = os.path.abspath(path or "")
        if not os.path.isdir(path):
            return self._json(404, {"ok": False, "error": "폴더가 없다: " + path})
        out = []
        for here, ds, fs in os.walk(path):
            depth = os.path.relpath(here, path).count(os.sep) + (0 if here == path else 1)
            ds[:] = sorted([d for d in ds if not d.startswith(".") and d.lower() not in self.SKIP_DIRS
                            and d != "_media_cache"], key=lambda s: s.lower()) if depth < 3 else []
            for name in sorted(fs, key=lambda s: s.lower()):
                k = self._kind(name)
                if not k:
                    continue
                full = os.path.join(here, name)
                try:
                    size = os.path.getsize(full)
                except OSError:
                    continue
                out.append({"name": os.path.relpath(full, path).replace("\\", "/"), "path": full, "kind": k, "size": size})
                if len(out) >= 800:
                    break
            if len(out) >= 800:
                break
        return self._json(200, {"ok": True, "path": path, "files": out, "more": len(out) >= 800})

    # ------------------------------------------------------------------
    # 설치된 폰트 목록
    #
    # 자막 폰트를 고르는 칸에 몇 개만 박아 두면, 실제로 쓰는 폰트가 목록에 없어
    # 손으로 이름을 적어야 한다. 이름을 한 글자만 틀려도 브라우저는 조용히 기본
    # 폰트로 떨어지고, 미리보기가 완성본과 달라진다 (BM JUA OTF가 그랬다 -
    # 브라우저가 아는 이름은 BM JUA_OTF다).
    #
    # 그래서 폰트 파일에서 이름표(name 테이블)를 직접 읽어 목록을 만든다.
    # 외부 라이브러리는 쓰지 않는다.
    # ------------------------------------------------------------------

    _font_cache = None

    @staticmethod
    def _font_names(data, off=0):
        import struct
        try:
            tag, = struct.unpack_from(">I", data, off)
        except struct.error:
            return []
        if tag == 0x74746366:                       # 'ttcf' - 여러 폰트가 든 파일
            try:
                n, = struct.unpack_from(">I", data, off + 8)
            except struct.error:
                return []
            out = []
            for i in range(min(n, 64)):
                try:
                    o, = struct.unpack_from(">I", data, off + 12 + 4 * i)
                except struct.error:
                    break
                out += Handler._font_names(data, o)
            return out
        try:
            num, = struct.unpack_from(">H", data, off + 4)
        except struct.error:
            return []
        rec = off + 12
        ntab = None
        for i in range(num):
            base = rec + 16 * i
            if base + 16 > len(data):
                return []
            if data[base:base + 4] == b"name":
                _, o, l = struct.unpack_from(">III", data, base + 4)
                ntab = (o, l)
                break
        if not ntab:
            return []
        o, _l = ntab
        try:
            _fmt, count, stroff = struct.unpack_from(">HHH", data, o)
        except struct.error:
            return []
        out = []
        for i in range(count):
            try:
                pid, _eid, _lid, nid, ln, off2 = struct.unpack_from(">HHHHHH", data, o + 6 + 12 * i)
            except struct.error:
                break
            if nid not in (1, 16):                  # 1=패밀리, 16=타이포그래피 패밀리
                continue
            a = o + stroff + off2
            raw = data[a:a + ln]
            try:
                txt = raw.decode("utf-16-be") if pid in (0, 3) else raw.decode("latin-1")
            except Exception:
                continue
            txt = txt.strip().replace("\x00", "")
            if txt and len(txt) < 64:
                out.append(txt)
        return out

    @staticmethod
    def _font_ratio(data, off=0):
        """ASS 글자 크기를 브라우저 글자 크기로 바꾸는 배율.

        libass는 Fontsize를 em 크기가 아니라 "폰트 높이"(winAscent+winDescent)로
        받는다. CSS의 font-size는 em 크기다. 그래서 같은 숫자를 줘도 크기가
        다르게 나온다 - 쿠키런은 미리보기가 1.36배 크게, 주아는 1.10배 크게
        나오고 있었다. 배율 = upem / (winAscent + winDescent).
        """
        import struct
        try:
            tag, = struct.unpack_from(">I", data, off)
            if tag == 0x74746366:
                off, = struct.unpack_from(">I", data, off + 12)
            num, = struct.unpack_from(">H", data, off + 4)
        except struct.error:
            return None
        t = {}
        for i in range(num):
            b = off + 12 + 16 * i
            if b + 16 > len(data):
                return None
            try:
                _, o, l = struct.unpack_from(">III", data, b + 4)
            except struct.error:
                return None
            t[data[b:b + 4]] = o
        if b"head" not in t:
            return None
        try:
            upem, = struct.unpack_from(">H", data, t[b"head"] + 18)
            if not upem:
                return None
            if b"OS/2" in t:
                wa, wd = struct.unpack_from(">HH", data, t[b"OS/2"] + 74)
                if wa + wd > 0:
                    return round(upem / float(wa + wd), 5)
            if b"hhea" in t:
                asc, desc = struct.unpack_from(">hh", data, t[b"hhea"] + 4)
                if asc - desc > 0:
                    return round(upem / float(asc - desc), 5)
        except struct.error:
            return None
        return None

    def list_fonts(self):
        if Handler._font_cache is None:
            dirs = [os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts"),
                    os.path.join(os.environ.get("LOCALAPPDATA", ""),
                                 "Microsoft", "Windows", "Fonts")]
            seen = {}
            for d in dirs:
                if not os.path.isdir(d):
                    continue
                try:
                    files = os.listdir(d)
                except OSError:
                    continue
                for fn in files:
                    if os.path.splitext(fn)[1].lower() not in (".ttf", ".otf", ".ttc", ".otc"):
                        continue
                    try:
                        with open(os.path.join(d, fn), "rb") as f:
                            head = f.read(600000)
                        ratio = self._font_ratio(head)
                        for nm in self._font_names(head):
                            if nm not in seen or (seen[nm] is None and ratio):
                                seen[nm] = ratio
                    except Exception:
                        continue
            Handler._font_cache = [{"name": k, "ratio": seen[k] or 1.0}
                                   for k in sorted(seen, key=lambda x: x.lower())]
            sys.stderr.write("  폰트 %d개 읽음\n" % len(Handler._font_cache))
        return self._json(200, {"ok": True, "fonts": Handler._font_cache})

    # ------------------------------------------------------------------
    # 프로젝트 저장소
    #
    # 편집은 저마다 다른 원본 · 다른 컷 · 다른 자막을 쓴다. 그걸 한 덩어리
    # 상태에 올려 두면 다음 편집을 시작하는 순간 앞의 것이 덮여 사라진다.
    # 그래서 편집마다 폴더 하나를 준다.
    #
    #   projects/<id>/project.json   대시보드 상태 전부 (컷 · 자막 · 레이아웃)
    #   projects/<id>/meta.json      목록에 쓸 요약 (이름 · 날짜 · 개수)
    #   projects/<id>/thumb.jpg      카드 썸네일 (미리보기 화면을 그대로 굽는다)
    #
    # 목록을 그릴 때 project.json을 전부 여는 건 느리다. 요약을 따로 두고
    # 목록은 meta.json만 읽는다.
    # ------------------------------------------------------------------

    def _pdir(self, pid, make=False):
        pid = "".join(c for c in str(pid or "") if c.isalnum() or c in "-_")[:64]
        if not pid:
            return None
        d = os.path.join(self.projects_dir, pid)
        if make:
            os.makedirs(d, exist_ok=True)
        return d

    @staticmethod
    def _qs(path, key):
        from urllib.parse import urlparse, parse_qs, unquote
        q = parse_qs(urlparse(path).query)
        return unquote((q.get(key) or [""])[0])

    def list_projects(self):
        out = []
        if os.path.isdir(self.projects_dir):
            for name in sorted(os.listdir(self.projects_dir)):
                if name.startswith("_"):
                    continue                      # _trash
                mp = os.path.join(self.projects_dir, name, "meta.json")
                if not os.path.isfile(mp):
                    continue
                try:
                    with open(mp, encoding="utf-8") as f:
                        m = json.load(f)
                except Exception:
                    continue
                m["id"] = name
                m["hasThumb"] = os.path.isfile(
                    os.path.join(self.projects_dir, name, "thumb.jpg"))
                out.append(m)
        out.sort(key=lambda m: m.get("savedAt") or "", reverse=True)
        return self._json(200, {"ok": True, "projects": out,
                                "dir": os.path.abspath(self.projects_dir)})

    # ---------- 스타일 ----------
    # 스타일은 프로젝트에 딸린 것이 아니라 대시보드 전체가 쓰는 것이다.
    # 편집 한 편에서 분석해 둔 스타일을 다음 편집에서 못 고르면 분석을
    # 다시 해야 한다. 그래서 프로젝트 안이 아니라 styles/ 폴더에 둔다.
    styles_dir = os.path.join(HERE, "styles")

    # 프리셋 (2026-09-17): shortsmith 형식의 영어 preset.json. 비공개 담유이 프리셋은 작업 폴더 presets/,
    # 공개 프리셋은 shortsmith/presets/. 옛 한국어 스타일 파일은 styles/_legacy_ko/ 에 남겨 두었다
    preset_dirs = [os.path.join(ROOT_DIR, "presets"), os.path.join(ROOT_DIR, "shortsmith", "presets")]

    def list_styles(self):
        out = []
        for pd in self.preset_dirs:
            if not os.path.isdir(pd):
                continue
            for pid in sorted(os.listdir(pd)):
                fp = os.path.join(pd, pid, "preset.json")
                if not os.path.isfile(fp):
                    continue
                try:
                    with open(fp, encoding="utf-8") as f:
                        data = json.load(f)
                except Exception as e:
                    out.append({"file": "preset:" + pid, "error": str(e)})
                    continue
                out.append({"file": "preset:" + pid, "name": data.get("name") or pid,
                            "savedAt": _iso(os.path.getmtime(fp)), "data": data, "path": fp.replace(os.sep, "/"),
                            "readonly": True})
        d = self.styles_dir
        if os.path.isdir(d):
            for name in sorted(os.listdir(d)):
                if not name.lower().endswith(".json"):
                    continue
                fp = os.path.join(d, name)
                try:
                    with open(fp, encoding="utf-8") as f:
                        data = json.load(f)
                except Exception as e:
                    out.append({"file": name, "error": str(e)})
                    continue
                out.append({
                    "file": name,
                    "name": data.get("name") or os.path.splitext(name)[0],
                    "savedAt": _iso(os.path.getmtime(fp)),
                    "data": data,
                })
        return self._json(200, {"ok": True, "styles": out,
                                "dir": os.path.abspath(d)})

    def save_style(self, d):
        data = d.get("data")
        if not isinstance(data, dict):
            return self._json(400, {"ok": False, "error": "스타일 내용이 없습니다"})
        name = (data.get("name") or d.get("name") or "").strip()
        if not name:
            return self._json(400, {"ok": False, "error": "스타일 이름이 없습니다"})
        data["name"] = name
        # 파일 이름은 스타일 이름에서 만든다. 경로를 벗어날 수 있는 글자는 뺀다.
        safe = "".join(c for c in name if c not in '\\/:*?"<>|').strip().replace(" ", "_")
        if not safe:
            safe = "style"
        os.makedirs(self.styles_dir, exist_ok=True)
        fp = os.path.join(self.styles_dir, safe + ".json")
        if os.path.abspath(os.path.dirname(fp)) != os.path.abspath(self.styles_dir):
            return self._json(400, {"ok": False, "error": "스타일 이름이 이상합니다"})
        try:
            with open(fp, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
                f.write("\n")
        except Exception as e:
            return self._json(500, {"ok": False, "error": "스타일을 저장하지 못했습니다: %s" % e})
        return self._json(200, {"ok": True, "file": os.path.basename(fp), "name": name})

    def delete_style(self, d):
        fname = os.path.basename((d.get("file") or "").strip())
        if not fname.lower().endswith(".json"):
            return self._json(400, {"ok": False, "error": "그런 스타일 파일이 없습니다"})
        fp = os.path.join(self.styles_dir, fname)
        if not os.path.isfile(fp):
            return self._json(404, {"ok": False, "error": "그런 스타일 파일이 없습니다"})
        try:
            os.remove(fp)
        except Exception as e:
            return self._json(500, {"ok": False, "error": str(e)})
        return self._json(200, {"ok": True})

    def read_project(self):
        d = self._pdir(self._qs(self.path, "id"))
        fp = os.path.join(d, "project.json") if d else None
        if not fp or not os.path.isfile(fp):
            return self._json(404, {"ok": False, "error": "프로젝트가 없다"})
        with open(fp, encoding="utf-8") as f:
            return self._json(200, {"ok": True, "project": json.load(f)})

    def serve_thumb(self):
        d = self._pdir(self._qs(self.path, "id"))
        fp = os.path.join(d, "thumb.jpg") if d else None
        if not fp or not os.path.isfile(fp):
            return self._json(404, {"ok": False, "error": "썸네일이 없다"})
        with open(fp, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _write_ranges(self, data):
        """사용자가 전체 자막에서 고른 구간을 작업 폴더에 떨군다.

        되살릴 말은 restore.json, 뺄 말은 drop.json, 고친 자막은
        captions_user.json 이다. 사용자가 지운 줄을
        눌러 되살리거나 남은 말을 눌러 빼면 다음에 구울 때 그대로 되어야
        한다 (지시). 파이프라인(timeline.py)은 대시보드 저장소를 모르므로
        제 폴더에서 읽을 수 있는 자리에 놓아 준다.
        """
        work = (data.get("render") or {}).get("dir") or ""
        if not work:
            return
        work = os.path.abspath(os.path.join(ROOT, work))
        try:
            inside = os.path.commonpath([work, ROOT]) == ROOT
        except ValueError:                # 다른 드라이브 (시험 사본 등)
            inside = False
        if not inside or not os.path.isdir(work):
            return
        review = data.get("review") or {}

        # 프롬프트 칸에 적은 지시. 지금까지는 project.json 안에만 있었는데,
        # export_project.py 가 review 블록을 통째로 새로 만들면서 그때마다
        # 지워졌다 - 사용자가 적어 둔 지시가 읽히기도 전에 사라진 것이다.
        # 되살릴 구간 · 뺄 구간과 같은 자리에 글로 떨궈 둔다.
        pr = (review.get("prompt") or "").strip()
        fpp = os.path.join(work, "feedback_prompt.txt")
        try:
            if pr:
                with open(fpp, "w", encoding="utf-8") as f:
                    f.write(pr + "\n")
                sys.stderr.write("  피드백 프롬프트 -> %s\n" % fpp)
            elif os.path.isfile(fpp):
                os.remove(fpp)
        except Exception as e:
            sys.stderr.write("  feedback_prompt.txt 쓰기 실패: %s\n" % e)

        # 영상 위에 붙인 쪽지 · 화살표 · 자취. 지금까지는 project.json 의
        # review.notes 안에만 있어서 파이프라인이 볼 수 없었다 (프롬프트와
        # 똑같은 사고다). "여기 이 영역"이라는 쪽지를 받아도 자리를 모르면
        # 쓸모가 없으므로 **좌표를 같이 적는다** - 화면 왼쪽 위가 0%,
        # 오른쪽 아래가 100%.
        _NL = chr(10)

        def _pct(v):
            return "%d%%" % int(round(float(v or 0) * 100))

        def _where(n):
            k = n.get("kind")
            if k == "region":
                xs = sorted([n.get("x", 0), n.get("x2", 0)])
                ys = sorted([n.get("y", 0), n.get("y2", 0)])
                return " (영역 %s,%s ~ %s,%s)" % (_pct(xs[0]), _pct(ys[0]),
                                                  _pct(xs[1]), _pct(ys[1]))
            if k == "curve":
                pts = n.get("pts") or []
                a = pts[0] if pts else [n.get("x", 0), n.get("y", 0)]
                b = pts[-1] if pts else [n.get("x2", 0), n.get("y2", 0)]
                return " (곡선 %s,%s -> %s,%s, 점 %d개)" % (
                    _pct(a[0]), _pct(a[1]), _pct(b[0]), _pct(b[1]), len(pts))
            if k in ("arrow", "line"):
                return " (%s %s,%s -> %s,%s)" % (
                    "화살표" if k == "arrow" else "선",
                    _pct(n.get("x")), _pct(n.get("y")),
                    _pct(n.get("x2")), _pct(n.get("y2")))
            return " (%s,%s)" % (_pct(n.get("x")), _pct(n.get("y")))

        def _mmss(t):
            t = float(t or 0)
            return "%d:%05.2f" % (int(t // 60), t - int(t // 60) * 60)

        _notes = review.get("notes") or []
        fnp = os.path.join(work, "feedback_notes.txt")
        try:
            if _notes:
                rows = []
                for n in sorted(_notes, key=lambda x: float(x.get("t") or 0)):
                    rows.append("[%s]%s %s" % (
                        _mmss(n.get("t")), _where(n),
                        (n.get("text") or "").strip() or "(글 없음)"))
                with open(fnp, "w", encoding="utf-8") as f:
                    f.write(_NL.join(rows) + _NL)
                sys.stderr.write("  영상 위 피드백 %d개 -> %s%s" % (len(_notes), fnp, _NL))
            elif os.path.isfile(fnp):
                os.remove(fnp)
        except Exception as e:
            sys.stderr.write("  feedback_notes.txt 쓰기 실패: %s%s" % (e, _NL))


        # 사용자가 고친 자막. 지금까지는 project.json 의 review 안에만 있어서
        # export_project.py 가 CSV 로 자막을 다시 만들 때마다 덮여 없어졌다
        # (프롬프트와 똑같은 사고다). 파이프라인이 읽을 수 있는 자리에 둔다.
        caps = [c for c in (review.get("captions") or [])
                if c.get("by") == "user"]
        cup = os.path.join(work, "captions_user.json")
        try:
            if caps:
                with open(cup, "w", encoding="utf-8") as f:
                    json.dump(caps, f, ensure_ascii=False, indent=1)
                sys.stderr.write("  고친 자막 %d줄 -> %s\n" % (len(caps), cup))
            elif os.path.isfile(cup):
                os.remove(cup)
        except Exception as e:
            sys.stderr.write("  captions_user.json 쓰기 실패: %s\n" % e)

        for key, name, what in (("restore", "restore.json", "되살릴"),
                                ("drop", "drop.json", "뺄")):
            ranges = review.get(key) or []
            fp = os.path.join(work, name)
            try:
                if ranges:
                    with open(fp, "w", encoding="utf-8") as f:
                        json.dump(ranges, f, ensure_ascii=False, indent=2)
                    sys.stderr.write("  %s 구간 %d개 -> %s\n"
                                     % (what, len(ranges), fp))
                elif os.path.isfile(fp):
                    # 다 취소했으면 파일도 없애야 다음 빌드가 옛 지시를 안 따른다
                    os.remove(fp)
                    sys.stderr.write("  %s 구간 없음 - %s 지움\n" % (what, name))
            except Exception as e:
                sys.stderr.write("  %s 쓰기 실패: %s\n" % (name, e))

    def save_project(self, d):
        pid = d.get("id")
        data = d.get("data")
        if not pid or data is None:
            return self._json(400, {"ok": False, "error": "id 또는 data 없음"})
        pd = self._pdir(pid, make=True)
        if not pd:
            return self._json(400, {"ok": False, "error": "쓸 수 없는 id"})

        # 파이프라인이 채워 준 것(review: 완성본 · 전사본 · 태운 자막)은
        # 브라우저가 모르면 null 로 보내온다. 그대로 쓰면 방금 내보낸 편집
        # 결과가 통째로 날아간다 - 예전 탭이 열려 있기만 해도 그렇다.
        # 클라이언트가 빈손일 때는 있던 것을 지키고, 실어 보냈을 때만 바꾼다.
        fp = os.path.join(pd, "project.json")
        oldr = None
        if os.path.isfile(fp):
            try:
                with open(fp, encoding="utf-8") as f:
                    oldr = (json.load(f) or {}).get("review")
            except Exception:
                oldr = None

        if data.get("review") is None and os.path.isfile(fp):
            try:
                with open(fp, encoding="utf-8") as f:
                    old = json.load(f)
                if old.get("review") is not None:
                    data["review"] = old["review"]
            except Exception as e:
                sys.stderr.write("  기존 review 읽기 실패: %s\n" % e)

        # 파이프라인이 만든 것은 파일 쪽이 정본이다. 브라우저는 kept ·
        # transcript · captions · video 를 만들지 않는다 - 열어 둔 탭이
        # 오래됐으면 그 옛 값을 그대로 실어 보내고, 그대로 쓰면 프로젝트가
        # 통째로 되감긴다. 실제로 저장 한 번에 자막이 "담린이 남긴"으로
        # 돌아가고 컷이 옛 타임라인이 됐다 (피드백3 이전 상태).
        # 사용자 것(prompt · notes · drop · restore · 고친 자막)만 받는다.
        newr = data.get("review")
        if isinstance(newr, dict) and isinstance(oldr, dict) and oldr:
            merged = dict(oldr)
            # ripple (리플 켬/끔) · restoreCaps (되살린 자리 자막) 도 사용자 것이다 (2026-09-30: 안 받아서 새로 열면 사라지고
            # 렌더 단추가 못 봤다)
            # userClips: 사용자 편집 탭 (2026-10-02) 의 클립 목록 [{s, e, at}] - 없으면 지운다 (초기화)
            # srcFolders: 사용자 편집 탭 소스 폴더 (절대 경로 목록) · userLayers: 덧 트랙 클립 (V2.. · A2.., 2026-10-02)
            for k in ("prompt", "notes", "drop", "restore", "ripple", "restoreCaps", "userClips", "srcFolders", "userLayers", "userGroups",
                      "userCaps", "capTracks", "srcFiles"):   # 새 자막 · 자막 트랙 · 가져온 파일 (2026-10-03)   # userGroups: 클립 그룹 이름 (2026-10-03)
                if k in newr:
                    merged[k] = newr[k]
                elif k in ("ripple", "userClips"):
                    merged.pop(k, None)
            # 낱말의 빼기 · 되살리기 표. 지금까지 drop · restore 구간 요약만 받고 낱말 표는 버려서, 렌더 단추(apply_review.py,
            # 낱말 표를 읽는다)가 브라우저에서 뺀 말을 못 봤다 (2026-09-30 확인). 같은 낱말(글 + 시작 0.05초 안)에 옮겨 단다
            ow = [w for sg in (merged.get("transcript") or []) for w in (sg.get("words") or [])]
            nw = [w for sg in (newr.get("transcript") or []) for w in (sg.get("words") or [])]
            if ow and nw:
                same = len(ow) == len(nw) and all(a.get("w") == b.get("w") and abs(a.get("s", 0) - b.get("s", 0)) < 0.05
                                                  for a, b in zip(ow, nw))
                if same:
                    pairs = zip(ow, nw)
                else:
                    idx = {}
                    for w in nw:
                        idx.setdefault(w.get("w"), []).append(w)
                    pairs = [(a, next((b for b in idx.get(a.get("w"), []) if abs(b.get("s", 0) - a.get("s", 0)) < 0.05), None))
                             for a in ow]
                for a, b in pairs:
                    for k in ("drop", "restore"):
                        if b is not None and b.get(k):
                            a[k] = True
                        else:
                            a.pop(k, None)
            # 고친 자막은 시각이 가장 가까운 줄에 얹는다. 탭이 오래돼서
            # 시각이 안 맞으면 못 얹지만, captions_user.json 에 남으므로
            # 사라지지는 않는다.
            base = [dict(c) for c in (merged.get("captions") or [])]
            for c in newr.get("captions") or []:
                if c.get("by") != "user" or not base:
                    continue
                # 같은 줄 찾기: 시작이 1.5초 안이면서 원래 글 (orig, 없으면 글) 이 같은 줄을 먼저, 그다음 화자가 같은 줄, 마지막에 가장 가까운 줄.
                # 시각만 보면 같은 시각에 시작하는 두 줄 (설명 딱지 0.05초 · "어? 잠깐만" 0.05초) 에서 딱지 고침이 옆 줄 글을 덮었다 (2026-10-03)
                def _k(x):
                    return ((x.get("orig") if x.get("orig") is not None else x.get("text")) or "").strip()
                near_all = [x for x in base if abs(x.get("s", 0) - c.get("s", 0)) <= 1.5]
                same = [x for x in near_all if _k(x) == _k(c)] or                        [x for x in near_all if (x.get("speaker") or "").strip() == (c.get("speaker") or "").strip()] or near_all or base
                near = min(same, key=lambda x: abs(x.get("s", 0) - c.get("s", 0)))
                if abs(near.get("s", 0) - c.get("s", 0)) <= 1.5:
                    near["text"] = c.get("text")
                    near["by"] = "user"
                    # **글만 옮기고 화자는 버리고 있었다.** 삼성에서 사용자가 화자
                    # 셋을 고쳤는데(로그에 "자막 6 화자: 담유이발끈") 저장된 자막과
                    # captions_user.json 에는 옛 화자가 남아 "전혀 적용이 안 됐어".
                    # 사용자가 손댈 수 있는 칸은 전부 옮긴다.
                    # 끝(e2) · 원본 시각(os2 · oe2) · 디자인(kind) 도 받는다 (2026-09-30: 끝을 늘린 것이 안 남았다).
                    # 시각은 되돌리면 칸이 없어진다 - 그때는 옛 값도 지운다
                    for k in ("speaker", "kind", "orig"):
                        if k in c:
                            near[k] = c[k]
                    for k in ("s2", "e2", "os2", "oe2", "tf"):     # tf: 자막 변형 (2026-10-03)
                        if k in c:
                            near[k] = c[k]
                        else:
                            near.pop(k, None)
                else:
                    sys.stderr.write(
                        "  탭이 오래됐다: 고친 자막 %.2f초 %r 을 얹을 데가"
                        " 없다 - captions_user.json 으로만 넘긴다\n"
                        % (c.get("s", 0), c.get("text")))
            merged["captions"] = base
            data["review"] = merged

        with open(fp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

        self._write_ranges(data)
        meta = d.get("meta") or {}
        meta["id"] = os.path.basename(pd)
        with open(os.path.join(pd, "meta.json"), "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)

        # 썸네일은 data URL로 온다. 없으면 예전 것을 그대로 둔다 - 미리보기에
        # 영상이 안 걸린 채로 저장했다고 카드가 빈칸이 되면 곤란하다.
        thumb = d.get("thumb") or ""
        if thumb.startswith("data:image"):
            import base64
            try:
                raw = base64.b64decode(thumb.split(",", 1)[1])
                with open(os.path.join(pd, "thumb.jpg"), "wb") as f:
                    f.write(raw)
            except Exception as e:
                sys.stderr.write("  썸네일 저장 실패: %s\n" % e)
        sys.stderr.write("  프로젝트 저장: %s (%s)\n"
                         % (meta.get("name") or "?", os.path.basename(pd)))
        return self._json(200, {"ok": True, "id": os.path.basename(pd),
                                "dir": os.path.abspath(pd)})

    def delete_project(self, d):
        pd = self._pdir(d.get("id"))
        if not pd or not os.path.isdir(pd):
            return self._json(404, {"ok": False, "error": "프로젝트가 없다"})
        # 지웠다고 말하되 실제로는 _trash로 옮긴다. 편집 하나가 실수로
        # 사라지면 되돌릴 방법이 없다.
        trash = os.path.join(self.projects_dir, "_trash")
        os.makedirs(trash, exist_ok=True)
        dest = os.path.join(trash, "%s_%s" % (time.strftime("%Y%m%d_%H%M%S"),
                                              os.path.basename(pd)))
        os.rename(pd, dest)
        sys.stderr.write("  프로젝트 삭제: %s -> _trash\n" % os.path.basename(pd))
        return self._json(200, {"ok": True, "trash": os.path.abspath(dest)})

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    # ---------- 폴더 고르기 ----------

    def list_dirs(self):
        """작업 폴더 아래의 폴더 목록.

        브라우저는 파일 고르기 창에서 진짜 경로를 내주지 않는다 (보안상
        파일 이름만 준다). 그래서 폴더는 서버가 읽어서 보여 주고, 사용자는
        그 목록에서 고른다. 작업 폴더 밖은 보여 주지 않는다.
        """
        from urllib.parse import urlparse, parse_qs
        q = parse_qs(urlparse(self.path).query)
        rel = (q.get("path") or [""])[0].replace("\\", "/").strip("/")
        base = os.path.abspath(os.path.join(ROOT, rel))
        if os.path.commonpath([base, ROOT]) != ROOT or not os.path.isdir(base):
            base = ROOT
        here = os.path.relpath(base, ROOT).replace("\\", "/")
        if here == ".":
            here = ""

        dirs = []
        try:
            for name in sorted(os.listdir(base)):
                full = os.path.join(base, name)
                if not os.path.isdir(full) or name.startswith("."):
                    continue
                if name in ("__pycache__", "node_modules"):
                    continue
                dirs.append({
                    "name": name,
                    "path": (here + "/" + name) if here else name,
                    # 파이프라인 폴더인지 한눈에 보이게 표시해 준다
                    "pipeline": all(os.path.exists(os.path.join(full, f))
                                    for f in ("import_project.py", "build_edit.py")),
                })
        except OSError as e:
            return self._json(400, {"ok": False, "error": str(e)})

        return self._json(200, {
            "ok": True,
            "path": here,
            "parent": None if not here else here.rsplit("/", 1)[0] if "/" in here else "",
            "root": os.path.abspath(ROOT),
            "dirs": dirs,
        })

    def list_translations(self):
        """이 폴더에 이미 있는 번역 자막.

        번역은 프로젝트가 아니라 파이프라인 폴더에 CSV 로 남는다. 이미 옮겨
        둔 것이 있으면 클로드를 다시 부를 이유가 없다 - 다만 그 뒤에 컷이나
        글자가 바뀌었으면 낡은 번역이다. 시각과 원문(src 칸)을 돌려주고 지금
        자막과 맞는지는 대시보드가 견준다.

        언어 목록은 `apply_captions_<언어>.py` 가 정한다. 구울 스크립트가
        없는 언어는 번역이 있어도 쓸 데가 없다.
        """
        import re
        from urllib.parse import urlparse, parse_qs
        q = parse_qs(urlparse(self.path).query)
        rel = (q.get("dir") or [""])[0]
        work = os.path.abspath(os.path.join(ROOT, rel))
        if os.path.commonpath([work, ROOT]) != ROOT or not os.path.isdir(work):
            return self._json(400, {"ok": False, "error": "폴더가 없습니다"})

        try:
            names = os.listdir(work)
        except OSError as e:
            return self._json(400, {"ok": False, "error": str(e)})

        out = {}
        for name in names:
            m = re.match(r"^apply_captions_([A-Za-z0-9-]+)\.py$", name)
            if not m:
                continue
            lang = m.group(1)
            tail = "_%s_subtitles.csv" % lang
            csv_name = next((f for f in names if f.endswith(tail)), None)
            if not csv_name:
                continue
            rows = _csv_rows(os.path.join(work, csv_name))
            if rows is None:
                continue
            out[lang] = {"csv": csv_name, "rows": rows}
        return self._json(200, {"ok": True, "dir": rel, "langs": out})

    # ---------- 렌더 ----------

    def render_status(self):
        from urllib.parse import urlparse, parse_qs
        q = parse_qs(urlparse(self.path).query)
        rid = (q.get("id") or [""])[0]
        r = RENDERS.report(rid)
        if not r:
            return self._json(404, {"ok": False, "error": "그런 렌더가 없습니다"})
        return self._json(200, {"ok": True, "render": r})

    def start_render(self, d):
        """대시보드가 확정한 타임라인을 그대로 굽는다.

        폴더는 대시보드가 준다. 아무 경로나 받으면 이 서버가 임의의 스크립트를
        돌리는 창구가 되므로, 프로젝트 뿌리 안이면서 파이프라인 스크립트가
        실제로 들어 있는 폴더만 받는다.
        """
        busy = RENDERS.busy()
        if busy:
            return self._json(409, {"ok": False, "error": "이미 굽고 있습니다", "id": busy})

        pid = _slug(d.get("project"), "")
        # 상대 경로는 서버를 어디서 띄웠느냐가 아니라 작업 폴더 기준으로 읽는다.
        # 대시보드에는 "edit/고구마"처럼 적는 편이 짧고, 옮겨 다녀도 깨지지 않는다.
        work = os.path.abspath(os.path.join(ROOT, d.get("dir") or ""))
        langs = [x for x in (d.get("langs") or []) if x]
        base = d.get("base") or (langs[0] if langs else "ko")

        # 내보내기 폴더. 비워 두면 스크립트에 적힌 자리로 간다.
        out_dir = (d.get("out") or "").strip()
        if out_dir:
            out_dir = os.path.abspath(os.path.join(ROOT, out_dir))
            if os.path.commonpath([out_dir, ROOT]) != ROOT:
                return self._json(400, {"ok": False,
                                        "error": "작업 폴더 밖으로는 내보낼 수 없습니다: " + out_dir})

        if not pid:
            return self._json(400, {"ok": False, "error": "프로젝트가 없습니다"})
        project_json = os.path.join(self.projects_dir, pid, "project.json")
        if not os.path.exists(project_json):
            return self._json(400, {"ok": False, "error": "저장된 프로젝트가 없습니다. 먼저 저장하세요"})

        if not os.path.isdir(work):
            return self._json(400, {"ok": False, "error": "파이프라인 폴더가 없습니다: " + work})
        if os.path.commonpath([work, ROOT]) != ROOT:
            return self._json(400, {"ok": False,
                                    "error": "작업 폴더 밖은 돌릴 수 없습니다: " + work})
        # shortsmith 편 (edit.json) 은 AI 없는 렌더: 자막 반영 -> build -> 대시보드 갱신
        if os.path.exists(os.path.join(work, "edit.json")):
            labels = ["자막 반영", "렌더", "대시보드 갱신"]
            rid = time.strftime("%Y%m%d_%H%M%S")
            RENDERS.start(rid, labels, work)
            sys.stderr.write("  렌더 시작 (shortsmith): %s  (%s)" % (rid, work) + chr(10))
            threading.Thread(target=shortsmith_job, args=(rid, work, os.path.abspath(project_json), pid), daemon=True).start()
            return self._json(200, {"ok": True, "id": rid, "steps": labels})
        for need in ("import_project.py", "build_edit.py"):
            if not os.path.exists(os.path.join(work, need)):
                return self._json(400, {"ok": False,
                                        "error": "파이프라인 스크립트가 없습니다: " + need})

        # 언어마다 자막 굽는 스크립트가 따로다. 기준 언어는 apply_captions.py,
        # 나머지는 apply_captions_<언어>.py 다.
        steps_lang = []
        for lg in (langs or [base]):
            script = "apply_captions.py" if lg == base else "apply_captions_%s.py" % _slug(lg, "x")
            if not os.path.exists(os.path.join(work, script)):
                return self._json(400, {"ok": False,
                                        "error": "%s 자막을 구울 스크립트가 없습니다: %s" % (lg, script)})
            steps_lang.append((lg, script))

        labels = ["컷 · 자막 반영", "영상 굽기"] + ["자막 굽기 (%s)" % lg for lg, _ in steps_lang]
        rid = time.strftime("%Y%m%d_%H%M%S")
        RENDERS.start(rid, labels, work)
        sys.stderr.write("  렌더 시작: %s  (%s)\n" % (rid, work))
        threading.Thread(target=render_job,
                         args=(rid, work, os.path.abspath(project_json), steps_lang, out_dir),
                         daemon=True).start()
        return self._json(200, {"ok": True, "id": rid, "steps": labels})

    def do_POST(self):
        if self.path.startswith("/api/ping"):
            d = self._read()
            cid = str(d.get("id") or "")[:64]
            if not cid:
                return self._json(400, {"ok": False, "error": "id 없음"})
            if CLIENTS.ping(cid, bool(d.get("hidden"))):
                sys.stderr.write("  페이지 연결됨 (%d개)\n" % CLIENTS.alive())
            return self._json(200, {"ok": True, "clients": CLIENTS.alive()})

        if self.path.startswith("/api/bye"):
            d = self._read()
            CLIENTS.bye(str(d.get("id") or "")[:64])
            sys.stderr.write("  페이지 닫힘 (남은 %d개)\n" % CLIENTS.alive())
            return self._json(200, {"ok": True})

        if self.path.startswith("/api/media/upload"):
            return self.media_upload()
        if self.path.startswith("/api/style/save"):
            return self.save_style(self._read())
        if self.path.startswith("/api/style/delete"):
            return self.delete_style(self._read())
        if self.path.startswith("/api/project/save"):
            return self.save_project(self._read())

        if self.path.startswith("/api/project/delete"):
            return self.delete_project(self._read())

        if self.path.startswith("/api/render"):
            return self.start_render(self._read())

        if self.path.startswith("/api/job"):
            d = self._read()
            kind = _slug(d.get("kind"), "job")
            job = d.get("job")
            prompt = d.get("prompt") or ""
            if not isinstance(job, dict):
                return self._json(400, {"ok": False, "error": "job은 JSON 객체여야 합니다"})
            if not isinstance(prompt, str):
                return self._json(400, {"ok": False, "error": "prompt는 문자열이어야 합니다"})
            pid = job.get("project")
            pd = self._pdir(pid) if isinstance(pid, str) else None
            if not pd or not os.path.isfile(os.path.join(pd, "project.json")):
                return self._json(400, {"ok": False, "error": "프로젝트를 먼저 저장하세요"})
            os.makedirs(self.jobs_dir, exist_ok=True)
            stamp = time.strftime("%Y%m%d_%H%M%S")
            base = "%s_%s_%s" % (stamp, kind, uuid.uuid4().hex[:8])
            jp = os.path.join(self.jobs_dir, base + ".json")
            pp = os.path.join(self.jobs_dir, base + ".md")
            request = (
                "이 저장소의 AGENTS.md와 docs/codex-editing.md를 읽고 편집 작업을 수행해 주세요.\n"
                "작업 JSON: " + os.path.abspath(jp) + "\n"
                "작업 지시문: " + os.path.abspath(pp) + "\n"
                "프로젝트: " + os.path.abspath(os.path.join(pd, "project.json")) + "\n"
                "JSON의 mediaPaths에서 실제 영상 경로를 확인하세요. 없는 영상이나 자막을 추측하지 마세요.\n"
                "소스 코드는 수정하지 말고 편집 데이터와 미리보기만 갱신하세요. "
                "완성 영상은 사용자가 렌더를 요청할 때만 만드세요."
            )
            job["agent"] = "codex"
            job["projectFile"] = os.path.abspath(os.path.join(pd, "project.json"))
            with open(jp, "w", encoding="utf-8") as f:
                json.dump(job, f, ensure_ascii=False, indent=2)
            with open(pp, "w", encoding="utf-8") as f:
                f.write(prompt)
            sys.stderr.write("  작업 저장: %s\n" % base)
            return self._json(200, {
                "ok": True,
                "job": os.path.abspath(jp),
                "prompt": os.path.abspath(pp),
                "name": base,
                "agent": "codex",
                "request": request,
            })

        return self._json(404, {"ok": False, "error": "없는 경로"})


def watchdog(httpd):
    """붙어 있는 페이지가 없어지면 서버를 내린다."""
    zero_since = None
    while True:
        time.sleep(PING_INTERVAL)
        if not CLIENTS.ever_connected():
            continue                      # 아직 브라우저가 뜨는 중
        # 새로고침도 작별 신호를 보낸다. 새 페이지가 첫 핑을 보내기 전에 여기 걸리면 서버가 내려가
        # "Failed to fetch" 가 났다 (2026-09-18) - 0 개가 10초 이어질 때만 내린다
        if CLIENTS.alive() > 0:
            zero_since = None
            continue
        zero_since = zero_since or time.time()
        if time.time() - zero_since >= 10:
            # 굽는 중에 내려가면 반쯤 쓰다 만 mp4 가 남는다. 탭을 닫았어도
            # 굽던 것은 끝내고 나간다.
            if RENDERS.busy():
                continue
            sys.stderr.write("대시보드가 닫혔습니다. 서버를 내립니다.\n")
            threading.Thread(target=httpd.shutdown, daemon=True).start()
            return


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8899)
    ap.add_argument("--jobs", default=os.path.join(os.path.dirname(HERE), "jobs"))
    ap.add_argument("--projects", default=os.path.join(os.path.dirname(HERE), "projects"))
    ap.add_argument("--open", action="store_true", help="브라우저를 같이 연다")
    ap.add_argument("--keep-alive", action="store_true",
                    help="페이지가 닫혀도 서버를 유지한다 (동기화 끔)")
    a = ap.parse_args()

    Handler.jobs_dir = a.jobs
    Handler.projects_dir = a.projects
    os.makedirs(a.jobs, exist_ok=True)
    os.makedirs(a.projects, exist_ok=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    url = "http://localhost:%d/" % a.port
    sys.stderr.write("대시보드 %s\n작업 폴더 %s\n프로젝트 폴더 %s\n"
                     % (url, os.path.abspath(a.jobs), os.path.abspath(a.projects)))
    if not a.keep_alive:
        threading.Thread(target=watchdog, args=(httpd,), daemon=True).start()
    if a.open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        sys.stderr.write("\n중단됨\n")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
