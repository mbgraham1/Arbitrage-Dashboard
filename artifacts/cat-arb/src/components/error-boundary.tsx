import React from "react";
import { AlertTriangle } from "lucide-react";

/**
 * Generic React error boundary.
 *
 * One bad row (e.g. a legacy ledger record with an unexpected field shape)
 * must never white-screen the whole dashboard. Wrap independent sections in
 * their own boundary so a render crash is contained to that section and the
 * rest of the page keeps working. A "Try again" button re-mounts the subtree.
 */
export class ErrorBoundary extends React.Component<
  { children: React.ReactNode; label?: string },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Surface the real cause in the console for debugging — the fallback UI
    // intentionally shows only a short message.
    console.error(`[ErrorBoundary${this.props.label ? `:${this.props.label}` : ""}]`, error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          className="border-2 border-destructive bg-destructive/5 p-4 flex flex-col gap-2"
          data-testid="error-boundary-fallback"
        >
          <div className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span className="text-sm font-bold uppercase">
              {this.props.label ? `${this.props.label} failed to render` : "This section failed to render"}
            </span>
          </div>
          <span className="text-xs font-mono text-muted-foreground break-all">
            {String(this.state.error?.message ?? this.state.error)}
          </span>
          <button
            className="self-start text-xs font-mono font-bold border-2 border-border px-2 py-1 hover:bg-muted"
            onClick={() => this.setState({ error: null })}
            data-testid="button-error-boundary-retry"
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
