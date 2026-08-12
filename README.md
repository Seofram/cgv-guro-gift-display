# CGV 구로 경품 안내

Windows 듀얼 모니터 환경을 위한 경품 관리·전시 데스크톱 앱입니다. 관리 창에서
영화·경품·재고 정보를 수정하면 두 번째 모니터의 전시 창에 즉시 반영됩니다.

## 데스크톱 전환 상태

- Tauri 2 네이티브 관리 창과 두 번째 모니터 전시 창
- Vite + React 공용 UI
- 기존 %LOCALAPPDATA%\CGVGiftDisplay\inventory.db SQLite 데이터 유지
- 운영 PC에서 Node.js, npm, 별도 브라우저, 로컬 서버 불필요
- 공유 WebView2를 제외한 설치 용량 50 MiB 이하 CI 검증
- 일반 재실행 후 관리 화면 준비 2초 이하 CI 검증

기존 웹 개발 경로도 같은 React 컴포넌트를 사용하므로 UI 변경이 데스크톱과 웹에
동시에 반영됩니다.

## 주요 기능

- 항목 위·아래 순서 변경 및 같은 영화끼리 안정적으로 묶기
- 영화명, 관람 포맷, 경품명, 재고 현황 관리
- 시작일·종료일·표시 요일에 따른 자동 노출
- 제공 중, 소진 중, 소진 임박, 재고 소진, 준비 중 상태 표시
- 8행 초과 시 자동 페이지 전환
- 두 번째 모니터 전체화면·항상 위 전시
- 관리 창의 수정 사항을 전시 창에 즉시 동기화
- SQLite 자동 저장과 기존 데이터 호환

## Windows에서 설치

1. [Releases](../../releases) 또는 GitHub Actions 아티팩트에서 최신 Windows
   x64 설치 파일을 내려받습니다.
2. 설치 파일을 실행합니다. 관리자 권한이나 Node.js 설치는 필요하지 않습니다.
3. 시작 메뉴의 CGV 구로 경품 안내를 실행합니다.
4. 관리 창 오른쪽 위의 전시 화면 열기를 누릅니다.

전시 창은 기본 모니터가 아닌 첫 번째 사용 가능 모니터에 전체화면으로 열립니다.
보조 모니터가 없으면 현재 모니터를 사용합니다.

## 데이터 보존

관리 데이터는 다음 파일에 저장됩니다.

    %LOCALAPPDATA%\CGVGiftDisplay\inventory.db

새 버전을 설치하거나 앱을 제거해도 이 파일은 자동 삭제하지 않습니다. 운영 전에는
파일을 별도로 백업하는 것이 좋습니다. 데이터를 초기화하려면 앱을 완전히 종료하고
이 파일을 다른 위치로 옮긴 뒤 다시 실행합니다.

## 운영 PC 최종 검증

GitHub Actions의 Windows 아티팩트를 압축 해제하면 설치 파일과 함께
verify-desktop-install.ps1, README_사용법.md, SHA256SUMS.txt가 들어 있습니다.
실제 기존 DB와 물리적 듀얼 모니터 검증은 이 검증 스크립트로 수행합니다.
실행 중인 기존 웹 버전과 데스크톱 앱을 모두 종료한 뒤 설치된 실행 파일 경로를
지정합니다.
설치 위치가 예시와 다르면 파일 탐색기에서 cgv-guro-gift-display.exe를 찾아
그 전체 경로로 바꿉니다.

    powershell -NoProfile -ExecutionPolicy Bypass -File .\verify-desktop-install.ps1 -ApplicationPath "C:\Program Files\CGV 구로 경품 안내\cgv-guro-gift-display.exe"

검증 도구는 실행 전 기존 DB 백업, 물리 모니터 2대, 네이티브 관리·전시 창,
비기본 모니터 전체화면, 기존 데이터 운영자 확인, 50 MiB 이하 설치 크기,
Node/npm/브라우저 런타임과 로컬 서버 부재, 일반 재실행 2초 이하를 확인합니다.

통과하면 DB 폴더에 desktop-verification-*.json 보고서와 검증 전 DB 백업 폴더를
남깁니다. 백업 폴더에는 SQLite WAL 데이터가 있을 경우 inventory.db-wal과
inventory.db-shm도 함께 보존됩니다.

## 개발

Node.js는 빌드·개발 PC에서만 필요하며 요구 버전은 22.13.0 이상입니다.

    npm ci
    npm test
    npm run desktop:check
    npm run tauri -- build --bundles nsis
    cargo test --locked --manifest-path src-tauri/Cargo.toml

나눔 글꼴의 저작권과 재배포 조건은
public/fonts/LICENSE-NANUM-FONT.txt를 확인하세요. CGV 명칭과 로고 사용 권한은
실제 운영 주체가 별도로 확인해야 합니다.
