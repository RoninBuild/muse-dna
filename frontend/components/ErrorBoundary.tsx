"use client";

import { Component, type ReactNode } from "react";

type ErrorBoundaryProps = {
  children: ReactNode;
  fallback?: (error: Error, reset: () => void) => ReactNode;
};

type ErrorBoundaryState = {
  error: Error | null;
};

/**
 * Root-level error boundary. Without this a single unhandled throw in any
 * child (canvas API refusing to create a 2D context, socket handler crashing
 * on malformed payload, etc.) unmounts the whole app and drops the user into
 * a blank page with no way to recover.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
    // Intentionally do not ship the error to a telemetry endpoint yet — keep
    // behaviour transparent for the demo. Console is the observability layer.
    // eslint-disable-next-line no-console
    console.error("[Muse] unhandled render error:", error, info?.componentStack);
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.reset);
      }
      return (
        <div
          role="alert"
          style={{
            position: "fixed",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "2rem",
            background: "#07090c",
            color: "var(--text, #e0e6f1)",
            fontFamily: "var(--font-mono, monospace)",
            zIndex: 100
          }}
        >
          <div
            style={{
              maxWidth: 560,
              padding: "1.6rem 1.8rem",
              border: "1px solid rgba(255, 86, 86, 0.5)",
              background: "rgba(255, 20, 20, 0.06)"
            }}
          >
            <div
              style={{
                fontSize: "0.6rem",
                letterSpacing: "0.3em",
                color: "#ff8585",
                marginBottom: "0.4rem"
              }}
            >
              MUSE · RENDER ERROR
            </div>
            <div style={{ fontSize: "0.95rem", marginBottom: "0.9rem" }}>
              Something crashed while rendering this view.
            </div>
            <pre
              style={{
                fontSize: "0.7rem",
                color: "var(--text-dim, #8a93a8)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                margin: "0 0 1rem"
              }}
            >
              {String(this.state.error?.message || this.state.error)}
            </pre>
            <button
              type="button"
              onClick={this.reset}
              style={{
                padding: "0.5rem 0.95rem",
                fontFamily: "var(--font-display, sans-serif)",
                fontSize: "0.75rem",
                fontWeight: 700,
                letterSpacing: "0.1em",
                background: "var(--acid, #c6f51f)",
                color: "#000",
                border: "none",
                cursor: "pointer"
              }}
            >
              ▶ RETRY
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
