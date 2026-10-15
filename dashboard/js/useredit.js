/* ==========================================================================
   useredit.js - 사용자 편집 탭 (2026-10-02)

   사용자: "피드백 탭 옆에 사용자 편집 탭을 추가하고 거기에 편집 프로그램 같은 ui 를 만들어줘 ui 스타일은 다빈치 리졸브처럼",
   "컷 직접 조작부터". 카덴라이브는 "ui 나 컨트롤이 어려운데" 로 버렸다.

   클립 = 원본 한 토막 [원본 시작 s, 원본 끝 e] 을 편집 시각 at 에 놓은 것. 목록은 review.userClips 로 저장되고
   렌더 단추 (tools/apply_review.py) 가 그대로 남길 구간으로 굽는다 - 자막 · 연출 시각은 원본 시각을 거쳐 따라 옮긴다.
   처음 열 때는 지금 컷 (피드백 탭의 낱말 되살리기 · 빼기까지 든 계획) 에서 시작한다.
   미리보기는 피드백 탭과 같은 굽지 않은 미리보기 (원본 사본에서 남길 구간을 이어 튼다, D.Feedback.sceneFor).

   타임라인 규칙 (timeline-playhead-nle-rules): 재생 위치 선은 클립을 고치거나 골라도 화면에서 제자리 ·
   클립을 누르는 것은 고르기일 뿐 (시점 안 옮김) · 눈금은 시간에 정비례 · 끌기는 마우스 1px = 눈금 1px.
   ========================================================================== */
(function (D) {
  'use strict';

  var R = null;            // review (피드백 탭과 같은 객체)
  var CL = [];             // 클립 [{id, s, e, at}] - at 순서
  var SEL = {};            // 고른 클립 id
  var TSEL = null;         // 고른 전환 (원본 클립 id 또는 덧 클립 xid)
  var CSEL = null;         // 고른 자막 줄 (장면 자막 id - 'r<번호>' 가 review.captions[번호])
  var PANE = 'ins';        // 오른쪽 탭: ins | words | render
  var TOOL = 'select';     // select | blade
  var SNAP = true, RIP = true, LINK = true;   // LINK: 영상과 묶인 소리를 같이 고르고 옮긴다 (2026-10-03, 툴바 고리 아이콘)
  var RANGE = { i: null, o: null };           // I · O 로 잡은 구간 (타임라인 시각) - 밖은 어둡게
  var SLIDING = false;                        // 인스펙터 슬라이더 · 커브를 끄는 중 - 인스펙터를 다시 그리지 않는다 (잡은 손잡이가 사라진다)
  var PPS = 80;            // 1초 = px
  var FPS = 60;
  var SHOWN = false, SC = null, MOUNTING = false;
  var UNDO = [], REDO = [];
  var UID = 1, drag = null, rafId = 0, upd = 0, MINW = 0;
  var MIN = 2;             // 클립 최소 길이 (프레임)
  var EDGEPX = 7;          // 끝 잡기 폭 (px)
  var SNAPPX = 8;          // 붙기 거리 (px)

  /* ---------- 시각 ---------- */
  function fr(t) { return Math.round(t * FPS) / FPS; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function tc(t) {                         // 리졸브 식 00:00:12:34
    t = Math.max(0, t || 0);
    var f = Math.round(t * FPS), s = Math.floor(f / FPS);
    return pad(Math.floor(s / 3600)) + ':' + pad(Math.floor(s / 60) % 60) + ':' + pad(s % 60) + ':' + pad(f % FPS);
  }
  function stc(t) {                        // 원본 시각 짧게 1:23.45
    t = Math.max(0, t || 0);
    var m = Math.floor(t / 60), s = t - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(2);
  }
  function len(c) { return c.e - c.s; }
  function end(c) { return c.at + len(c); }
  function total() { return CL.reduce(function (a, c) { return Math.max(a, end(c)); }, 0); }
  function sorted() { return CL.slice().sort(function (a, b) { return a.at - b.at; }); }
  function plan() {
    var P = sorted().map(function (c) { return [c.s, c.e, c.at, c.vol || 0, { color: c.color, tin: c.tin, tf: c.tf }]; });   // 넷째 = 소리 dB, 다섯째 = 색 · 전환 · 변형
    P.ripple = true;
    return P;
  }
  function srcDur() {
    var w = waveData() || (R && R.srcPreview && MED[R.srcPreview.path] && MED[R.srcPreview.path].wave);
    if (w && w.b64) return Math.floor(w.b64.length * 3 / 4) / (w.hz || 50);
    return Infinity;
  }
  function byId(id) { for (var i = 0; i < CL.length; i++) if (CL[i].id === id) return CL[i]; return null; }
  function selected() { return CL.filter(function (c) { return SEL[c.id]; }); }
  /* 리플: 고친 자리 뒤를 당기고 밀되 그 밖의 틈은 지킨다 (리졸브처럼). 전에는 전체를 틈 없이 붙여서, 위 트랙으로 올리며
     남긴 빈 자리가 다른 클립을 자르거나 지울 때 메워졌다 - 덧 클립이 엉뚱한 장면 위에 얹혔다 (2026-10-03).
     G = 고치기 전 gapsOf() - 클립마다 [id, 앞 틈, 시작, 끝]. 지운 클립의 틈은 다음 클립이 물려받는다, 새 클립 (자른 뒤쪽) 은 틈 0.
     덧 클립 (V2.. · A2..) 과 새 자막도 같이 밀고 당긴다 (shiftRest) - 전에는 놓은 시각 그대로라 V1 만 당겨져 어긋났다 */
  function gapsOf() {
    var G = [], t = 0;
    sorted().forEach(function (c) { var g = c.at - t; G.push([c.id, g > 0.5 / FPS ? g : 0, c.at, end(c)]); t = Math.max(t, end(c)); });
    return G;
  }
  function pack(G) {
    var gap = {}, acc = 0, t = 0;
    (G || []).forEach(function (r) { if (byId(r[0])) { gap[r[0]] = acc + r[1]; acc = 0; } else acc += r[1]; });
    sorted().forEach(function (c) { c.at = fr(t + (gap[c.id] || 0)); t = c.at + len(c); });
    shiftRest(G);
  }
  function shiftRest(G) {                  // 옛 타임라인 시각 t 가 얼마나 움직였나: t 가 든 (또는 그 뒤) 클립이 움직인 만큼
    if (!G || !G.length) return;
    var A = G.map(function (r) { var c = byId(r[0]); return { o1: r[3], d: c ? c.at - r[2] : null }; });
    var newEnd = CL.reduce(function (a, c) { return Math.max(a, end(c)); }, 0), tail = newEnd - G.reduce(function (a, r) { return Math.max(a, r[3]); }, 0);
    for (var i = A.length - 1; i >= 0; i--) if (A[i].d == null) A[i].d = i + 1 < A.length ? A[i + 1].d : tail;
    var sh = function (t) { for (var k = 0; k < A.length; k++) if (t < A[k].o1 - 1e-6) return A[k].d; return tail; };
    EX.forEach(function (x) { var d = sh(x.at); if (Math.abs(d) > 1e-6) x.at = fr(Math.max(0, x.at + d)); });
    ((R && R.userCaps) || []).forEach(function (o) { var d = sh(o.at); if (Math.abs(d) > 1e-6) o.at = +Math.max(0, o.at + d).toFixed(4); });
  }
  function clipAt(t) {
    var r = null;
    CL.forEach(function (c) { if (t >= c.at - 1e-6 && t < end(c) - 1e-6) r = c; });
    return r;
  }
  function edits() {                       // 편집 점 (클립 시작 · 끝)
    var a = [0];
    CL.forEach(function (c) { a.push(c.at, end(c)); });
    return a.sort(function (x, y) { return x - y; }).filter(function (x, i, A) { return i === 0 || x - A[i - 1] > 1e-4; });
  }

  /* ---------- 되돌리기 ---------- */
  function snapshot() { return JSON.stringify({ c: CL, k: R ? R.captions : null, x: EX, ct: R ? R.capTracks || null : null, uc: R ? R.userCaps || null : null }); }
  function remember() { UNDO.push(snapshot()); if (UNDO.length > 200) UNDO.shift(); REDO = []; }
  function restoreState(js) {
    var o = JSON.parse(js); CL = o.c; EX = o.x || []; if (R && o.k) R.captions = o.k;
    if (R) { if (o.ct) R.capTracks = o.ct; else delete R.capTracks; if (o.uc) R.userCaps = o.uc; else delete R.userCaps; }
    var keep = {};
    Object.keys(SEL).forEach(function (id) { if (byId(+id) || exById(id)) keep[id] = true; });
    SEL = keep;
    changed();
  }
  function undo() { if (!UNDO.length) return; REDO.push(snapshot()); restoreState(UNDO.pop()); D.toast('되돌림'); }
  function redo() { if (!REDO.length) return; UNDO.push(snapshot()); restoreState(REDO.pop()); D.toast('다시 함'); }

  function layersOut() {
    R.userLayers = EX.map(function (x) {       // 덧 클립 (V2.. · A2..) - 시각은 넷째 자리까지
      var o = JSON.parse(JSON.stringify(x));
      ['at', 's', 'e'].forEach(function (k) { o[k] = +(+o[k]).toFixed(4); });
      return o;
    });
  }
  /* 고친 뒤: 저장 · 미리보기 · 다시 그리기 */
  function saveState() {
    if (!R) return;
    R.userClips = sorted().map(function (c) {
      var o = { s: +c.s.toFixed(4), e: +c.e.toFixed(4), at: +c.at.toFixed(4) };
      if (c.vol) o.vol = c.vol;                // 클립 소리 dB (A1 인스펙터)
      if (c.color) o.color = c.color;          // 색 (밝기 · 대비 · 채도 · RGBW · 커브, lib/color.mjs)
      if (c.tin && c.tin.d) o.tin = c.tin;     // 앞 클립에서 넘어오는 전환 {type, d}
      if (c.tf) o.tf = c.tf;                   // 변형 {x, y (창 px), z (배율), r (도)} - AI 화면 잡기 위에 얹는다 (2026-10-03)
      if (c.g) o.g = c.g;                      // 그룹 id (review.userGroups)
      if (c.vhide) o.vhide = true;             // 화면은 V2.. 로 옮기고 소리만 A1 에 남은 클립
      if (c.ahide) o.ahide = true;             // 소리는 A2.. 로 옮기고 화면만 V1 에 남은 클립
      if (c.fx && c.fx.length) o.fx = c.fx;    // 화면 효과 [{type: zoom | push | shake | blur, ...}] (이펙트 탭, 2026-10-03)
      return o;
    });
    layersOut();
    D.touch();
  }
  function changed() {
    saveState();
    draw();
    clearTimeout(upd);
    upd = setTimeout(refreshScene, 120);
  }

  /* ---------- 미리보기 ----------
     피드백 탭과 **같은 영상**을 쓴다 (사용자 2026-10-02 둘째: "피드백 탭과 사용자 편집 탭의 영상은 공유",
     "피드백에서 미리보기 변경 사항도 사용자 편집에서 적용"). 피드백 탭의 화면 (.fb-stage-wrap - 영상 · 쪽지 · 화살표가 든 상자)
     을 이 탭이 보일 때 뷰어로 옮겨 오고, 떠날 때 돌려놓는다. 그래서 재생 위치 · 장면 (자막 고침 · 클립) · 쪽지가 두 탭에서 같다.
     영상 시각 = 이 타임라인 시각 (클립을 고치면 review.userClips 가 피드백 탭의 계획이 된다). */
  var BOUND = null;
  function video() { var v = D.Feedback && D.Feedback.video(); return v && (v.src || v.duration || SC) ? v : null; }
  function now() { var v = video(); return v ? v.currentTime || 0 : (drag && drag.t != null ? drag.t : 0); }
  function viewerMsg(msg) {
    var host = D.$('#ueViewer');
    var m = host.querySelector('.ue-msg:not(#ueEmpty)');            // #ueEmpty 는 남긴다 - 지우면 프로젝트를 다시 열 때 load 가 멈췄다
    if (!msg) { if (m) m.remove(); return; }
    if (!m) { m = D.el('div', { class: 'ue-msg' }); host.appendChild(m); }
    m.textContent = msg;
  }
  function bindShared() {                  // 피드백 탭이 프로젝트를 새로 열면 영상 객체가 바뀐다 - 바뀔 때마다 다시 단다
    var v = D.Feedback && D.Feedback.video();
    if (!v || v === BOUND) return;
    BOUND = v;
    v.addEventListener('play', function () { if (BOUND !== v) return; icon('pause'); loop(); });
    v.addEventListener('pause', function () { if (BOUND !== v) return; icon('play'); drawPlayhead(); });
    v.addEventListener('seeked', function () { if (BOUND === v && SHOWN) drawPlayhead(); });
    v.addEventListener('timeupdate', function () { if (BOUND === v && SHOWN && v.paused) drawPlayhead(); });
    v.addEventListener('loadedmetadata', function () { if (BOUND === v && SHOWN) { fitViewer(); drawPlayhead(); } });
    icon(v.paused ? 'play' : 'pause');
  }
  function mountPlayer() {                 // 피드백 화면을 뷰어로 옮겨 온다
    if (MOUNTING || !R || !SHOWN) return;
    var wrap = D.$('.fb-stage-wrap');
    if (wrap && wrap.parentNode !== D.$('#ueViewer')) D.$('#ueViewer').appendChild(wrap);
    if (!D.Feedback.ready()) {
      if (!R.srcPreview && R.scene) viewerMsg('원본 사본 없음');          // 옛 프로젝트 - tools/src_preview.py (내보내기) 가 만든다
      MOUNTING = true;
      setTimeout(function () { MOUNTING = false; if (SHOWN) mountPlayer(); }, 400);
      return;
    }
    viewerMsg('');
    SC = D.Feedback.sceneFor(plan());
    if (SC) FPS = SC.fps || 60;
    bindShared();
    fitViewer();
    draw();
  }
  function unmountPlayer() {               // 피드백 탭 제자리 (전송 막대 앞) 로 돌려놓는다
    var wrap = D.$('.fb-stage-wrap'), body = D.$('#paneVideo .video-body');
    if (wrap && body && wrap.parentNode !== body) body.insertBefore(wrap, body.querySelector('.fb-transport'));
    var ed = D.$('#ueBoxEd'); if (ed) ed.hidden = true;
    if (D.Feedback && D.Feedback.refresh) D.Feedback.refresh();
  }
  function refreshScene() {
    if (!R || !D.Feedback.ready()) return;
    var t = now();
    SC = D.Feedback.sceneFor(plan());
    if (!SC) return;
    D.Feedback.livePreview(Math.min(t, Math.max(0, total() - 1 / FPS)));   // 같은 영상에 새 장면 - 고쳐도 보던 시각을 지킨다
    bindShared();
    tag();
    draw();
  }
  function fitViewer() { if (SHOWN && D.Feedback && D.Feedback.refresh) D.Feedback.refresh(); tag(); }
  function tag() {                         // 렌더 전 (완성본이 옛것 · 고친 컷이 있다) 이면 뷰어 머리에 표
    var t = D.$('#ueTag');
    if (t) t.hidden = !(R && (R.unbaked || (R.userClips && R.userClips.length)));   // 고친 것이 아직 안 구워졌다 (전환 때문에 원본 사본으로 트는 것과는 다르다)
  }
  function icon(name) { var u = D.$('#uePlay use'); if (u) u.setAttribute('href', '#i-' + name); }
  function toggle() { var v = video(); if (!v) return; if (v.paused) { if (v.currentTime >= total() - 0.02) v.currentTime = 0; v.play(); } else v.pause(); }
  function seek(t) {
    t = Math.max(0, Math.min(fr(t), Math.max(0, total() - 1 / FPS)));
    var v = video();
    if (v) v.currentTime = t; else if (drag) drag.t = t;
    drawPlayhead();
  }
  function loop() {
    cancelAnimationFrame(rafId);
    var v = video();
    if (!v || v.paused) return;
    drawPlayhead(true);
    rafId = requestAnimationFrame(loop);
  }

  /* ---------- 타임라인 그리기 ---------- */
  function scroller() { return D.$('#ueScroll'); }
  function X(t) { return t * PPS; }
  function T(x) { return x / PPS; }
  function draw() {
    var sc = scroller();
    if (!sc) return;
    var cont = D.$('#ueContent');
    var w = Math.max(MINW, X(Math.max(total(), exEnd()) + 20), sc.clientWidth);
    MINW = w;                               // 편집 중에는 줄이지 않는다 - 줄면 스크롤이 당겨져 선이 화면에서 움직인다
    cont.style.width = w + 'px';
    drawRuler(w);
    CAPR = capRows();
    var titleButton = D.$('#ueTitle');
    if (titleButton) titleButton.disabled = !hasTitle();
    buildLanes();
    drawCaps();
    syncBoxEd();
    var lv = laneEl('v', 1), la = laneEl('a', 1), mp = R && R.srcPreview && R.srcPreview.path, mm = mp ? med(mp, 'video') : {};
    sorted().forEach(function (c, i) {
      [['v', lv], ['a', la]].forEach(function (kv) {
        var hid = kv[0] === 'v' ? c.vhide : c.ahide;
        var el = D.el('div', { class: 'ue-clip ue-' + kv[0] + (SEL[c.id] ? ' is-sel' : '') + (hid ? ' is-vhide' : '') });
        el.style.left = X(c.at) + 'px';
        el.style.width = Math.max(2, X(len(c))) + 'px';
        el.dataset.id = c.id;
        if (hid) el.appendChild(D.el('span', { class: 'ue-clip-name', text: kv[0] === 'v' ? '위 트랙으로' : '아래 트랙으로' }));
        else if (kv[0] === 'v') {
          film(el, mm.th, c.s, len(c), LANE_H - 6 - 16);
          el.appendChild(D.el('span', { class: 'ue-clip-name', text: (i + 1) + '  ' + stc(c.s) + ' - ' + stc(c.e) }));
          if (c.fx && c.fx.length) el.appendChild(D.el('span', { class: 'ue-fxb', text: 'fx', title: c.fx.map(fxName).join(' · ') }));
        } else {
          wave(el, waveData() || mm.wave, c.s, len(c), LANE_H - 8);
          if (c.vol) el.appendChild(D.el('span', { class: 'ue-clip-name ue-vol', text: (c.vol > 0 ? '+' : '') + c.vol + 'dB' }));
        }
        el.appendChild(D.el('i', { class: 'ue-trim ue-trim-l' }));
        el.appendChild(D.el('i', { class: 'ue-trim ue-trim-r' }));
        kv[1].appendChild(el);
      });
    });
    sorted().forEach(function (c, i) {
      if (!i || !c.tin || !c.tin.d) return;
      var tr = D.el('div', { class: 'ue-trans' + (String(TSEL) === String(c.id) ? ' is-sel' : ''), title: (TRANS.filter(function (kv) { return kv[0] === c.tin.type; })[0] || ['', ''])[1] + ' ' + c.tin.d + '초' });
      tr.style.left = X(c.at - c.tin.d / 2) + 'px'; tr.style.width = Math.max(6, X(c.tin.d)) + 'px';
      tr.dataset.id = c.id;
      tr.appendChild(D.el('i', { class: 'ue-tr-h ue-tr-l' })); tr.appendChild(D.el('i', { class: 'ue-tr-h ue-tr-r' }));
      lv.appendChild(tr);
    });
    EX.forEach(function (x) { var ln = laneEl(areaOf(x), x.track); if (ln) ln.appendChild(exEl(x)); });
    EX.forEach(function (x) {                // 덧 클립 사이 전환 표 (맞닿은 앞 클립이 있을 때만 먹는다)
      if (!x.tin || !x.tin.d || !prevOnTrack(x)) return;
      var ln = laneEl(areaOf(x), x.track);
      if (!ln) return;
      var tr = D.el('div', { class: 'ue-trans' + (String(TSEL) === String(x.id) ? ' is-sel' : ''), title: (TRANS.filter(function (kv) { return kv[0] === x.tin.type; })[0] || ['', '디졸브'])[1] + ' ' + x.tin.d + '초' });
      tr.style.left = X(x.at - x.tin.d / 2) + 'px'; tr.style.width = Math.max(6, X(x.tin.d)) + 'px';
      tr.dataset.xid = x.id;
      tr.appendChild(D.el('i', { class: 'ue-tr-h ue-tr-l' })); tr.appendChild(D.el('i', { class: 'ue-tr-h ue-tr-r' }));
      ln.appendChild(tr);
    });
    vscroll();
    drawRange(w);
    drawGroups();
    drawPlayhead();
    if (drag && drag.moved) return;          // 끄는 동안은 인스펙터 · 낱말 칸을 다시 만들지 않는다 (놓을 때 그린다 - 끌기 한 번에 23ms 중 대부분)
    side();
    drawWords();
  }
  var LANE_H = 50;

  /* ---------- 트랙 (2026-10-02 넷째, 사용자: "y축 가운데를 기준으로 아래는 오디오 영역 위는 비디오 영역(자막 포함)이고 비디오는 기준에서부터
     위로 1,2,3,4,... 스크롤 가능, 오디오는 기준에서부터 아래로 1,2,3,4,... 스크롤 가능") ----------
     V1 · A1 = 이 편 원본 (지금까지의 클립), V2.. · A2.. = 소스 칸에서 끌어 놓은 덧 클립 (EX). 쓰인 트랙 + 빈 트랙 하나를 늘 보인다.
     세로 넘김은 칸마다 따로 (바퀴) - 비디오는 위로, 오디오는 아래로 늘어난다. */
  function areaOf(x) { return x.kind === 'audio' ? 'a' : 'v'; }
  function trackCount(a) {                 // 쓰는 트랙까지만 - 끄는 동안 빈 트랙 하나 더 (2026-10-03)
    var n = 1;
    EX.forEach(function (x) { if (areaOf(x) === a) n = Math.max(n, x.track); });
    if (a === 'v') CAPR.forEach(function (r) { n = Math.max(n, r.track); });
    if (drag && drag.moved && drag.area === a && /^(move|xmove|cap)$/.test(drag.kind)) n++;
    return n;
  }
  /* 자막은 비디오 트랙에 (2026-10-03): 정한 트랙 (review.capTracks, 글로 찾음 · 새 자막은 id) 이 없으면 V2 부터 비어 있는 트랙 */
  var CAPR = [];
  var TITLE_ID = 'title';
  function titleCaption() {
    var found = null;
    ((R && R.captions) || []).forEach(function (c) {
      if (/^(제목|title)$/.test((c.speaker || '').trim())) found = c;
    });
    return found;
  }
  function hasTitle() { return !!(SC && ((SC.style && SC.style.title) || SC.title || titleCaption())); }
  function titleText() {
    var c = titleCaption();
    return c ? c.text || '' : (SC && SC.title && SC.title.text) || '';
  }
  function titlePlain(text) { return String(text || '').replace(/«(.+?)\|[A-Za-z]+»/g, '$1'); }
  function titleWithMarks(text, original) {
    var old = String(original || '').split('\n');
    return text.split('\n').map(function (line, i) {
      var before = old[i] || '';
      if (line === titlePlain(before)) return before;
      var whole = before.match(/^«(.+)\|([A-Za-z]+)»$/);
      if (whole) return line ? '«' + line + '|' + whole[2] + '»' : '';
      return line;
    }).join('\n');
  }
  function selectTitle() {
    if (!hasTitle()) return;
    CSEL = TITLE_ID; SEL = {}; TSEL = null;
    showPane('ins'); draw();
    var vin = D.$('#ueVin'), va = D.$('#ueVA');
    if (vin && va) { VS = Math.max(0, vin.offsetHeight - va.clientHeight); vscroll(); }
  }
  function capKey(c) { return /^uc/.test(c.id) ? c.id : String(c.text || '').replace(/«(.+?)\|[A-Za-z]+»/g, '$1').trim(); }
  function capRows() {
    var caps = ((SC && SC.captions) || []).filter(function (c) { return c.e > c.s; }).slice().sort(function (a, b) { return a.s - b.s; });
    var TR = (R && R.capTracks) || {}, out = [];
    var trackOf = function (c) { return drag && drag.kind === 'cap' && drag.moved && drag.cid === c.id ? drag.track : TR[capKey(c)]; };
    var busy = function (n, s, e) {
      return out.some(function (r) { return r.track === n && s < r.c.e - 1e-3 && e > r.c.s + 1e-3; })
        || EX.some(function (x) { return areaOf(x) === 'v' && x.track === n && s < x.at + xlen(x) - 1e-3 && e > x.at + 1e-3; });
    };
    caps.forEach(function (c) { var t = trackOf(c); if (t >= 2) out.push({ c: c, track: t }); });
    caps.forEach(function (c) { if (trackOf(c) >= 2) return; var n = 2; while (busy(n, c.s, c.e)) n++; out.push({ c: c, track: n }); });
    if (hasTitle()) {
      var top = 2;
      out.forEach(function (r) { top = Math.max(top, r.track + 1); });
      EX.forEach(function (x) { if (areaOf(x) === 'v') top = Math.max(top, x.track + 1); });
      out.push({ c: { id: TITLE_ID, s: 0, e: total(), text: titleText() }, track: top });
    }
    return out;
  }
  function capRow(id) { return CAPR.filter(function (r) { return r.c.id === id; })[0] || null; }
  function ucOf(id) { return ((R && R.userCaps) || []).filter(function (o) { return 'uc' + o.id === id; })[0] || null; }
  function laneEl(a, n) { return D.$('#ue' + (a === 'v' ? 'Vin' : 'Ain') + ' .ue-lane[data-track="' + n + '"]'); }
  function buildLanes() {
    var nv = trackCount('v'), na = trackCount('a');
    var vin = D.$('#ueVin'), ain = D.$('#ueAin'), hv = D.$('#ueHVin'), ha = D.$('#ueHAin');
    if (!vin) return;
    vin.textContent = ''; ain.textContent = ''; hv.textContent = ''; ha.textContent = '';
    var lane = function (a, n) {
      var l = D.el('div', { class: 'ue-lane ue-lane-' + a + (n === 1 ? ' is-main' : '') });
      l.dataset.area = a; l.dataset.track = n; l.style.height = LANE_H + 'px';
      if (n === 1) l.id = a === 'v' ? 'ueLaneV' : 'ueLaneA';
      var h = D.el('div', { class: 'ue-hd' + (n === 1 ? ' is-main' : '') });
      h.style.height = LANE_H + 'px';
      h.appendChild(D.el('b', { text: (a === 'v' ? 'V' : 'A') + n }));
      var isTitle = a === 'v' && CAPR.some(function (r) { return r.track === n && r.c.id === TITLE_ID; });
      h.appendChild(D.el('small', { text: isTitle ? '제목' : n === 1 ? '원본' : a === 'v' ? '비디오' : '오디오' }));
      return [l, h];
    };
    for (var n = nv; n >= 1; n--) { var p = lane('v', n); vin.appendChild(p[0]); hv.appendChild(p[1]); }
    for (var m = 1; m <= na; m++) { var q = lane('a', m); ain.appendChild(q[0]); ha.appendChild(q[1]); }
  }
  var VS = 0, AS = 0;
  function vscroll() {                     // 비디오 칸은 아래 (가운데 선) 에 붙여 위로 넘기고, 오디오 칸은 위에 붙여 아래로 넘긴다
    var va = D.$('#ueVA'), aa = D.$('#ueAA'), vin = D.$('#ueVin'), ain = D.$('#ueAin');
    if (!va) return;
    VS = Math.max(0, Math.min(VS, vin.offsetHeight - va.clientHeight));
    AS = Math.max(0, Math.min(AS, ain.offsetHeight - aa.clientHeight));
    [vin, D.$('#ueHVin')].forEach(function (e) { e.style.transform = 'translateY(' + VS + 'px)'; });
    [ain, D.$('#ueHAin')].forEach(function (e) { e.style.transform = 'translateY(' + (-AS) + 'px)'; });
  }
  /* 바퀴 (2026-10-03 사용자: "비디오 영역 스크롤시 영역자체가 위 아래로 스크롤 (상위 트랙보려고) ... 오디오 영역 스크롤도 동일하게,
     ctrl+스크롤이 현재 스크롤을 대체"): 그냥 = 그 칸 (비디오 · 오디오) 세로 넘김만, Ctrl (또는 Shift · 가로 바퀴) = 가로 넘김, Alt = 확대 */
  function onWheel(ev) {
    var sc = scroller(), d = ev.deltaY || ev.deltaX;
    ev.preventDefault();
    if (ev.altKey) { var r = sc.getBoundingClientRect(); zoomBy(ev.deltaY < 0 ? 1.15 : 1 / 1.15, ev.clientX - r.left); return; }
    if (ev.ctrlKey || ev.metaKey || ev.shiftKey || Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) { sc.scrollLeft += d; return; }
    var va = D.$('#ueVA').getBoundingClientRect(), inV = ev.clientY < va.bottom;
    if (inV) VS -= ev.deltaY; else AS += ev.deltaY;
    vscroll();
  }
  var RULK = '';
  function drawRuler(w) {
    var ru = D.$('#ueRuler'), k = w + '|' + PPS + '|' + FPS;
    if (k === RULK && ru.firstChild) return;     // 폭 · 배율이 그대로면 눈금은 그대로 (끌기마다 수백 개를 다시 만들었다)
    RULK = k;
    ru.textContent = '';
    var steps = [1 / FPS * 5, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300], step = 300;
    for (var i = 0; i < steps.length; i++) if (X(steps[i]) >= 90) { step = steps[i]; break; }
    var minor = step / 5;
    for (var t = 0; X(t) <= w; t += minor) {
      var major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      var tk = D.el('i', { class: 'ue-tick' + (major ? ' is-major' : '') });
      tk.style.left = X(t) + 'px';
      ru.appendChild(tk);
      if (major) {
        var lb = D.el('span', { class: 'ue-tlabel', text: tc(t) });
        lb.style.left = (X(t) + 3) + 'px';
        ru.appendChild(lb);
      }
    }
  }
  /* ---------- 썸네일 · 파형 (2026-10-02 둘째: "오디오 부분에 파형 적용 비디오의 경우 일정부분마다 썸네일 캡쳐해서 클립에 적용") ----------
     서버가 파일마다 0.5초마다 한 장씩 뜬 격자 그림 하나 (/api/media/thumbs) 와 파형 (/api/media/wave) 을 만들어 준다 - 한 번 만들면
     서버 임시 폴더에 남는다. 원본 (V1 · A1) 은 원본 사본 (review.srcPreview), 파형은 review.wave 가 있으면 그것. 덧 클립은 제 파일. */
  var MED = {};
  function med(path, kind) {
    var m = MED[path];
    if (m) return m;
    m = MED[path] = {};
    var q = '?path=' + encodeURIComponent(path);
    if (kind !== 'audio' && kind !== 'image') {
      fetch('/api/media/thumbs' + q).then(function (r) { return r.json(); }).then(function (j) {
        if (!j.ok || j.none) return;
        var im = new Image();
        im.onload = function () { m.th = j; draw(); };
        im.src = j.url;
      }).catch(function (e) { D.warn('썸네일을 못 만들었습니다: ' + e.message, 'useredit'); });
    }
    if (kind !== 'image') {
      fetch('/api/media/wave' + q).then(function (r) { return r.json(); }).then(function (j) {
        if (j.ok) { m.wave = j; draw(); }
      }).catch(function (e) { D.warn('파형을 못 만들었습니다: ' + e.message, 'useredit'); });
    }
    return m;
  }
  function loadMedia() { var p = R && R.srcPreview && R.srcPreview.path; if (p) med(p, 'video'); }
  function film(el, th, s, L, h) {         // 클립 머리 아래로 썸네일을 줄지어 (칸마다 그 자리 파일 시각의 그림)
    if (!th || h < 12) return;
    var tw = h * th.tw / th.th, W = X(L), rows = Math.ceil(th.n / th.cols);
    var box = D.el('div', { class: 'ue-film' });
    box.style.height = h + 'px';
    var size = (th.cols * tw) + 'px ' + (rows * h) + 'px';
    for (var x = 0; x < W && x < 60000; x += tw) {
      var k = Math.max(0, Math.min(th.n - 1, Math.round((s + T(x)) / th.step)));
      var f = D.el('i');
      f.style.left = x + 'px'; f.style.width = Math.ceil(tw) + 'px';
      f.style.backgroundImage = 'url("' + th.url + '")';
      f.style.backgroundSize = size;
      f.style.backgroundPosition = (-(k % th.cols) * tw) + 'px ' + (-Math.floor(k / th.cols) * h) + 'px';
      box.appendChild(f);
    }
    el.appendChild(box);
  }
  /* ---------- 덧 클립 (V2.. · A2..) - 소스 칸에서 끌어 놓은 영상 · 그림 · 소리 (2026-10-02 넷째: "소스 파일 타임라인으로 끌어 넣기") ----------
     {id 'x<n>', kind video|image|audio, path, name, track, at (타임라인 시각), s · e (파일 시각), dur (파일 길이, 그림은 없음),
      link (영상과 그 소리 짝 - 같이 옮기고 자른다), box (화면 px), opacity, vol (dB), mute, fin · fout (페이드 초), color}
     review.userLayers 로 저장 -> 렌더 단추가 edit.json layers 로 (tools/apply_review.py) -> 렌더가 ffmpeg 로 합성 · 섞는다 (자막은 그 위).
     원본 클립 (V1 · A1) 의 리플은 덧 클립을 밀지 않는다 - 놓은 타임라인 시각 그대로. */
  var EX = [];
  function exById(id) { for (var i = 0; i < EX.length; i++) if (EX[i].id === id) return EX[i]; return null; }
  function partner(x) { return x && x.link ? exById(x.link) : null; }
  function selX() { return EX.filter(function (x) { return SEL[x.id]; }); }
  function exEnd() { return EX.reduce(function (a, x) { return Math.max(a, x.at + x.e - x.s); }, 0); }
  function xlen(x) { return x.e - x.s; }
  function overlaps(x, n) {
    return EX.some(function (y) { return y !== x && areaOf(y) === areaOf(x) && y.track === n && x.at < y.at + xlen(y) - 1e-6 && x.at + xlen(x) > y.at + 1e-6; });
  }
  function settle(x) { var n = Math.max(2, x.track); while (overlaps(x, n)) n++; x.track = n; }   // 겹치면 위 (오디오는 아래) 빈 트랙으로
  function fitBox(w0, h0, mode) {          // 창 (또는 화면 전체) 안에 비율 그대로 - mode 'cover' 는 꽉 채움
    var W = mode === 'canvas' || mode === 'cover' ? { x: 0, y: 0, w: (SC && SC.width) || 1080, h: (SC && SC.height) || 1920 } : (SC && SC.window) || { x: 0, y: 0, w: 1080, h: 1920 };
    if (!w0 || !h0) return { x: W.x, y: W.y, w: W.w, h: W.h };
    var k = mode === 'cover' ? Math.max(W.w / w0, W.h / h0) : Math.min(W.w / w0, W.h / h0), w = w0 * k, h = h0 * k;
    return { x: Math.round(W.x + (W.w - w) / 2), y: Math.round(W.y + (W.h - h) / 2), w: Math.round(w), h: Math.round(h) };
  }
  /* 움직임 (2026-10-03: 위치 · 크기 키프레임) - keys [{t, x, y, w, h}], t = 클립 안 시각 (at 부터 초). 키가 둘 이상이면 키 사이를
     곧게 잇는다 (ease = 부드럽게, smoothstep). 키 하나는 고정 자리. 미리보기 src/parts/Layers.tsx boxAt · 렌더 lib/render.mjs (perspective) 가 같은 계산 */
  function kbox(k) { return { x: k.x, y: k.y, w: k.w, h: k.h }; }
  function rbox(b) { return { x: Math.round(b.x), y: Math.round(b.y), w: Math.max(8, Math.round(b.w)), h: Math.max(8, Math.round(b.h)) }; }
  function boxAt(x, tl) {
    var K = x.keys;
    if (!K || !K.length) return x.box || fitBox(x.w0, x.h0);
    if (tl <= K[0].t) return kbox(K[0]);
    if (tl >= K[K.length - 1].t) return kbox(K[K.length - 1]);
    var i = 0;
    while (i + 2 < K.length && tl >= K[i + 1].t) i++;
    var a = K[i], b = K[i + 1], p = (tl - a.t) / Math.max(1e-6, b.t - a.t);
    if (x.ease) p = p * p * (3 - 2 * p);
    return { x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p, w: a.w + (b.w - a.w) * p, h: a.h + (b.h - a.h) * p };
  }
  function localT(x) { return Math.max(0, Math.min(xlen(x), fr(now() - x.at))); }
  function curBox(x) { return boxAt(x, localT(x)); }
  function keyAt(x, tl) { return (x.keys || []).filter(function (k) { return Math.abs(k.t - tl) < 0.5 / FPS; })[0] || null; }
  function setBox(x, b) {                  // 키가 있으면 재생 위치에 키를 만들거나 고친다 (리졸브처럼), 없으면 상자 하나
    b = rbox(b);
    if (!x.keys || !x.keys.length) { x.box = b; return; }
    var tl = localT(x), k = keyAt(x, tl);
    if (k) Object.assign(k, b);
    else { x.keys.push(Object.assign({ t: +tl.toFixed(4) }, b)); x.keys.sort(function (p, q) { return p.t - q.t; }); }
    x.box = kbox(x.keys[0]);                 // 키를 모르는 쪽이 읽을 자리
  }
  function exEl(x) {
    var a = areaOf(x), el = D.el('div', { class: 'ue-clip ue-x ue-' + a + (x.kind === 'image' ? ' is-img' : '') + (SEL[x.id] ? ' is-sel' : '') + (x.mute ? ' is-mute' : ''),
                                          title: x.name + (x.link ? '' : '') });
    el.style.left = X(x.at) + 'px';
    el.style.width = Math.max(2, X(xlen(x))) + 'px';
    el.dataset.xid = x.id;
    var m = med(x.path, x.kind);
    if (x.kind === 'video') film(el, m.th, x.s, xlen(x), LANE_H - 6 - 16);
    else if (x.kind === 'image') {
      var im = D.el('div', { class: 'ue-film ue-img' });
      im.style.height = (LANE_H - 6 - 16) + 'px';
      im.style.backgroundImage = 'url("/api/media/poster?path=' + encodeURIComponent(x.path) + '")';
      el.appendChild(im);
    } else wave(el, m.wave, x.s, xlen(x), LANE_H - 8);
    el.appendChild(D.el('span', { class: 'ue-clip-name', text: (x.link ? '🔗 ' : '') + x.name + (x.kind === 'audio' && x.vol ? '  ' + (x.vol > 0 ? '+' : '') + x.vol + 'dB' : '') }));
    if (x.fin) { var fi = D.el('i', { class: 'ue-fade ue-fade-in' }); fi.style.width = X(x.fin) + 'px'; el.appendChild(fi); }
    if (x.fout) { var fo = D.el('i', { class: 'ue-fade ue-fade-out' }); fo.style.width = X(x.fout) + 'px'; el.appendChild(fo); }
    (x.keys || []).forEach(function (k) {
      if (k.t < -1e-4 || k.t > xlen(x) + 1e-4) return;
      var kf = D.el('i', { class: 'ue-kf' }); kf.style.left = X(k.t) + 'px'; el.appendChild(kf);
    });
    el.appendChild(D.el('i', { class: 'ue-trim ue-trim-l' }));
    el.appendChild(D.el('i', { class: 'ue-trim ue-trim-r' }));
    return el;
  }
  function splitX(x, t) {                  // 타임라인 시각 t 에서 둘로 (짝도 같이)
    t = fr(t);
    var m = MIN / FPS;
    if (!x || t <= x.at + m || t >= x.at + xlen(x) - m) return false;
    var pairs = [x].concat(LINK && partner(x) ? [partner(x)] : []), made = [];
    pairs.forEach(function (y) {
      var cut = y.s + (t - y.at), y2 = JSON.parse(JSON.stringify(y));
      y2.id = 'x' + (UID++); y2.at = t; y2.s = cut; y2.fin = 0;
      if (y.keys && y.keys.length) {
        var lt = t - y.at, mid = rbox(boxAt(y, lt));
        y2.keys = [Object.assign({ t: 0 }, mid)].concat(y.keys.filter(function (k) { return k.t > lt + 1e-4; })
          .map(function (k) { return Object.assign({}, k, { t: +(k.t - lt).toFixed(4) }); }));
        y.keys = y.keys.filter(function (k) { return k.t < lt - 1e-4; }).concat([Object.assign({ t: +lt.toFixed(4) }, mid)]);
        y2.box = kbox(y2.keys[0]);
      }
      y.e = cut; y.fout = 0;
      EX.push(y2); made.push(y2);
    });
    if (made.length === 2) { made[0].link = made[1].id; made[1].link = made[0].id; }
    else if (partner(made[0]) && LINK === false) made[0].link = null;     // 따로 자른 쪽은 짝이 엇갈린다 - 묶음을 푼다
    return true;
  }

  /* 소스 칸 -> 타임라인 끌어 놓기 */
  var DRAGTYPE = 'application/x-kirinuki-media';
  function dropInfo(ev) {
    var el = document.elementFromPoint(ev.clientX, ev.clientY), ln = el && el.closest && el.closest('#ueContent .ue-lane');
    var va = D.$('#ueVA').getBoundingClientRect();
    var a = ln && ln.dataset.area ? ln.dataset.area : (ev.clientY < va.bottom ? 'v' : 'a');
    var n = ln && ln.dataset.track ? Math.max(2, +ln.dataset.track) : 2;
    return { area: a, track: n, t: Math.max(0, snapT(T(cx(ev)), null)) };
  }

  /* 바깥 파일 (탐색기에서 끌어 온 것, 2026-10-03): 서버 projects/<id>/media 로 올리고 소스 "가져온 파일" (review.srcFiles) 에 넣는다 */
  function hasFiles(ev) { return !!(ev.dataTransfer && Array.prototype.indexOf.call(ev.dataTransfer.types || [], 'Files') >= 0); }
  function uploadFiles(files, done) {
    var pid = (D.state.project || {}).id, list = Array.prototype.slice.call(files || []), got = [];
    if (!pid || !list.length) return;
    var next = function (i) {
      if (i >= list.length) {
        if (got.length) {
          var have = srcFiles().map(function (f) { return f.path; });
          R.srcFiles = srcFiles().concat(got.filter(function (f) { return have.indexOf(f.path) < 0; }));
          D.touch(); drawBins();
        }
        if (done) done(got);
        return;
      }
      var f = list[i];
      D.toast('가져오는 중 ' + (i + 1) + '/' + list.length + ' · ' + f.name);
      fetch('/api/media/upload?project=' + encodeURIComponent(pid) + '&name=' + encodeURIComponent(f.name), { method: 'POST', body: f })
        .then(function (r) { return r.json(); })
        .then(function (j) { if (j.ok) got.push({ path: j.path, name: j.name, kind: j.kind, size: j.size }); else D.toast(j.error || '못 가져왔습니다'); next(i + 1); })
        .catch(function () { D.toast('못 가져왔습니다: ' + f.name); next(i + 1); });
    };
    next(0);
  }
  function srcFiles() { return (R && R.srcFiles) || []; }
  function dropFiles(ev) {                  // 타임라인에 놓은 바깥 파일: 올린 뒤 놓은 자리부터 차례로 클립
    var d = dropInfo(ev);
    uploadFiles(ev.dataTransfer.files, function (got) {
      var t = d.t;
      var one = function (i) {
        if (i >= got.length) return;
        fetch('/api/media/info?path=' + encodeURIComponent(got[i].path)).then(function (r) { return r.json(); }).then(function (info) {
          if (info.ok) { addMedia(got[i], info, { area: d.area, track: d.track, t: t }); t += info.kind === 'image' || !info.dur ? 5 : info.dur; }
          one(i + 1);
        });
      };
      one(0);
    });
  }
  function onDragOver(ev) {
    if (FXDRAG) {                          // 이펙트 끌기: 아래 클립에 표
      var tg = fxTarget(ev), ok = tg && !fxWhy(FXDRAG, tg.o);
      fxHL(ok ? tg.el : null);
      if (ok) { ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; }
      return;
    }
    if (hasFiles(ev)) { ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; var df = dropInfo(ev), mf = D.$('#ueDrop'); mf.hidden = false; mf.style.left = X(df.t) + 'px'; return; }
    if (!ev.dataTransfer || Array.prototype.indexOf.call(ev.dataTransfer.types || [], DRAGTYPE) < 0) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
    var d = dropInfo(ev), m = D.$('#ueDrop');
    m.hidden = false; m.style.left = X(d.t) + 'px';
  }
  function onDrop(ev) {
    if (FXDRAG) {
      ev.preventDefault();
      var it = FXDRAG, tg = fxTarget(ev);
      FXDRAG = null; fxHL(null);
      if (!tg) { D.toast('클립 위에 놓아 주세요'); return; }
      applyFx(it, [tg.o], true);
      return;
    }
    var raw = ev.dataTransfer && ev.dataTransfer.getData(DRAGTYPE);
    D.$('#ueDrop').hidden = true;
    if (!raw && hasFiles(ev) && ev.dataTransfer.files.length) { ev.preventDefault(); dropFiles(ev); return; }
    if (!raw) return;
    ev.preventDefault();
    var f = JSON.parse(raw), d = dropInfo(ev);
    fetch('/api/media/info?path=' + encodeURIComponent(f.path)).then(function (r) { return r.json(); }).then(function (info) {
      if (!info.ok) { D.toast('파일을 못 읽었습니다: ' + (info.error || f.name)); return; }
      addMedia(f, info, d);
    });
  }
  function addMedia(f, info, d) {
    var kind = info.kind || f.kind, dur = info.dur || 0, made = [];
    var base = { path: f.path, name: f.name.split('/').pop(), at: fr(d.t), s: 0, opacity: 1, vol: 0, fin: 0, fout: 0 };
    remember();
    if (kind === 'image') {
      made.push(Object.assign({}, base, { id: 'x' + (UID++), kind: 'image', track: d.area === 'v' ? d.track : 2, e: 5, dur: null,
                                          w0: info.w, h0: info.h, box: fitBox(info.w, info.h) }));
    } else if (kind === 'audio' || (kind === 'video' && d.area === 'a')) {
      if (!info.audio) { UNDO.pop(); D.toast('이 파일에는 소리가 없습니다'); return; }
      made.push(Object.assign({}, base, { id: 'x' + (UID++), kind: 'audio', track: d.area === 'a' ? d.track : 2, e: dur, dur: dur }));
    } else {
      var v = Object.assign({}, base, { id: 'x' + (UID++), kind: 'video', track: d.track, e: dur, dur: dur, w0: info.w, h0: info.h, box: fitBox(info.w, info.h) });
      made.push(v);
      if (info.audio) {
        var au = Object.assign({}, base, { id: 'x' + (UID++), kind: 'audio', track: 2, e: dur, dur: dur, link: v.id });
        v.link = au.id; made.push(au);
      }
    }
    made.forEach(function (x) { EX.push(x); settle(x); });
    SEL = {}; CSEL = null; made.forEach(function (x) { SEL[x.id] = true; });
    showPane('ins');
    changed();
    D.toast(made.length > 1 ? '영상 + 소리를 놓았습니다 (묶음)' : '놓았습니다');
  }
  /* 덧 클립 끌기: 가운데 = 옮기기 (시각 + 같은 칸 안의 다른 트랙), 끝 = 자르기 (짝도 같이). 놓을 때 겹치면 빈 트랙으로 */
  function xDown(ev, el, t) {
    var x = exById(el.dataset.xid);
    if (!x) return;
    if (TOOL === 'blade') {
      remember();
      if (splitX(x, snapT(t, null))) changed(); else UNDO.pop();
      return;
    }
    var r = el.getBoundingClientRect(), off = ev.clientX - r.left;
    var kind = off < EDGEPX ? 'l' : off > r.width - EDGEPX ? 'r' : 'move';
    CSEL = null;
    if (!SEL[x.id] || kind !== 'move') {
      if (!ev.shiftKey) SEL = {};
      SEL[x.id] = true;
      if (LINK && partner(x)) SEL[partner(x).id] = true;         // 묶음은 같이 고른다 (리졸브처럼, 연결 끄면 따로)
    }
    drag = { kind: 'x' + kind, id: x.id, x0: cx(ev), base: snapshot(), moved: false, area: areaOf(x) };
    draw();
  }
  function xMove(ev) {
    var dx = cx(ev) - drag.x0;
    if (!drag.moved && Math.abs(dx) < 3 && drag.kind !== 'xmove') return;
    drag.moved = true;
    EX = JSON.parse(drag.base).x || [];
    var x = exById(drag.id), p = LINK ? partner(x) : null, o = JSON.parse(JSON.stringify(x)), dt = T(dx), m = MIN / FPS;
    var both = [x].concat(p ? [p] : []);
    D.$('#ueSnap').hidden = true;
    if (drag.kind === 'xmove') {
      var grp = selX();
      if (grp.indexOf(x) < 0) grp.push(x);
      if (p && grp.indexOf(p) < 0) grp.push(p);
      var skip = function (id) { return grp.some(function (g) { return g.id === id; }); };
      var a = Math.max(0, o.at + dt), sa = snapX(a, skip), se = snapX(a + xlen(o), skip) - xlen(o);
      a = Math.abs(sa - a) <= Math.abs(se - a) ? sa : se;
      if (a !== Math.max(0, o.at + dt)) showSnap(a === sa ? a : a + xlen(o));
      var d = fr(a) - o.at;
      grp.forEach(function (g) { g.at = Math.max(0, fr(g.at + d)); });
      var hit = document.elementFromPoint(ev.clientX, ev.clientY), ln = hit && hit.closest && hit.closest('#ueContent .ue-lane');
      if (ln && ln.dataset.area === areaOf(x) && +ln.dataset.track >= 2) x.track = +ln.dataset.track;   // 같은 칸 안에서만 트랙을 옮긴다
      drag.toMain = !!(ln && +ln.dataset.track === 1 && ln.dataset.area === areaOf(x) && (x.kind === 'video' || x.kind === 'audio'));
      drag.ghost = drag.toMain ? [areaOf(x), 1, x.at, xlen(x)] : null;
    } else if (drag.kind === 'xl') {
      var lo = x.kind === 'image' ? -Infinity : 0;
      var ns = Math.max(lo, Math.min(o.s + dt, o.e - m));
      if (o.at + (ns - o.s) < 0) ns = o.s - o.at;
      var d2 = fr(ns - o.s);
      both.forEach(function (g) {
        g.s += d2; g.at = fr(g.at + d2);
        if (g.keys) g.keys.forEach(function (k) { k.t = +(k.t - d2).toFixed(4); });
        if (g.kind === 'image' && g.s < 0) { g.e -= g.s; g.s = 0; }     // 그림은 길이만 있다
      });
    } else {
      var e1 = snapX(o.at + xlen(o) + dt, function (id) { return id === x.id || (p && id === p.id); });
      var ne = Math.max(o.s + m, Math.min(o.s + (e1 - o.at), x.dur || Infinity));
      var d3 = fr(ne - o.e);
      both.forEach(function (g) { g.e = Math.min(g.e + d3, g.dur || Infinity); });
    }
    draw();
    if (drag.ghost) laneGhost.apply(null, drag.ghost);   // 그린 뒤에 (draw 가 레인을 새로 만들어 지웠다 - 내릴 때 표시가 안 보였다)
  }
  function xUp(d) {
    laneGhost(null);
    if (d.kind === 'xmove' && d.toMain) {
      var mv = exById(d.id), at0 = mv && mv.at;
      EX = JSON.parse(d.base).x || [];
      remember();
      if (toMain(exById(d.id), at0)) changed(); else { UNDO.pop(); draw(); }
      return;
    }
    EX.forEach(function (x) { if (SEL[x.id]) settle(x); });
    var after = JSON.stringify(EX);
    EX = JSON.parse(d.base).x || []; remember(); EX = JSON.parse(after);
    changed();
  }
  function snapX(t, skip) {               // 재생 위치 · 원본 클립 끝 · 다른 덧 클립 끝에 붙기
    if (!SNAP) return t;
    var best = t, bd = SNAPPX / PPS, cand = [now()];
    CL.forEach(function (c) { cand.push(c.at, end(c)); });
    EX.forEach(function (y) { if (!skip(y.id)) cand.push(y.at, y.at + xlen(y)); });
    cand.forEach(function (x) { var dd = Math.abs(x - t); if (dd < bd) { bd = dd; best = x; } });
    return best;
  }
  /* 숫자 칸 하나 (Enter 또는 칸을 떠날 때 반영, 되돌리기 됨) */
  function numRow(ins, label, val, unit, set, step) {
    var row = D.el('label', { class: 'ue-field' });
    row.appendChild(D.el('span', { text: label }));
    var box = D.el('div', { class: 'ue-num' });
    var inp = D.el('input', { type: 'number', value: String(val), step: String(step || 1) });
    var commit = function () {
      var v = parseFloat(inp.value);
      if (isNaN(v) || v === val) return;
      remember(); set(v); changed();
    };
    inp.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); inp.blur(); } });
    inp.addEventListener('change', commit);
    box.appendChild(inp);
    if (unit) box.appendChild(D.el('small', { text: unit }));
    row.appendChild(box);
    ins.appendChild(row);
  }
  /* ---------- 인스펙터 부품 (2026-10-03 사용자: "인스펙터에 비디오 / 오디오 구분, 소리 크기는 슬라이더 + 숫자, 색은 rgbw, 컬러 커브 그래프,
     밝기 대비 채도 탭으로, 색 되돌리기 -> 초기화", "이동, 확대, 회전 ... x,y값 (슬라이더 + 숫자(변경 불가, 확인 용))") ---------- */
  var INS_TAB = 'v', COL_TAB = 'basic', CUR_CH = 'm', LIVE_T = 0, liveTm = 0;
  function sub(ins, text) { ins.appendChild(D.el('div', { class: 'ue-ins-sub', text: text })); }
  function live() {                        // 끄는 동안: 저장 + 미리보기만 (타임라인 · 인스펙터는 놓을 때 다시 그린다)
    saveState();
    clearTimeout(liveTm);
    if (Date.now() - LIVE_T < 80) { liveTm = setTimeout(liveScene, 90); return; }
    liveScene();
  }
  function liveScene() {
    LIVE_T = Date.now();
    if (!R || !D.Feedback.ready()) return;
    SC = D.Feedback.sceneFor(plan());
    if (SC) D.Feedback.livePreview(now());
    syncBoxEd();
  }
  /* 슬라이더 + 숫자 한 줄: 끄는 동안 미리보기에 바로, 놓으면 되돌리기 한 번. 숫자 칸은 o.ro 면 보기만. 슬라이더 두 번 누르면 기본값 */
  function sliderRow(ins, label, o) {
    var row = D.el('div', { class: 'ue-field ue-sl' + (o.cls ? ' ' + o.cls : '') });
    row.appendChild(D.el('span', { text: label }));
    var fmt = o.fmt || function (v) { return String(Math.round(v * 100) / 100); };
    var rg = D.el('input', { type: 'range', min: String(o.min), max: String(o.max), step: String(o.step || 1), value: String(o.val) });
    var nb = D.el('input', { type: 'number', value: fmt(o.val), step: String(o.step || 1) });
    if (o.ro) { nb.readOnly = true; nb.tabIndex = -1; }
    var box = D.el('div', { class: 'ue-num' + (o.ro ? ' is-ro' : '') });
    box.appendChild(nb);
    if (o.unit) box.appendChild(D.el('small', { text: o.unit }));
    var on = false;
    var begin = function () { if (!on) { remember(); on = true; SLIDING = true; } };
    var done = function () { if (!on) return; on = false; SLIDING = false; changed(); };
    rg.addEventListener('input', function () { begin(); o.set(+rg.value); nb.value = fmt(+rg.value); live(); });
    rg.addEventListener('change', done);
    rg.addEventListener('pointerup', function () { setTimeout(done, 0); });
    rg.addEventListener('dblclick', function () { if (o.def == null) return; begin(); rg.value = String(o.def); o.set(o.def); done(); });
    nb.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); nb.blur(); } });
    if (!o.ro) nb.addEventListener('change', function () {
      var v = parseFloat(nb.value);
      if (isNaN(v)) return;
      remember(); o.set(Math.max(o.min, Math.min(o.max, v))); changed();
    });
    row.appendChild(rg); row.appendChild(box);
    ins.appendChild(row);
    return row;
  }
  function insTabs(ins, has) {              // 비디오 / 오디오 (둘 다 있을 때만 탭)
    if (!(has.v && has.a)) return has.v ? 'v' : 'a';
    var bar = D.el('div', { class: 'ue-itabs' });
    [['v', '비디오', 'video'], ['a', '오디오', 'audio']].forEach(function (kv) {
      var b = D.el('button', { class: 'ue-itab' + (INS_TAB === kv[0] ? ' is-on' : '') });
      b.appendChild(D.icon(kv[2])); b.appendChild(D.el('span', { text: kv[1] }));
      b.addEventListener('click', function () { INS_TAB = kv[0]; side(); });
      bar.appendChild(b);
    });
    ins.appendChild(bar);
    return INS_TAB;
  }
  function groupNote(ins, o) {
    var g = o.g && groupOf(o.g), M = mates(o);
    if (g || M.length > 1) ins.appendChild(D.el('div', { class: 'ue-ins-note ue-grp-note', text: (g ? '그룹 ' + g.name + ' · ' : '') + M.length + '개' }));
  }
  /* 색: 밝기 · 대비 · 채도 / RGBW (어두운 곳 · 중간 · 밝은 곳 마다 R · G · B · W) / 커브 (전체 · R · G · B). 계산은 shortsmith/lib/color.mjs -
     렌더는 조각마다 eq + 밝기 + curves (body.mjs colorVf, render.mjs 덧 클립), 미리보기는 CSS filter + SVG 표 (같은 33점) */
  function cleanColor(c) {
    ['brightness', 'contrast', 'saturation'].forEach(function (k) { if (c[k] != null && Math.abs(c[k] - 1) < 1e-3) delete c[k]; });
    ['lift', 'gamma', 'gain'].forEach(function (k) {
      var o = c[k]; if (!o) return;
      ['r', 'g', 'b', 'w'].forEach(function (q) { if (!o[q]) delete o[q]; });
      if (!Object.keys(o).length) delete c[k];
    });
    if (c.curves) {
      ['m', 'r', 'g', 'b'].forEach(function (q) {
        var p = c.curves[q];
        if (!p || p.every(function (xy) { return Math.abs(xy[0] - xy[1]) < 1e-3; })) delete c.curves[q];
      });
      if (!Object.keys(c.curves).length) delete c.curves;
    }
    return Object.keys(c).length ? c : null;
  }
  function setColor(list, fn) {
    list.forEach(function (t) {
      var c = JSON.parse(JSON.stringify(t.color || {}));
      fn(c);
      c = cleanColor(c);
      if (c) t.color = c; else delete t.color;
    });
  }
  function colorPanel(ins, o) {
    sub(ins, '색');
    var tabs = D.el('div', { class: 'ue-ctabs' });
    [['basic', '밝기 · 대비 · 채도'], ['rgbw', 'RGBW'], ['curve', '커브']].forEach(function (kv) {
      var b = D.el('button', { class: 'ue-ctab' + (COL_TAB === kv[0] ? ' is-on' : ''), text: kv[1] });
      b.addEventListener('click', function () { COL_TAB = kv[0]; side(); });
      tabs.appendChild(b);
    });
    ins.appendChild(tabs);
    var col = o.color || {};
    if (COL_TAB === 'basic') {
      [['밝기', 'brightness'], ['대비', 'contrast'], ['채도', 'saturation']].forEach(function (kv) {
        sliderRow(ins, kv[0], { val: Math.round((col[kv[1]] == null ? 1 : col[kv[1]]) * 100), min: 0, max: 200, unit: '%', def: 100,
          set: function (v) { setColor(mates(o), function (c) { c[kv[1]] = v / 100; }); } });
      });
    } else if (COL_TAB === 'rgbw') {
      [['lift', '리프트'], ['gamma', '감마'], ['gain', '게인']].forEach(function (gk) {
        ins.appendChild(D.el('div', { class: 'ue-ins-sub2', text: gk[1] }));
        [['r', 'R'], ['g', 'G'], ['b', 'B'], ['w', 'W']].forEach(function (ch) {
          sliderRow(ins, ch[1], { val: (col[gk[0]] || {})[ch[0]] || 0, min: -100, max: 100, def: 0, cls: 'ch-' + ch[0],
            set: function (v) { setColor(mates(o), function (c) { c[gk[0]] = Object.assign({}, c[gk[0]]); c[gk[0]][ch[0]] = v; }); } });
        });
      });
    } else curveEditor(ins, o);
    var bt = D.el('div', { class: 'ue-ins-btns' }), rs = D.el('button', { class: 'ue-btn', text: '초기화', title: '초기화' });
    rs.addEventListener('click', function () { remember(); mates(o).forEach(function (t) { delete t.color; }); changed(); });
    bt.appendChild(rs); ins.appendChild(bt);
  }
  function pchip(points) {                 // shortsmith/lib/color.mjs pchip 와 같다 (그래프 그리기용)
    var P = (points || []).map(function (p) { return [Math.max(0, Math.min(1, p[0])), Math.max(0, Math.min(1, p[1]))]; })
      .sort(function (a, b) { return a[0] - b[0]; });
    if (!P.length) return function (x) { return x; };
    if (P.length === 1) return function () { return P[0][1]; };
    var n = P.length, h = [], d = [], m = [], i;
    for (i = 0; i < n - 1; i++) { h[i] = Math.max(1e-6, P[i + 1][0] - P[i][0]); d[i] = (P[i + 1][1] - P[i][1]) / h[i]; }
    m[0] = d[0]; m[n - 1] = d[n - 2];
    for (i = 1; i < n - 1; i++) {
      if (d[i - 1] * d[i] <= 0) m[i] = 0;
      else { var w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1]; m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]); }
    }
    return function (x) {
      if (x <= P[0][0]) return P[0][1];
      if (x >= P[n - 1][0]) return P[n - 1][1];
      var k = 0;
      while (k < n - 2 && x > P[k + 1][0]) k++;
      var t = (x - P[k][0]) / h[k], t2 = t * t, t3 = t2 * t;
      return (2 * t3 - 3 * t2 + 1) * P[k][1] + (t3 - 2 * t2 + t) * h[k] * m[k] + (-2 * t3 + 3 * t2) * P[k + 1][1] + (t3 - t2) * h[k] * m[k + 1];
    };
  }
  /* 커브 그래프: 누르면 점 더하기 (그 자리로), 점 끌기, 점 두 번 누르기 = 빼기 (양 끝은 남는다, 위아래만) */
  function curveEditor(ins, o) {
    var chs = D.el('div', { class: 'ue-ctabs ue-cch' });
    [['m', '전체'], ['r', 'R'], ['g', 'G'], ['b', 'B']].forEach(function (kv) {
      var b = D.el('button', { class: 'ue-ctab ch-' + kv[0] + (CUR_CH === kv[0] ? ' is-on' : ''), text: kv[1] });
      b.addEventListener('click', function () { CUR_CH = kv[0]; side(); });
      chs.appendChild(b);
    });
    ins.appendChild(chs);
    var COL = { m: '#e8e8ec', r: '#ff6b6b', g: '#5cd65c', b: '#5aa0ff' };
    var get = function (ch) { var c = o.color && o.color.curves && o.color.curves[ch]; return c ? c.map(function (p) { return p.slice(); }) : [[0, 0], [1, 1]]; };
    var P = get(CUR_CH);
    var cv = D.el('canvas', { class: 'ue-curve' }), dpr = window.devicePixelRatio || 1, SZ = 220;
    cv.width = SZ * dpr; cv.height = SZ * dpr;
    ins.appendChild(cv);
    var paint = function () {
      var g = cv.getContext('2d'), W = cv.width, H = cv.height;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, W, H);
      g.fillStyle = '#18181c'; g.fillRect(0, 0, W, H);
      g.strokeStyle = 'rgba(255,255,255,.08)'; g.lineWidth = 1;
      for (var q = 1; q < 4; q++) { g.beginPath(); g.moveTo(W * q / 4, 0); g.lineTo(W * q / 4, H); g.moveTo(0, H * q / 4); g.lineTo(W, H * q / 4); g.stroke(); }
      g.setLineDash([4 * dpr, 4 * dpr]); g.beginPath(); g.moveTo(0, H); g.lineTo(W, 0); g.stroke(); g.setLineDash([]);
      ['m', 'r', 'g', 'b'].forEach(function (ch) {           // 다른 갈래는 흐리게
        if (ch === CUR_CH) return;
        var Q = get(ch);
        if (Q.length === 2 && !Q[0][1] && Q[1][1] === 1) return;
        var f = pchip(Q); g.strokeStyle = COL[ch]; g.globalAlpha = 0.3; g.lineWidth = 1.2 * dpr;
        g.beginPath(); for (var x = 0; x <= W; x += 2) { var y = H - f(x / W) * H; if (x) g.lineTo(x, y); else g.moveTo(x, y); } g.stroke();
        g.globalAlpha = 1;
      });
      var f0 = pchip(P);
      g.strokeStyle = COL[CUR_CH]; g.lineWidth = 2 * dpr;
      g.beginPath(); for (var x2 = 0; x2 <= W; x2 += 2) { var y2 = H - f0(x2 / W) * H; if (x2) g.lineTo(x2, y2); else g.moveTo(x2, y2); } g.stroke();
      P.forEach(function (p) { g.fillStyle = '#111'; g.strokeStyle = COL[CUR_CH]; g.lineWidth = 1.5 * dpr; g.beginPath(); g.arc(p[0] * W, H - p[1] * H, 4.5 * dpr, 0, 7); g.fill(); g.stroke(); });
    };
    paint();
    var at = function (ev) { var r = cv.getBoundingClientRect(); return [Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)), Math.max(0, Math.min(1, 1 - (ev.clientY - r.top) / r.height))]; };
    var near = function (p) { var best = -1, bd = 0.045; P.forEach(function (q, i) { var d = Math.hypot(q[0] - p[0], q[1] - p[1]); if (d < bd) { bd = d; best = i; } }); return best; };
    var put = function () {
      var Q = P.map(function (p) { return [+p[0].toFixed(3), +p[1].toFixed(3)]; });
      setColor(mates(o), function (c) { c.curves = Object.assign({}, c.curves); c.curves[CUR_CH] = Q; });
      live();
    };
    var di = -1;
    cv.addEventListener('pointerdown', function (ev) {
      var p = at(ev), i = near(p);
      remember(); SLIDING = true;
      if (i < 0) { P.push(p); P.sort(function (a, b) { return a[0] - b[0]; }); i = P.indexOf(p); }
      di = i;
      cv.setPointerCapture(ev.pointerId);
      paint(); put();
    });
    cv.addEventListener('pointermove', function (ev) {
      if (di < 0) return;
      var p = at(ev);
      if (di === 0 || di === P.length - 1) p[0] = P[di][0];          // 양 끝은 위아래만
      else p[0] = Math.max(P[di - 1][0] + 0.01, Math.min(P[di + 1][0] - 0.01, p[0]));
      P[di] = p;
      paint(); put();
    });
    var up = function () { if (di < 0) return; di = -1; SLIDING = false; changed(); };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('dblclick', function (ev) {
      var i = near(at(ev));
      if (i <= 0 || i >= P.length - 1) return;
      remember(); P.splice(i, 1); put(); changed();
    });
    var bt = D.el('div', { class: 'ue-ins-btns' }), rs = D.el('button', { class: 'ue-btn', text: '초기화' });
    rs.addEventListener('click', function () { remember(); setColor(mates(o), function (c) { if (c.curves) delete c.curves[CUR_CH]; }); changed(); });
    bt.appendChild(rs); ins.appendChild(bt);
  }
  /* 원본 클립 변형 (2026-10-03 사용자: "1차 편집 ... 화면을 1.5배 확대 하고 싶은데 1.6배 확대 시킨 경우 변경 불가 (실제로는 눈으로 보는 게 더 정확") -
     AI 가 잡은 화면 (크롭) 위에 얹는 이동 (창 px) · 확대 · 회전. 렌더는 body.mjs 가 크롭을 다시 잡고 (원본 화질) 회전,
     미리보기는 Window.tsx PlanRange 가 같은 계산. 뷰어에서도 상자를 끌어 바꾼다 */
  function tfOf(o) { return Object.assign({ x: 0, y: 0, z: 1, r: 0 }, o.tf); }
  function setTf(list, key, v) {
    list.forEach(function (t) {
      var f = tfOf(t); f[key] = v;
      if (!f.x && !f.y && Math.abs(f.z - 1) < 1e-4 && !f.r) delete t.tf; else t.tf = f;
    });
  }
  function transformRows(ins, o, setFn, W, H) {
    var f = tfOf(o);
    sliderRow(ins, 'X', { val: Math.round(f.x), min: -W, max: W, unit: 'px', ro: true, def: 0, set: function (v) { setFn('x', v); } });
    sliderRow(ins, 'Y', { val: Math.round(f.y), min: -H, max: H, unit: 'px', ro: true, def: 0, set: function (v) { setFn('y', v); } });
    sliderRow(ins, '확대', { val: Math.round(f.z * 100), min: 10, max: 400, unit: '%', def: 100, set: function (v) { setFn('z', v / 100); } });
    sliderRow(ins, '회전', { val: f.r, min: -180, max: 180, step: 0.5, unit: '°', def: 0, set: function (v) { setFn('r', v); } });
  }
  function transformMain(ins, c) {
    var W = (SC && SC.window) || { w: 1080, h: 1920 };
    sub(ins, '변형');
    transformRows(ins, c, function (k, v) { setTf(mates(c), k, v); }, W.w, W.h);
    var bt = D.el('div', { class: 'ue-ins-btns' }), rs = D.el('button', { class: 'ue-btn', text: '초기화' });
    rs.addEventListener('click', function () { remember(); mates(c).forEach(function (t) { delete t.tf; }); changed(); });
    bt.appendChild(rs); ins.appendChild(bt);
  }
  function volRows(ins, o, title) {
    sub(ins, title);
    sliderRow(ins, '크기', { val: o.vol || 0, min: -60, max: 20, step: 0.5, unit: 'dB', def: 0,
      set: function (v) { mates(o).forEach(function (t) { if (v) t.vol = v; else delete t.vol; }); } });
  }
  /* 전환 (2026-10-02 다섯째) - 앞 클립에서 이 클립으로 넘어갈 때. 컷 가운데에 걸리고 양쪽 클립 바깥 원본 (손잡이) 을 쓴다 - 길이 · 자막 시각 그대로 */
  var TRANS = [['', '없음'], ['dissolve', '디졸브'], ['black', '검은 화면'], ['white', '흰 화면'],
    ['wipe', '닦기 ←'], ['wipe_r', '닦기 →'], ['wipe_u', '닦기 ↑'], ['wipe_d', '닦기 ↓'],
    ['slide', '밀기 ←'], ['slide_r', '밀기 →'], ['slide_u', '밀기 ↑'], ['slide_d', '밀기 ↓'], ['circle', '원형']];
  /* ---------- 이펙트 탭 (2026-10-03 사용자: "소스 / 이펙트로 탭 분리 , 이펙트 카테고리 별로 정리해서 드래그 -> 클립에 적용 가능하게") ----------
     화면 효과 = 원본 클립 (V1) 의 창에 걸리는 scene fx (lib/render.mjs windowFx · src/parts/Window.tsx 그대로) - 클립 fx [{type, ...}] ->
     tools/apply_review.py 가 fx.json "fx" 에 user 표 + 숫자 시각 (클립 시작 ~ 끝) 으로 쓴다. 색 = 클립 color 를 통째로 바꾼다 (원본 · 덧 클립).
     전환 = 클립 tin (앞 클립에서). 소리 효과는 없다 - 소리에는 사용자가 말하기 전에 필터를 걸지 않는다 (docs/editing-rules.md) */
  var FXTYPE = 'application/x-kirinuki-fx', FXDRAG = null, PTAB = 'src', FXOPEN = {};
  var FXLIB = [
    { cat: '화면 효과', note: '', items: [
      { id: 'zoom', name: '확대', icon: 'fx-zoom', fx: { type: 'zoom', z: 1.2 } },
      { id: 'zoom2', name: '크게 확대', icon: 'fx-zoom', fx: { type: 'zoom', z: 1.45 } },
      { id: 'pushin', name: '다가가기', icon: 'fx-pushin', fx: { type: 'push', z0: 1, z1: 1.15 } },
      { id: 'pushin2', name: '빠르게 다가가기', icon: 'fx-pushin', fx: { type: 'push', z0: 1, z1: 1.35 } },
      { id: 'pushout', name: '물러나기', icon: 'fx-pushout', fx: { type: 'push', z0: 1.15, z1: 1 } },
      { id: 'shake', name: '흔들기', icon: 'fx-shake', fx: { type: 'shake', amp: 12 } },
      { id: 'shake2', name: '세게 흔들기', icon: 'fx-shake', fx: { type: 'shake', amp: 30 } },
      { id: 'blur', name: '흐리게', icon: 'fx-blur', fx: { type: 'blur', sigma: 8 } },
      { id: 'mono', name: '흑백', icon: 'fx-mono', fx: { type: 'mono' } },
      { id: 'flash', name: '번쩍', icon: 'fx-flash', fx: { type: 'flash', d: 0.3, k: 0.6 } },
      { id: 'vignette', name: '비네트', icon: 'fx-vig', fx: { type: 'vignette', angle: 0.6 } },
      { id: 'hflip', name: '좌우 반전', icon: 'fx-flip', fx: { type: 'hflip' } }] },
    { cat: '색', note: '', items: [
      { id: 'c-mono', name: '흑백', sw: 'linear-gradient(135deg,#eee,#555)', color: { saturation: 0 } },
      { id: 'c-mono2', name: '강한 흑백', sw: 'linear-gradient(135deg,#fff,#000)', color: { saturation: 0, contrast: 1.35 } },
      { id: 'c-warm', name: '따뜻하게', sw: 'linear-gradient(135deg,#ffd9a8,#c8743c)', color: { gain: { r: 8, b: -8 }, lift: { r: 2, b: -2 } } },
      { id: 'c-cool', name: '차갑게', sw: 'linear-gradient(135deg,#cfe6ff,#3d6fae)', color: { gain: { r: -6, b: 10 }, lift: { b: 2 } } },
      { id: 'c-vivid', name: '선명하게', sw: 'linear-gradient(135deg,#ff4f7b,#2fb4ff)', color: { contrast: 1.15, saturation: 1.35 } },
      { id: 'c-faded', name: '바랜 색', sw: 'linear-gradient(135deg,#e6dccb,#8f8a80)', color: { contrast: 0.85, saturation: 0.7, lift: { w: 10 } } },
      { id: 'c-teal', name: '청록 · 주황', sw: 'linear-gradient(135deg,#ffb36b,#1f6f78)', color: { contrast: 1.08, lift: { r: -3, b: 6 }, gain: { r: 6, b: -5 } } },
      { id: 'c-sepia', name: '세피아', sw: 'linear-gradient(135deg,#f1d9b0,#7a5a34)', color: { saturation: 0.35, gain: { r: 12, g: 4, b: -14 } } },
      { id: 'c-cine', name: '시네마', sw: 'linear-gradient(135deg,#d9c3a5,#22343f)', color: { contrast: 1.12, saturation: 0.85, lift: { b: 4 }, gain: { r: 4 } } },
      { id: 'c-sunset', name: '노을', sw: 'linear-gradient(135deg,#ffc27a,#c2456b)', color: { gain: { r: 14, g: 2, b: -12 }, saturation: 1.1 } },
      { id: 'c-night', name: '밤', sw: 'linear-gradient(135deg,#5b6ea8,#0d1226)', color: { gamma: { w: -20 }, gain: { r: -8, b: 12 }, saturation: 0.8 } },
      { id: 'c-pastel', name: '파스텔', sw: 'linear-gradient(135deg,#ffe0ef,#bfe3ff)', color: { contrast: 0.85, saturation: 0.8, lift: { w: 12 } } },
      { id: 'c-vintage', name: '빈티지', sw: 'linear-gradient(135deg,#e8d3a0,#6b5b3e)', color: { contrast: 0.9, saturation: 0.75, lift: { r: 6, b: -4 }, gain: { b: -6 } } },
      { id: 'c-bright', name: '밝게', sw: 'linear-gradient(135deg,#fff,#bbb)', color: { gamma: { w: 25 } } },
      { id: 'c-dark', name: '어둡게', sw: 'linear-gradient(135deg,#777,#111)', color: { gamma: { w: -25 } } }] },
    { cat: '전환', note: '', items: TRANS.filter(function (kv) { return kv[0]; }).map(function (kv) {
      var base = kv[0].split('_')[0], d = kv[0].split('_')[1];
      return { id: 't-' + kv[0], name: kv[1], icon: 'fx-t-' + base, rot: d === 'r' ? 180 : d === 'u' ? 90 : d === 'd' ? -90 : 0, tin: { type: kv[0], d: 0.5 } }; }) }];
  var FXNAME = { zoom: '확대', push: '밀기', shake: '흔들기', blur: '흐리게', mono: '흑백', flash: '번쩍', vignette: '비네트', hflip: '좌우 반전' };
  var FXPARAM = {                           // [칸, 이름, 최소, 최대, 걸음, 단위, 기본]
    zoom: [['z', '배율', 1.05, 2, 0.01, '배', 1.2]],
    push: [['z0', '시작 배율', 1, 1.6, 0.01, '배', 1], ['z1', '끝 배율', 1, 1.6, 0.01, '배', 1.15]],
    shake: [['amp', '세기', 2, 40, 1, 'px', 12]],
    blur: [['sigma', '세기', 1, 30, 1, '', 8]],
    flash: [['d', '길이', 0.1, 1, 0.05, '초', 0.3], ['k', '세기', 0.2, 1, 0.05, '', 0.6]],
    vignette: [['angle', '세기', 0.2, 1.2, 0.05, '', 0.6]] };
  function fxName(f) { return f.type === 'push' ? (f.z1 >= f.z0 ? '다가가기' : '물러나기') : FXNAME[f.type] || f.type; }
  function setPTab(t) {
    PTAB = t;
    D.$$('#view-edit [data-ptab]').forEach(function (b) { b.classList.toggle('is-on', b.dataset.ptab === t); });
    D.$('#ueBins').hidden = t !== 'src'; D.$('#ueAddFolder').hidden = t !== 'src'; D.$('#ueFxLib').hidden = t !== 'fx';
    if (t === 'fx') drawFxLib();
  }
  function drawFxLib() {
    var host = D.$('#ueFxLib');
    if (!host) return;
    host.textContent = '';
    FXLIB.forEach(function (g) {
      var open = FXOPEN[g.cat] !== false;
      var h = D.el('div', { class: 'ue-fxcat' + (open ? ' is-open' : '') });
      h.appendChild(D.icon('chev')); h.appendChild(D.el('b', { text: g.cat })); h.appendChild(D.el('small', { text: g.note }));
      h.addEventListener('click', function () { FXOPEN[g.cat] = !open; drawFxLib(); });
      host.appendChild(h);
      if (!open) return;
      var grid = D.el('div', { class: 'ue-fxgrid' });
      g.items.forEach(function (it) {
        var t = D.el('div', { class: 'ue-fxt', title: it.name });
        t.dataset.fx = it.id;
        var sw = D.el('div', { class: 'ue-fxt-sw' });
        if (it.sw) sw.style.background = it.sw;
        else { var ic = D.icon(it.icon); if (it.rot) ic.style.transform = 'rotate(' + it.rot + 'deg)'; sw.appendChild(ic); }
        t.appendChild(sw); t.appendChild(D.el('span', { text: it.name }));
        t.draggable = true;
        t.addEventListener('dragstart', function (ev) { FXDRAG = it; ev.dataTransfer.setData(FXTYPE, it.id); ev.dataTransfer.effectAllowed = 'copy'; });
        t.addEventListener('dragend', function () { FXDRAG = null; fxHL(null); });
        t.addEventListener('click', function () {
          var T = selected().concat(selX());
          if (!T.length) { D.toast('클립을 고르거나 클립 위에 끌어 놓으세요'); return; }
          applyFx(it, T);
        });
        grid.appendChild(t);
      });
      host.appendChild(grid);
    });
  }
  function fxTarget(ev) {
    var ce = (document.elementsFromPoint(ev.clientX, ev.clientY) || []).filter(function (e) { return e.matches && e.matches('#ueContent .ue-clip'); })[0];   // 전환 표 · 그룹 테 아래 클립도
    if (!ce) return null;
    var o = ce.dataset.xid ? exById(ce.dataset.xid) : byId(+ce.dataset.id);
    return o ? { o: o, el: ce } : null;
  }
  function fxWhy(it, o) {                   // 못 거는 까닭 (걸 수 있으면 null)
    var main = CL.indexOf(o) >= 0;
    if (it.fx) return main ? null : '화면 효과는 원본 클립 (V1) 에만 걸립니다';
    if (!main && o.kind === 'audio') return '소리 클립에는 색 · 전환이 없습니다';
    if (it.tin && main && sorted().indexOf(o) <= 0) return '첫 클립에는 앞 클립이 없습니다';
    return null;
  }
  function fxHL(el) {
    D.$$('#ueContent .is-fxdrop').forEach(function (e) { if (e !== el) e.classList.remove('is-fxdrop'); });
    if (el) el.classList.add('is-fxdrop');
  }
  function applyFx(it, list, drop) {        // drop: 끌어 놓은 클립 - 골라 둔 클립 위에 놓았을 때만 고른 것 전부에 (그룹은 늘 같이)
    var T = [];
    list.forEach(function (o) {
      var M = drop && !SEL[o.id] ? CL.concat(EX).filter(function (y) { return y === o || (o.g && y.g === o.g && fam(y) === fam(o)); }) : mates(o);
      M.forEach(function (m) { if (T.indexOf(m) < 0) T.push(m); });
    });
    var why = null, ok = T.filter(function (o) { var w = fxWhy(it, o); if (w) why = w; return !w; });
    if (!ok.length) { D.toast(why || '걸 수 있는 클립이 없습니다'); return; }
    remember();
    ok.forEach(function (o) {
      if (it.fx) o.fx = (o.fx || []).filter(function (f) { return f.type !== it.fx.type; }).concat([JSON.parse(JSON.stringify(it.fx))]);
      if (it.color) o.color = JSON.parse(JSON.stringify(it.color));
      if (it.tin) o.tin = { type: it.tin.type, d: (o.tin && o.tin.d) || it.tin.d };
    });
    CSEL = null; SEL = {}; SEL[ok[0].id] = true;
    if (it.tin && CL.indexOf(ok[0]) < 0 && !prevOnTrack(ok[0])) D.toast('"' + it.name + '" 를 걸었지만 같은 트랙에 맞닿은 앞 클립이 없어 아직 안 먹습니다');
    else D.toast('"' + it.name + '" 적용' + (ok.length > 1 ? ' (' + ok.length + '개 클립)' : ''));
    showPane('ins');
    changed();
  }
  function fxRows(ins, c) {
    sub(ins, '효과');
    if (!c.fx || !c.fx.length) { ins.appendChild(D.el('div', { class: 'ue-ins-empty', text: '없음' })); return; }
    c.fx.forEach(function (f) {
      var head = D.el('div', { class: 'ue-fxrow' });
      head.appendChild(D.icon('fx')); head.appendChild(D.el('b', { text: fxName(f) }));
      var del = D.el('button', { class: 'ue-btn ue-btn-sm', title: '빼기' });
      del.appendChild(D.icon('x'));
      del.addEventListener('click', function () {
        remember();
        mates(c).forEach(function (t) { if (!t.fx) return; t.fx = t.fx.filter(function (g) { return g.type !== f.type; }); if (!t.fx.length) delete t.fx; });
        changed();
      });
      head.appendChild(del);
      ins.appendChild(head);
      (FXPARAM[f.type] || []).forEach(function (p) {
        sliderRow(ins, p[1], { val: f[p[0]] != null ? f[p[0]] : p[6], min: p[2], max: p[3], step: p[4], unit: p[5], def: p[6],
          set: function (v) { mates(c).forEach(function (t) { if (t.fx) t.fx = t.fx.map(function (g) { if (g.type !== f.type) return g; var n = Object.assign({}, g); n[p[0]] = v; return n; }); }); } });
      });
    });
  }
  function clipTransRows(ins, c) {
    var S = sorted(), i = S.indexOf(c);
    ins.appendChild(D.el('div', { class: 'ue-ins-sub', text: '전환' }));
    if (i <= 0) { ins.appendChild(D.el('div', { class: 'ue-ins-empty', text: '없음' })); return; }
    var row = D.el('label', { class: 'ue-field' });
    row.appendChild(D.el('span', { text: '종류' }));
    var sel = D.el('select');
    TRANS.forEach(function (kv) { sel.appendChild(D.el('option', { value: kv[0], text: kv[1] })); });
    sel.value = (c.tin && c.tin.type) || '';
    sel.addEventListener('change', function () {
      remember();
      if (!sel.value) delete c.tin; else c.tin = { type: sel.value, d: (c.tin && c.tin.d) || 0.5 };
      changed();
    });
    row.appendChild(sel); ins.appendChild(row);
    if (c.tin) numRow(ins, '길이', c.tin.d, '초', function (v) { c.tin = { type: c.tin.type, d: Math.max(0.1, Math.min(3, v)) }; }, 0.1);
  }
  /* 덧 클립 사이 전환 (2026-10-03) - 같은 트랙에서 끝이 이 클립 시작에 맞닿은 앞 클립에서 디졸브. 컷 가운데에 걸리고 두 파일의 클립 밖 부분을 쓴다
     (렌더 lib/render.mjs withTrans · 미리보기 Layers.tsx 같은 계산). 떨어뜨리면 표는 남아도 안 먹는다 */
  function prevOnTrack(x) {
    return EX.filter(function (y) { return y !== x && areaOf(y) === areaOf(x) && y.track === x.track && Math.abs(y.at + xlen(y) - x.at) < 0.02; })[0] || null;
  }
  function layerTransRows(ins, x) {
    var A = prevOnTrack(x);
    ins.appendChild(D.el('div', { class: 'ue-ins-sub', text: '전환' }));
    if (!A) return;
    var row = D.el('label', { class: 'ue-field' });
    row.appendChild(D.el('span', { text: '종류' }));
    var sel = D.el('select');
    TRANS.forEach(function (kv) { sel.appendChild(D.el('option', { value: kv[0], text: kv[1] })); });   // 원본 클립 전환과 같은 종류
    sel.value = (x.tin && x.tin.type) || '';
    sel.addEventListener('change', function () {
      remember();
      if (!sel.value) delete x.tin; else x.tin = { type: sel.value, d: (x.tin && x.tin.d) || 0.5 };
      changed();
    });
    row.appendChild(sel); ins.appendChild(row);
    if (!x.tin) return;
    numRow(ins, '길이', x.tin.d, '초', function (v) { x.tin = { type: x.tin.type, d: Math.max(0.1, Math.min(3, v)) }; }, 0.1);
    var dip = x.tin.type === 'black' || x.tin.type === 'white';     // 검은 · 흰 화면 거쳐는 컷 너머를 안 쓴다
    var hA = dip || A.kind === 'image' ? Infinity : A.dur ? A.dur - A.e : 0, hB = dip || x.kind === 'image' ? Infinity : x.s;
    var h = Math.min(x.tin.d / 2, hA, hB, xlen(A) / 2, xlen(x) / 2);
    if (h < x.tin.d / 2 - 1e-3) ins.appendChild(D.el('div', { class: 'ue-ins-note',
      text: h >= 0.01 ? (2 * h).toFixed(2) + '초' : '안 걸림' }));
  }
  /* 움직임 칸: 재생 위치에 키 추가 · 지우기, 앞 · 뒤 키로 가기, 부드럽게, 움직임 지우기 */
  function motionRows(ins, x) {
    var K = x.keys || [], tl = localT(x), here = keyAt(x, tl), t = now();
    var inside = t >= x.at - 1e-3 && t <= x.at + xlen(x) + 1e-3;
    ins.appendChild(D.el('div', { class: 'ue-ins-sub', text: '키프레임' }));
    var bt = D.el('div', { class: 'ue-ins-btns' });
    var mk = function (label, title, fn, on, off) {
      var b = D.el('button', { class: 'ue-btn' + (on ? ' is-on' : ''), text: label, title: title });
      if (off) b.disabled = true;
      b.addEventListener('click', fn);
      bt.appendChild(b);
    };
    var prev = K.filter(function (k) { return k.t < tl - 0.5 / FPS; }).pop(), next = K.filter(function (k) { return k.t > tl + 0.5 / FPS; })[0];
    mk('◀', '앞 키로', function () { if (prev) seek(x.at + prev.t); }, false, !prev);
    mk(here ? '◆ 키 지우기' : '◇ 키 추가', here ? '키 지우기' : '키 추가', function () {
      remember();
      if (here) {
        var last = kbox(here);
        x.keys = K.filter(function (k) { return k !== here; });
        if (!x.keys.length) { delete x.keys; delete x.ease; x.box = last; } else x.box = kbox(x.keys[0]);
      } else {
        var b = rbox(curBox(x));
        x.keys = K.concat([Object.assign({ t: +tl.toFixed(4) }, b)]).sort(function (p, q) { return p.t - q.t; });
        x.box = kbox(x.keys[0]);
      }
      changed();
    }, !!here, !inside);
    mk('▶', '뒤 키로', function () { if (next) seek(x.at + next.t); }, false, !next);
    ins.appendChild(bt);
    if (K.length) {
      var bt2 = D.el('div', { class: 'ue-ins-btns' });
      var ez = D.el('button', { class: 'ue-btn' + (x.ease ? ' is-on' : ''), text: '부드럽게', title: '부드럽게' });
      ez.addEventListener('click', function () { remember(); if (x.ease) delete x.ease; else x.ease = true; changed(); });
      var cl = D.el('button', { class: 'ue-btn', text: '움직임 지우기', title: '움직임 지우기' });
      cl.addEventListener('click', function () { remember(); x.box = rbox(curBox(x)); delete x.keys; delete x.ease; changed(); });
      bt2.appendChild(ez); bt2.appendChild(cl); ins.appendChild(bt2);
    }
  }

  /* ---------- 뷰어에서 덧 클립 끌기 (2026-10-03) ----------
     고른 영상 · 그림 하나가 재생 위치에 있으면 뷰어 위에 상자를 그린다: 가운데 = 옮기기, 모서리 = 비율 그대로 크기 (맞은편 모서리 고정, Alt = 가운데 고정).
     붙기 (N) 가 켜져 있으면 화면 가운데 · 창 가장자리 · 창 가운데에 붙는다. 키가 있으면 재생 위치에 키를 만들거나 고친다 (setBox).
     상자는 피드백 화면 (#fbStage) 안에 두지만 이 탭이 보일 때만 그린다 */
  var BED = null;
  function objById(id) { return typeof id === 'string' && id.charAt(0) === 'x' ? exById(id) : byId(+id); }
  function boxTarget() {                   // 고른 덧 그림 하나, 또는 원본 클립 하나 (변형) - 재생 위치가 그 안일 때
    if (!SHOWN || !SC) return null;
    var SX = selX().filter(function (x) { return x.kind !== 'audio'; }), S = selected(), t = now();
    if (SX.length === 1 && !S.length) { var x = SX[0]; return t >= x.at - 1e-3 && t < x.at + xlen(x) ? x : null; }
    if (S.length === 1 && !SX.length) { var c = S[0]; return t >= c.at - 1e-3 && t < end(c) ? c : null; }
    return null;
  }
  function tBox(o) {                       // 화면 위 상자 (캔버스 px): 덧 클립은 상자, 원본 클립은 창에 변형을 얹은 것
    if (o.kind) return curBox(o);
    var W = SC.window, f = tfOf(o);
    return { x: W.x + W.w / 2 + f.x - W.w * f.z / 2, y: W.y + W.h / 2 + f.y - W.h * f.z / 2, w: W.w * f.z, h: W.h * f.z };
  }
  function putBox(o, b) {
    if (o.kind) { setBox(o, b); return; }
    var W = SC.window;
    setTf([o], 'z', +(b.w / W.w).toFixed(4));
    setTf([o], 'x', Math.round(b.x + b.w / 2 - (W.x + W.w / 2)));
    setTf([o], 'y', Math.round(b.y + b.h / 2 - (W.y + W.h / 2)));
  }
  function stageG() {                      // 플레이어는 칸 안에 비율 그대로 가운데 (남는 반 픽셀 띠까지 맞춘다)
    var st = D.$('#fbStage');
    if (!st || !SC) return null;
    var W = SC.width || 1080, H = SC.height || 1920, k = Math.min(st.clientWidth / W, st.clientHeight / H);
    return k > 0 ? { k: k, ox: (st.clientWidth - W * k) / 2, oy: (st.clientHeight - H * k) / 2 } : null;
  }
  function syncBoxEd() {
    var st = D.$('#fbStage');
    if (!st) return;
    var ed = D.$('#ueBoxEd');
    if (!ed) {
      ed = D.el('div', { class: 'ue-boxed', id: 'ueBoxEd' });
      ['tl', 'tr', 'bl', 'br'].forEach(function (h) { var i = D.el('i', { class: 'ue-bh ue-bh-' + h }); i.dataset.h = h; ed.appendChild(i); });
      ed.addEventListener('pointerdown', bedDown);
      ed.addEventListener('pointermove', bedMove);
      ed.addEventListener('pointerup', bedUp);
      ed.addEventListener('pointercancel', bedUp);
      ed.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
      ed.addEventListener('click', function (ev) { ev.stopPropagation(); });
    }
    if (ed.parentNode !== st) st.appendChild(ed);
    var x = BED ? objById(BED.id) : boxTarget(), g = stageG();
    if (!x || !g) { ed.hidden = true; return; }
    var k = g.k;
    var b = tBox(x);
    ed.hidden = false;
    ed.classList.toggle('has-keys', !!(x.keys && x.keys.length));
    ed.style.left = (g.ox + b.x * k) + 'px'; ed.style.top = (g.oy + b.y * k) + 'px';
    ed.style.width = (b.w * k) + 'px'; ed.style.height = (b.h * k) + 'px';
  }
  function snapBox(b, k) {
    if (!SNAP) return b;
    var W = SC.width || 1080, H = SC.height || 1920, w = SC.window || { x: 0, y: 0, w: W, h: H }, d = SNAPPX / k;
    var xs = [0, W / 2, W, w.x, w.x + w.w / 2, w.x + w.w], ys = [0, H / 2, H, w.y, w.y + w.h / 2, w.y + w.h];
    var pick = function (lo, len, cand) {        // 앞 끝 · 가운데 · 뒤 끝 중 가장 가까운 선에
      var best = null;
      cand.forEach(function (c) { [0, len / 2, len].forEach(function (o) { var dd = Math.abs(lo + o - c); if (dd < d && (!best || dd < best.d)) best = { d: dd, v: c - o }; }); });
      return best ? best.v : lo;
    };
    return { x: pick(b.x, b.w, xs), y: pick(b.y, b.h, ys), w: b.w, h: b.h };
  }
  function bedDown(ev) {
    var x = boxTarget();
    if (!x || ev.button !== 0) return;
    ev.stopPropagation(); ev.preventDefault();
    var v = video(); if (v && !v.paused) v.pause();
    BED = { id: x.id, h: ev.target.dataset.h || 'move', x0: ev.clientX, y0: ev.clientY, b0: tBox(x), base: snapshot(), k: stageG().k, last: 0 };
    ev.currentTarget.setPointerCapture(ev.pointerId);
  }
  function bedMove(ev) {
    if (!BED) return;
    var k = BED.k, dx = (ev.clientX - BED.x0) / k, dy = (ev.clientY - BED.y0) / k, b0 = BED.b0, b;
    if (!BED.moved && Math.abs(dx) * k < 2 && Math.abs(dy) * k < 2) return;
    if (BED.h === 'move') b = snapBox({ x: b0.x + dx, y: b0.y + dy, w: b0.w, h: b0.h }, k);
    else {
      var sx = BED.h.charAt(1) === 'l' ? -1 : 1, sy = BED.h.charAt(0) === 't' ? -1 : 1, c = ev.altKey ? 2 : 1;
      var s = Math.max(8 / Math.min(b0.w, b0.h), ((b0.w + c * sx * dx) / b0.w + (b0.h + c * sy * dy) / b0.h) / 2);
      var w = b0.w * s, h = b0.h * s;
      if (ev.altKey) b = { x: b0.x + (b0.w - w) / 2, y: b0.y + (b0.h - h) / 2, w: w, h: h };
      else b = { x: sx > 0 ? b0.x : b0.x + b0.w - w, y: sy > 0 ? b0.y : b0.y + b0.h - h, w: w, h: h };
    }
    var base = JSON.parse(BED.base);
    EX = base.x || []; CL = base.c;
    var x = objById(BED.id);
    if (!x) return;
    putBox(x, b);
    BED.moved = true;
    syncBoxEd();
    if (Date.now() - BED.last > 90) {        // 그림도 끌면서 보이게 (너무 자주는 말고)
      BED.last = Date.now();
      saveState();
      SC = D.Feedback.sceneFor(plan());
      if (SC) D.Feedback.livePreview(now());
    }
  }
  function bedUp() {
    if (!BED) return;
    var d = BED; BED = null;
    if (!d.moved) { syncBoxEd(); return; }
    var afterX = JSON.stringify(EX), afterC = JSON.stringify(CL), base = JSON.parse(d.base);
    EX = base.x || []; CL = base.c; remember(); EX = JSON.parse(afterX); CL = JSON.parse(afterC);
    INS_T = null;
    changed();
  }
  function exInspector(ins, x) {
    var p = partner(x), aud = x.kind === 'audio' ? x : p, pic = x.kind === 'audio' ? null : x;
    var both = function (fn) { fn(x); if (p && LINK) fn(p); };
    var kname = { video: '영상', image: '그림', audio: '소리' }[x.kind];
    ins.appendChild(D.el('div', { class: 'ue-ins-h', text: kname + ' · ' + (areaOf(x) === 'v' ? 'V' : 'A') + x.track + (p ? ' (묶음)' : '') }));
    groupNote(ins, x);
    var ro = function (label, v) { var r = D.el('label', { class: 'ue-field' }); r.appendChild(D.el('span', { text: label }));
      var i = D.el('input', { type: 'text', value: v }); i.readOnly = true; r.appendChild(i); ins.appendChild(r); };
    ro('파일', x.name);
    numRow(ins, '시작', +x.at.toFixed(2), '초', function (v) { var d = Math.max(0, v) - x.at; both(function (y) { y.at = fr(y.at + d); settle(y); }); }, 0.1);
    numRow(ins, '길이', +xlen(x).toFixed(2), '초', function (v) {
      both(function (y) { y.e = Math.max(y.s + MIN / FPS, Math.min(y.s + v, y.dur || Infinity)); settle(y); });
    }, 0.1);
    if (x.kind !== 'image') ro('파일 시작', stc(x.s));
    var tab = insTabs(ins, { v: !!pic, a: !!aud });
    if (tab === 'v' && pic) {
      sub(ins, '변형');
      var b = curBox(pic), fb = fitBox(pic.w0, pic.h0), Wc = (SC && SC.width) || 1080, Hc = (SC && SC.height) || 1920;
      sliderRow(ins, 'X', { val: Math.round(b.x + b.w / 2), min: -Wc / 2, max: Wc * 1.5, unit: 'px', ro: true,
        set: function (v) { var q = curBox(pic); setBox(pic, { x: v - q.w / 2, y: q.y, w: q.w, h: q.h }); } });
      sliderRow(ins, 'Y', { val: Math.round(b.y + b.h / 2), min: -Hc / 2, max: Hc * 1.5, unit: 'px', ro: true,
        set: function (v) { var q = curBox(pic); setBox(pic, { x: q.x, y: v - q.h / 2, w: q.w, h: q.h }); } });
      sliderRow(ins, '크기', { val: Math.round(b.w / Math.max(1, fb.w) * 100), min: 5, max: 400, unit: '%', def: 100,
        set: function (v) { var q = curBox(pic), cx0 = q.x + q.w / 2, cy0 = q.y + q.h / 2, w = Math.max(8, fb.w * v / 100), h = Math.max(8, fb.h * v / 100);
          setBox(pic, { x: cx0 - w / 2, y: cy0 - h / 2, w: w, h: h }); } });
      sliderRow(ins, '회전', { val: pic.rot || 0, min: -180, max: 180, step: 0.5, unit: '°', def: 0,
        set: function (v) { mates(pic).forEach(function (t) { if (v) t.rot = v; else delete t.rot; }); } });
      sliderRow(ins, '불투명도', { val: Math.round((pic.opacity == null ? 1 : pic.opacity) * 100), min: 0, max: 100, unit: '%', def: 100,
        set: function (v) { mates(pic).forEach(function (t) { t.opacity = v / 100; }); } });
      var bt = D.el('div', { class: 'ue-ins-btns' });
      [['창에 맞춤', 'window'], ['화면 꽉 채움', 'cover']].forEach(function (kv) {
        var btn = D.el('button', { class: 'ue-btn', text: kv[0] });
        btn.addEventListener('click', function () { remember(); setBox(pic, fitBox(pic.w0, pic.h0, kv[1])); changed(); });
        bt.appendChild(btn);
      });
      ins.appendChild(bt);
      motionRows(ins, pic);
      colorPanel(ins, pic);
      layerTransRows(ins, pic);
      sub(ins, '페이드');
      numRow(ins, '들어올 때', pic.fin || 0, '초', function (v) { mates(pic).forEach(function (y) { y.fin = Math.max(0, Math.min(v, xlen(y) / 2)); }); }, 0.1);
      numRow(ins, '나갈 때', pic.fout || 0, '초', function (v) { mates(pic).forEach(function (y) { y.fout = Math.max(0, Math.min(v, xlen(y) / 2)); }); }, 0.1);
    }
    if (tab === 'a' && aud) {
      volRows(ins, aud, '소리');
      var mu = D.el('button', { class: 'ue-btn' + (aud.mute ? ' is-on' : ''), text: aud.mute ? '음소거 풀기' : '음소거' });
      mu.addEventListener('click', function () { remember(); var m = !aud.mute; mates(aud).forEach(function (t) { t.mute = m; }); changed(); });
      var bt2 = D.el('div', { class: 'ue-ins-btns' }); bt2.appendChild(mu); ins.appendChild(bt2);
      sub(ins, '페이드');
      numRow(ins, '들어올 때', aud.fin || 0, '초', function (v) { mates(aud).forEach(function (y) { y.fin = Math.max(0, Math.min(v, xlen(y) / 2)); }); }, 0.1);
      numRow(ins, '나갈 때', aud.fout || 0, '초', function (v) { mates(aud).forEach(function (y) { y.fout = Math.max(0, Math.min(v, xlen(y) / 2)); }); }, 0.1);
    }
    var bt3 = D.el('div', { class: 'ue-ins-btns' });
    if (p) {
      var ul = D.el('button', { class: 'ue-btn', text: '묶음 풀기' });
      ul.addEventListener('click', function () { remember(); x.link = null; p.link = null; changed(); });
      bt3.appendChild(ul);
    }
    var del = D.el('button', { class: 'ue-btn ue-cap-cut', text: '지우기' });
    del.addEventListener('click', removeSel);
    bt3.appendChild(del);
    ins.appendChild(bt3);
  }
  /* ---------- 소스 (2026-10-02 둘째: "미디어 · 클립 부분 -> 소스 폴더 추가로 변경") ----------
     왼쪽 칸 = 리졸브의 미디어 풀처럼 폴더째 넣는 소스 목록. 첫 묶음은 이 편 원본 (사본), 그 아래 사용자가 넣은 폴더들.
     폴더 경로는 review.srcFolders 로 저장되고 (server.py 저장 칸), 편집 (AI) 단추가 넘기는 글에도 들어간다.
     브라우저는 고른 폴더의 진짜 경로를 안 주므로 서버가 폴더를 읽어 고르는 창을 띄운다 (/api/media/browse · list). */
  var BINS = {}, OPEN = {}, FSEL = null;
  function folders() { return (R && R.srcFolders) || []; }
  function drawBins() {
    var host = D.$('#ueBins');
    if (!host) return;
    host.textContent = '';
    if (!R) { host.appendChild(D.el('div', { class: 'ue-ins-empty', text: '' })); return; }
    var own = R.srcPreview && R.srcPreview.path;
    var groups = [];
    if (own) groups.push({ key: '', name: '이 편 원본', files: [{ name: String(own).split(/[\\/]/).pop(), path: own, kind: 'video' }], fixed: true });
    if (srcFiles().length) groups.push({ key: '@files', name: '가져온 파일', files: srcFiles(), clear: true });
    folders().forEach(function (f) {
      groups.push({ key: f, name: f.split(/[\\/]/).filter(Boolean).pop() || f, files: BINS[f], title: f });
    });
    groups.forEach(function (g) {
      var open = OPEN[g.key] !== false;
      var hd = D.el('div', { class: 'ue-bin' + (open ? ' is-open' : ''), title: g.title || '' });
      hd.appendChild(D.icon('folder'));
      hd.appendChild(D.el('span', { class: 'ue-bin-n', text: g.name }));
      hd.appendChild(D.el('span', { class: 'ue-bin-c', text: g.files ? g.files.length + '' : '...' }));
      if (!g.fixed) {
        var rm = D.el('button', { class: 'ue-bin-x', title: '빼기' });
        rm.appendChild(D.icon('x'));
        rm.addEventListener('click', function (ev) {
          ev.stopPropagation();
          if (g.clear) R.srcFiles = []; else R.srcFolders = folders().filter(function (x) { return x !== g.key; });
          D.touch(); drawBins();
        });
        hd.appendChild(rm);
      }
      hd.addEventListener('click', function () { OPEN[g.key] = !open; drawBins(); });
      host.appendChild(hd);
      if (!open) return;
      if (!g.files) { loadBin(g.key); return; }
      if (!g.files.length) host.appendChild(D.el('div', { class: 'ue-ins-empty ue-bin-empty', text: '비어 있음' }));
      g.files.forEach(function (f) {
        var row = D.el('div', { class: 'ue-media' + (FSEL === f.path ? ' is-sel' : ''), title: f.path });
        var th = D.el('div', { class: 'ue-media-th is-' + f.kind });
        if (f.kind !== 'audio') {
          var im = D.el('img', { loading: 'lazy', alt: '', src: '/api/media/poster?path=' + encodeURIComponent(f.path) });
          im.addEventListener('error', function () { im.remove(); th.appendChild(D.icon('video')); });
          th.appendChild(im);
        } else th.appendChild(D.icon('vol'));
        row.appendChild(th);
        var tx = D.el('div', { class: 'ue-media-t' });
        tx.appendChild(D.el('b', { text: f.name }));
        tx.appendChild(D.el('small', { text: (f.kind === 'video' ? '영상' : f.kind === 'audio' ? '소리' : '그림') + (f.size ? ' · ' + D.fmtBytes(f.size) : '') }));
        row.appendChild(tx);
        row.addEventListener('click', function () { FSEL = f.path; drawBins(); });
        row.draggable = true;                  // 타임라인으로 끌어 놓기 (2026-10-02 넷째)
        row.addEventListener('dragstart', function (ev) {
          ev.dataTransfer.setData(DRAGTYPE, JSON.stringify({ path: f.path, name: f.name, kind: f.kind }));
          ev.dataTransfer.effectAllowed = 'copy';
        });
        host.appendChild(row);
      });
    });
  }
  function loadBin(dir) {
    if (BINS[dir] === null) return;
    BINS[dir] = null;
    fetch('/api/media/list?path=' + encodeURIComponent(dir)).then(function (r) { return r.json(); }).then(function (j) {
      BINS[dir] = j.ok ? j.files : [];
      if (!j.ok) D.warn('소스 폴더를 못 읽었습니다: ' + (j.error || dir), 'useredit');
      drawBins();
    }).catch(function () { BINS[dir] = []; drawBins(); });
  }
  function addFolder() {                   // 서버가 읽은 폴더를 오가며 고른다
    if (!R) { D.toast('프로젝트를 먼저 여세요'); return; }
    var body = D.el('div', { class: 'ue-browse' });
    var where = D.el('div', { class: 'ue-browse-path' });
    var list = D.el('div', { class: 'ue-browse-list' });
    body.appendChild(where); body.appendChild(list);
    var cur = '';
    var go = function (p) {
      fetch('/api/media/browse?path=' + encodeURIComponent(p || '')).then(function (r) { return r.json(); }).then(function (j) {
        if (!j.ok) { D.toast(j.error || '폴더를 못 읽었습니다'); return; }
        cur = j.path; where.textContent = j.path || '내 PC';
        list.textContent = '';
        if (j.parent != null) list.appendChild(row('..', 'folder', function () { go(j.parent); }));
        j.dirs.forEach(function (d) { list.appendChild(row(d.name, 'folder', function () { go(d.path); })); });
        j.files.forEach(function (f) {
          var r = row(f.name, f.kind === 'audio' ? 'vol' : 'video', null);
          r.classList.add('is-file');
          r.appendChild(D.el('small', { text: D.fmtBytes(f.size) }));
          list.appendChild(r);
        });
      });
    };
    var row = function (name, ic, fn) {
      var r = D.el('div', { class: 'ue-browse-row' });
      r.appendChild(D.icon(ic));
      r.appendChild(D.el('span', { text: name }));
      if (fn) r.addEventListener('click', fn);
      return r;
    };
    var start = folders()[folders().length - 1];
    if (!start && R.srcPreview && R.srcPreview.path) start = String(R.srcPreview.path).replace(/[\\/][^\\/]*$/, '');
    go(start || '');
    D.modal.open({
      title: '소스 폴더 추가', body: body,
      buttons: [{ label: '취소' }, {
        label: '이 폴더 추가', class: 'btn-primary', onClick: function () {
          if (!cur) { D.toast('폴더를 고르세요'); return false; }
          if (folders().indexOf(cur) === -1) { R.srcFolders = folders().concat([cur]); D.touch(); }
          OPEN[cur] = true; delete BINS[cur]; drawBins();
          D.info('소스 폴더 추가: ' + cur, 'useredit');
        }
      }]
    });
  }
  function waveData() { return R && R.wave && R.wave.b64 ? R.wave : null; }
  function waveBytes(w) {                  // 파형 바이트와 눈금 (바닥 잡음 10% 가 0, 99.5% 가 꼭대기) - 파형 객체에 붙여 둔다
    if (!w || !w.b64) return null;
    if (!w._b) {
      var bin = atob(w.b64), a = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
      var srt = Array.prototype.slice.call(a).sort(function (x, y) { return x - y; });
      w._lo = srt[Math.floor(srt.length * 0.10)] || 0; w._hi = Math.max(w._lo + 1, srt[Math.floor(srt.length * 0.995)] || 255);
      Object.defineProperty(w, '_b', { value: a, enumerable: false });       // 저장 (JSON) 에는 안 실린다
    }
    return w._b;
  }
  var WAVEC = {}, WAVEN = 0;               // 그린 파형 캔버스 - draw() 가 칸을 비우면 떨어지므로 같은 것을 다시 붙인다
  function wave(el, w, s, L, H) {          // 파일 시각 [s, s + L] 의 파형을 클립 폭에 (칸 높이를 다 쓴다)
    var B = waveBytes(w);
    if (!B) return;
    var hz = w.hz || 50, dpr = window.devicePixelRatio || 1, LO = w._lo, HI = w._hi;
    var CW = Math.max(2, Math.round(X(L))), Wd = Math.min(4000, CW);
    H = Math.max(20, H || 40);
    var ck = [B.length, LO, HI, s.toFixed(4), L.toFixed(4), CW, H, dpr].join('|'), hit = WAVEC[ck];
    if (hit && !hit.isConnected) { el.appendChild(hit); return; }
    if (WAVEN > 400) { WAVEC = {}; WAVEN = 0; }
    var cv = document.createElement('canvas');
    WAVEC[ck] = cv; WAVEN++;
    cv.className = 'ue-wave';
    cv.width = Math.round(Wd * dpr); cv.height = Math.round(H * dpr);
    cv.style.width = CW + 'px'; cv.style.height = H + 'px';   // 4000px 넘는 클립은 늘여 그린다
    var g = cv.getContext('2d');
    g.scale(dpr, dpr);
    g.fillStyle = 'rgba(190,240,205,.75)';
    for (var x = 0; x < Wd; x++) {
      var s0 = s + L * x / Wd, s1 = s + L * (x + 1) / Wd, best = -1;
      for (var j = Math.floor(s0 * hz); j < Math.max(Math.floor(s0 * hz) + 1, Math.ceil(s1 * hz)) && j < B.length; j++) if (B[j] > best) best = B[j];
      if (best < 0) continue;
      var v = Math.max(0, Math.min(1, (best - LO) / (HI - LO))), hh = (H / 2 - 2) * v;
      if (hh >= 0.5) g.fillRect(x, H / 2 - hh, 1, hh * 2);
    }
    el.appendChild(cv);
  }
  function drawCaps() {                    // 자막 클립 - 비디오 트랙 안
    CAPR.forEach(function (r) {
      var c = r.c, ln = laneEl('v', r.track);
      if (!ln) return;
      var s = drag && drag.kind === 'cap' && drag.moved && drag.cid === c.id && drag.at != null ? drag.at : c.s;
      var el = D.el('div', { class: 'ue-cap' + (CSEL === c.id ? ' is-sel' : '') + (/^uc/.test(c.id) ? ' is-new' : ''), title: c.text });
      el.dataset.cid = c.id;
      el.style.left = X(s) + 'px';
      el.style.width = Math.max(2, X(c.e - c.s)) + 'px';
      el.appendChild(D.el('span', { text: (c.id === TITLE_ID ? '제목 · ' : '') + titlePlain(c.text) }));
      if (c.id === TITLE_ID) {
        el.classList.add('ue-title');
        el.setAttribute('role', 'button'); el.setAttribute('tabindex', '0');
        el.setAttribute('aria-label', '제목 캡션: ' + titlePlain(c.text));
        el.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.stopPropagation(); selectTitle(); }
        });
      }
      ln.appendChild(el);
    });
  }
  function drawPlayhead(follow) {
    var ph = D.$('#uePh'), sc = scroller();
    if (!ph || !sc) return;
    var t = now(), x = X(t);
    ph.style.left = x + 'px';
    D.$('#ueTc').textContent = tc(t);
    D.$('#ueDur').textContent = tc(total());
    if (follow && (x > sc.scrollLeft + sc.clientWidth - 40 || x < sc.scrollLeft)) sc.scrollLeft = Math.max(0, x - 40);
    syncBoxEd();
    if (!follow) insFollow();
  }
  var INS_T = null;
  function insFollow() {                   // 멈춰 있을 때 재생 위치가 바뀌면 고른 덧 클립 인스펙터를 다시 (위치 · 크기 · 키 단추가 그 시점 값)
    var SX = selX(), ins = D.$('#ueIns');
    if (SX.length < 1 || SX.length > 2 || selected().length || !ins || BED) return;
    var v = video(), t = Math.round(now() * FPS);
    if ((v && !v.paused) || t === INS_T) return;
    if (ins.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
    INS_T = t;
    side();
  }

  /* ---------- 옆 칸: 클립 정보 (클립 목록은 소스 칸으로 바꿨다 - 2026-10-02 둘째) ---------- */
  function side() {
    var ins = D.$('#ueIns');
    if (!ins || SLIDING) return;
    var keep = ins.scrollTop;
    ins.textContent = '';
    setTimeout(function () { ins.scrollTop = keep; }, 0);
    if (TSEL != null && transInspector(ins)) return;
    if (CSEL && capInspector(ins)) return;
    var SX = selX(), S = selected();
    if (SX.length && !S.length) {          // 덧 클립 (여럿이면 첫 그림 클립 기준, 값은 같이 고른 같은 갈래에 같이)
      exInspector(ins, SX.filter(function (x) { return x.kind !== 'audio'; })[0] || SX[0]);
      return;
    }
    if (!S.length) {
      ins.appendChild(D.el('div', { class: 'ue-ins-empty', text: SX.length ? SX.length + '개' : '' }));
      return;
    }
    var c = S[0];
    var field = function (label, val, set) {
      var row = D.el('label', { class: 'ue-field' });
      row.appendChild(D.el('span', { text: label }));
      var inp = D.el('input', { type: 'text', value: val });
      if (!set) inp.readOnly = true;
      else inp.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Enter') return;
        var v = parseT(inp.value);
        if (v == null) { D.toast('시각을 못 읽었습니다 (예: 1:23.45 또는 83.45)'); return; }
        set(v); inp.blur();
      });
      row.appendChild(inp);
      ins.appendChild(row);
    };
    ins.appendChild(D.el('div', { class: 'ue-ins-h', text: '클립 ' + (sorted().indexOf(c) + 1) + (S.length > 1 ? ' 외 ' + (S.length - 1) + '개' : '') }));
    groupNote(ins, c);
    field('원본 시작', stc(c.s), function (v) { trimTo(c, 'l', v); });
    field('원본 끝', stc(c.e), function (v) { trimTo(c, 'r', v); });
    field('길이', len(c).toFixed(2) + 's');
    field('타임라인', tc(c.at));
    if (insTabs(ins, { v: true, a: true }) === 'v') {
      transformMain(ins, c);
      colorPanel(ins, c);
      clipTransRows(ins, c);
      fxRows(ins, c);
    } else volRows(ins, c, '소리');
  }
  function parseT(s) {
    s = String(s || '').trim();
    if (!s) return null;
    var parts = s.split(':'), t = 0;
    for (var i = 0; i < parts.length; i++) { var n = parseFloat(parts[i]); if (isNaN(n)) return null; t = t * 60 + n; }
    return t;
  }

  /* ---------- 고르기 ---------- */
  function pick(id, add) {
    CSEL = null; TSEL = null;
    if (!add) SEL = {};
    if (id != null) { if (add && SEL[id]) delete SEL[id]; else SEL[id] = true; }
    draw();
  }

  /* ---------- 편집 ---------- */
  function trimTo(c, side_, v) {           // 칸에 적은 원본 시각으로 끝을 옮긴다 (끌기와 같은 규칙)
    remember();
    var o = { s: c.s, e: c.e, at: c.at };
    applyTrim(c, o, side_, side_ === 'l' ? v - o.s : v - o.e);
    changed();
  }
  function neighbors(c) {
    var S = sorted(), i = S.indexOf(c);
    return { prev: S[i - 1] || null, next: S[i + 1] || null };
  }
  function applyTrim(c, o, side_, dt) {
    var m = MIN / FPS, nb = neighbors(c), G = RIP ? gapsOf() : null;
    if (side_ === 'r') {
      var e = Math.min(Math.max(o.e + dt, o.s + m), srcDur());
      if (!RIP && nb.next) e = Math.min(e, o.s + (nb.next.at - o.at));
      c.e = fr(e);
    } else {
      var s = Math.max(0, Math.min(o.s + dt, o.e - m));
      if (!RIP) {
        var lo = nb.prev ? end(nb.prev) : 0;
        s = Math.max(s, o.s - (o.at - lo));
        c.at = fr(o.at + (s - o.s));
      }
      c.s = fr(s);
    }
    if (RIP) pack(G);
  }
  function split(c, t) {                   // 편집 시각 t 에서 둘로
    t = fr(t);
    if (!c || t <= c.at + MIN / FPS || t >= end(c) - MIN / FPS) return false;
    var cut = c.s + (t - c.at);
    var c2 = { id: UID++, s: cut, e: c.e, at: t, vol: c.vol, color: c.color, tf: c.tf, g: c.g, vhide: c.vhide, ahide: c.ahide, fx: c.fx };
    c.e = cut;
    CL.push(c2);
    return true;
  }
  function splitAtPlayhead() {
    var t = now(), c = clipAt(t);
    var SX = selX().filter(function (x) { return x.kind !== 'audio' || !partner(x) || !SEL[partner(x).id]; });   // 묶음은 한쪽만 (짝은 splitX 가 같이)
    SX = SX.filter(function (x) { return t > x.at && t < x.at + xlen(x); });
    if (SX.length && !selected().length) {   // 덧 클립을 골라 두었으면 그것만 (리졸브처럼 고른 것을 자른다)
      remember();
      var ok = false;
      SX.forEach(function (x) { if (splitX(x, t)) ok = true; });
      if (ok) changed(); else UNDO.pop();
      return;
    }
    remember();
    if (split(c, t)) changed(); else { UNDO.pop(); D.toast('재생 위치에 자를 클립이 없습니다'); }
  }
  function removeSel() {
    var S = selected(), SX = selX();
    if (!S.length && SX.length) { remember(); EX = EX.filter(function (x) { return !SEL[x.id]; }); EX.forEach(function (x) { if (x.link && !exById(x.link)) x.link = null; }); SEL = {}; changed(); return; }
    if (!S.length) return;
    if (S.length === CL.length) { D.toast('클립을 전부 지울 수는 없습니다'); return; }
    remember();
    var G = gapsOf();
    CL = CL.filter(function (c) { return !SEL[c.id]; });
    EX = EX.filter(function (x) { return !SEL[x.id]; });
    EX.forEach(function (x) { if (x.link && !exById(x.link)) x.link = null; });
    SEL = {};
    if (RIP) pack(G);
    changed();
  }
  function snapT(t, skip) {               // 재생 위치 · 다른 클립 끝에 붙기
    if (!SNAP) return t;
    var best = t, bd = SNAPPX / PPS;
    var cand = [now()];
    CL.forEach(function (c) { if (c.id !== skip) cand.push(c.at, end(c)); });
    cand.forEach(function (x) { var d = Math.abs(x - t); if (d < bd) { bd = d; best = x; } });
    return best;
  }

  /* ---------- 마우스 ---------- */
  function cx(ev) { var sc = scroller(), r = sc.getBoundingClientRect(); return ev.clientX - r.left + sc.scrollLeft; }
  function onDown(ev) {
    if (ev.button !== 0) return;
    var t = T(cx(ev));
    if (ev.target.closest('#ueRuler') || ev.target.closest('#uePh')) {   // 시점은 눈금 · 선을 끌 때만 옮긴다
      drag = { kind: 'ph' };
      seek(t);
      return ev.preventDefault();
    }
    var cap = ev.target.closest('.ue-cap');
    if (cap) {                               // 고르기 (시점 안 옮김) · 끌어 트랙 옮기기 (새 자막은 시각도)
      CSEL = cap.dataset.cid; SEL = {}; TSEL = null; showPane('ins');
      if (CSEL === TITLE_ID) { selectTitle(); return ev.preventDefault(); }
      var cr0 = capRow(CSEL), uc0 = ucOf(CSEL);
      drag = { kind: 'cap', cid: CSEL, x0: cx(ev), y0: ev.clientY, area: 'v', moved: false, track: cr0 ? cr0.track : 2,
               at0: uc0 ? uc0.at : null, at: null, s0: cr0 ? cr0.c.s : 0, len: cr0 ? cr0.c.e - cr0.c.s : 0 };
      draw(); return ev.preventDefault();
    }
    var trm = ev.target.closest('.ue-trans');
    if (trm) {                               // 전환만 고른다 · 양 끝을 끌면 길이 (앞뒤 같이)
      TSEL = trm.dataset.xid || +trm.dataset.id; SEL = {}; CSEL = null; showPane('ins');
      var tw = transOwner();
      if (tw && ev.target.classList.contains('ue-tr-h')) drag = { kind: 'tr', base: snapshot(), moved: false, x0: cx(ev) };
      draw(); return ev.preventDefault();
    }
    TSEL = null;
    var xe = ev.target.closest('.ue-x');
    if (xe) { xDown(ev, xe, t); drag && (drag.y0 = ev.clientY); return ev.preventDefault(); }
    var el = ev.target.closest('.ue-clip');
    if (!el) {                               // 빈 곳: 끌면 상자로 여럿 고르기 (2026-10-03), 그냥 누르면 고르기 풀기
      var cr = D.$('#ueContent').getBoundingClientRect();
      drag = { kind: 'box', x0: ev.clientX - cr.left, y0: ev.clientY - cr.top, add: ev.shiftKey, sel0: Object.assign({}, SEL), moved: false };
      return ev.preventDefault();
    }
    var c = byId(+el.dataset.id);
    if (!c) return;
    if (TOOL === 'blade') {
      remember();
      if (split(c, snapT(t, null))) changed(); else UNDO.pop();
      return ev.preventDefault();
    }
    var r = el.getBoundingClientRect(), off = ev.clientX - r.left;
    var kind = off < EDGEPX ? 'l' : off > r.width - EDGEPX ? 'r' : 'move';
    CSEL = null;
    if (!SEL[c.id] || kind !== 'move') { if (!ev.shiftKey) SEL = {}; SEL[c.id] = true; }
    drag = { kind: kind, id: c.id, x0: cx(ev), y0: ev.clientY, base: snapshot(), o: { s: c.s, e: c.e, at: c.at }, moved: false, area: el.classList.contains('ue-a') ? 'a' : 'v' };
    draw();
    ev.preventDefault();
  }
  function edgeScroll(ev) {                 // 끄는 동안 칸 끝에 닿으면 위 (오디오는 아래) 트랙으로 넘긴다
    if (!drag || !drag.moved || !/^(move|xmove|cap)$/.test(drag.kind)) return;
    var va = D.$('#ueVA'), aa = D.$('#ueAA');
    if (!va || !aa) return;
    var rv = va.getBoundingClientRect(), ra = aa.getBoundingClientRect();
    if (drag.area === 'v' && ev.clientY < rv.top + 14) { VS += 10; vscroll(); }
    else if (drag.area === 'a' && ev.clientY > ra.bottom - 14) { AS += 10; vscroll(); }
  }
  function onMove(ev) {
    if (!drag) { hover(ev); return; }
    edgeScroll(ev);
    if (drag.kind === 'tr') {
      var tw = transOwner();
      if (!tw || !tw.tin) return;
      if (!drag.moved && Math.abs(cx(ev) - drag.x0) < 2) return;
      drag.moved = true;
      tw.tin = { type: tw.tin.type, d: +Math.max(0.1, Math.min(3, 2 * Math.abs(T(cx(ev)) - tw.at))).toFixed(2) };
      draw();
      return;
    }
    if (drag.kind === 'ph') { seek(T(cx(ev))); return; }
    if (drag.kind === 'box') { marquee(ev); return; }
    if (drag.kind === 'cap') {
      if (!drag.moved && Math.abs(cx(ev) - drag.x0) < 3 && Math.abs(ev.clientY - drag.y0) < 6) return;
      drag.moved = true;
      var ch = document.elementFromPoint(ev.clientX, ev.clientY), cl = ch && ch.closest && ch.closest('#ueContent .ue-lane');
      if (cl && cl.dataset.area === 'v' && +cl.dataset.track >= 2) drag.track = +cl.dataset.track;
      if (drag.at0 != null) drag.at = Math.max(0, fr(snapT(drag.at0 + T(cx(ev) - drag.x0), null)));
      draw();
      laneGhost('v', drag.track, drag.at != null ? drag.at : drag.s0, drag.len);
      return;
    }
    if (drag.kind.charAt(0) === 'x') { if (drag.moved || Math.abs(cx(ev) - drag.x0) >= 3 || Math.abs(ev.clientY - (drag.y0 || ev.clientY)) >= 6) { drag.moved = true; xMove(ev); } return; }
    var dx = cx(ev) - drag.x0;
    if (!drag.moved && Math.abs(dx) < 3 && (drag.kind !== 'move' || Math.abs(ev.clientY - drag.y0) < 6)) return;   // 세로만 끌어도 (V2 로 올리기)
    drag.moved = true;
    var dt = T(dx), o = drag.o, B0 = JSON.parse(drag.base);
    CL = B0.c;
    if (RIP && (drag.kind === 'l' || drag.kind === 'r')) { EX = B0.x || []; if (R && B0.uc) R.userCaps = B0.uc; }   // 리플 끝 끌기는 덧 클립 · 새 자막도 민다 - 매번 끌기 전 상태에서
    var c = byId(drag.id);
    D.$('#ueSnap').hidden = true;
    if (drag.kind === 'r') {
      var e0 = o.at + (o.e - o.s), e1 = snapT(e0 + dt, c.id);
      applyTrim(c, o, 'r', e1 - e0);
      showSnap(e1 !== e0 + dt ? end(c) : null);
    } else if (drag.kind === 'l') {
      if (!RIP) { var a1 = snapT(o.at + dt, c.id); dt = a1 - o.at; showSnap(a1 !== o.at + T(dx) ? a1 : null); }
      applyTrim(c, o, 'l', dt);
    } else {
      var a = Math.max(0, o.at + dt), sa = snapT(a, c.id), se = snapT(a + (o.e - o.s), c.id) - (o.e - o.s);
      a = Math.abs(sa - a) <= Math.abs(se - a) ? sa : se;
      drag.at = fr(a);
      showSnap(a !== Math.max(0, o.at + dt) ? (a === sa ? a : a + (o.e - o.s)) : null);
      var hit = document.elementFromPoint(ev.clientX, ev.clientY), ln = hit && hit.closest && hit.closest('#ueContent .ue-lane');
      drag.lane = ln && ln.dataset.area === drag.area && +ln.dataset.track >= 2 && !(drag.area === 'v' ? c.vhide : c.ahide) ? +ln.dataset.track : null;   // V2.. 로 올리기 · A2.. 로 내리기
    }
    draw();
    if (drag.kind === 'move') { ghost(drag.id, drag.at); laneGhost(drag.area, drag.lane, drag.at, o.e - o.s); }
  }
  /* 마우스 이동은 화면 한 번에 한 번만 처리한다 - 이동 이벤트가 그리기보다 잦으면 (고주사율 마우스) 끌기마다 전체를 다시 그려 밀렸다 */
  var MOVEQ = null, MOVEF = 0;
  function onMoveQ(ev) {
    if (!drag) { hover(ev); return; }
    MOVEQ = ev;
    if (!MOVEF) MOVEF = requestAnimationFrame(flushMove);
  }
  function flushMove() {
    if (MOVEF) { cancelAnimationFrame(MOVEF); MOVEF = 0; }
    var e = MOVEQ; MOVEQ = null;
    if (e) onMove(e);
  }
  function onUp() {
    flushMove();
    if (!drag) return;
    var d = drag; drag = null;
    D.$('#ueSnap').hidden = true;
    if (d.kind === 'box') { D.$('#ueMarq').hidden = true; if (!d.moved && !d.add) pick(null); else draw(); return; }
    if (d.kind === 'tr') {
      if (d.moved) { UNDO.push(d.base); REDO = []; changed(); } else draw();
      return;
    }
    if (d.kind === 'cap') {
      laneGhost(null);
      var row = capRow(d.cid), ucx = ucOf(d.cid);
      if (!d.moved || !row) { draw(); return; }
      remember();
      R.capTracks = Object.assign({}, R.capTracks || {});
      R.capTracks[capKey(row.c)] = d.track;
      if (ucx && d.at != null) ucx.at = +d.at.toFixed(4);
      changed();
      return;
    }
    if (d.kind === 'ph' || !d.moved) { draw(); return; }
    if (d.kind.charAt(0) === 'x') { xUp(d); return; }
    var after = null;
    laneGhost(null);
    if (d.kind === 'move' && d.lane) {      // 위 트랙에 놓았다: 덧 클립으로
      CL = JSON.parse(d.base).c;
      remember();
      if ((d.area === 'a' ? toAudio : toLayer)(byId(d.id), d.lane, d.at)) changed(); else { UNDO.pop(); draw(); }
      return;
    }
    if (d.kind === 'move') {
      CL = JSON.parse(d.base).c;
      var c = byId(d.id);
      if (RIP) {                           // 끼워 넣기: 옮긴 자리 가운데로 순서를 다시 매기고 틈 없이
        /* 옮기는 클립은 놓은 시작점, 다른 클립은 가운데로 줄 세운다 - 둘 다 가운데로 재니 맨 앞에 놓아도 첫 클립 뒤로 갔다 */
        var mid = function (x) { return x === c ? d.at + 1e-3 : x.at + len(x) / 2; };
        var ord = CL.slice().sort(function (p, q) { return mid(p) - mid(q); }), t = 0;
        var G = gapsOf(), gp = {}, oi = -1;          // 틈은 지킨다 - 옮긴 클립의 앞 틈은 원래 뒤 클립이 물려받는다
        G.forEach(function (r, i) { gp[r[0]] = r[1]; if (r[0] === c.id) oi = i; });
        if (oi >= 0 && oi + 1 < G.length) gp[G[oi + 1][0]] += gp[c.id];
        gp[c.id] = 0;
        ord.forEach(function (x) { x.at = fr(t + (gp[x.id] || 0)); t = x.at + len(x); });
        shiftRest(G.filter(function (r) { return r[0] !== c.id; }));   // 옮긴 클립 자리 밖의 덧 클립 · 새 자막도 같이
      } else {                             // 빈 자리에만 놓는다 - 겹치면 되돌림
        var hit = CL.some(function (x) { return x !== c && d.at < end(x) - 1e-6 && d.at + len(c) > x.at + 1e-6; });
        if (hit) { D.toast('다른 클립과 겹칩니다 - 리플을 켜면 끼워 넣습니다'); draw(); return; }
        c.at = d.at;
      }
    }
    after = JSON.stringify(CL);
    var B = JSON.parse(d.base), afX = EX, afU = R && R.userCaps;     // 되돌리기에는 끌기 전 상태 (리플이 덧 클립 · 새 자막도 옮겼다)
    CL = B.c; EX = B.x || []; if (R && B.uc) R.userCaps = B.uc;
    remember();
    CL = JSON.parse(after); EX = afX; if (R && afU) R.userCaps = afU;
    changed();
  }
  function ghost(id, at) {                // 옮기는 클립 그림자
    D.$$('.ue-clip[data-id="' + id + '"]').forEach(function (el) { el.classList.add('is-ghost'); el.style.left = X(at) + 'px'; });
  }
  function showSnap(t) {
    var s = D.$('#ueSnap');
    if (t == null) { s.hidden = true; return; }
    s.hidden = false; s.style.left = X(t) + 'px';
  }
  function hover(ev) {
    var el = ev.target.closest && ev.target.closest('.ue-clip'), cur = '';
    if (TOOL === 'blade' && el) cur = 'crosshair';
    else if (el) {
      var r = el.getBoundingClientRect(), off = ev.clientX - r.left;
      cur = off < EDGEPX || off > r.width - EDGEPX ? 'ew-resize' : 'grab';
    }
    D.$('#ueContent').style.cursor = cur;
  }
  function zoomBy(f, atX) {               // atX: 화면 x (scroller 안) - 그 자리 시각이 그대로 남게
    var sc = scroller(), x = atX == null ? sc.clientWidth / 2 : atX, t = T(sc.scrollLeft + x);
    PPS = Math.max(4, Math.min(1200, PPS * f));
    MINW = 0; draw();
    sc.scrollLeft = Math.max(0, X(t) - x);
    var z = D.$('#ueZoom'); if (z) z.value = Math.log(PPS);
  }
  function fit() {
    var sc = scroller();
    PPS = Math.max(4, (sc.clientWidth - 40) / Math.max(1, total()));
    MINW = 0; draw(); sc.scrollLeft = 0;
    var z = D.$('#ueZoom'); if (z) z.value = Math.log(PPS);
  }

  /* ---------- 오른쪽 탭 (인스펙터 · 전사 자막 · 렌더) ---------- */
  function showPane(p) {
    PANE = p;
    D.$$('#view-edit .ue-tab').forEach(function (b) { b.classList.toggle('is-on', b.dataset.pane === p); });
    D.$$('#view-edit .ue-inspector [data-pane]').forEach(function (el) { if (!el.classList.contains('ue-tab')) el.hidden = el.dataset.pane !== p; });
    if (p === 'words') drawWords();
  }

  /* ---------- 자막 줄 인스펙터 (2026-10-02 "자막도 인스펙터에 표시") ----------
     장면 자막 'r<번호>' 가 review.captions[번호] 다 (feedback.js sceneFromReview). 글 · 화자 · 디자인 · 시작 · 끝을 고친다.
     시작 · 끝은 이 타임라인 시각으로 보이고, 저장은 지금 구운 편집 시각 (s2 · e2) 으로 되돌려 적는다 - 렌더 단추가 컷을 따라 다시 옮긴다 */
  function plain(t) { return String(t || '').split('«').join('').split('»').join('').split('|')[0].trim(); }
  function capIndex(id) {
    if (!id) return -1;
    if (id.charAt(0) === 'l') {             // 설명 딱지: 장면이 그리지만 글은 review.captions 의 설명 줄 (피드백 탭과 같이 고친다)
      var sc = ((SC && SC.captions) || []).filter(function (c) { return c.id === id; })[0], L = (R && R.captions) || [];
      for (var i = 0; i < L.length; i++) {
        if ((L[i].speaker || '').trim() === '설명' && sc && (plain(L[i].text) === plain(sc.text) || plain(L[i].orig) === plain(sc.text))) return i;
      }
      return -1;
    }
    if (id.charAt(0) !== 'r' || id.charAt(1) === 'c') return -1;
    var n = +id.slice(1);
    return isNaN(n) ? -1 : n;
  }
  function toOld(t) {                      // 이 타임라인 시각 -> 지금 구운 편집 시각
    return D.Feedback.srcToEdit(D.Feedback.unplanned(plan(), t));
  }
  function transOwner() { return TSEL == null ? null : typeof TSEL === 'string' ? exById(TSEL) : byId(TSEL); }
  function transInspector(ins) {
    var o = transOwner();
    if (!o || !o.tin) { TSEL = null; return false; }
    ins.appendChild(D.el('div', { class: 'ue-ins-h', text: '전환' }));
    if (CL.indexOf(o) >= 0) clipTransRows(ins, o); else layerTransRows(ins, o);
    var del = D.el('button', { class: 'ue-btn ue-cap-cut' });
    del.appendChild(D.icon('trash')); del.appendChild(D.el('span', { text: '지우기' }));
    del.addEventListener('click', function () { remember(); delete o.tin; TSEL = null; changed(); });
    ins.appendChild(del);
    return true;
  }
  function ucInspector(ins, o) {             // 자막 추가로 만든 줄 (review.userCaps, 출력 시각)
    ins.appendChild(D.el('div', { class: 'ue-ins-h', text: '자막' }));
    var row = function (label, el) { var r = D.el('label', { class: 'ue-field' }); r.appendChild(D.el('span', { text: label })); r.appendChild(el); ins.appendChild(r); return el; };
    var edit = function (fn) { remember(); fn(); changed(); };
    var ta = D.el('textarea', { class: 'ue-cap-text', rows: 3 });
    ta.value = o.text || '';
    ta.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); ta.blur(); } });
    ta.addEventListener('change', function () { var v = ta.value.trim(); if (v !== o.text) edit(function () { o.text = v; }); });
    row('글', ta);
    var spk = D.el('select'), spks = {};
    ((R && R.captions) || []).forEach(function (x) { if (x.speaker) spks[x.speaker] = 1; });
    if (o.speaker) spks[o.speaker] = 1;
    Object.keys(spks).forEach(function (k) { spk.appendChild(D.el('option', { value: k, text: k })); });
    spk.value = o.speaker || '';
    spk.addEventListener('change', function () { edit(function () { o.speaker = spk.value; }); });
    row('화자', spk);
    var kd = D.el('select'), names = ((SC && SC.style && SC.style.captions && SC.style.captions.kindNames) || {}), ks = [''].concat(Object.keys(names));
    ks.forEach(function (k) { kd.appendChild(D.el('option', { value: k, text: k || '기본' })); });
    kd.value = o.kind || '';
    kd.addEventListener('change', function () { edit(function () { o.kind = kd.value; }); });
    row('디자인', kd);
    var t0 = D.el('input', { type: 'text', value: tc(o.at) });
    t0.addEventListener('keydown', function (ev) { if (ev.key !== 'Enter') return; var v = parseTC(t0.value); if (v != null) edit(function () { o.at = +Math.max(0, v).toFixed(4); }); });
    row('시작', t0);
    numRow(ins, '길이', o.d, '초', function (v) { o.d = Math.max(0.2, Math.min(60, v)); }, 0.1);
    sub(ins, '변형');
    transformRows(ins, o, function (k, v) { setTf([o], k, v); }, (SC && SC.width) || 1080, (SC && SC.height) || 1920);
    var del = D.el('button', { class: 'ue-btn ue-cap-cut' });
    del.appendChild(D.icon('trash')); del.appendChild(D.el('span', { text: '지우기' }));
    del.addEventListener('click', cutCaption);
    ins.appendChild(del);
  }
  function addCaption() {                  // 자막 추가 (재생 위치, 2초)
    if (!R) return;
    var n = {};
    (R.captions || []).forEach(function (c) { var k = (c.speaker || '').trim(); if (k && !/^(제목|title|채팅|설명|주석|후원)$/.test(k)) n[k] = (n[k] || 0) + 1; });
    var o = { id: D.uid('c'), at: +fr(now()).toFixed(4), d: 2, text: '자막', speaker: Object.keys(n).sort(function (a, b) { return n[b] - n[a]; })[0] || '', kind: '' };
    remember();
    R.userCaps = (R.userCaps || []).concat([o]);
    CSEL = 'uc' + o.id; SEL = {}; TSEL = null;
    showPane('ins');
    changed();
  }
  function titleInspector(ins) {
    ins.appendChild(D.el('div', { class: 'ue-ins-h', text: '제목 캡션' }));
    var label = D.el('label', { class: 'ue-field' });
    label.appendChild(D.el('span', { text: '글' }));
    var ta = D.el('textarea', { class: 'ue-cap-text', rows: 4, id: 'ueTitleText', placeholder: '제목 입력' });
    ta.setAttribute('aria-label', '제목 글');
    ta.value = titlePlain(titleText());
    ta.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); commit(); ta.blur(); }
    });
    function commit() {
      if (!R) return;
      var original = titleText(), text = titleWithMarks(ta.value.trim(), original);
      if (text === original) return;
      remember();
      var c = titleCaption();
      if (!c) {
        c = { s: 0, e: total(), speaker: '제목', kind: '기본', text: original };
        (R.captions || (R.captions = [])).push(c);
      }
      if (c.orig == null) c.orig = original;
      c.text = text; c.by = 'user'; R.unbaked = true;
      D.touch(); refreshScene(); draw();
    }
    ta.addEventListener('change', commit);
    ta.addEventListener('blur', commit);
    label.appendChild(ta); ins.appendChild(label);
    ins.appendChild(D.el('div', { class: 'ue-title-help', text: 'Shift+Enter로 줄바꿈 · Enter로 적용. 제목은 영상 전체에 표시됩니다.' }));
  }
  function capInspector(ins) {
    if (CSEL === TITLE_ID) { titleInspector(ins); return true; }
    if (/^uc/.test(CSEL || '')) { var uo = ucOf(CSEL); if (!uo) { CSEL = null; return false; } ucInspector(ins, uo); return true; }
    var sc = ((SC && SC.captions) || []).filter(function (c) { return c.id === CSEL; })[0];
    if (!sc) { CSEL = null; return false; }
    var i = capIndex(sc.id), c = R && i >= 0 ? (R.captions || [])[i] : null;
    ins.appendChild(D.el('div', { class: 'ue-ins-h', text: '자막' + (c ? ' ' + (i + 1) : '') }));
    var row = function (label, el) {
      var r = D.el('label', { class: 'ue-field' });
      r.appendChild(D.el('span', { text: label }));
      r.appendChild(el);
      ins.appendChild(r);
      return el;
    };
    var edit = function (fn) { remember(); fn(); c.by = 'user'; D.touch(); refreshScene(); draw(); };
    if (!c) { var ro = D.el('input', { type: 'text', value: sc.text }); ro.readOnly = true; row('글', ro); return true; }
    var ta = D.el('textarea', { class: 'ue-cap-text', rows: 3 });
    ta.value = c.text || '';
    ta.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); ta.blur(); } });
    ta.addEventListener('change', function () {
      var v = ta.value.trim();
      if (v === (c.text || '')) return;
      edit(function () { if (c.orig == null) c.orig = c.text; c.text = v; });
    });
    row('글', ta);
    var spk = D.el('select'), spks = {};
    (R.captions || []).forEach(function (x) { if (x.speaker) spks[x.speaker] = 1; });
    Object.keys(spks).forEach(function (k) { spk.appendChild(D.el('option', { value: k, text: k })); });
    spk.value = c.speaker || '';
    spk.addEventListener('change', function () { edit(function () { c.speaker = spk.value; }); });
    row('화자', spk);
    var kd = D.el('select'), names = ((SC.style && SC.style.captions && SC.style.captions.kindNames) || {});
    var ks = Object.keys(names);
    if (c.kind && ks.indexOf(c.kind) < 0) ks.unshift(c.kind);
    if (!c.kind) ks.unshift('');
    ks.forEach(function (k) { kd.appendChild(D.el('option', { value: k, text: k || '기본' })); });
    kd.value = c.kind || '';
    kd.addEventListener('change', function () { edit(function () { c.kind = kd.value; }); });
    row('디자인', kd);
    var tf = function (label, val, key) {
      var inp = D.el('input', { type: 'text', value: tc(val) });
      inp.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Enter') return;
        var v = parseTC(inp.value);
        if (v == null) { D.toast('시각을 못 읽었습니다 (예: 00:00:12:30 또는 12.5)'); return; }
        edit(function () { c[key] = +toOld(v).toFixed(3); });
      });
      row(label, inp);
    };
    tf('시작', sc.s, 's2');
    tf('끝', sc.e, 'e2');
    var ln = D.el('input', { type: 'text', value: (sc.e - sc.s).toFixed(2) + 's' }); ln.readOnly = true;
    row('길이', ln);
    /* 자막 변형 (2026-10-03: "모든 비디오(자막)클립에 대해서도 이동, 확대, 회전") - 렌더 · 미리보기 같은 React (Caption.tsx), captions.csv tf 칸 */
    sub(ins, '변형');
    transformRows(ins, c, function (k, v) { setTf([c], k, v); c.by = 'user'; }, (SC && SC.width) || 1080, (SC && SC.height) || 1920);
    /* 자막으로 컷 더하기 · 빼기 (사용자 2026-10-02: "자막에 의해 컷 추가 / 삭제 할 때 미리보기에서 바로 볼 수도 없지").
       원본 시각을 앞당기면 그만큼 원본을 되살리고 늦추면 그만큼 뺀다 - 클립 목록을 바로 고쳐 미리보기에 곧장 보인다.
       줄은 os2 · oe2 (원본 시각) 에 선다 - 미리보기 (feedback.js planScene) 와 렌더 (apply_review.py) 가 같이 읽는다 */
    var s0 = c.os2 != null ? c.os2 : srcOfT(sc.s), e0 = c.oe2 != null ? c.oe2 : srcOfT(sc.e - 1e-3);
    var sf = function (label, val, isEnd) {
      var inp = D.el('input', { type: 'text', value: val != null ? stc(val) : '-' });
      inp.title = '원본 시각';
      inp.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Enter') return;
        var v = parseT(inp.value);
        if (v == null || s0 == null || e0 == null) { D.toast('시각을 못 읽었습니다 (예: 1:23.45 또는 83.45)'); return; }
        var a = isEnd ? s0 : v, b = isEnd ? v : e0;
        if (b - a < 0.1) { D.toast('끝이 시작보다 앞입니다'); return; }
        remember();
        if (!isEnd) { if (v < s0) restoreSrc(v, s0); else if (v > s0) removeSrc(s0, v); }
        else if (v > e0) restoreSrc(e0, v); else if (v < e0) removeSrc(v, e0);
        merge();
        c.os2 = +a.toFixed(3); c.oe2 = +b.toFixed(3); c.by = 'user';
        changed();
      });
      row(label, inp);
    };
    sf('원본 시작', s0, false);
    sf('원본 끝', e0, true);
    var cut = D.el('button', { class: 'ue-btn ue-cap-cut', title: '컷에서 빼기 (Delete)' });
    cut.appendChild(D.icon('trash')); cut.appendChild(D.el('span', { text: '컷에서 빼기' }));
    cut.addEventListener('click', cutCaption);
    ins.appendChild(cut);
    return true;
  }
  function srcOfT(t) {                     // 이 타임라인 시각 -> 원본 시각 (그 자리 클립)
    var c = clipAt(t);
    return c ? c.s + (t - c.at) : null;
  }
  function cutCaption() {                  // 고른 자막 줄의 원본 구간을 컷에서 뺀다 (줄도 같이 사라진다 - 남은 말이 0.1초 미만)
    if (CSEL === TITLE_ID) { D.toast('제목은 인스펙터에서 글을 비우면 숨길 수 있습니다'); return; }
    if (/^uc/.test(CSEL || '')) {           // 새 자막은 그냥 지운다
      remember();
      R.userCaps = (R.userCaps || []).filter(function (o) { return 'uc' + o.id !== CSEL; });
      if (R.capTracks) delete R.capTracks[CSEL];
      CSEL = null; changed();
      return;
    }
    var sc = ((SC && SC.captions) || []).filter(function (x) { return x.id === CSEL; })[0];
    if (!sc) return;
    var i = capIndex(sc.id), c = R && i >= 0 ? (R.captions || [])[i] : null;
    var a = c && c.os2 != null ? c.os2 : srcOfT(sc.s), b = c && c.oe2 != null ? c.oe2 : srcOfT(sc.e - 1e-3);
    if (a == null || b == null || b - a < 0.05) { D.toast('이 줄은 컷 밖에 있습니다'); return; }
    remember();
    removeSrc(a, b);
    merge();
    CSEL = null;
    changed();
    D.toast('자막 줄 구간을 컷에서 뺐습니다 (Ctrl+Z 로 되돌림)');
  }
  function parseTC(s) {                    // 00:00:12:30 (프레임) 또는 초
    s = String(s || '').trim();
    var p = s.split(':');
    if (p.length === 4) return ((+p[0] * 60 + +p[1]) * 60 + +p[2]) + +p[3] / FPS;
    return parseT(s);
  }

  /* ---------- 전사 자막: 낱말 빼기 · 되살리기 (2026-10-02 "단어별 추가 제거") ----------
     낱말은 클립 목록을 바로 고친다 (클립 목록이 하나뿐인 정본). 뺄 때는 앞뒤 쉼의 가운데까지 잘라 낸다 - 낱말 끝에서 딱 자르면
     위스퍼 시각이 어긋난 만큼 말이 잘린다 (drop-snap-to-word-gaps). 되살릴 때는 앞 0.10 · 뒤 0.15초 여유 (피드백 탭과 같은 값) 를 붙여
     원본에서 바로 앞에 남아 있는 클립 뒤에 끼워 넣는다 (뒤는 민다) */
  var WALL = null, LASTW = null;
  /* 낱말 시각 바로잡기: 위스퍼 시각이 쉼 앞뒤에서 1초쯤 어긋난 편이 있다 (퍼리취향: "어 잠깐만" 이 7.78초인데 실제는 첫 조각 8.72초 안 -
     파이프라인의 keep 은 남았다고 하는데 시각으로 재면 잘린 쪽). keep 이 정본이다: keep 인데 AI 조각 (review.clips) 밖인 낱말 덩이는
     가장 가까운 조각 끝 안으로 통째로 옮겨 잰다 (사이 간격은 그대로) */
  function allWords() {
    if (WALL) return WALL;
    WALL = [];
    ((R && R.transcript) || []).forEach(function (sg, si) {
      (sg.words || []).forEach(function (w, wi) { WALL.push({ w: w, k: si + ':' + wi, s: w.s, e: w.e }); });
    });
    WALL.sort(function (a, b) { return a.s - b.s; });
    var K = (R && R.clips) || [];
    var inK = function (x) { return K.some(function (k) { return Math.min(x.e, k.e) - Math.max(x.s, k.s) >= 0.5 * Math.max(0.001, x.e - x.s); }); };
    var run = [];
    var fix = function () {
      if (!run.length) return;
      var a = run[0], b = run[run.length - 1], best = null, off = 0;
      K.forEach(function (k) {
        /* 조각 앞 · 뒤에 있거나 걸쳐 있으면 (잠깐만 7.97-9.07 이 조각 8.72 에 0.35초만 걸침) 조각 안으로 */
        var o = a.s < k.s && b.e > k.s - 3 && a.s < k.s ? k.s + 0.02 - a.s : b.e > k.e && a.s < k.e + 3 ? k.e - 0.02 - b.e : 0;
        if (o && (best == null || Math.abs(o) < Math.abs(off))) { best = k; off = o; }
      });
      if (best && Math.abs(off) < 3) run.forEach(function (x) { x.s += off; x.e += off; });
      run = [];
    };
    WALL.forEach(function (x) { if (x.w.keep && !inK(x)) run.push(x); else fix(); });
    fix();
    return WALL;
  }
  function covered(x) {
    var d = Math.max(0.001, x.e - x.s), got = 0;
    CL.forEach(function (c) { got += Math.max(0, Math.min(x.e, c.e) - Math.max(x.s, c.s)); });
    return got >= 0.5 * d;
  }
  function srcToT(t) {
    var r = null;
    CL.forEach(function (c) { if (t >= c.s - 1e-3 && t < c.e) r = c; });
    return r ? r.at + (t - r.s) : 0;
  }
  function wordOf(el) {
    var sp = el && el.closest && el.closest('.ue-w');
    if (!sp) return null;
    var k = sp.dataset.k, A = allWords();
    for (var i = 0; i < A.length; i++) if (A[i].k === k) return A[i];
    return null;
  }
  function removeSrc(a, b) {
    var out = [], G = gapsOf();
    sorted().forEach(function (c) {          // 나머지 칸 (색 · 변형 · 효과 · 화면 / 소리 옮김 · 그룹) 은 그대로 - 전에는 효과 · ahide 가 빠졌다
      if (b <= c.s || a >= c.e) { out.push(c); return; }
      if (a > c.s + 1e-3) out.push(Object.assign({}, c, { e: a }));
      if (b < c.e - 1e-3) { var c2 = Object.assign({}, c, { id: UID++, s: b, at: c.at + (b - c.s) }); delete c2.tin; out.push(c2); }
    });
    CL = out;
    if (RIP) pack(G);
  }
  function restoreSrc(a, b) {
    var parts = [[Math.max(0, a), Math.min(b, srcDur())]];
    CL.forEach(function (c) {                // 이미 남은 원본은 빼고 새로 들어올 토막만
      var Q = [];
      parts.forEach(function (p) {
        if (c.e <= p[0] || c.s >= p[1]) { Q.push(p); return; }
        if (c.s > p[0] + 1e-3) Q.push([p[0], c.s]);
        if (c.e < p[1] - 1e-3) Q.push([c.e, p[1]]);
      });
      parts = Q;
    });
    parts.forEach(function (p) {
      var L = p[1] - p[0];
      if (L < 0.02) return;
      var prev = null;
      CL.forEach(function (c) { if (c.e <= p[0] + 0.002 && (!prev || c.e > prev.e)) prev = c; });
      var at = prev ? end(prev) : 0;
      CL.forEach(function (c) { if (c !== prev && c.at >= at - 1e-4) c.at += L; });
      if (prev && Math.abs(prev.e - p[0]) < 0.002) prev.e = p[1];        // 바로 이어지면 그 클립을 늘인다
      else CL.push({ id: UID++, s: p[0], e: p[1], at: at });
    });
  }
  function toggleWords(ws, on) {
    remember();
    ws.forEach(function (w) {
      if (on) { restoreSrc(w.s - 0.10, w.e + 0.15); return; }
      var A = allWords(), i = A.indexOf(w);
      var pv = i > 0 ? A[i - 1] : null, nx = i >= 0 && i + 1 < A.length ? A[i + 1] : null;
      var a = pv && pv.e <= w.s ? (pv.e + w.s) / 2 : w.s - 0.05, b = nx && nx.s >= w.e ? (w.e + nx.s) / 2 : w.e + 0.05;
      removeSrc(a, b);
    });
    merge();
    changed();
  }
  function merge() {                      // 원본도 타임라인도 바로 이어지는 클립은 하나로 (낱말을 빼고 되살리면 둘로 남았다)
    var S = sorted(), out = [];
    S.forEach(function (c) {
      var l = out[out.length - 1];
      if (l && Math.abs(l.e - c.s) < 0.002 && Math.abs(end(l) - c.at) < 0.002 && (l.vol || 0) === (c.vol || 0) && !c.tin
          && JSON.stringify(l.color || null) === JSON.stringify(c.color || null) && JSON.stringify(l.tf || null) === JSON.stringify(c.tf || null)
          && (l.g || null) === (c.g || null) && !l.vhide === !c.vhide) l.e = c.e;
      else out.push(c);
    });
    CL = out;
  }
  function onWord(ev) {
    var w = wordOf(ev.target);
    if (!w) return;
    var on = !covered(w), ws = [w];
    if (ev.shiftKey && LASTW) {              // Shift: 앞에 누른 낱말부터 여기까지 같이
      var A = allWords(), i0 = A.indexOf(LASTW), i1 = A.indexOf(w);
      if (i0 >= 0 && i1 >= 0) ws = A.slice(Math.min(i0, i1), Math.max(i0, i1) + 1).filter(function (x) { return covered(x) !== on; });
    }
    LASTW = w;
    toggleWords(ws, on);
  }
  function drawWords() {
    var box = D.$('#ueWords');
    if (!box || PANE !== 'words') return;
    var keep = box.scrollTop;
    box.textContent = '';
    var segs = (R && R.transcript) || [];
    if (!segs.length) { box.appendChild(D.el('div', { class: 'ue-ins-empty', text: '전사가 없습니다' })); return; }
    var byK = {};
    allWords().forEach(function (x) { byK[x.k] = x; });
    segs.forEach(function (sg, si) {
      var ws = sg.words || [];
      if (!ws.length) return;
      var p = D.el('div', { class: 'ue-seg' });
      p.appendChild(D.el('span', { class: 'ue-seg-t', text: stc(byK[si + ':0'] ? byK[si + ':0'].s : ws[0].s) }));
      ws.forEach(function (w, wi) {
        var sp = D.el('span', { class: 'ue-w' + (covered(byK[si + ':' + wi]) ? '' : ' is-cut'), text: w.w });
        sp.dataset.k = si + ':' + wi;
        p.appendChild(sp);
      });
      box.appendChild(p);
    });
    box.scrollTop = keep;
  }

  /* ---------- 트랙 사이 옮기기 (2026-10-03 사용자: "트랙 이동 기능 예) v1 <-> v2등등 , 오디오도 같이 움직일건지 따로 움직일 건지 선택 가능하게 아이콘") ----------
     원본 클립 (V1) 을 V2.. 에 놓으면 같은 원본 구간 · 같은 화면 (AI 크롭 + 변형) 의 덧 영상이 된다 (review.source 원본 파일, crop 칸).
     연결 (고리) 이 켜져 있으면 소리도 A2.. 로 같이 옮기고 V1 · A1 에는 빈 틈이 남는다. 꺼져 있으면 소리는 A1 에 남고 V1 화면만 비운다 (vhide).
     덧 영상 (원본 파일에서 온 것) 을 V1 에 놓으면 다시 원본 클립이 된다 (화면만 비운 클립이 그 자리에 있으면 그것을 되살린다) */
  function srcPath() { return (R && (R.source || (R.srcPreview && R.srcPreview.path))) || null; }
  function srcWH() { return (R && R.srcSize) || (R && R.srcPreview && { w: R.srcPreview.w, h: R.srcPreview.h }) || { w: 1920, h: 1080 }; }
  function normP(p) { return String(p || '').replace(/\\/g, '/').toLowerCase(); }
  function isSrc(p) { var a = normP(p); return !!a && (a === normP(R.source) || a === normP((R.srcPreview || {}).path)); }
  function pieceOf(c) { return ((R && R.clips) || []).filter(function (k) { return c.s >= k.s - 0.01 && c.s < k.e; })[0] || null; }
  function laneGhost(a, n, at, L) {
    D.$$('.ue-lane-ghost').forEach(function (g) { g.remove(); });
    if (!a || !n) return;
    var ln = laneEl(a, n);
    if (!ln) return;
    var g = D.el('div', { class: 'ue-lane-ghost' });
    g.style.left = X(at) + 'px'; g.style.width = Math.max(2, X(L)) + 'px';
    ln.appendChild(g);
  }
  function toAudio(c, track, at) {         // A1 의 소리를 A2.. 로 (연결 켬이면 영상도 같이 위로)
    if (LINK) return toLayer(c, 2, at, track);
    var p = srcPath();
    if (!c || !p) { D.toast('원본 경로를 몰라 옮길 수 없습니다'); return false; }
    var pc = pieceOf(c), a = { id: 'x' + (UID++), kind: 'audio', path: p, name: '원본 ' + stc(c.s) + ' - ' + stc(c.e), track: track, at: fr(at), s: c.s, e: c.e,
      dur: srcDur() === Infinity ? null : srcDur(), vol: +((c.vol || 0) + ((pc && pc.gain) || 0)).toFixed(2), fin: 0, fout: 0 };
    if (c.g) a.g = c.g;
    c.ahide = true;
    EX.push(a); settle(a);
    SEL = {}; SEL[a.id] = true;
    return true;
  }
  function toLayer(c, track, at, atrack) {
    var p = srcPath();
    if (!c || !p || !SC) { D.toast('원본 경로를 몰라 옮길 수 없습니다 - 내보내기를 다시 해 주세요'); return false; }
    if (LINK && CL.length <= 1) { D.toast('마지막 원본 클립은 옮길 수 없습니다 (연결을 끄면 화면만 옮깁니다)'); return false; }
    var W = SC.window, S = srcWH(), pc = pieceOf(c), cr = (pc && pc.crop) || (R.srcPreview && R.srcPreview.crop) || { x: 0, y: 0, w: S.w, h: S.h };
    var A = W.w / W.h, V = cr.w / cr.h > A ? { w: cr.h * A, h: cr.h } : { w: cr.w, h: cr.w / A };
    V.x = cr.x + (cr.w - V.w) / 2; V.y = cr.y + (cr.h - V.h) / 2;
    var f = tfOf(c), name = '원본 ' + stc(c.s) + ' - ' + stc(c.e);
    var v = { id: 'x' + (UID++), kind: 'video', path: p, name: name, track: track, at: fr(at), s: c.s, e: c.e, dur: srcDur() === Infinity ? null : srcDur(),
              w0: S.w, h0: S.h, crop: { x: Math.round(V.x), y: Math.round(V.y), w: Math.round(V.w), h: Math.round(V.h) },
              box: rbox({ x: W.x + W.w / 2 + f.x - W.w * f.z / 2, y: W.y + W.h / 2 + f.y - W.h * f.z / 2, w: W.w * f.z, h: W.h * f.z }),
              opacity: 1, vol: 0, fin: 0, fout: 0 };
    if (c.color) v.color = c.color;
    if (f.r) v.rot = f.r;
    if (c.g) v.g = c.g;
    var made = [v];
    if (LINK) {
      var a = { id: 'x' + (UID++), kind: 'audio', path: p, name: name, track: atrack || 2, at: v.at, s: c.s, e: c.e, dur: v.dur,
                vol: +((c.vol || 0) + ((pc && pc.gain) || 0)).toFixed(2), fin: 0, fout: 0, link: v.id };   // AI 조각 이득도 같이
      v.link = a.id; made.push(a);
      CL = CL.filter(function (x) { return x !== c; });                                // V1 · A1 에는 빈 틈 (리플 안 함)
    } else c.vhide = true;
    made.forEach(function (x) { EX.push(x); settle(x); });
    SEL = {}; made.forEach(function (x) { SEL[x.id] = true; });
    D.toast(LINK ? '영상 + 소리를 V' + v.track + ' · A' + (made[1] && made[1].track) + ' 로 옮겼습니다' : '화면만 V' + v.track + ' 로 옮겼습니다 (소리는 A1)');
    return true;
  }
  function toMain(x, at) {                 // 원본에서 온 덧 영상 · 소리를 V1 · A1 로
    if (!x || (x.kind !== 'video' && x.kind !== 'audio') || !isSrc(x.path)) { D.toast('이 편 원본에서 온 클립만 원본 트랙으로 옮길 수 있습니다'); return false; }
    var p = partner(x), both = !!(p && LINK), flag = x.kind === 'video' ? 'vhide' : 'ahide', other = flag === 'vhide' ? 'ahide' : 'vhide';
    var hid = CL.filter(function (c) { return c[flag] && Math.abs(c.s - x.s) < 0.02 && Math.abs(c.e - x.e) < 0.02; })[0];
    if (hid) { delete hid[flag]; if (both) delete hid[other]; }
    else {
      at = fr(at);
      var L = x.e - x.s, tol = 2.5 / FPS;
      CL.forEach(function (c) {
        if (end(c) > at && end(c) - at <= tol && c.at < at) at = end(c);
        if (c.at < at + L && at + L - c.at <= tol && c.at > at) L = c.at - at;
      });
      var hit = L < 1 / FPS || CL.some(function (c) { return at < end(c) - 1e-6 && at + L > c.at + 1e-6; });
      if (hit) { D.toast('그 자리에 다른 클립이 있습니다'); return false; }
      var c = { id: UID++, s: x.s, e: x.s + L, at: at };
      if (x.color) c.color = x.color;
      if (x.g) c.g = x.g;
      if (p && !both) c[other] = true;             // 짝은 위 (아래) 트랙에 남는다
      else if (!p && x.kind === 'audio') c.vhide = true;
      CL.push(c);
    }
    EX = EX.filter(function (y) { return y !== x && !(both && y === p); });
    if (p && !both) p.link = null;
    SEL = {};
    return true;
  }
  function moveSelTrack(dir) {             // 우클릭: 원본 클립 하나를 V2 로 / 덧 영상 하나를 V1 로
    var S = selected(), SX = selX().filter(function (x) { return x.kind === 'video'; });
    remember();
    var ok = dir > 0 && S.length === 1 ? toLayer(S[0], 2, S[0].at) : dir < 0 && SX.length === 1 ? toMain(SX[0], SX[0].at) : false;
    if (ok) changed(); else UNDO.pop();
  }

  /* ---------- I · O 구간 (2026-10-03 사용자: "영역 선택 시작 부는 i, 끝은 o, 선택 부분 외에는 어둡게 처리") ----------
     Alt+X 로 지운다 (리졸브). 고른 클립이 없을 때 Delete = 그 구간을 원본 클립 (V1 · A1) 에서 빼기 (리플이면 당김) */
  function setMark(k) {
    var t = fr(now());
    RANGE[k] = t;
    if (RANGE.i != null && RANGE.o != null && RANGE.o < RANGE.i) { if (k === 'i') RANGE.o = null; else RANGE.i = null; }
    draw();
  }
  function drawRange(w) {
    var L = D.$('#ueRangeL'), Rr = D.$('#ueRangeR');
    if (!L) return;
    L.hidden = RANGE.i == null; Rr.hidden = RANGE.o == null;
    if (RANGE.i != null) { L.style.left = '0px'; L.style.width = X(RANGE.i) + 'px'; }
    if (RANGE.o != null) { Rr.style.left = X(RANGE.o) + 'px'; Rr.style.width = Math.max(0, w - X(RANGE.o)) + 'px'; }
  }
  function removeRange() {
    var a = RANGE.i, b = RANGE.o;
    if (a == null || b == null || b - a < 1 / FPS) return;
    remember();
    var out = [];
    sorted().forEach(function (c) {
      var ca = c.at, cb = end(c);
      if (b <= ca || a >= cb) { out.push(c); return; }
      if (a > ca + 1e-3) out.push(Object.assign({}, c, { e: c.s + (a - ca) }));
      if (b < cb - 1e-3) { var c2 = Object.assign({}, c, { id: UID++, s: c.s + (b - ca), at: b }); delete c2.tin; out.push(c2); }
    });
    if (!out.length) { UNDO.pop(); D.toast('클립을 전부 지울 수는 없습니다'); return; }
    var G = gapsOf();
    CL = out;
    if (RIP) pack(G);
    RANGE = { i: null, o: null };
    changed();
    D.toast('구간을 뺐습니다 (Ctrl+Z 로 되돌림)');
  }
  /* 빈 곳에서 끌어 상자로 여럿 고르기 */
  function marquee(ev) {
    var cr = D.$('#ueContent').getBoundingClientRect(), x1 = ev.clientX - cr.left, y1 = ev.clientY - cr.top, d = drag;
    if (!d.moved && Math.abs(x1 - d.x0) < 4 && Math.abs(y1 - d.y0) < 4) return;
    d.moved = true;
    var m = D.$('#ueMarq'), l = Math.min(d.x0, x1), t = Math.min(d.y0, y1), r = Math.max(d.x0, x1), b = Math.max(d.y0, y1);
    m.hidden = false; m.style.left = l + 'px'; m.style.top = t + 'px'; m.style.width = (r - l) + 'px'; m.style.height = (b - t) + 'px';
    SEL = d.add ? Object.assign({}, d.sel0) : {};
    CSEL = null;
    D.$$('#ueContent .ue-clip').forEach(function (el) {
      var q = el.getBoundingClientRect(), ql = q.left - cr.left, qt = q.top - cr.top;
      if (ql > r || ql + q.width < l || qt > b || qt + q.height < t) return;
      var va = D.$('#ueVA').getBoundingClientRect(), aa = D.$('#ueAA').getBoundingClientRect();   // 넘겨서 가려진 트랙은 빼고
      if ((q.bottom < va.top || q.top > va.bottom) && (q.bottom < aa.top || q.top > aa.bottom)) return;
      var id = el.dataset.xid || +el.dataset.id;
      SEL[id] = true;
      if (el.dataset.xid && LINK && partner(exById(id))) SEL[partner(exById(id)).id] = true;
    });
    D.$$('#ueContent .ue-clip').forEach(function (el) { el.classList.toggle('is-sel', !!SEL[el.dataset.xid || +el.dataset.id]); });
  }
  /* ---------- 그룹 (2026-10-03 사용자: "선택한 클립들에 우클릭 시 그룹 만들기 -> 이름 설정 -> 그룹으로 묶인 경우 설정 변경 시 묶인 클립에 일괄 적용") ----------
     클립마다 g = 그룹 id, 이름은 review.userGroups [{id, name}]. 인스펙터에서 바꾸는 값 (색 · 변형 · 소리 · 불투명도 · 페이드 ...) 은 같은 그룹의
     같은 갈래 (원본 클립 / 그림 덧 클립 / 소리 덧 클립) 에 모두 먹는다 (mates). 위치처럼 클립마다 다른 값은 빼고 */
  var GCOL = ['#e0a33a', '#5aa9e6', '#a88be8', '#5cc48a', '#e6739f', '#d6d65a'];
  function groups() { return (R && R.userGroups) || []; }
  function groupOf(id) { return groups().filter(function (g) { return g.id === id; })[0] || null; }
  function fam(o) { return o.kind ? (o.kind === 'audio' ? 'a' : 'v') : 'c'; }
  function selObjs() { return selected().concat(selX()); }
  function mates(o) {                      // 이 값을 같이 받을 클립들: 같은 그룹 + 같이 고른 같은 갈래
    var M = [o];
    var add = function (y) { if (M.indexOf(y) < 0 && fam(y) === fam(o)) M.push(y); };
    if (o.g) CL.concat(EX).forEach(function (y) { if (y.g === o.g) add(y); });
    selObjs().forEach(add);
    return M;
  }
  function drawGroups() {
    var gs = groups();
    if (!gs.length) return;
    D.$$('#ueContent .ue-clip').forEach(function (el) {
      var o = el.dataset.xid ? exById(el.dataset.xid) : byId(+el.dataset.id), g = o && o.g ? groupOf(o.g) : null;
      if (!g) return;
      var col = GCOL[gs.indexOf(g) % GCOL.length];
      el.style.boxShadow = 'inset 0 3px 0 ' + col;
      var tg = D.el('span', { class: 'ue-grp', text: g.name });
      tg.style.background = col;
      el.appendChild(tg);
    });
  }
  function makeGroup() {
    var objs = selObjs();
    if (objs.length < 2) { D.toast('클립을 둘 이상 고르세요'); return; }
    var n = 1;
    while (groups().some(function (g) { return g.name === '그룹 ' + n; })) n++;
    var inp = D.el('input', { class: 'input', type: 'text', value: '그룹 ' + n });
    var body = D.el('div'); body.appendChild(D.el('p', { class: 'hint', text: objs.length + '개 클립을 묶습니다 - 묶인 클립은 인스펙터에서 바꾼 값이 같이 바뀝니다' })); body.appendChild(inp);
    D.modal.open({
      title: '그룹 만들기', body: body,
      buttons: [{ label: '취소' }, { label: '만들기', class: 'btn-primary', onClick: function () {
        var name = inp.value.trim() || ('그룹 ' + n), id = 'g' + Date.now().toString(36);
        remember();
        R.userGroups = groups().concat([{ id: id, name: name }]);
        objs.forEach(function (o) { o.g = id; });
        changed();
        D.toast('그룹 "' + name + '"');
      } }]
    });
    setTimeout(function () { inp.focus(); inp.select(); }, 30);
  }
  function ungroup() {
    remember();
    selObjs().forEach(function (o) { delete o.g; });
    var used = {};
    CL.concat(EX).forEach(function (o) { if (o.g) used[o.g] = 1; });
    R.userGroups = groups().filter(function (g) { return used[g.id]; });
    changed();
  }
  function selectGroup() {
    var ids = {};
    selObjs().forEach(function (o) { if (o.g) ids[o.g] = 1; });
    CL.concat(EX).forEach(function (o) { if (o.g && ids[o.g]) SEL[o.id] = true; });
    draw();
  }
  function renameGroup() {
    var o = selObjs().filter(function (y) { return y.g; })[0], g = o && groupOf(o.g);
    if (!g) return;
    var inp = D.el('input', { class: 'input', type: 'text', value: g.name });
    D.modal.open({ title: '그룹 이름', body: inp, buttons: [{ label: '취소' }, { label: '바꾸기', class: 'btn-primary', onClick: function () {
      remember(); g.name = inp.value.trim() || g.name; changed(); } }] });
    setTimeout(function () { inp.focus(); inp.select(); }, 30);
  }
  function ctxMenu(ev) {                    // 타임라인 우클릭: 고른 클립에 대한 일
    ev.preventDefault();
    var old = D.$('#ueCtx'); if (old) old.remove();
    var el = ev.target.closest('.ue-clip');
    if (el) { var id = el.dataset.xid || +el.dataset.id; if (!SEL[id]) { SEL = {}; SEL[id] = true; CSEL = null; draw(); } }
    var objs = selObjs(), items = [];
    if (objs.length >= 2) items.push(['그룹 만들기', makeGroup]);
    if (objs.some(function (o) { return o.g; })) { items.push(['그룹 전체 고르기', selectGroup]); items.push(['그룹 이름 바꾸기', renameGroup]); items.push(['그룹 풀기', ungroup]); }
    if (selected().length === 1 && !selected()[0].vhide) items.push(['위 트랙으로' + (LINK ? '' : ''), function () { moveSelTrack(1); }]);
    if (selX().filter(function (x) { return x.kind === 'video' && isSrc(x.path); }).length === 1) items.push(['원본 트랙으로', function () { moveSelTrack(-1); }]);
    if (objs.length) { items.push(['재생 위치에서 자르기', splitAtPlayhead]); items.push(['지우기', removeSel]); }
    if (RANGE.i != null && RANGE.o != null) items.push(['I-O 구간 빼기', removeRange]);
    if (!items.length) return;
    var m = D.el('div', { class: 'ue-ctx', id: 'ueCtx' });
    items.forEach(function (it) {
      var b = D.el('button', { text: it[0] });
      b.addEventListener('click', function () { m.remove(); it[1](); });
      m.appendChild(b);
    });
    m.style.left = ev.clientX + 'px'; m.style.top = ev.clientY + 'px';
    document.body.appendChild(m);
  }

  /* ---------- 도구 · 단축키 (리졸브와 같은 글쇠) ---------- */
  function setTool(t) {
    TOOL = t;
    D.$$('#view-edit [data-tool]').forEach(function (b) { b.classList.toggle('is-on', b.dataset.tool === t); });
  }
  function setSnap(on) { SNAP = on; var b = D.$('#ueSnapBtn'); if (b) b.classList.toggle('is-on', on); }
  function setRipple(on) { RIP = on; var b = D.$('#ueRipBtn'); if (b) b.classList.toggle('is-on', on); }
  function jumpEdit(dir) {
    var t = now(), E = edits(), x = null;
    if (dir > 0) { for (var i = 0; i < E.length; i++) if (E[i] > t + 1e-4) { x = E[i]; break; } }
    else { for (var j = E.length - 1; j >= 0; j--) if (E[j] < t - 1e-4) { x = E[j]; break; } }
    if (x != null) seek(x);
  }
  function key(ev) {
    var k = ev.key, low = (k || '').toLowerCase(), ctrl = ev.ctrlKey || ev.metaKey, v = video();
    if (ctrl) {
      if (low === 'z') { ev.preventDefault(); if (ev.shiftKey) redo(); else undo(); }
      else if (low === 'y') { ev.preventDefault(); redo(); }
      else if (low === 'b') { ev.preventDefault(); splitAtPlayhead(); }
      else if (low === 'a') { ev.preventDefault(); SEL = {}; CL.forEach(function (c) { SEL[c.id] = true; }); draw(); }
      else if (k === '=' || k === '+') { ev.preventDefault(); zoomBy(1.25); }
      else if (k === '-') { ev.preventDefault(); zoomBy(0.8); }
      return;
    }
    switch (k) {
      case ' ': ev.preventDefault(); toggle(); break;
      case 'ArrowLeft': ev.preventDefault(); seek(now() - (ev.shiftKey ? 1 : 1 / FPS)); break;
      case 'ArrowRight': ev.preventDefault(); seek(now() + (ev.shiftKey ? 1 : 1 / FPS)); break;
      case 'ArrowUp': ev.preventDefault(); jumpEdit(-1); break;
      case 'ArrowDown': ev.preventDefault(); jumpEdit(1); break;
      case 'Home': ev.preventDefault(); seek(0); break;
      case 'End': ev.preventDefault(); seek(total()); break;
      case 'Delete': case 'Backspace':
        ev.preventDefault();
        if (TSEL != null) { var tw = transOwner(); if (tw) { remember(); delete tw.tin; TSEL = null; changed(); } }
        else if (CSEL && !selected().length && !selX().length) cutCaption();
        else if (!selected().length && !selX().length && RANGE.i != null && RANGE.o != null) removeRange();
        else removeSel();
        break;
      case 'Escape': pick(null); break;
      default:
        if (low === 'a') setTool('select');
        else if (low === 'c') setTool(TOOL === 'blade' ? 'select' : 'blade');   // 칼 (2026-10-03: "자르기는 c")
        else if (low === 'i') setMark('i');
        else if (low === 'o') setMark('o');
        else if (low === 'x' && ev.altKey) { RANGE = { i: null, o: null }; draw(); }
        else if (low === 'n') setSnap(!SNAP);
        else if (low === 'j') seek(now() - 1);
        else if (low === 'k') { if (v) v.pause(); }
        else if (low === 'l') { if (v && v.paused) toggle(); }
        else if (k === 'Z') fit();
    }
  }


  /* ---------- 렌더 설정 (2026-10-03 사용자: "렌더 탭에서 렌더 버튼은 맨 아래, 렌더 시 필요한 모든 설정 커스텀 가능하게 변경 코덱 설정, 화질 등등
     영상에 맞게 세로 영상은 세로 영상 비율만, 가로 영상은 가로 영상 비율만") ----------
     D.state.render.opts {codec, soft, q, size: [w, h], fps, abr, lufs} -> project.json render.opts -> apply_review.py 가 edit.json output ->
     render.mjs outVideo (조각과 다를 때만 마지막에 한 번 더 인코딩). 해상도 목록은 프리셋 캔버스 비율 그대로 - 세로면 세로 크기만 */
  function rOpts() { D.state.render = D.state.render || {}; return D.state.render.opts || {}; }
  function rSet(k, v) {
    var o = Object.assign({}, rOpts());
    if (v === '' || v == null || v === false) delete o[k]; else o[k] = v;
    D.state.render.opts = Object.keys(o).length ? o : null;
    D.touch();
    rNote();
  }
  function rCanvas() { return (R && R.canvas) || (D.state.layout && D.state.layout.canvas) || [1080, 1920]; }
  function rSizes() {
    var c = rCanvas(), cw = c[0], ch = c[1], out = [], even = function (v) { return Math.round(v / 2) * 2; };
    var names = { 720: '720p', 1080: '1080p', 1440: '1440p (2K)', 2160: '2160p (4K)' };
    [720, 1080, 1440, 2160].forEach(function (s) {          // 짧은 변 기준 - 세로면 가로가 짧은 변
      var w = cw <= ch ? s : even(s * cw / ch), h = cw <= ch ? even(s * ch / cw) : s;
      if (w === cw && h === ch) return;
      out.push([w, h, names[s]]);
    });
    return out;
  }
  function rQLab(q) { return q <= 15 ? '아주 좋음' : q <= 18 ? '좋음' : q <= 22 ? '보통' : q <= 26 ? '작은 파일' : '아주 작은 파일'; }
  function rNote() {
    var o = rOpts(), c = rCanvas(), sz = o.size, re = !!(sz || o.fps || o.codec === 'hevc' || o.soft || (o.q != null && o.q !== 20));
    var n = D.$('#rndNote');
    if (n) n.textContent = re ? '' : '';
    var h = D.$('#rndSizeHint');
    if (h) h.textContent = '';
  }
  function rFill() {
    if (!D.$('#rndCodec')) return;
    var o = rOpts(), c = rCanvas();
    D.$('#rndCodec').value = o.codec || 'h264';
    D.$('#rndEnc').value = o.soft ? 'soft' : '';
    var q = o.q != null ? o.q : 20;
    D.$('#rndQ').value = String(q); D.$('#rndQN').value = String(q); D.$('#rndQLab').textContent = rQLab(q);
    var sel = D.$('#rndSize');
    sel.textContent = '';
    sel.appendChild(D.el('option', { value: '', text: '기본 (' + c[0] + '×' + c[1] + ')' }));
    rSizes().forEach(function (s) { sel.appendChild(D.el('option', { value: s[0] + 'x' + s[1], text: s[0] + '×' + s[1] + ' · ' + s[2] })); });
    var sv = o.size ? o.size[0] + 'x' + o.size[1] : '';
    if (sv && !sel.querySelector('option[value="' + sv + '"]')) sel.appendChild(D.el('option', { value: sv, text: sv.replace('x', '×') + '' }));
    sel.value = sv;
    D.$('#rndFps').value = o.fps ? String(o.fps) : '';
    D.$('#rndAbr').value = o.abr ? String(o.abr) : '';
    D.$('#rndLufs').value = o.lufs != null ? String(o.lufs) : '';
    rNote();
  }
  function rInit() {
    if (!D.$('#rndCodec')) return;
    D.$('#rndCodec').addEventListener('change', function (e) { rSet('codec', e.target.value === 'h264' ? '' : e.target.value); });
    D.$('#rndEnc').addEventListener('change', function (e) { rSet('soft', e.target.value === 'soft'); });
    var setQ = function (v) {
      v = Math.max(12, Math.min(32, Math.round(+v || 20)));
      D.$('#rndQ').value = String(v); D.$('#rndQN').value = String(v); D.$('#rndQLab').textContent = rQLab(v);
      rSet('q', v === 20 ? '' : v);
    };
    D.$('#rndQ').addEventListener('input', function (e) { setQ(e.target.value); });
    D.$('#rndQ').addEventListener('dblclick', function () { setQ(20); });
    D.$('#rndQN').addEventListener('change', function (e) { setQ(e.target.value); });
    D.$('#rndSize').addEventListener('change', function (e) { rSet('size', e.target.value ? e.target.value.split('x').map(Number) : ''); });
    D.$('#rndFps').addEventListener('change', function (e) { rSet('fps', e.target.value ? +e.target.value : ''); });
    D.$('#rndAbr').addEventListener('change', function (e) { rSet('abr', e.target.value ? +e.target.value : ''); });
    D.$('#rndLufs').addEventListener('change', function (e) { rSet('lufs', e.target.value ? +e.target.value : ''); });
    D.$('#rndReset').addEventListener('click', function () { D.state.render.opts = null; D.touch(); rFill(); D.toast('렌더 설정을 기본으로 돌렸습니다'); });
  }

  /* ---------- 불러오기 · 보이기 ---------- */
  function load(review) {
    R = review || null;
    UNDO = []; REDO = []; SEL = {}; CSEL = null; MINW = 0; CL = []; WALL = null; LASTW = null;
    SC = null; BINS = {}; FSEL = null;
    if (R && (R.clips || []).length) {
      var UCs = R.userClips && R.userClips.length ? R.userClips : null;
      var src = UCs ? UCs.map(function (c) { return [c.s, c.e, c.at, c.vol, c]; }) : D.Feedback.basePlan();
      CL = src.map(function (r) {
        var c = { id: UID++, s: r[0], e: r[1], at: r[2] };
        if (r[3]) c.vol = r[3];
        var from = r[4] || (R.clips || []).filter(function (k) { return Math.abs(k.s - r[0]) < 0.01; })[0];   // 렌더한 조각의 색 · 전환
        if (from && from.color) c.color = from.color;
        if (from && from.tin) c.tin = from.tin;
        if (from && from.tf) c.tf = from.tf;
        if (from && from.vhide) c.vhide = true;
        if (from && from.ahide) c.ahide = true;
        if (from && from.fx) c.fx = JSON.parse(JSON.stringify(from.fx));
        if (r[4] && r[4].g) c.g = r[4].g;
        return c;
      });
    }
    EX = JSON.parse(JSON.stringify((R && R.userLayers) || []));
    EX.forEach(function (x) { var n = parseInt(String(x.id || '').slice(1), 10); if (!x.id) x.id = 'x' + (UID++); else if (n >= UID) UID = n + 1; });
    VS = 0; AS = 0;
    var em = D.$('#ueEmpty');
    if (em) { em.hidden = !!CL.length; em.textContent = R ? '컷 정보 없음' : '프로젝트 없음'; }   // 컷 정보 = review.clips (옛 내보내기에는 없다)
    rFill();
    loadMedia();
    drawBins();
    draw();
    if (SHOWN) { mountPlayer(); setTimeout(fit, 0); }
  }
  function resetToAI() {
    if (!R || !R.userClips) { D.toast('이미 AI 컷 그대로입니다'); return; }
    remember();
    delete R.userClips;
    CL = D.Feedback.basePlan().map(function (r) { return { id: UID++, s: r[0], e: r[1], at: r[2] }; });
    SEL = {};
    D.touch(); draw(); refreshScene();
    D.toast('AI 컷으로 되돌림 (Ctrl+Z 로 취소)');
  }
  function shown(on) {
    SHOWN = on;
    if (!on) { var v = video(); if (v && !v.paused) v.pause(); unmountPlayer(); return; }
    mountPlayer();
    setTimeout(function () { fitViewer(); draw(); if (PPS === 80 && total()) fit(); }, 0);
  }

  function mount() {
    var sc = scroller();
    if (!sc) return;
    sc.addEventListener('mousedown', onDown);
    document.addEventListener('mousemove', onMoveQ);
    document.addEventListener('mouseup', onUp);
    D.$('#view-edit .ue-timeline').addEventListener('wheel', onWheel, { passive: false });   // 그냥: 칸마다 트랙 넘김, Ctrl: 가로, Alt: 확대
    sc.addEventListener('contextmenu', ctxMenu);
    sc.addEventListener('dragover', onDragOver);
    sc.addEventListener('dragleave', function (ev) { if (!sc.contains(ev.relatedTarget)) D.$('#ueDrop').hidden = true; });
    sc.addEventListener('drop', onDrop);
    var pool = D.$('#view-edit .ue-pool');      // 소스 칸에도 바깥 파일을 놓을 수 있다
    if (pool) {
      pool.addEventListener('dragover', function (ev) { if (hasFiles(ev)) { ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; pool.classList.add('is-drop'); } });
      pool.addEventListener('dragleave', function (ev) { if (!pool.contains(ev.relatedTarget)) pool.classList.remove('is-drop'); });
      pool.addEventListener('drop', function (ev) { pool.classList.remove('is-drop'); if (!hasFiles(ev) || !ev.dataTransfer.files.length) return; ev.preventDefault(); setPTab('src'); uploadFiles(ev.dataTransfer.files); });
    }
    if (D.$('#ueAddCap')) D.$('#ueAddCap').addEventListener('click', addCaption);
    if (D.$('#ueTitle')) D.$('#ueTitle').addEventListener('click', selectTitle);
    D.$$('#view-edit [data-ptab]').forEach(function (b) { b.addEventListener('click', function () { setPTab(b.dataset.ptab); }); });
    rInit();
    D.$$('#view-edit [data-tool]').forEach(function (b) { b.addEventListener('click', function () { setTool(b.dataset.tool); }); });
    D.$('#ueSnapBtn').addEventListener('click', function () { setSnap(!SNAP); });
    D.$('#ueRipBtn').addEventListener('click', function () { setRipple(!RIP); });
    D.$('#ueLinkBtn').addEventListener('click', function () { LINK = !LINK; D.$('#ueLinkBtn').classList.toggle('is-on', LINK); D.toast(LINK ? '연결: 영상과 소리를 같이' : '연결 끔: 영상 · 소리 따로'); });
    D.$('#ueSplit').addEventListener('click', splitAtPlayhead);
    D.$('#ueDel').addEventListener('click', removeSel);
    D.$('#ueUndo').addEventListener('click', undo);
    D.$('#ueRedo').addEventListener('click', redo);
    D.$('#ueFit').addEventListener('click', fit);
    D.$('#ueReset').addEventListener('click', resetToAI);
    D.$('#ueAddFolder').addEventListener('click', addFolder);
    D.$('#uePlay').addEventListener('click', toggle);
    D.$('#ueStart').addEventListener('click', function () { seek(0); });
    D.$('#ueEnd').addEventListener('click', function () { seek(total()); });
    D.$('#uePrev').addEventListener('click', function () { jumpEdit(-1); });
    D.$('#ueNext').addEventListener('click', function () { jumpEdit(1); });
    D.$('#ueZoom').addEventListener('input', function (ev) {
      var sc2 = scroller(), t = T(sc2.scrollLeft + sc2.clientWidth / 2);
      PPS = Math.exp(+ev.target.value); MINW = 0; draw();
      sc2.scrollLeft = Math.max(0, X(t) - sc2.clientWidth / 2);
    });
    D.$$('#view-edit .ue-tab').forEach(function (b) { b.addEventListener('click', function () { showPane(b.dataset.pane); }); });
    D.$('#ueWords').addEventListener('click', onWord);
    D.$('#ueWords').addEventListener('dblclick', function (ev) { var w = wordOf(ev.target); if (w && covered(w)) seek(srcToT(w.s)); });
    if (window.ResizeObserver) {
      new ResizeObserver(function () { fitViewer(); }).observe(D.$('#ueViewer'));
      new ResizeObserver(function () { if (SHOWN) draw(); }).observe(sc);
      new ResizeObserver(function () { if (SHOWN) draw(); }).observe(D.$('#view-edit .ue-timeline'));
    }
    setTool('select'); setSnap(true); setRipple(true); D.$('#ueLinkBtn').classList.add('is-on');
    document.addEventListener('mousedown', function (ev) { var m = D.$('#ueCtx'); if (m && !m.contains(ev.target)) m.remove(); }, true);
  }

  D.UserEdit = { mount: mount, load: load, shown: shown, key: key, clips: function () { return sorted(); } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})(window.D);
