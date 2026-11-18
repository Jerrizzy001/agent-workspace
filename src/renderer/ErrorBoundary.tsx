import { Component, type ErrorInfo, type ReactNode } from "react";
import { Copy, RefreshCw, RotateCcw } from "lucide-react";

// A lazy chunk that is gone after an upgrade, in Chromium and in Safari.
const staleChunk = (error: Error) =>
  /dynamically imported module|Importing a module script failed|Loading chunk/i.test(
    error.message,
  );

interface Props {
  /** Names what stopped, as the heading's subject: "This view", "Files". */
  area?: string;
  /** A change here clears the error, e.g. moving to another view or folder. */
  resetKey?: string;
  children: ReactNode;
}
interface State {
  error: Error | null;
  details: string;
  copied: boolean;
}

/**
 * Contains a render failure. Sessions run in the host, not in this window, so
 * the fallback can promise they are untouched. Without `area` it covers the
 * whole window and offers only a reload.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, details: "", copied: false };
  static getDerivedStateFromError(error: unknown): Partial<State> {
    return {
      error: error instanceof Error ? error : new Error(String(error)),
      copied: false,
    };
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    const e = error instanceof Error ? error : new Error(String(error));
    console.error(e);
    this.setState({
      details: [`${e.name}: ${e.message}`, e.stack, info.componentStack]
        .filter(Boolean)
        .join("\n"),
    });
  }
  componentDidUpdate(previous: Props) {
    if (this.state.error && previous.resetKey !== this.props.resetKey)
      this.setState({ error: null, details: "", copied: false });
  }
  render() {
    const { error, details, copied } = this.state;
    if (!error) return this.props.children;
    const { area } = this.props;
    const stale = staleChunk(error);
    const copy = () =>
      void navigator.clipboard
        ?.writeText(details || `${error.name}: ${error.message}`)
        .then(() => this.setState({ copied: true }))
        .catch(() => {});
    return (
      <div className={area ? "crash crash-inline" : "crash"} role="alert">
        <div className="crash-card">
          <h2>
            {stale
              ? "Agent Workspace was updated"
              : area
                ? `${area} stopped working`
                : "This window stopped working"}
          </h2>
          <p>
            {stale
              ? "Part of the app changed while this window was open. Reload to use the new version."
              : area
                ? "An error stopped this part of the window from drawing. Other views are unaffected."
                : "An error stopped the window from drawing. Reloading reconnects to your folders and sessions."}{" "}
            Your sessions keep running.
          </p>
          <div className="crash-actions">
            {area && !stale ? (
              <button
                className="button primary"
                onClick={() =>
                  this.setState({ error: null, details: "", copied: false })
                }
              >
                <RotateCcw size={14} />
                Try again
              </button>
            ) : null}
            <button
              className={"button" + (area && !stale ? "" : " primary")}
              onClick={() => window.location.reload()}
            >
              <RefreshCw size={14} />
              Reload window
            </button>
            <button className="button ghost" onClick={copy}>
              <Copy size={14} />
              {copied ? "Copied" : "Copy error details"}
            </button>
          </div>
          <details>
            <summary>Error details</summary>
            <pre>{details || `${error.name}: ${error.message}`}</pre>
          </details>
        </div>
      </div>
    );
  }
}
