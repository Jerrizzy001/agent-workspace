import { useSyncExternalStore } from "react";
import type { ITheme } from "@xterm/xterm";

export type AppearanceMode = "light" | "dark" | "system";
export type ResolvedAppearance = "light" | "dark";
const key = "workspace.appearance";
const system = window.matchMedia("(prefers-color-scheme: dark)");
const modeOf = (value: string | null): AppearanceMode =>
  value === "light" || value === "system" ? value : "dark";
function savedMode() {
  try {
    return modeOf(localStorage.getItem(key));
  } catch {
    return "dark" as const;
  }
}
const resolve = (mode: AppearanceMode): ResolvedAppearance =>
  mode === "system" ? (system.matches ? "dark" : "light") : mode;
const initialMode = savedMode();
let state = { mode: initialMode, resolved: resolve(initialMode) };
const listeners = new Set<() => void>();
function apply() {
  document.documentElement.dataset.theme = state.resolved;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute(
      "content",
      state.resolved === "light" ? "#ffffff" : "#0f1218",
    );
}
function update(mode: AppearanceMode) {
  const resolved = resolve(mode);
  if (state.mode === mode && state.resolved === resolved) return;
  state = { mode, resolved };
  apply();
  listeners.forEach((listener) => listener());
}
export function setAppearance(mode: AppearanceMode) {
  try {
    localStorage.setItem(key, mode);
  } catch {
    /* The in-memory choice still works. */
  }
  update(mode);
}
export const getAppearance = () => state;
export const subscribeAppearance = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const useAppearance = () =>
  useSyncExternalStore(subscribeAppearance, getAppearance);
system.addEventListener("change", () => update(state.mode));
window.addEventListener("storage", (event) => {
  if (event.key === key || event.key === null) update(savedMode());
});
apply();

export const terminalThemes: Record<ResolvedAppearance, ITheme> = {
  dark: {
    background: "#0d1015",
    foreground: "#d8dee9",
    cursor: "#8fb4ff",
    cursorAccent: "#0d1015",
    selectionBackground: "#2c3a55",
    black: "#232832",
    red: "#f07f86",
    green: "#8fd19e",
    yellow: "#f0c674",
    blue: "#82aaff",
    magenta: "#c3a6ff",
    cyan: "#7fd4d4",
    white: "#d8dee9",
    brightBlack: "#5c6577",
    brightRed: "#ff9ba3",
    brightGreen: "#a8e5b6",
    brightYellow: "#ffe09c",
    brightBlue: "#a4c2ff",
    brightMagenta: "#dbc4ff",
    brightCyan: "#a0e7e7",
    brightWhite: "#ffffff",
  },
  light: {
    background: "#ffffff",
    foreground: "#1d2737",
    cursor: "#4054bd",
    cursorAccent: "#ffffff",
    selectionBackground: "#d7e1ff",
    black: "#242933",
    red: "#b42335",
    green: "#147344",
    yellow: "#8a6000",
    blue: "#245ac7",
    magenta: "#8741b4",
    cyan: "#006c7c",
    white: "#5b6576",
    brightBlack: "#687386",
    brightRed: "#c32739",
    brightGreen: "#0d7d45",
    brightYellow: "#916900",
    brightBlue: "#315ed8",
    brightMagenta: "#934db4",
    brightCyan: "#00778a",
    brightWhite: "#374151",
  },
};
