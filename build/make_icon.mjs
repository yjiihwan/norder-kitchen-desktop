// 앱 아이콘 생성 — N오더 확정 로고 1-B «집게 N»(09-27). 원본 = build/icon_source.svg (appicon_1024 + 모서리 라운드).
// resvg 는 ad_studio_v2 것 재사용(읽기 전용).
import { Resvg } from "/Users/ideagent/ad_studio_v2/node_modules/@resvg/resvg-js/index.js";
import fs from "fs";

const svg = fs.readFileSync(new URL("./icon_source.svg", import.meta.url), "utf8");
const png = new Resvg(svg, { fitTo: { mode: "width", value: 512 } }).render().asPng();
fs.writeFileSync(new URL("./icon.png", import.meta.url), png);
console.log("icon.png", png.length, "bytes");
