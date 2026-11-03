import { Monitor, Moon, Sun } from "lucide-react";
import {
  setAppearance,
  useAppearance,
  type AppearanceMode,
} from "./appearance";

const choices = [
  { mode: "light", label: "Light", Icon: Sun },
  { mode: "dark", label: "Dark", Icon: Moon },
  { mode: "system", label: "System", Icon: Monitor },
] satisfies { mode: AppearanceMode; label: string; Icon: typeof Sun }[];

export function AppearanceSettings() {
  const appearance = useAppearance();
  return (
    <fieldset className="appearance-settings">
      <legend>Appearance</legend>
      <div
        className="appearance-options"
        role="radiogroup"
        aria-label="Color theme"
      >
        {choices.map(({ mode, label, Icon }) => (
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
            <Icon size={18} aria-hidden="true" />
            <span>{label}</span>
          </label>
        ))}
      </div>
      <p>Light, dark, or match your system. Saved on this device.</p>
    </fieldset>
  );
}
