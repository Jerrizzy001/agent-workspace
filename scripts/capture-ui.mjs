// Captures the main views in dark and light themes for redesign comparison.
// Usage: npm run build && node scripts/capture-ui.mjs <output-dir>
// Page screenshots cannot include native window materials, so the macOS
// sidebar is drawn with its opaque fallback there; on macOS a real window
// screenshot (<theme>-native.png) shows the translucent sidebar as users see it.
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, writeFile, realpath } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { cleanupFixture } from "./fixture-cleanup.mjs";

const out = path.resolve(process.argv[2] || "release/ui-capture");
await mkdir(out, { recursive: true });
const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });

for (const theme of ["dark", "light"]) {
  const fixture = await realpath(await mkdtemp(path.join(tmpdir(), "aw-capture-")));
  const repo = path.join(fixture, "storefront");
  await mkdir(path.join(repo, "src"), { recursive: true });
  await writeFile(path.join(repo, "README.md"), "# Storefront\n");
  await writeFile(path.join(repo, "package.json"), '{ "name": "storefront" }\n');
  await writeFile(path.join(repo, "src", "index.ts"), "export {};\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", ".");
  git(repo, "-c", "user.name=Capture", "-c", "user.email=capture@example.invalid", "commit", "-qm", "init");
  await writeFile(path.join(repo, "README.md"), "# Storefront\n\nChanged.\n");

  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, SHELL: "/bin/sh", WORKSPACE_TEST_DATA_DIR: path.join(fixture, "data") },
  });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1440, 900),
    );
    await page.waitForFunction(() => !!window.workspace);
    await page.evaluate((t) => localStorage.setItem("workspace.appearance", t), theme);
    await page.reload();
    await page.waitForFunction(() => !!window.workspace);
    await page.addStyleTag({
      content: ':root[data-chrome] .sidebar { background: var(--bg-sidebar) !important; }',
    });
    const shot = async (name) => {
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(out, `${theme}-${name}.png`) });
    };
    const view = (name) =>
      page.getByRole("navigation", { name: "Views" }).getByRole("button", { name, exact: true }).click();

    await page.evaluate((p) => window.workspace.invoke("project.add", { path: p }), repo);
    await page.getByRole("button", { name: "Open Shell here", exact: true }).waitFor();
    await shot("01-launchpad");

    await page.getByRole("button", { name: "Open Shell here", exact: true }).click();
    await page.getByRole("button", { name: "Interrupt", exact: true }).waitFor();
    await page.waitForFunction(() =>
      document.querySelector(".session-view .xterm-rows")?.textContent?.includes("$"),
    );
    await page.locator(".session-view .xterm-helper-textarea").focus();
    await page.keyboard.type("ls -la\n");
    await shot("02-session");
    if (process.platform === "darwin") {
      const b = await app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows()[0];
        w.setBounds({ x: 60, y: 60, width: 1280, height: 800 });
        w.show();
        w.focus();
        return w.getBounds();
      });
      await page.waitForTimeout(800);
      try {
        execFileSync("screencapture", [
          "-x", "-o", "-R", `${b.x},${b.y},${b.width},${b.height}`,
          path.join(out, `${theme}-native.png`),
        ]);
      } catch (error) {
        console.warn("Native screenshot skipped:", error.message.split("\n")[0]);
      }
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setContentSize(1440, 900),
      );
    }

    await view("Board");
    await shot("03-board");
    await view("Canvas");
    await shot("04-canvas");
    await view("Terminals");

    await page.getByRole("button", { name: "Settings and connections", exact: true }).first().click();
    await shot("05-settings");
    await page.keyboard.press("Escape");

    await page.locator(".session-view summary[title=\"More actions\"]").click();
    await shot("06-menu");
    await page.keyboard.press("Escape");

    await page.keyboard.press("Meta+k");
    await page.keyboard.type("set");
    await shot("07-palette");
    await page.keyboard.press("Escape");
    console.log(`${theme}: captured 7 views`);
  } finally {
    await app.close().catch(() => {});
    await cleanupFixture(fixture);
  }
}
console.log("Saved to", out);
