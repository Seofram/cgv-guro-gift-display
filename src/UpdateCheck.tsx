import { useCallback, useEffect, useRef, useState } from "react";
import packageJson from "../package.json";
import { checkLatestRelease, RELEASES_URL } from "./release-check.mjs";

const CURRENT_VERSION = packageJson.version;
type ReleaseCheckResult = Awaited<ReturnType<typeof checkLatestRelease>>;

export function UpdateCheck() {
  const [result, setResult] = useState<ReleaseCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const mounted = useRef(true);
  const request = useRef<AbortController | null>(null);
  const check = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setChecking(true);
    const next = await checkLatestRelease({ currentVersion: CURRENT_VERSION, signal: controller.signal });
    if (mounted.current && request.current === controller && !controller.signal.aborted) {
      // Failed checks stay silent and retain any previously discovered release.
      if (next.status === "update" || next.status === "current") setResult(next);
      setChecking(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    // Defer until after StrictMode's setup/cleanup replay to send only one check.
    queueMicrotask(() => { if (!disposed) void check(); });
    return () => {
      disposed = true;
      mounted.current = false;
      request.current?.abort();
    };
  }, [check]);
  return (
    <aside aria-live="polite" className="update-check">
      <span>현재 버전 {CURRENT_VERSION}</span>
      <button type="button" onClick={() => void check()} disabled={checking}>
        {checking ? "업데이트 확인 중…" : "업데이트 확인"}
      </button>
      {result?.status === "update" && result.release ? (
        <a href={result.release.url || RELEASES_URL} target="_blank" rel="noreferrer">업데이트 가능 · {result.release.tag}</a>
      ) : result?.status === "current" ? <span>최신 버전입니다</span> : null}
    </aside>
  );
}
