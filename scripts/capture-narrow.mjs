// Captures the desktop renderer at the edges the redesign must hold up at:
// a 320px-wide viewport, 200% zoom and a right-to-left document, plus a
// report of anything that overflows the viewport horizontally.
// Usage: npm run build && node scripts/capture-narrow.mjs <output-dir>
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, writeFile, realpath } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { cleanupFixture } from "./fixture-cleanup.mjs";

const out = path.resolve(process.argv[2] || "release/narrow-capture");
await mkdir(out, { recursive: true });
const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });

const fixture = await realpath(await mkdtemp(path.join(tmpdir(), "aw-narrow-")));
const repo = path.join(fixture, "storefront");
await mkdir(path.join(repo, "src"), { recursive: true });
await writeFile(path.join(repo, "README.md"), "# Storefront\n");
git(repo, "init", "-q", "-b", "main");
git(repo, "add", ".");
git(repo, "-c", "user.name=Capture", "-c", "user.email=capture@example.invalid", "commit", "-qm", "init");

// Elements wider than the viewport, or poking past its right edge.
const overflow = () =>
  page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    const found = [];
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.position === "fixed") continue;
      if (r.right > w + 1 || r.left < -1) {
        let p = el.parentElement;
        let clipped = false;
        while (p && p !== document.body) {
          const ps = getComputedStyle(p);
          if (/(auto|scroll|hidden|clip)/.test(ps.overflowX)) {
            clipped = true;
            break;
          }
          p = p.parentElement;
        }
        if (!clipped)
          found.push(
            `${el.tagName.toLowerCase()}.${[...el.classList].join(".")} ${Math.round(r.left)}–${Math.round(r.right)} of ${w}`,
          );
      }
    }
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: w,
      offenders: found.slice(0, 20),
    };
  });

let page;
const app = await electron.launch({
  args: ["."],
  env: { ...process.env, SHELL: "/bin/sh", WORKSPACE_TEST_DATA_DIR: path.join(fixture, "data") },
});
const report = {};
try {
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await page.waitForFunction(() => !!window.workspace);
  await page.evaluate((p) => window.workspace.invoke("project.add", { path: p }), repo);
  await page.getByRole("button", { name: "Open Shell here", exact: true }).click();
  await page.getByRole("button", { name: "Interrupt", exact: true }).waitFor();
  await page.waitForTimeout(600);

  const shot = async (name) => {
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(out, `${name}.png`) });
    report[name] = await overflow();
  };

  for (const theme of ["light", "dark"]) {
    await page.evaluate((t) => localStorage.setItem("workspace.appearance", t), theme);
    await page.reload();
    await page.waitForFunction(() => !!window.workspace);
    await page.getByRole("button", { name: "Interrupt", exact: true }).waitFor();

    // 320px phone-width viewport.
    await page.setViewportSize({ width: 320, height: 640 });
    await shot(`${theme}-320-terminal`);
    const folders = page.getByRole("button", { name: /folders and sessions/i }).first();
    if (await folders.isVisible().catch(() => false)) {
      await folders.click();
      await shot(`${theme}-320-drawer`);
      await page.keyboard.press("Escape");
    }
    await page.getByRole("button", { name: "Settings and connections" }).first().click().catch(() => {});
    await shot(`${theme}-320-settings`);
    await page.keyboard.press("Escape");

    // 200% zoom of a 1440x900 window: a 720x450 CSS viewport.
    await page.setViewportSize({ width: 1440, height: 900 });
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2),
    );
    await shot(`${theme}-zoom200-terminal`);
    await page.getByRole("button", { name: "Settings and connections" }).first().click().catch(() => {});
    await shot(`${theme}-zoom200-settings`);
    await page.keyboard.press("Escape");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1),
    );

    // Right-to-left document at full width.
    await page.evaluate(() => (document.documentElement.dir = "rtl"));
    await shot(`${theme}-rtl-terminal`);
    for (const v of ["Board", "Canvas"]) {
      await page.getByRole("navigation", { name: "Views" }).getByRole("button", { name: v, exact: true }).click();
      await shot(`${theme}-rtl-${v.toLowerCase()}`);
    }
    await page.getByRole("navigation", { name: "Views" }).getByRole("button", { name: "Terminals", exact: true }).click();
    await page.getByRole("button", { name: "Settings and connections" }).first().click();
    await shot(`${theme}-rtl-settings`);
    await page.keyboard.press("Escape");
    await page.evaluate(() => (document.documentElement.dir = "ltr"));
  }
  await writeFile(path.join(out, "overflow.json"), JSON.stringify(report, null, 2) + "\n");
  for (const [name, r] of Object.entries(report))
    console.log(name, r.scrollWidth > r.clientWidth ? `SCROLLS ${r.scrollWidth}/${r.clientWidth}` : "ok", r.offenders.length ? r.offenders.slice(0, 4).join(" | ") : "");
} finally {
  await app.close().catch(() => {});
  await cleanupFixture(fixture);
}
console.log("Saved to", out);
