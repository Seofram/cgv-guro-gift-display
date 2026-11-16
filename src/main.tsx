import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import "../app/globals.css";
import App from "./App";

const root = document.getElementById("root");

if (!root) {
  throw new Error("CGV Gift Display root element was not found.");
}

/**
 * Last line of defence: a rendering error must never leave the secondary
 * monitor blank. The page explains the problem and reloads itself.
 */
class AppErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  private reloadTimer: number | undefined;

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    this.reloadTimer = window.setTimeout(() => window.location.reload(), 15000);
  }

  componentWillUnmount() {
    window.clearTimeout(this.reloadTimer);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="boot-screen app-error" role="alert">
        {"화면을 표시하는 중 문제가 발생했습니다.\n잠시 후 자동으로 다시 시도합니다. 계속되면 프로그램을 다시 실행해 주세요."}
      </div>
    );
  }
}

createRoot(root).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);
