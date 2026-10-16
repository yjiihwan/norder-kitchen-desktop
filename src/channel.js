// 빌드 채널(실서버/테스트서버) — 설치파일마다 기본 연결 서버가 다르다.
// 채널은 package.json 의 norderChannel(빌드 때 -c.extraMetadata.norderChannel 로 덮음)에서 읽는다.
// 기본값은 staging — 실수로 채널 없이 빌드해도 실서버 식당 데이터에 붙지 않게(fail-safe).
// 2026-10-15 형 승인으로 실서버 주소(norder.shop)를 넣었다. 0.4.6 은 staging 고정이라 실서버 식당이 로그인하지 못했다.
const RELEASES = "https://github.com/yjiihwan/norder-kitchen-desktop/releases";

// 자동 업데이트 통로(0.4.10~) — 실서버용은 «Latest» 릴리스의 latest.yml, 테스트용은 별도 사전 릴리스 staging-channel 의 staging.yml.
// 주소와 파일 이름이 둘 다 달라서 한쪽 앱이 다른 쪽 설치파일을 집을 수 없다(updater.js 가 설치파일 이름도 한 번 더 본다).
const CHANNELS = {
  prod: {
    server: "https://norder.shop", title: "N오더 주방", about: "N오더 주방",
    update: { url: `${RELEASES}/latest/download`, channel: "latest", macDownload: `${RELEASES}/latest/download/NOrder-Kitchen-universal.dmg` },
  },
  staging: {
    server: "https://norder-web-staging.up.railway.app", title: "N오더 주방 (staging)", about: "N오더 주방 (staging 전용)",
    update: { url: `${RELEASES}/download/staging-channel`, channel: "staging", macDownload: `${RELEASES}/download/staging-channel/NOrder-Kitchen-universal-staging.dmg` },
  },
};

function resolveChannel() {
  const fromEnv = process.env.NORDER_CHANNEL; // 로컬 실행·E2E 전용
  if (fromEnv && CHANNELS[fromEnv]) return fromEnv;
  try {
    const c = require("../package.json").norderChannel;
    if (CHANNELS[c]) return c;
  } catch { /* */ }
  return "staging";
}

const CHANNEL = resolveChannel();
const KNOWN_SERVERS = Object.values(CHANNELS).map((c) => c.server);

// 0.4.6(staging 고정)이 settings.json 에 staging 주소를 저장해 두었다 — 앱을 지우고 실서버용을 깔아도
// 설정 폴더는 남으므로, 다른 채널의 기본 주소가 남아 있으면 이 빌드의 기본 주소로 바꾼다.
// 직접 넣은 다른 주소(개발용)는 건드리지 않는다.
function migrateServerUrl(saved, server) {
  return KNOWN_SERVERS.includes(saved) && saved !== server ? server : saved;
}

module.exports = { CHANNEL, ...CHANNELS[CHANNEL], migrateServerUrl };
