# N오더 주방 (데스크톱)

N오더 식당(점주·주방)용 주문 접수 데스크톱 앱. 파트너 화면(`/partner/*`)만 래핑한다.

**설치파일은 연결 서버별로 따로 만든다(0.4.7~).** 0.4.6 까지는 테스트서버 고정이라 실서버 식당이 로그인하지 못했다.

| 빌드 | 연결 서버 | 파일 이름 | 창 제목 |
|---|---|---|---|
| 실서버용 `npm run dist:win:prod` · `dist:mac:prod` | `https://norder.shop` | `NOrder-Kitchen-Setup-<버전>.exe` · `NOrder-Kitchen-<버전>-universal.dmg` | N오더 주방 |
| 테스트용 `npm run dist:win` · `dist:mac` | `https://norder-web-staging.up.railway.app` | 이름 끝 `-staging` | N오더 주방 (staging) |

채널은 `package.json` 의 `norderChannel`(기본 staging)이고, 실서버 스크립트가 빌드 때 `prod` 로 덮는다. 주소 정본은 `src/channel.js`.
빌드 뒤 반드시 `npm run verify:channel -- dist/<파일>...` 로 설치파일을 직접 열어 연결 서버를 확인한다(파일 이름에 `-staging` 이 없으면 norder.shop 이어야 통과).
0.4.6 이 저장해 둔 테스트서버 주소(settings.json)는 실서버용 앱이 처음 켜질 때 실서버 주소로 바꾼다.

## 자동 업데이트 (0.4.10~) — 절차는 [RELEASING.md](RELEASING.md)

- **윈도우만 자동.** 켤 때·1시간마다 확인 → 조용히 받아 둠 → **앱을 끌 때 설치**, 또는 오른쪽 아래 «재시작해서 업데이트»(메뉴 «앱»에도 있음)를 누를 때만. 영업 중 저절로 재시작하지 않는다. 로그인·프린터 설정(설정 폴더)은 그대로 남는다.
- **실서버용은 Latest 릴리스의 `latest.yml`, 테스트용은 `staging-channel` 릴리스의 `staging.yml`** 만 본다 — 서로의 설치파일을 받지 않는다(이름 검사까지 3겹).
- 맥은 ad-hoc 서명이라 자동 설치 불가 → «새 버전 받기» 안내만.
- 오프라인·GitHub 장애 때는 아무것도 띄우지 않는다(설정 폴더 `update.log` 에만 기록).
- 🔴 **서버 API·DB 변경이 필요한 앱 버전은 외부 개발자가 실서버 반영을 확인하기 전까지 Latest 로 올리지 않는다**(사전 릴리스·초안으로 둔다). Latest 가 되면 모든 매장이 받는다.

- 신규 주문 감시(«신규 (N)» 탭 카운트) → 소리·전면 팝업·OS 알림·Dock 배지(맥)/작업표시줄 깜빡임(윈도우). **수락·거절(자동거절 포함)될 때까지 30초마다 다시 알림**(주문판 밖 화면에서도)
- 주문이 수락되면 — **휴대폰·웹에서 수락해도** — 주방프린터로 전표 자동 인쇄. 서버 인쇄 기록(찜)으로 앱 두 대·재시작·재시도에도 한 번만 찍힌다. 기준: **최근 15분 안에 수락된** 주문만(설치 전·오래된 주문은 안 쏟아짐). 실패하면 하단 띠 + OS 알림, 1분 뒤 자동 재시도(최대 3번), 주문판 카드 [주문서 재인쇄]는 언제든 가능 — 기본 **이미지(래스터) 방식**이라 프린터 기종·한글 펌웨어와 무관하게 전 ESC/POS 기종 호환. 텍스트(CP949) 방식은 옵션. 네트워크(9100)/USB RAW/OS 폴백/미리보기
- 전체화면(키오스크) 모드(F11) · 윈도우 부팅 시 자동 실행 옵션 · 화면 절전 방지
- 파트너 외 경로(고객·어드민) 이동 차단 — 예외: 임시 비밀번호 직원의 첫 로그인 비밀번호 변경 화면(`/admin/password`)과 그 화면의 로그아웃(0.4.7~, 막으면 무한 반복)
- 앱에서 로그인하면 앱을 켜 두는 동안 로그인이 풀리지 않는다(서버가 앱 세션만 쓰는 동안 12시간씩 연장 — 12시간 넘게 꺼 두면 다시 로그인). 휴대폰·웹 브라우저 로그인은 12시간 고정

> **매장마다 1대.** 앱은 로그인한 매장 하나의 주문만 알리고 인쇄한다. 앱에서 매장을 바꾸면 앞 매장의 새 주문 알림과 자동 인쇄가 끊긴다 — 매장이 여럿이면 매장마다 PC 1대에 설치해 그 매장 계정으로 로그인한다. (같은 매장에 2대를 켜 두어도 전표는 한 번만 인쇄된다.)

## 개발

```bash
npm install
npm start           # 로컬 실행(테스트서버) · npm run start:prod 는 실서버
npm run dist:win    # 윈도우 NSIS 설치파일 (dist/NOrder-Kitchen-Setup-*.exe)
npm run dist:mac    # macOS dmg (universal). 서명·공증 자격증명은 electron-builder.env — SIGNING.md 참고
npm run verify:mac-sign   # 맥 빌드 서명 상태 게이트
npx electron tools/e2e_updater   # 자동 업데이트 검사(가짜 통로) · E2E_REAL=1 이면 실제 GitHub 통로
```

macOS 서명·공증(Developer ID + notarization) 설정과 필요한 자격증명 목록은 [SIGNING.md](SIGNING.md).

로그인: staging 시드 식당 계정 — 아이디는 휴대폰 번호 (`010-5555-0101` / `partner1234!`)
