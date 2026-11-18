import fs from "node:fs";
import path from "node:path";

export interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
}
interface Area {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const WINDOW_DEFAULT = { width: 1480, height: 940 };
export const WINDOW_MIN = { width: 860, height: 600 };

/** Restores the last size and place, but only where some display can show it. */
export function restoreBounds(saved: unknown, workAreas: Area[]): WindowBounds {
  const s = saved as Partial<WindowBounds> | null;
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  if (!s || !num(s.width) || !num(s.height)) return { ...WINDOW_DEFAULT };
  const width = Math.max(WINDOW_MIN.width, Math.round(s.width!));
  const height = Math.max(WINDOW_MIN.height, Math.round(s.height!));
  const result: WindowBounds = {
    width,
    height,
    maximized: s.maximized === true,
  };
  if (num(s.x) && num(s.y)) {
    // Keep it only if a usable piece (title bar included) lands on a display.
    const visible = workAreas.some(
      (a) =>
        s.x! + 120 <= a.x + a.width &&
        s.x! + width - 120 >= a.x &&
        s.y! >= a.y &&
        s.y! + 40 <= a.y + a.height,
    );
    if (visible)
      Object.assign(result, { x: Math.round(s.x!), y: Math.round(s.y!) });
  }
  // Never larger than the largest display.
  const largest = workAreas.reduce(
    (m, a) => ({
      width: Math.max(m.width, a.width),
      height: Math.max(m.height, a.height),
    }),
    { width: 0, height: 0 },
  );
  if (largest.width) result.width = Math.min(result.width, largest.width);
  if (largest.height) result.height = Math.min(result.height, largest.height);
  return result;
}

export function windowStateFile(dataDir: string) {
  const file = path.join(dataDir, "window-state.json");
  return {
    read(): unknown {
      try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        return null;
      }
    },
    write(bounds: WindowBounds) {
      const temp = file + ".tmp";
      fs.writeFileSync(temp, JSON.stringify(bounds));
      fs.renameSync(temp, file);
    },
  };
}
