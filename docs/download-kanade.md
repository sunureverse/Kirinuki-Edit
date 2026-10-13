# 奏 방송 다시보기 일괄 다운로드 (Windows)

`download-kanade.cmd`를 실행하면 공개된 종료 방송을 최대 1080p로 **3개씩 동시에** 다운로드합니다. Node.js 22 이상과 ffmpeg·ffprobe가 필요합니다. 기본 저장 위치는 사용자가 정한 `D:\kirinuki_source\kanade`입니다.

## 실행 순서

1. GitHub 기본 `main`에서 최신 ZIP을 내려받아 **새 폴더**에 압축을 풉니다. 기존 프로젝트·영상 폴더를 덮어쓰지 마세요.
2. 그 폴더의 **`download-kanade.cmd`를 두 번 클릭**합니다. yt-dlp와 JavaScript 지원 패키지를 갱신한 뒤 시작합니다.
3. `Listed`는 채널 목록 개수, `already downloaded`는 이전에 받은 개수, `queued`는 이번 작업 개수입니다. 각 영상 진행은 `download-logs/<영상ID>.log`에서 확인할 수 있습니다.
4. 검은 창을 계속 열어둡니다. 멈추려면 Ctrl+C를 누릅니다. 같은 파일을 다시 실행하면 받은 영상은 건너뛰고, 일부 받은 영상은 가능한 범위에서 이어받습니다.

채널 영상 ID 목록을 한 번만 읽고 나눠 처리하므로 작업자마다 다른 목록 위치를 사용하는 문제를 피합니다. `downloaded.txt`는 yt-dlp가 성공한 영상만 기록하고 파일 잠금으로 동시 저장합니다. 이전에 개별 다운로드한 영상도 파일명에 영상 ID가 있고 ffprobe로 영상·오디오를 확인할 수 있으면 기록에 추가해 건너뜁니다.

완료 결과는 `last-run.json`, 개별 오류는 `download-logs`에 있습니다. 필터 때문에 제외된 진행 중 방송·예정 방송은 `skipped`로 표시됩니다. 비공개·삭제·지역 제한 등으로 접근할 수 없는 영상은 모두 받을 수 있다고 보장할 수 없습니다. 실패는 다른 다운로드를 막지 않으며, 오류가 있으면 마지막에 실패 개수를 표시합니다.

완료 영상은 주로 MKV이며 선택된 형식에 따라 다른 확장자도 있을 수 있습니다. `downloaded.txt`와 `.part` 파일은 재개를 위해 보관하세요. 방송 전체는 큰 저장 공간이 필요합니다. 다운로드와 클립 공개에 적용되는 권리자·YouTube 이용 조건은 별도로 확인하세요.

## PowerShell에서 직접 실행

압축을 푼 새 폴더에서 PowerShell을 열고 실행합니다. 다른 폴더에서 실행하면 `tools` 파일을 찾지 못합니다.

```powershell
python -m pip install -U "yt-dlp[default]"
python tools\download_channel.py --output "D:\kirinuki_source\kanade" --workers 3
```

연결이 불안정하면 `--workers 1`로 줄이세요. 이 도구는 다운로드를 사용자 PC에서 실행하며, 클라우드 채팅이 D: 드라이브에 직접 저장하는 기능은 아닙니다.
