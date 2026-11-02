import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronRight,
  Folder,
  FolderGit2,
  FolderOpen,
  File,
  HardDrive,
  House,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import type { DirectoryListing, Project, Session } from "../shared/contracts";
import { errorText, shortPath } from "./sessions";

const lastPathKey = "workspace.browser.path";
function rememberedPath() {
  try {
    return localStorage.getItem(lastPathKey) || undefined;
  } catch {
    return undefined;
  }
}

/** The desktop owner's in-app folder navigation. */
export function FolderBrowser({
  projects,
  sessions,
  onOpenFolder,
  onSelectProject,
  onSystemPicker,
}: {
  projects: Project[];
  sessions: Session[];
  onOpenFolder: (path: string) => Promise<void>;
  onSelectProject: (id: string) => void;
  onSystemPicker: () => void;
}) {
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [location, setLocation] = useState("");
  const [filter, setFilter] = useState("");
  const ticket = useRef(0);
  const go = useCallback(
    async (target?: string, fallback = true) => {
      const browse = window.workspace.browseDirectory;
      if (!browse) return;
      const current = ++ticket.current;
      setLoading(true);
      try {
        const next = await browse(target);
        if (current !== ticket.current) return;
        setListing(next);
        setLocation(next.path);
        setError("");
        setFilter("");
        try {
          localStorage.setItem(lastPathKey, next.path);
        } catch {}
      } catch (reason) {
        if (current !== ticket.current) return;
        // A remembered folder may have moved; fall back to home once.
        if (fallback && target && !listing) return go(undefined, false);
        setError(errorText(reason));
      } finally {
        if (current === ticket.current) setLoading(false);
      }
    },
    [listing],
  );
  useEffect(() => {
    void go(rememberedPath());
    // Only the initial location is loaded here; later navigation is explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const entries = useMemo(
    () =>
      (listing?.entries || []).filter(
        (entry) =>
          (showHidden || !entry.hidden) &&
          entry.name.toLowerCase().includes(filter.trim().toLowerCase()),
      ),
    [listing, showHidden, filter],
  );
  const crumbs = useMemo(() => {
    if (!listing) return [];
    const home = listing.home;
    const underHome =
      listing.path === home || listing.path.startsWith(home + "/");
    const base = underHome ? home : "/";
    const rest = (underHome ? listing.path.slice(home.length) : listing.path)
      .split("/")
      .filter(Boolean);
    const items = [{ name: underHome ? "Home" : "Computer", path: base }];
    rest.forEach((name, index) =>
      items.push({
        name,
        path:
          (base === "/" ? "" : base) + "/" + rest.slice(0, index + 1).join("/"),
      }),
    );
    return items;
  }, [listing]);
  const registered = new Map(projects.map((p) => [p.path, p]));
  async function open(path: string) {
    setOpening(path);
    try {
      await onOpenFolder(path);
    } finally {
      setOpening("");
    }
  }
  const visible = projects.filter((p) => !p.hidden);
  const currentName = listing
    ? listing.path === listing.home
      ? "Home"
      : listing.path.split("/").filter(Boolean).pop() || "/"
    : "";
  return (
    <section className="folder-home" aria-labelledby="folder-home-title">
      <header className="folder-home-head">
        <div>
          <p className="eyebrow">Start here</p>
          <h1 id="folder-home-title">Open a folder to work in</h1>
          <p className="lede">
            Pick a project folder below. Claude, Codex and a shell then open
            right inside it with one click.
          </p>
        </div>
        <button className="button ghost" onClick={onSystemPicker}>
          <FolderOpen size={15} />
          System picker…
        </button>
      </header>
      {visible.length ? (
        <section className="recent-folders" aria-label="Recent folders">
          <h2 className="section-label">Recent folders</h2>
          <div className="recent-grid">
            {visible.slice(0, 6).map((project) => {
              const running = sessions.filter(
                (s) => s.projectId === project.id && s.status !== "exited",
              ).length;
              return (
                <button
                  key={project.id}
                  className="recent-card"
                  onClick={() => onSelectProject(project.id)}
                >
                  <FolderGit2 size={18} />
                  <span>
                    <strong>{project.name}</strong>
                    <small>{shortPath(project.path, listing?.home)}</small>
                  </span>
                  {running ? (
                    <em className="count-pill">{running} open</em>
                  ) : null}
                </button>
              );
            })}
          </div>
        </section>
      ) : null}
      <div className="browser">
        <nav className="places" aria-label="Places">
          {(listing?.places || []).map((place) => (
            <button
              key={place.path}
              className={listing?.path === place.path ? "active" : ""}
              onClick={() => void go(place.path)}
            >
              {place.name === "Home" ? (
                <House size={15} />
              ) : place.name === "Computer" ? (
                <HardDrive size={15} />
              ) : (
                <Folder size={15} />
              )}
              {place.name}
            </button>
          ))}
        </nav>
        <div className="browser-main">
          <form
            className="browser-location"
            onSubmit={(e) => {
              e.preventDefault();
              const target = location.trim();
              if (target)
                void go(
                  target.startsWith("~/") && listing
                    ? listing.home + target.slice(1)
                    : target,
                  false,
                );
            }}
          >
            <label>
              Folder location
              <input
                aria-label="Folder location"
                disabled={loading}
                value={location}
                placeholder="Paste a folder path…"
                onChange={(e) => setLocation(e.target.value)}
              />
            </label>
            <button className="button" disabled={loading || !location.trim()}>
              Go
            </button>
          </form>
          <div className="browser-bar">
            <button
              className="icon-button"
              aria-label="Parent folder"
              title="Parent folder"
              disabled={!listing?.parent || loading}
              onClick={() => listing?.parent && void go(listing.parent)}
            >
              <ArrowUp size={16} />
            </button>
            <ol className="crumbs" aria-label="Current folder">
              {crumbs.map((crumb, index) => (
                <li key={crumb.path}>
                  {index ? <ChevronRight size={13} aria-hidden="true" /> : null}
                  <button
                    onClick={() => void go(crumb.path)}
                    aria-current={
                      index === crumbs.length - 1 ? "location" : undefined
                    }
                  >
                    {crumb.name}
                  </button>
                </li>
              ))}
            </ol>
            <input
              className="browser-filter"
              aria-label="Filter folders"
              placeholder="Filter"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            <label className="toggle">
              <input
                type="checkbox"
                checked={showHidden}
                onChange={(event) => setShowHidden(event.target.checked)}
              />
              Hidden
            </label>
          </div>
          {error ? (
            <div className="notice notice-error" role="alert">
              <span>{error}</span>
              <div>
                {listing?.parent ? (
                  <button
                    className="button ghost small"
                    onClick={() => void go(listing.path)}
                  >
                    <RefreshCw size={13} />
                    Try again
                  </button>
                ) : null}
                <button
                  className="button ghost small"
                  onClick={() => void go(listing?.home)}
                >
                  <House size={13} />
                  Go home
                </button>
              </div>
            </div>
          ) : null}
          <ul
            className="entries"
            aria-label="Folder contents"
            aria-busy={loading}
          >
            {entries.map((entry) =>
              entry.type === "directory" ? (
                <li key={entry.path} className="entry">
                  <button
                    className="entry-main"
                    onClick={() => void go(entry.path)}
                    title={"Show inside " + entry.name}
                  >
                    {entry.git ? (
                      <FolderGit2 size={16} className="entry-git" />
                    ) : (
                      <Folder size={16} />
                    )}
                    <span>{entry.name}</span>
                    {registered.has(entry.path) ? (
                      <em className="tag">In your list</em>
                    ) : entry.git ? (
                      <em className="tag">Git</em>
                    ) : null}
                  </button>
                  <button
                    className="button small entry-open"
                    aria-label={"Open " + entry.name}
                    disabled={!!opening}
                    onClick={() => void open(entry.path)}
                  >
                    {opening === entry.path ? (
                      <LoaderCircle size={13} className="spin" />
                    ) : null}
                    Open
                  </button>
                </li>
              ) : (
                <li key={entry.path} className="entry entry-file">
                  <File size={15} />
                  <span>{entry.name}</span>
                </li>
              ),
            )}
            {listing && !entries.length && !loading ? (
              <li className="entries-empty">
                {filter
                  ? "Nothing here matches that filter."
                  : listing.entries.length
                    ? "Only hidden items are here. Turn on Hidden to see them."
                    : "This folder is empty. You can still open it."}
              </li>
            ) : null}
            {listing?.truncated ? (
              <li className="entries-empty">Showing the first 2,000 items.</li>
            ) : null}
          </ul>
          <footer className="browser-foot">
            <span className="browser-current">
              {listing?.git ? <FolderGit2 size={15} /> : <Folder size={15} />}
              <span>
                <strong>{currentName}</strong>
                <small>
                  {listing
                    ? listing.git
                      ? "Git repository"
                      : "Folder (Git review needs a repository)"
                    : loading
                      ? "Loading…"
                      : ""}
                </small>
              </span>
            </span>
            <button
              className="button primary"
              disabled={!listing || !!opening}
              onClick={() => listing && void open(listing.path)}
            >
              {opening && opening === listing?.path ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <FolderOpen size={15} />
              )}
              Open this folder
            </button>
          </footer>
        </div>
      </div>
    </section>
  );
}
