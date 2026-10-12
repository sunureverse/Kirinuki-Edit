# Codex로 영상 편집하기

Claude Code 없이 Codex 채팅에서 편집 판단과 파일 작업을 맡길 수 있습니다. 대시보드는 모델 API를 호출하거나 이 채팅을 자동 실행하지 않습니다.

## 사용자 순서

1. 이 저장소를 Codex에서 열고 대시보드를 실행합니다.
2. 프로젝트를 만든 뒤 AI 편집 탭에서 원본 영상과 스타일을 고릅니다. 지시와 영상 위 쪽지를 적습니다.
3. **스타일 적용**을 누릅니다. 원본·소스 파일을 서버에 저장하고, 프로젝트 ID와 실제 파일 경로를 포함한 작업 JSON 및 지시문을 `jobs/`에 만듭니다.
4. **Codex에 맡기기 → 요청 복사**를 누르고, **같은 파일에 접근할 수 있는 Codex 채팅**에 붙여넣습니다. 다른 PC/환경의 채팅이라면 요청문만으로 영상이 전달되지 않으므로 영상과 프로젝트 파일도 전달해야 합니다.
5. Codex가 편집 데이터와 미리보기를 갱신하면 프로젝트를 다시 엽니다. 사용자 편집 탭에서 컷·자막·효과를 확인합니다.
6. 추가 수정은 **재편집**을 누른 뒤 새 요청을 Codex에 전달합니다. 최종본은 **사용자 편집 → 렌더**로 만듭니다.

정적 파일로만 열었다면 영상이 서버에 저장되지 않습니다. 표시된 요청문과 함께 영상을 Codex에 전달하세요. 페이지를 다시 연 뒤 원본 파일을 읽을 수 없다는 메시지가 나오면 해당 파일을 다시 넣으세요.

## Codex가 처리할 일

- `AGENTS.md`, 작업 JSON과 Markdown, `projectFile`을 읽습니다. `mediaPaths`의 `group`은 편집 대상(`apply.target`), 추가 재료(`apply.assets`), 스타일 분석 원본(`analyze.src`)과 편집본(`analyze.edited`)을 구분합니다.
- `style.analyze`는 실제 원본과 편집본을 비교해 지시문의 JSON 형식으로 스타일 규칙을 반환합니다. 사용자가 분석 결과 등록에 붙여넣습니다.
- `style.apply`는 프리셋을 확인하고 `edit/<episode>/`에 `edit.json`, `captions.csv`, `fx.json`을 만듭니다. 영상에서 프레임을 추출해 구도를 확인하고, 실제 전사/음성을 근거로 구간과 자막을 정합니다. 자막 CSV 시각은 대시보드 내보내기와 호환되는 `HH:MM:SS.mmm` 형식을 사용합니다.
- 기존 전사를 재사용합니다. 첫 전사가 필요하면 `tools/transcribe_words.py`의 의존성과 모델 접근을 확인하고, 준비된 환경에서 `ALLOW_AI=1 python tools/transcribe_words.py <episode>`를 사용합니다. Whisper `large-v3` 하나로 한국어·일본어·영어를 지원합니다. 기본은 원본 음성 언어 자동 감지이며, `--language ko`, `--language ja`, `--language en`으로 지정할 수도 있습니다. 이것은 원래 언어로 받아쓰기이며 번역 자막 생성은 별도 작업입니다. Codex 연결만으로 전사 모델이 설치되는 것은 아닙니다.
- 프로젝트는 대시보드에서 먼저 저장되어 있어야 합니다. 최초 편집 후 저장소 루트에서 다음을 실행합니다.

```bash
python tools/preview_update.py edit/<episode> <project-id>
```

- 재편집은 사용자 변경을 먼저 반영하고 요청한 부분을 수정한 뒤 같은 미리보기 명령을 실행합니다.

```bash
python tools/apply_review.py edit/<episode> projects/<project-id>/project.json
```

- 최종 렌더를 명시적으로 요청받았을 때만 `shortsmith/`에서 아래 명령을 실행하고 출력 파일을 검사합니다.

```bash
node bin/shortsmith.mjs build ../edit/<episode>
```

## 필요한 환경

자동 감지는 구간마다 언어를 확인하므로 여러 언어가 섞인 영상에도 사용할 수 있습니다. 짧은 발화·잡음·고유명사는 잘못 인식될 수 있어 결과를 확인해야 합니다. 일본어·영어 구간에는 한국어 음절 수 기반 시간 보정을 적용하지 않고 모델의 원래 낱말 시간을 유지합니다.

Python 3.11 이상, Node.js 18 이상, ffmpeg·ffprobe, shortsmith 의존성, 선택한 프리셋의 글꼴이 필요합니다. 별도 Claude Code 설치나 Claude API 키는 필요하지 않습니다. Codex 자체는 사용 중인 앱/계정의 인증을 사용합니다.

작업 요청은 저장만으로 실행되지 않습니다. Codex에 전달한 뒤 실행 결과를 확인하세요. 원본과 작업 폴더는 편집 전 백업하세요.
