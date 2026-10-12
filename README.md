# Kirinuki-Edit - 미완성

## ※ 주의

- 전체 코드를 Claude Code로 제작했으며, 개발자가 직접 수정하지 않았습니다.
- 개발은 당분간 중단될 예정입니다. 버그 수정이나 기능 추가, 문의 대응을 보장하지 않습니다.
- 사용 전에 원본 영상과 작업 폴더를 반드시 백업하세요. 이 도구가 만든 파일이나 설정, 폴더가 기존 작업을 덮어쓰거나 망가뜨릴 수 있고, 그로 인한 손실에 책임지지 않습니다.

## 구조

방송 다시보기에서 쇼츠와 롱폼 편집본을 만드는 작업 폴더입니다. 세 부분으로 나뉩니다.

| 부분 | 폴더 | 하는 일 |
|---|---|---|
| 편집 엔진 | `shortsmith/` | 편 폴더의 `edit.json` · `fx.json` 을 읽어 컷 → 화면 → 장면 → 렌더까지 합니다. 자막과 연출은 React, 영상은 ffmpeg 가 그립니다 |
| 대시보드 | `dashboard/` | 브라우저에서 쓰는 편집 화면입니다. AI 에게 지시하고, 타임라인에서 직접 고치고, 완성본을 굽습니다 |
| 도구 | `tools/` | 전사, 대시보드와 편 폴더 사이 주고받기, 미리보기 갱신, 댄스 카메라 같은 보조 스크립트입니다 |

- 화면 사용법: [대시보드 가이드](docs/대시보드_가이드.md)
- Codex에 편집 맡기기: [Codex 편집 가이드](docs/codex-editing.md)
- 작업 규칙 (영어): [CLAUDE.md](CLAUDE.md)
- 대시보드 코드 구조 (영어): [dashboard/README.md](dashboard/README.md)

## 준비

- Python 3.11 이상
- Node.js 18 이상
- `PATH` 에 ffmpeg 와 ffprobe
- 엔진 패키지 설치:

```bash
cd shortsmith
npm install
```

## 대시보드 켜기

```bash
python dashboard/server.py --port 8899 --open
```

| 인자 | 기본값 | 뜻 |
|---|---|---|
| `--port` | 8899 | 주소는 `http://localhost:8899` |
| `--projects` | `projects/` | 프로젝트 저장소 (프로젝트마다 `project.json` 과 가져온 파일 `media/`) |
| `--jobs` | `jobs/` | AI 에게 넘기는 작업 글이 쌓이는 곳 |
| `--open` | 꺼짐 | 브라우저를 같이 엽니다 |

브라우저 탭을 모두 닫으면 서버도 잠시 뒤 저절로 꺼집니다.

## 한 편을 만드는 순서

1. **AI 편집 탭 · 스타일 적용**: 원본과 스타일을 고르고, 지시와 영상 위 쪽지를 적어 넘깁니다. 원본을 서버에 저장하고 `jobs/` 에 작업 글이 생깁니다.
2. **Codex에 맡기기**: 표시된 **요청 복사**를 눌러 같은 저장소를 연 Codex 채팅에 붙여넣습니다. Codex가 편 폴더 (`edit/<편>/`) 에 `edit.json` · `captions.csv` · `fx.json` 을 씁니다. 작업 저장만으로 자동 실행되지는 않습니다. Claude Code나 Claude API 키는 필요하지 않습니다.
   이때는 완성본을 굽지 않고 미리보기만 만듭니다.
   ```bash
   python tools/preview_update.py edit/<편> <프로젝트 id>
   ```
3. **사용자 편집 탭**: 컷 · 트랙 · 색 · 변형 · 이펙트 · 자막을 직접 고칩니다. 원본은 그대로 두고, 고친 것은 미리보기에 바로 보입니다.
4. 프로젝트를 다시 열어 결과를 확인합니다. 더 고칠 것은 **재편집**으로 새 요청을 만들어 Codex 채팅에 전달합니다.
5. **사용자 편집 > 렌더**: 마지막에 한 번 굽습니다. 서버가 아래 순서로 돌립니다.
   - `tools/apply_review.py` (대시보드에서 고친 것을 편 폴더에 반영)
   - `shortsmith cuts` (컷이 바뀌었을 때)
   - `shortsmith build`
   - `tools/export_shortsmith.py` (결과를 대시보드로 되돌림)

## 엔진 명령 (shortsmith)

`shortsmith` 폴더 안에서 돌립니다. 다른 폴더에서 돌리면 Remotion 이 그 폴더에 브라우저 (약 500MB) 를 새로 받습니다.

```bash
node bin/shortsmith.mjs build <편 폴더>
```

| 명령 | 하는 일 |
|---|---|
| `build <편>` | 컷 · 화면 · 장면 · 렌더 전부 |
| `preview <편>` | 컷 · 장면만 (완성본은 굽지 않고, 미리보기 배경도 만듦) |
| `cuts` · `body` · `scene` · `render` | 한 단계씩 |
| `still <편> <초> <png>` | 한 장 뽑기 |
| `doctor --preset <id>` | 글꼴 · 도구 점검 |
| `presets` | 프리셋 목록 |

자세한 설명은 [shortsmith/README.md](shortsmith/README.md) 에 있습니다.

## 자주 쓰는 도구

| 도구 | 하는 일 |
|---|---|
| `tools/transcribe_words.py <편>` | 낱말 단위 전사 (AI 를 씁니다 - `ALLOW_AI=1`) |
| `tools/export_shortsmith.py <편> <id>` | 편 폴더 → 대시보드 프로젝트 |
| `tools/apply_review.py <편> <project.json>` | 대시보드에서 고친 것 → 편 폴더 |
| `tools/preview_update.py <편> <id>` | 완성본을 굽지 않고 미리보기만 갱신 |
| `tools/dance_camera.py <편>` | 댄스 편의 카메라 경로 |
| `tools/edit_audit/` | 컷 · 자막 검사 도구 모음 (설명은 폴더 안 README) |

## 라이선스

Copyright (C) 2026 seoldam82

- 이 저장소: GPL-3.0 ([LICENSE](LICENSE))
- `shortsmith/`: AGPL-3.0 ([shortsmith/LICENSE](shortsmith/LICENSE))
- 영상 렌더링에 [Remotion](https://www.remotion.dev/) 을 씁니다. Remotion 은 개인과 3명 이하 회사는 무료이고, 그보다 큰 회사는 [Remotion 회사 라이선스](https://www.remotion.dev/license)가 필요합니다. 이 프로젝트가 쓰는 Remotion 패키지에는 Remotion 자체 라이선스가 그대로 적용됩니다.
- 글꼴은 포함되어 있지 않습니다. 파일을 다시 배포하기 전에 각 글꼴의 라이선스를 확인하세요.
