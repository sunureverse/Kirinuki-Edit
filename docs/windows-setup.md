# Windows에서 처음 실행하기

이 페이지는 개발을 처음 하는 사용자를 위한 안내입니다. 클라우드와 내 PC는 서로 다른 컴퓨터이므로 PC에서도 설치해야 합니다. 영상과 모델 다운로드 공간을 포함해 여유 공간을 최소 10GB 이상 확보하세요.

## 1. 프로그램 받기

[GitHub 저장소](https://github.com/sunureverse/Kirinuki-Edit)를 열고 기본 `main`에서 **Code → Download ZIP**을 누릅니다. ZIP 안에서 바로 실행하지 말고 압축을 풀어 주세요. 예를 들어 `C:\Kirinuki-Edit`에 넣습니다. 그 안에 `install-windows.cmd`와 `dashboard` 폴더가 보이면 됩니다.

## 2. 필요한 도구 설치하기

Windows의 시작 버튼을 오른쪽 클릭하고 **터미널**을 엽니다. 터미널은 컴퓨터에 명령을 입력하는 창입니다. 아래 명령을 한 줄씩 붙여넣고 Enter를 누르세요. `winget`은 Windows의 프로그램 설치 도구입니다. 설치 과정에서 표시되는 조건을 확인하세요.

```powershell
winget install --id Python.Python.3.12 --exact
winget install --id OpenJS.NodeJS.LTS --exact
winget install --id Gyan.FFmpeg --exact
```

설치가 끝나면 터미널을 닫고 새로 열어 아래를 각각 실행합니다.

```powershell
python --version
node --version
ffmpeg -version
ffprobe -version
```

버전 정보가 표시되면 준비됐습니다. `winget`을 찾을 수 없으면 Microsoft Store에서 **앱 설치 관리자(App Installer)**를 설치/업데이트합니다. Python이 Microsoft Store만 열거나 명령을 찾지 못하면 그 화면과 오류를 Codex에 알려주세요. 공식 설치 파일로 설치할 때는 Python의 **Add python.exe to PATH** 옵션을 선택해야 합니다.

## 3. 프로젝트 설치하기

압축을 푼 폴더의 **`install-windows.cmd`를 두 번 클릭**하세요. 편집 엔진, 음성 인식 도구와 기본 글꼴을 다운로드합니다. 작업 폴더 안의 `venv`는 Python 도구, `local-fonts`는 기본 글꼴을 보관합니다.

`Installation complete`가 나오면 설치가 끝났습니다. 오류가 나면 창을 닫기 전에 마지막 오류를 복사하거나 캡처해서 Codex에 알려주세요.

이 설치 파일은 인터넷 다운로드가 필요합니다. 기본 글꼴은 OFL 배포본이며 다운로드 후 SHA-256을 확인합니다. Whisper `large-v3` 모델은 첫 전사 때 별도로 약 3GB를 다운로드합니다. GPU가 없어도 CPU에서 작동하지만 긴 영상은 오래 걸릴 수 있습니다.

## 4. 편집 화면 열기

`dashboard` 폴더의 **`dashboard.cmd` 또는 `대시보드.cmd`를 두 번 클릭**합니다. 브라우저에서 로컬 편집 화면이 열립니다. 서버가 실행되는 검은 창은 닫지 마세요. 종료하려면 그 창에서 Ctrl+C를 누릅니다.

프로젝트를 만들고 처음에는 짧은 영상으로 시험하세요. 스타일 적용 → Codex 요청 복사 → 같은 폴더를 연 Codex 채팅에 붙여넣기 순서로 편집을 맡깁니다. [Codex 편집 가이드](codex-editing.md)를 참고하세요.

PC 영상은 클라우드 채팅에서 직접 읽을 수 없습니다. 사용자 PC의 프로젝트 폴더에 접근할 수 있는 Codex에서 실행하거나, 클라우드 채팅에 영상과 필요한 프로젝트 파일을 전달해야 합니다. Codex 앱에서 해당 로컬 폴더를 열 수 있는지는 사용 중인 앱의 지원 기능을 확인하세요.

## 5. 자동 자막

한 모델로 한국어·일본어·영어를 받아씁니다. 기본은 구간별 언어 자동 감지입니다. Codex에 “일본어 영상이고 한국어 번역 자막도 만들어줘”처럼 요청할 수도 있습니다. 원문 전사와 번역은 별도 단계입니다.

Codex가 실행할 명령 예시는 다음과 같습니다. `<편폴더>`는 실제 작업 폴더 이름이며, 그대로 입력하는 문자가 아닙니다.

```powershell
$env:ALLOW_AI = "1"
.\venv\Scripts\python.exe tools\transcribe_words.py edit\<편폴더> --language auto
```

한국어 고정은 `--language ko`, 일본어는 `--language ja`, 영어는 `--language en`입니다. 이미 전사가 있으면 모델을 다시 실행하지 않고 재사용합니다.

## 현재 검증 범위

클라우드 Linux에서 편집·렌더링, 기본 글꼴, CPU 음성 인식과 실제 영어 샘플을 검증했습니다. Windows 설치 파일은 Windows에서 실행 검증하지 않았습니다. 처음 실행하며 발생한 오류는 환경 문제와 코드 문제를 구분해 해결해야 합니다. 원본 영상과 작업 폴더는 백업하세요.
