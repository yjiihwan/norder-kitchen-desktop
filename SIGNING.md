# macOS 서명·공증 (Developer ID + Notarization)

N오더 주방 데스크톱 맥 빌드(`npm run dist:mac`)는 **자격증명이 있으면 서명·공증**, **없으면 ad-hoc 서명**으로 자동 분기한다.
자격증명은 **환경변수로만** 읽는다 — 코드·repo에 하드코딩하지 않는다.

| 상태 | 결과물 | 첫 실행 |
|---|---|---|
| 자격증명 없음 (현재) | `NOrder-Kitchen-<ver>-universal.dmg` — ad-hoc(-) 서명, hardened runtime | Gatekeeper 경고 → 우클릭→열기 |
| 자격증명 있음 (2단계) | 같은 파일명 — Developer ID 서명 + 공증(스테이플) | 경고 없이 바로 실행 |

## 1. 파이프라인 구성 (package.json `build.mac`)

```
hardenedRuntime: true                                   # Apple 공증 필수 조건
entitlements: build/entitlements.mac.plist               # Electron JIT 예외 3종
entitlementsInherit: build/entitlements.mac.inherit.plist # 헬퍼 프로세스 동일
gatekeeperAssess: false                                  # 서명 직후 spctl 검사는 공증 전이라 항상 실패 → 끔(공증 후 검증은 verify 스크립트가 함)
notarize: true                                           # electron-builder 내장 @electron/notarize (env 없으면 자동 skip)
afterPack: build/mac-sign.js                             # 자격증명 없을 때 ad-hoc 폴백(같은 entitlements·hardened runtime)
afterAllArtifactBuild: build/mac-notarize-dmg.js         # 자격증명 있을 때 dmg 자체도 notarytool 공증 + stapler
```

흐름: 패키징 → `afterPack`(자격증명 감지 시 무동작 / 없으면 ad-hoc) → electron-builder 서명(Developer ID) → `.app` 공증·스테이플 → dmg 생성·서명 → `afterAllArtifactBuild`(dmg 공증·스테이플).

## 2. 형이 보내야 할 자격증명 (체크리스트)

### [A] Developer ID Application 인증서 — 서명용 (필수)
- [ ] **A-1. `.p12` 파일** — Keychain Access에서 «Developer ID Application: <회사명> (<TeamID>)» 인증서를 **개인 키 포함**해 내보내기(.p12). 인증서가 없으면 developer.apple.com → Certificates → «Developer ID Application» 생성(CSR 필요).
- [ ] **A-2. `.p12` 내보내기 비밀번호**
- 대안: 이 빌드 맥의 로그인 키체인에 인증서를 직접 설치하면 A-1/A-2 없이 자동 탐색된다.

### [B] 공증(notarization) 자격증명 — 둘 중 하나
- [ ] **B-1. Apple ID 방식**: `APPLE_ID`(개발자 계정 이메일) / `APPLE_APP_SPECIFIC_PASSWORD`(appleid.apple.com → 로그인 및 보안 → **앱 암호** 생성, 계정 비밀번호 아님) / `APPLE_TEAM_ID`(developer.apple.com → Membership, 10자리)
- [ ] **B-2. App Store Connect API 키 방식(권장)**: App Store Connect → 사용자 및 액세스 → 통합 → App Store Connect API → 키 생성(**Developer** 역할 이상) → `AuthKey_XXXX.p8` 파일 + **Key ID** + **Issuer ID**

> 전달 방법: 텔레그램 DM 또는 `~/shared_inbox/secrets_apple_*.txt` 같은 비공개 경로. 슬랙 채널 공개 게시 금지.

## 3. 주입 위치

### 로컬 빌드 — `electron-builder.env` (gitignore 됨)
```bash
cp electron-builder.env.example electron-builder.env   # 값 채우기
npm run dist:mac                                         # 자동 로드 → 서명·공증
npm run verify:mac-sign -- --expect developer-id         # 게이트
```
| 변수 | 값 |
|---|---|
| `CSC_LINK` | `.p12` 절대경로 또는 base64 문자열 |
| `CSC_KEY_PASSWORD` | `.p12` 비밀번호 |
| `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` | B-1 |
| `APPLE_API_KEY`(.p8 절대경로) / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER` | B-2 |

### CI — GitHub Actions secrets (`.github/workflows/build-mac.yml`)
repo Settings → Secrets and variables → Actions 에 같은 이름으로 등록. `CSC_LINK`는 **base64** 문자열(`base64 -i cert.p12 | pbcopy`), `APPLE_API_KEY`는 `.p8` **내용**을 `APPLE_API_KEY_CONTENT`로 넣으면 워크플로가 파일로 풀어 경로를 넘긴다. secrets가 비어 있으면 ad-hoc 빌드로 정상 완료된다.

## 4. 검증
```bash
npm run verify:mac-sign                        # 서명 종류 자동 판정(ad-hoc/developer-id)
npm run verify:mac-sign -- --expect adhoc      # 1단계 게이트
npm run verify:mac-sign -- --expect developer-id   # 2단계 게이트: spctl --assess, stapler validate(app·dmg)까지
```
항목: codesign -dvvv · hardened runtime 플래그 · entitlements(allow-jit 등) · `--verify --deep --strict` · 헬퍼 4종 hardened · universal(x86_64+arm64) · (developer-id) spctl 통과·stapler app/dmg.

## 5. 실패 규칙·부작용
- **자격증명(CSC_LINK/CSC_NAME/identity 또는 키체인의 Developer ID)이 감지되면 서명은 필수** — 유효 identity를 못 찾으면 빌드가 «skipped macOS application code signing» 에러로 실패한다(무서명 앱이 조용히 나오는 것을 막음). 자격증명이 전혀 없을 때만 ad-hoc 폴백.
- 공증 env 3종 중 일부만 있으면 electron-builder가 «APPLE_… env var needs to be set» 으로 실패한다. 전부 넣거나 전부 비울 것.
- CSC_LINK 빌드는 electron-builder가 임시 키체인을 만들어 p12를 넣고 끝나면 삭제한다. 단 Apple 루트 인증서 캐시 키체인(`~/Library/Caches/electron-builder/electron-builder-root-certs.keychain`, 공개 루트 CA만 포함)이 키체인 검색 목록에 남는다 — electron-builder 표준 동작이며 무해.

## 6. 강제 옵션
- `npm run dist:mac:unsigned` — 인증서가 있어도 ad-hoc으로 빌드(`CSC_IDENTITY_AUTO_DISCOVERY=false`).
- `mac.notarize=false`로 임시 오버라이드: `npx electron-builder --mac --universal -c.mac.notarize=false` (서명만).

## 7. 2단계(자격증명 수령 후) 절차
1. `electron-builder.env` 작성 → `npm run dist:mac` → `npm run verify:mac-sign -- --expect developer-id` PASS
2. `package.json` 버전 범프 → `git tag v<ver>` → GitHub Release 재발행(dmg + exe)
3. 다른 맥에서 dmg 다운로드 → 더블클릭 설치 → 경고 없이 실행되는지 육안 확인
4. 링크허브(`~/agent_hub/links.json`) 맥 항목 desc의 «무서명» 문구 제거·URL 갱신
