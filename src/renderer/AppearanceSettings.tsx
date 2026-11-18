import { SunMoon } from "lucide-react";
import {
  setAppearance,
  useAppearance,
  type AppearanceMode,
} from "./appearance";

const choices = [
  { mode: "light", label: "Light" },
  { mode: "dark", label: "Dark" },
  { mode: "system", label: "System" },
] satisfies { mode: AppearanceMode; label: string }[];

/** Settings row: theme choice as a segmented control. Saved on this device. */
export function AppearanceSettings() {
  const appearance = useAppearance();
  return (
    <div className="settings-row appearance-row">
      <span className="settings-row-icon tile-blue" aria-hidden="true">
        <SunMoon size={13} />
      </span>
      <span className="settings-row-label">
        Appearance
      </span>
      <div
        className="segmented"
        role="radiogroup"
        aria-label="Color theme"
      >
        {choices.map(({ mode, label }) => (
          <label
            key={mode}
            className={appearance.mode === mode ? "selected" : ""}
          >
            <input
              type="radio"
              name="appearance"
              value={mode}
              checked={appearance.mode === mode}
              onChange={() => setAppearance(mode)}
            />
            {label}
          </label>
        ))}
      </div>
    </div>
  );
}
