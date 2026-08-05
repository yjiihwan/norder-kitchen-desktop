# N오더 주방 (데스크톱)

N오더 식당(점주·주방)용 주문 접수 데스크톱 앱. **staging 전용** — `https://norder-web-staging.up.railway.app` 의 파트너 화면(`/partner/*`)만 래핑한다.

- 신규 주문 감시(«신규 (N)» 탭 카운트) → 소리·전면 팝업·윈도우 네이티브 알림
- 전체화면(키오스크) 모드(F11) · 윈도우 부팅 시 자동 실행 옵션 · 화면 절전 방지
- 파트너 외 경로(고객·어드민) 이동 차단

## 개발

```bash
npm install
npm start           # 로컬 실행
npm run dist:win    # 윈도우 NSIS 설치파일 (dist/NOrder-Kitchen-Setup-*.exe)
```

로그인: staging 시드 파트너 계정 (`hansang@norder.test` / `partner1234!`)
