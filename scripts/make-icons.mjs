// Renders the brand mark (the same geometry as BrandMark in src/renderer/ui.tsx)
// into the desktop app icon and the browser/PWA icons.
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
const mark = (size, inset) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">
  ${inset ? "" : '<rect width="32" height="32" fill="#0b0d12"/>'}
  <rect x="${inset}" y="${inset}" width="${32 - inset * 2}" height="${32 - inset * 2}" rx="${7 - inset / 2}" fill="#1b2130" stroke="#303a4a" stroke-width="0.5"/>
  <g transform="translate(16 16) scale(${(32 - inset * 2) / 30}) translate(-16 -16)">
    <path d="M10 21.5 L16 10.5 L22 21.5" fill="none" stroke="#8b9dff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>
    <circle cx="10" cy="21.5" r="3" fill="#dfe5f3"/>
    <circle cx="16" cy="10.5" r="3" fill="#ee9b70"/>
    <circle cx="22" cy="21.5" r="3" fill="#dfe5f3"/>
  </g>
</svg>`;
const browser = await chromium.launch(
  process.env.WORKSPACE_BROWSER ? { executablePath: process.env.WORKSPACE_BROWSER } : {},
);
const page = await browser.newPage();
await mkdir("build", { recursive: true });
for (const [file, size, inset] of [
  ["build/icon.png", 1024, 3],
  ["src/renderer/public/icons/workspace-512.png", 512, 0],
  ["src/renderer/public/icons/workspace-192.png", 192, 0],
]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<body style="margin:0;background:transparent">${mark(size, inset)}</body>`);
  // The desktop icon keeps transparent corners; PWA icons are full-bleed for masking.
  await page.locator("svg").screenshot({ path: file, omitBackground: !!inset });
}
await browser.close();
console.log("icons written");
