import React from "react";
import ErrorState from "./ErrorState.jsx";

/**
 * Catches render/lifecycle errors in its subtree so one broken screen shows a
 * recoverable message instead of unmounting the whole SPA to a blank page.
 * Pass `resetKey` (e.g. the route path) so navigating to another screen clears
 * a caught error automatically — React error boundaries don't reset on their own.
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Surface it for debugging; a real error reporter would hook in here.
    // eslint-disable-next-line no-console
    console.error("Render error:", error, info && info.componentStack);
  }

  componentDidUpdate(prevProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <ErrorState
          error={this.state.error}
          full={this.props.full}
          onRetry={() => this.setState({ error: null })}
        />
      );
    }
    return this.props.children;
  }
}
