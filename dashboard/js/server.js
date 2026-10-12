/* server.js - 로컬 서버와의 연결.

   대시보드와 서버의 수명을 맞춘다. 페이지가 열려 있는 동안 핑을 보내고, 닫힐
   때 작별 신호를 보낸다. 서버는 붙어 있는 페이지가 없어지면 스스로 내려간다.

   서버가 있으면 작업을 jobs/ 폴더에 파일로 떨어뜨려 Codex가 읽게
   하고, 없으면(정적 파일만 서비스 중이면) 예전처럼 클립보드로 넘긴다. 어느
   쪽이든 모델 API는 직접 부르지 않는다. */
(function (D) {
  'use strict';

  var S = {
    online: false,
    jobsDir: '',
    id: 'dash-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36),
    interval: 3000,
    timer: null,
    warned: false,
    submitting: false
  };

  function setBadge() {
    var el = D.$('#srvState');
    if (!el) return;
    el.classList.toggle('is-on', S.online);
    el.classList.toggle('is-off', !S.online);
    el.title = S.online
      ? '로컬 서버 연결됨 · 작업을 파일로 넘깁니다\n' + S.jobsDir
      : '로컬 서버 없음 · 작업을 클립보드로 넘깁니다';
    var t = el.querySelector('span');
    if (t) t.textContent = S.online ? '서버' : '서버 없음';
  }

  function post(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  /* 한 번 찔러 보고 끝내면, 서버가 페이지보다 늦게 뜨거나 중간에 다시 뜬
     경우 배지가 영영 "서버 없음"으로 남는다. 그래서 상태를 물어보는 게 아니라
     핑 자체를 계속 돌린다 - 붙으면 그때 작업 폴더를 물어보고, 끊기면 다음
     핑에서 알아서 다시 붙는다. 양방향으로 스스로 맞춰진다. */
  function ping() {
    /* 숨은 탭은 타이머가 1분에 한 번까지 늦춰진다 - 숨었다고 알려 서버가 기다리게 한다 (server.py HIDDEN_TTL) */
    return post('/api/ping', { id: S.id, hidden: document.hidden }).then(function () {
      if (S.online) return;
      S.online = true;
      S.warned = false;
      setBadge();
      /* 경로로만 있는 원본(프리셋 배경 같은 것)은 서버가 붙어야 열린다.
         페이지가 먼저 뜨면 미리보기가 그것 없이 그려지므로 다시 그리게 한다. */
      D.emit('server:online');
      fetch('/api/status').then(function (r) { return r.json(); }).then(function (st) {
        S.jobsDir = st.jobsDir || '';
        if (st.pingInterval && st.pingInterval * 1000 !== S.interval) {
          S.interval = st.pingInterval * 1000;
          clearInterval(S.timer);
          S.timer = setInterval(ping, S.interval);
        }
        setBadge();
        D.info('로컬 서버에 연결되었습니다. 작업을 파일로 넘깁니다: ' + S.jobsDir, 'server');
      }).catch(function () {
        D.info('로컬 서버에 연결되었습니다.', 'server');
      });
    }).catch(function () {
      if (S.online) {
        S.online = false;
        setBadge();
        D.warn('로컬 서버 연결이 끊겼습니다. 작업은 클립보드로 넘어갑니다.', 'server');
      } else if (!S.warned) {
        S.warned = true;
        setBadge();
        D.info('정적 서버로 열렸습니다. 작업은 클립보드로 넘어갑니다. ' +
          '파일로 넘기려면 대시보드.cmd 로 여세요.', 'server');
      }
    });
  }

  S.start = function () {
    if (S.timer) clearInterval(S.timer);
    ping();
    S.timer = setInterval(ping, S.interval);

    /* 숨거나 다시 보일 때 바로 알린다 - 늦춰진 다음 핑까지 기다리면 서버가 그 사이 탭이 닫혔다고 본다.
       멈추기(freeze) 직전에도 숨었다고 한 번 더 남긴다 */
    document.addEventListener('visibilitychange', function () { ping(); });
    document.addEventListener('freeze', function () {
      try {
        navigator.sendBeacon('/api/ping',
          new Blob([JSON.stringify({ id: S.id, hidden: true })], { type: 'application/json' }));
      } catch (e) { /* 남길 곳이 없다 */ }
    });

    /* 탭을 닫거나 다른 페이지로 가면 서버에 알린다. unload는 요즘 브라우저에서
       무시될 수 있어 pagehide를 쓰고, sendBeacon이라 응답을 기다리지 않는다. */
    window.addEventListener('pagehide', function () {
      if (!S.online) return;
      try {
        navigator.sendBeacon('/api/bye',
          new Blob([JSON.stringify({ id: S.id })], { type: 'application/json' }));
      } catch (e) { /* 닫히는 중이라 남길 곳이 없다 */ }
    });
  };

  /* 작업 넘기기. 서버가 있으면 파일로, 없으면 클립보드로. */
  function prepareMedia(job, pid) {
    var keys = job.task === 'style.analyze' ? ['analyze.src', 'analyze.edited']
      : job.task === 'style.apply' ? ['apply.target', 'apply.assets'] : [];
    var paths = [];
    // 브라우저의 File 이름은 서버 경로가 아니다. 파일을 먼저 저장한 후 매핑한다.
    return keys.reduce(function (chain, key) {
      return chain.then(function () {
        return D.flatten(D.state.ai.drops[key] || []).reduce(function (uploads, node) {
          return uploads.then(function () {
            var file = D.fileOf(node);
            if (!file) {
              if (!node.serverPath && !/^(\/|[A-Za-z]:[\\/])/.test(node.path || '')) {
                throw new Error(node.name + ' 파일을 다시 넣어주세요. 브라우저 파일을 읽을 수 없습니다.');
              }
              paths.push({ group: key, original: node.path, path: node.serverPath || node.path });
              return;
            }
            return fetch('/api/media/upload?project=' + encodeURIComponent(pid)
              + '&name=' + encodeURIComponent(file.name), { method: 'POST', body: file })
              .then(function (r) {
                if (!r.ok) throw new Error(node.name + ' 업로드 실패 (HTTP ' + r.status + ')');
                return r.json();
              }).then(function (r) {
                if (!r.ok) throw new Error(r.error || '파일 저장 실패');
                node.serverPath = r.path;
                paths.push({ group: key, original: node.path, path: r.path });
              });
          });
        }, Promise.resolve());
      });
    }, Promise.resolve()).then(function () { job.mediaPaths = paths; });
  }

  function showCodexRequest(kind, request) {
    var box = D.el('div');
    box.appendChild(D.el('p', { text: '아래 요청을 이 저장소를 연 Codex 채팅에 붙여넣으세요. 편집이 끝나면 프로젝트를 다시 여세요.' }));
    var text = D.el('textarea', { class: 'inp', rows: '9', readonly: 'readonly' });
    text.value = request;
    box.appendChild(text);
    D.modal.open({ title: kind + ' · Codex에 맡기기', body: box, buttons: [
      { label: '요청 복사', class: 'btn-primary', onClick: function () { D.copy(request, 'Codex 편집 요청'); return false; } },
      { label: '닫기' }
    ] });
  }

  S.submit = function (kind, prompt, job) {
    if (!S.online) {
      var offline = '이 저장소의 AGENTS.md와 docs/codex-editing.md에 따라 편집해 주세요.\n'
        + '영상은 별도로 첨부하거나 실제 경로를 알려주세요.\n\n' + prompt
        + '\n\n작업 JSON:\n' + JSON.stringify(job, null, 2);
      showCodexRequest(kind, offline);
      D.warn('서버가 없어 영상은 저장되지 않았습니다. Codex에 영상도 전달하세요.', 'handoff');
      return Promise.resolve();
    }
    if (S.submitting) {
      D.toast('이미 작업을 준비하고 있습니다. 잠시 기다려주세요.');
      return Promise.resolve();
    }
    S.submitting = true;
    var pid;
    D.toast('Codex 작업 준비 중 · 영상 저장');
    return D.Projects.save({ force: true, thumb: false }).then(function () {
      pid = D.state.project.id;
      job.project = pid;
      return prepareMedia(job, pid);
    }).then(function () {
      if (D.state.project.id !== pid) throw new Error('프로젝트가 바뀌었습니다. 원래 프로젝트에서 다시 요청하세요.');
      // 업로드 경로도 프로젝트에 남겨 다음에 열어도 사용할 수 있게 한다.
      return D.Projects.save({ force: true, thumb: false });
    }).then(function () {
      return post('/api/job', { kind: kind, prompt: prompt, job: job });
    }).then(function (r) {
      D.info(kind + ' 작업 준비 완료: ' + r.job + ' · 요청을 Codex 채팅에 붙여넣으세요.', 'handoff');
      showCodexRequest(kind, r.request);
    }).catch(function (e) {
      D.error('Codex 작업 준비 실패: ' + e.message, 'handoff');
      D.toast('작업 준비 실패 · 로그를 확인하세요');
    }).finally(function () { S.submitting = false; });
  };

  /* 스타일은 프로젝트가 아니라 대시보드 전체가 쓰는 것이라 서버의
     styles/ 폴더에 둔다. 프로젝트 안에 넣어 두면 한 편에서 분석해 둔
     스타일을 다음 편집에서 못 고른다. */
  S.listStyles = function () {
    return fetch('/api/styles').then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  };
  S.saveStyle = function (data) { return post('/api/style/save', { data: data }); };
  S.deleteStyle = function (file) { return post('/api/style/delete', { file: file }); };

  /* 렌더는 작업 파일이 아니라 서버가 직접 돌린다. 굽는 데 몇 분씩 걸려서
     요청은 바로 돌아오고, 진행은 물어봐야 한다. */
  S.startRender = function (body) { return post('/api/render', body); };
  S.renderStatus = function (id) {
    return fetch('/api/render/status?id=' + encodeURIComponent(id))
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      });
  };

  D.Server = S;
})(window.D);
