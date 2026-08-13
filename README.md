# CGV 구로 경품 안내

Windows 듀얼 모니터 환경을 위한 경품 관리·전시 도구입니다. 관리 화면에서
영화·경품·재고 정보를 수정하면 보조 모니터의 전시 화면에 즉시 반영됩니다.

## v1.4.1 EXE 없는 경량 구조

- 정적 Vite + React 화면
- Windows PowerShell 5.1 로컬 서버(`127.0.0.1:3210`)
- 기존 `%LOCALAPPDATA%\CGVGiftDisplay\inventory.db` SQLite 데이터 호환
- 설치된 Microsoft Edge 또는 Google Chrome을 앱·키오스크 모드로 사용
- 운영 패키지에 자체 EXE, Node.js, npm, Tauri, 브라우저 엔진을 포함하지 않음
- Windows 내장 `winsqlite3.dll`로 기존 SQLite 파일을 직접 사용
- Windows CI에서 압축 해제 용량 10 MiB 이하와 서버 준비 3초 이하 검증

기존의 Tauri/WebView, Rust EXE, Vinext 개발 서버와 휴대용 Node 자동 설치 과정은
제거했습니다. ZIP을 풀고 배치 파일을 실행하면 Windows에 포함된 PowerShell
프로세스 하나만 시작되며, 화면 렌더링은 이미 설치된 브라우저가 담당합니다.

## 주요 기능

- 항목 위·아래 순서 변경 및 같은 영화끼리 안정적으로 묶기
- 영화명, 관람 포맷, 경품명, 재고 현황 관리
- 시작일·종료일·표시 요일에 따른 자동 노출
- 8행 초과 시 자동 페이지 전환
- 보조 모니터 전체화면·항상 위 전시
- 관리 화면의 수정 사항을 전시 화면에 즉시 동기화
- SQLite 자동 저장과 기존 데이터 호환

## Windows에서 실행

1. [Releases](../../releases)에서 최신 `windows-x64` ZIP을 받습니다.
2. ZIP을 원하는 폴더에 완전히 압축 해제합니다.
3. `start-local.bat`를 실행합니다.
4. 관리 화면 오른쪽 위의 **전시 화면 열기**를 누릅니다.

관리자 권한, 자체 EXE 실행 허용, Node.js 설치는 필요하지 않습니다. Windows 10
버전 1511 이상과 Windows PowerShell 5.1을 대상으로 합니다. Edge가 기본값이며
Chrome으로 바꾸는 방법은 아래에 있습니다.

## Edge 또는 Chrome 선택

패키지 루트의 `browser-settings.json`을 메모장으로 엽니다.

    {
      "browser": "edge",
      "executablePath": ""
    }

- Edge: `"browser": "edge"`
- Chrome: `"browser": "chrome"`
- 비표준 설치 경로: `executablePath`에 실행 파일의 전체 경로 지정

예를 들어 Chrome 경로를 직접 지정하려면 JSON의 역슬래시를 두 번 씁니다.

    {
      "browser": "chrome",
      "executablePath": "D:\\Apps\\Chrome\\chrome.exe"
    }

관리 화면과 보조 화면은 항상 이 설정을 함께 사용합니다.

## 데이터 보존과 초기화

관리 데이터는 다음 파일에 저장됩니다.

    %LOCALAPPDATA%\CGVGiftDisplay\inventory.db

새 버전의 ZIP으로 교체해도 데이터는 유지됩니다. `reset-data.bat`는 확인 문구를
입력한 경우에만 운영 데이터를 초기화합니다. `clean-uninstall.bat`는 운영 데이터와
CGV 전용 브라우저 프로필까지 제거하므로 백업 후 사용하세요.

## 개발 및 검증

Node.js는 프런트엔드 빌드 PC에서만 필요하며 운영 ZIP에는 포함되지 않습니다.

    npm ci
    npm run lint
    npm test
Windows 워크플로는 PowerShell 5.1에서 정적 화면, WinSQLite 저장/조회와 재시작,
UTF-8 한글, 서버 준비 시간, 10 MiB 제한 및 EXE/Node/Tauri 미포함을 패키지
자체에서 확인합니다. 실제 물리적 듀얼 모니터의 창 위치는 릴리즈 배포 전 Windows
운영 PC에서 최종 확인해야 합니다.

나눔 글꼴의 저작권과 재배포 조건은
`public/fonts/LICENSE-NANUM-FONT.txt`를 확인하세요. CGV 명칭과 로고 사용 권한은
실제 운영 주체가 별도로 확인해야 합니다.
