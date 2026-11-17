import { useEffect, useId, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { ExecutionHostView } from "../shared/contracts";
import { useProfiles } from "./ProfilesPanel";
import { isRemoteBrowser } from "./remote";

export interface SettingsStates {
  dictation: string;
  assist: string;
  team: string;
  remote: string;
}
const plural = (n: number, one: string, many = one + "s") =>
  `${n} ${n === 1 ? one : many}`;

/** What each Settings entry is set to, read when the panel opens. */
export function useSettingsStates(open: boolean): SettingsStates {
  const [states, setStates] = useState<SettingsStates>({
    dictation: "",
    assist: "",
    team: "",
    remote: "",
  });
  useEffect(() => {
    if (!open || isRemoteBrowser) return;
    let active = true;
    const set = (key: keyof SettingsStates, value: string) =>
      active && setStates((current) => ({ ...current, [key]: value }));
    const w = window.workspace;
    void w.dictation
      ?.status()
      .then((s) => {
        const model = s.models.find((m) => m.id === s.selected);
        set(
          "dictation",
          s.download && !["done", "failed"].includes(s.download.phase)
            ? "Downloading model…"
            : model?.installed
              ? `Ready · ${model.label}`
              : "Model not downloaded",
        );
      })
      .catch(() => {});
    void w.assist
      ?.status()
      .then((s) =>
        set(
          "assist",
          s.provider
            ? `On · ${s.provider}${s.model ? " · " + s.model : ""}`
            : "Off",
        ),
      )
      .catch(() => {});
    void w.team
      ?.status()
      .then((s) =>
        set(
          "team",
          s.connected
            ? `Signed in${s.identity?.name ? " · " + s.identity.name : ""}`
            : "Not connected",
        ),
      )
      .catch(() => {});
    void w.remote
      ?.status()
      .then((s) =>
        set(
          "remote",
          s.enabled
            ? `On · ${plural(s.sharedProjects.length, "folder")}`
            : "Off",
        ),
      )
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [open]);
  return states;
}

export function hostsState(hosts: ExecutionHostView[]) {
  if (!hosts.length) return "No hosts";
  const connected = hosts.filter((h) => h.state === "connected").length;
  return `${plural(hosts.length, "host")} · ${connected} connected`;
}

export function useProfilesState() {
  const { profiles } = useProfiles();
  return profiles.length
    ? plural(profiles.length, "profile")
    : "Default sign-in only";
}

/** One Settings entry: what it is, what it is set to, and where it leads. */
export function SettingsRow({
  icon,
  label,
  name,
  state,
  onOpen,
}: {
  icon: ReactNode;
  label: string;
  /** Accessible name; defaults to the visible label. */
  name?: string;
  state: string;
  onOpen: () => void;
}) {
  const stateId = useId();
  return (
    <button
      className="settings-row"
      aria-label={name || label}
      aria-describedby={state ? stateId : undefined}
      onClick={onOpen}
    >
      <span className="settings-row-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="settings-row-label">{label}</span>
      <span className="settings-row-state" id={stateId}>
        {state || "…"}
      </span>
      <ChevronRight size={14} aria-hidden="true" />
    </button>
  );
}
