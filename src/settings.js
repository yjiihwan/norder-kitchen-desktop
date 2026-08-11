// 설정 파일 로드·저장 — 경로·기본값을 주입받는 순수 함수(E2E가 임시 경로로 지속성 검증).
const fs = require("fs");

function loadSettingsFile(file, base) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    return { ...base, ...saved, printer: { ...base.printer, ...(saved.printer || {}) } };
  } catch {
    return { ...base, printer: { ...base.printer } };
  }
}

function saveSettingsFile(file, s) {
  try { fs.writeFileSync(file, JSON.stringify(s, null, 2)); } catch { /* 디스크 오류 시 다음 부팅에 기본값 */ }
}

module.exports = { loadSettingsFile, saveSettingsFile };
