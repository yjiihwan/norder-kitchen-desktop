// 앱 아이콘 생성 — 니짐 팔레트 v2 Rose(#FF0065) 바탕 + 흰 벨. resvg 는 ad_studio_v2 것 재사용(읽기 전용).
import { Resvg } from "/Users/ideagent/ad_studio_v2/node_modules/@resvg/resvg-js/index.js";
import fs from "fs";

const svg = `
<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <rect width="512" height="512" rx="112" fill="#FF0065"/>
  <g fill="#ffffff">
    <path d="M256 118c13 0 24 9 26 22 44 10 76 48 76 96v58l26 40c6 10-1 22-13 22H141c-12 0-19-12-13-22l26-40v-58c0-48 32-86 76-96 2-13 13-22 26-22z"/>
    <path d="M226 372h60c0 18-13 32-30 32s-30-14-30-32z"/>
  </g>
</svg>`;

const png = new Resvg(svg, { fitTo: { mode: "width", value: 512 } }).render().asPng();
fs.writeFileSync(new URL("./icon.png", import.meta.url), png);
console.log("icon.png", png.length, "bytes");
