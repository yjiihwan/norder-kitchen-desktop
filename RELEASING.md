# 주방 앱 릴리스 절차 (0.4.10~ 자동 업데이트)

## 업데이트 통로 — 실서버용·테스트용이 서로의 파일을 볼 수 없다
| 앱 | 확인하는 파일 | 위치 | 받는 설치파일 |
|---|---|---|---|
| 실서버용(norder.shop) | `latest.yml` | **Latest** 릴리스 (`releases/latest/download/`) | `NOrder-Kitchen-Setup-<버전>.exe` |
| 테스트용(staging) | `staging.yml` | 사전 릴리스 **`staging-channel`** (`releases/download/staging-channel/`) | `NOrder-Kitchen-Setup-<버전>-staging.exe` |

막는 장치 3겹: ① 통로 주소가 다르다 ② 파일 이름이 다르다(실서버 앱은 `latest.yml`, 테스트 앱은 `staging.yml`만 찾는다) ③ 앱이 받기 전에 설치파일 이름을 본다(`src/updater.js` — 실서버 앱은 `-staging` 파일을, 테스트 앱은 `-staging` 아닌 파일을 받지 않는다).
yml 안의 설치파일 주소는 버전 태그 릴리스의 **절대 주소**다(`build/release-prep.js` 가 만든다).

- 맥은 ad-hoc 서명이라 자동 설치가 안 된다 → 같은 yml 로 새 버전이 있는지만 보고 «새 버전 받기» 안내만 띄운다.
- 앱은 켤 때(1분 뒤)·1시간마다 확인 → 조용히 받아 둠 → **앱을 끌 때 설치**, 또는 매장이 «재시작해서 업데이트»를 누를 때만 설치(영업 중 저절로 재시작하지 않음). 기록: 설정 폴더 `update.log`.
- 웹 다운로드 화면(norder_app `src/lib/desktopReleases.ts`)은 Latest 의 **이름 고정 파일** `NOrder-Kitchen-Setup.exe`·`NOrder-Kitchen-universal.dmg` 와 `latest.yml` 버전을 읽는다(테스트서버는 `staging-channel` 의 `-staging` 고정 파일·`staging.yml`). 그래서 **버전이 올라도 웹은 안 고친다.**

## 🔴 매장 배포 시점 규칙
**서버 API·DB 변경이 필요한 앱 버전은, 외부 개발자가 실서버(norder.shop) 반영을 확인하기 전까지 Latest 로 올리지 않는다** — `--prerelease`(또는 `--draft`)로 둔다.
Latest 가 되는 순간 모든 매장 앱이 1시간 안에 받아 두고, 다음 종료 때 설치된다. 실서버가 아직 옛 서버면 매장 앱이 깨진다.
- 테스트서버(`staging-channel`)는 서버 변경이 staging 에 올라가 있으면 바로 갱신해도 된다.
- 실서버 반영 확인 후: `gh release edit v<버전> --prerelease=false --latest`
- 서버 변경이 없는 버전은 바로 Latest 로 내도 된다.

## 순서
```bash
# 0) staging 브랜치에서 버전 올리고 커밋 (package.json version)
# 1) 빌드 4개
npm run dist:win && npm run dist:win:prod && npm run dist:mac && npm run dist:mac:prod
# 2) 모으기 — verify:channel(서버·업데이트 통로 검사) 통과해야 진행, release_out/<버전>/ 에 파일·yml·SHA256SUMS
node build/release-prep.js 0.4.10 v0.4.10
# 3) 버전 릴리스 — 서버 변경 필요하면 --latest 대신 --prerelease
cd release_out/0.4.10
gh release create v0.4.10 --target main --title "..." --notes-file notes.md --latest \
  NOrder-Kitchen-Setup-0.4.10.exe NOrder-Kitchen-0.4.10-universal.dmg \
  NOrder-Kitchen-Setup-0.4.10-staging.exe NOrder-Kitchen-0.4.10-universal-staging.dmg \
  NOrder-Kitchen-Setup.exe NOrder-Kitchen-universal.dmg latest.yml
# 4) 테스트 통로 갱신(설치파일 먼저, yml 마지막)
gh release upload staging-channel staging-channel/NOrder-Kitchen-Setup-staging.exe staging-channel/NOrder-Kitchen-universal-staging.dmg --clobber
gh release upload staging-channel staging-channel/staging.yml --clobber
# 5) 올린 파일을 다시 받아 SHA256SUMS 와 비교
```
- ⛔ `latest.yml` 은 버전 릴리스에만, `staging.yml` 은 `staging-channel` 에만 올린다. 둘을 바꿔 올리면 ③에서 막히지만 애초에 하지 않는다.
- ⛔ `staging-channel` 은 지우지 말 것(테스트 앱·테스트서버 다운로드 화면이 본다). 사전 릴리스라 Latest 가 되지 않는다.
- 테스트서버 전용 시험판: `node build/release-prep.js 0.4.11 v0.4.11-staging-test --staging-only` → 사전 릴리스로 올리고 `staging-channel` 갱신. 끝나면 시험판 릴리스·태그를 지우고 `staging-channel` 을 정식 버전 파일로 되돌린다.

## 되돌리기(롤백)
- 앱은 **낮은 버전으로 내려가지 않는다**(allowDowngrade=false). Latest 를 옛 릴리스로 돌리면 새로 까는 매장만 옛 버전을 받는다.
- 이미 퍼진 버전을 되돌리려면 고친 코드를 **더 높은 버전**(예: 0.4.11)으로 다시 내는 것이 정석.
- 급하면: `gh release edit v<문제버전> --prerelease --latest=false` + 직전 버전 `--latest`. 이때 직전 릴리스에 이름 고정 파일(`NOrder-Kitchen-Setup.exe`·`NOrder-Kitchen-universal.dmg`)·`latest.yml` 이 없으면 웹 다운로드가 404 — 0.4.9 이하로 돌릴 땐 그 릴리스에 이름 고정 사본을 올려야 한다.
- 아직 설치 전(받아만 둔) 매장: Latest 를 내리면 다음 확인 때 새 파일을 안 받지만, 이미 받아 둔 파일은 종료 때 설치된다.
