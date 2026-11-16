"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { DateRangeEditor } from "./DateRangeEditor";
import { UpdateCheck } from "./UpdateCheck";
import {
  newItemDates,
  getScheduleState,
  isAppDataLike,
  nextUpdatedAt,
  normalizeAppData,
  sameAppData,
} from "./schedule.mjs";
import { buildDisplayPages } from "./display-pages.mjs";
import { stableGroupItemsByMovie } from "./item-order.mjs";

type GiftStatus =
  | "available"
  | "depleting"
  | "low"
  | "soldout"
  | "ready";

type GiftItem = {
  id: string;
  movie: string;
  format: string;
  gift: string;
  status: GiftStatus;
  startDate: string;
  endDate: string;
  days: number[];
  visible: boolean;
};

type DisplaySettings = {
  location: string;
  title: string;
  notices: string[];
  pageSeconds: number;
  showSoldout: boolean;
  rotateNotices: boolean;
};

type AppData = {
  items: GiftItem[];
  settings: DisplaySettings;
  updatedAt: string;
};

type DisplayMonitorStatus = {
  controller: boolean;
  running: boolean;
  expected: boolean;
  abnormal: boolean;
  incidentId: string | null;
  incidentAt: string | null;
  lastSyncAt: string | null;
  // Absent on controllers older than the display heartbeat.
  responding?: boolean;
  displaySeenAt?: string | null;
};

const STORAGE_KEY = "cgv-guro-gift-display-v1";
// The controller revision this profile's copy is based on, and whether the
// copy holds edits that SQLite has not confirmed yet.
const SYNC_KEY = "cgv-guro-gift-display-sync-v1";
// Versions set aside when a save conflict was resolved; nothing is discarded.
const RECOVERY_KEY = "cgv-guro-gift-display-recovery-v1";
const RECOVERY_LIMIT = 20;
const CONTROLLER_URL = "";
const DAYS = ["일", "월", "화", "수", "목", "금", "토"];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

function serverDate(value: string) {
  const numeric = Number(value);
  return new Date(Number.isFinite(numeric) ? numeric : value);
}

const STATUS_META: Record<
  GiftStatus,
  { label: string; short: string; className: string }
> = {
  available: { label: "제공 중", short: "제공 중", className: "available" },
  depleting: { label: "소진 중", short: "소진 중", className: "depleting" },
  low: { label: "소진 임박", short: "소진 임박", className: "low" },
  soldout: { label: "재고 소진", short: "재고 소진", className: "soldout" },
  ready: { label: "준비 중", short: "준비 중", className: "ready" },
};

const SAMPLE_DATA: AppData = {
  items: [
    {
      id: "gift-01",
      movie: "토이스토리5",
      format: "SCREENX",
      gift: "SX 포스터",
      status: "soldout",
      startDate: "2026-07-01",
      endDate: "2026-12-31",
      days: ALL_DAYS,
      visible: true,
    },
    {
      id: "gift-02",
      movie: "토이스토리5",
      format: "전체",
      gift: "TTT",
      status: "soldout",
      startDate: "2026-07-01",
      endDate: "2026-12-31",
      days: ALL_DAYS,
      visible: true,
    },
    {
      id: "gift-03",
      movie: "슈퍼맨",
      format: "SCREENX",
      gift: "SX 포스터",
      status: "available",
      startDate: "2026-07-01",
      endDate: "2026-12-31",
      days: ALL_DAYS,
      visible: true,
    },
    {
      id: "gift-04",
      movie: "슈퍼맨",
      format: "전체",
      gift: "TTT",
      status: "soldout",
      startDate: "2026-07-01",
      endDate: "2026-12-31",
      days: ALL_DAYS,
      visible: true,
    },
    {
      id: "gift-05",
      movie: "디스클로저 데이",
      format: "전체",
      gift: "TTT",
      status: "depleting",
      startDate: "2026-07-01",
      endDate: "2026-12-31",
      days: ALL_DAYS,
      visible: true,
    },
    {
      id: "gift-06",
      movie: "상자 속의 양",
      format: "전체",
      gift: "3주차 엽서 SET",
      status: "available",
      startDate: "2026-07-01",
      endDate: "2026-12-31",
      days: ALL_DAYS,
      visible: true,
    },
    {
      id: "gift-07",
      movie: "상자 속의 양",
      format: "전체",
      gift: "주말 렌티큘러 엽서",
      status: "available",
      startDate: "2026-07-01",
      endDate: "2026-12-31",
      days: [0, 6],
      visible: true,
    },
    {
      id: "gift-08",
      movie: "싱 스트리트",
      format: "전체",
      gift: "트랙리스트 포스터 (A3)",
      status: "available",
      startDate: "2026-07-01",
      endDate: "2026-12-31",
      days: ALL_DAYS,
      visible: true,
    },
  ],
  settings: {
    location: "구로",
    title: "경품 안내",
    notices: [
      "당일 CGV 구로 관람 티켓에 한해 수령 가능합니다. 경품 수령 후 교환은 불가합니다.",
      "예매 고객은 티켓 표기 시간 이후 6층 매점에서 경품 수령 가능합니다. (마지막 영화 포함)",
      "경품은 선착순 지급되며 실시간 소진 등의 사유로 안내된 전산 보유수량과 실제 재고에 차이가 있을 수 있습니다.",
    ],
    pageSeconds: 8,
    showSoldout: true,
    rotateNotices: false,
  },
  updatedAt: new Date().toISOString(),
};

function cloneSample(): AppData {
  return JSON.parse(JSON.stringify(SAMPLE_DATA)) as AppData;
}

function normalizeMovieName(movie: string) {
  return movie.trim();
}

function groupItems(items: GiftItem[]) {
  const groups: { movie: string; items: GiftItem[] }[] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (
      last &&
      normalizeMovieName(last.movie) === normalizeMovieName(item.movie)
    ) {
      last.items.push(item);
    } else {
      groups.push({ movie: item.movie, items: [item] });
    }
  }
  return groups;
}

function paginateGroups(
  groups: { movie: string; items: GiftItem[] }[],
  maxRows = 8,
) {
  const pages: typeof groups[] = [];
  let page: typeof groups = [];
  let rowCount = 0;

  for (const group of groups) {
    if (page.length && rowCount + group.items.length > maxRows) {
      pages.push(page);
      page = [];
      rowCount = 0;
    }
    page.push(group);
    rowCount += group.items.length;
  }
  if (page.length) pages.push(page);
  return pages.length ? pages : [[]];
}

type ViewMode = { view: "admin" | "display"; monitor: boolean };

function readViewMode(): ViewMode {
  const params = new URLSearchParams(window.location.search);
  return {
    view: params.get("view") === "display" ? "display" : "admin",
    // The monitoring popup is a read-only preview and never counts as the
    // real secondary-monitor display.
    monitor: params.get("monitor") === "1",
  };
}

function readStorage(key: string) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
    return true;
  } catch {
    // Storage may be unavailable or full; SQLite remains the source of truth.
    return false;
  }
}

function readLocalData(): AppData | null {
  const stored = readStorage(STORAGE_KEY);
  if (!stored) return null;
  try {
    const parsed: unknown = JSON.parse(stored);
    return isAppDataLike(parsed) ? (normalizeAppData(parsed) as AppData) : null;
  } catch {
    return null;
  }
}

type SyncMeta = { baseRevision: number; dirty: boolean };

function readSyncMeta(): SyncMeta | null {
  try {
    const parsed = JSON.parse(readStorage(SYNC_KEY) ?? "null") as SyncMeta | null;
    return parsed &&
      Number.isSafeInteger(parsed.baseRevision) &&
      parsed.baseRevision >= 0 &&
      typeof parsed.dirty === "boolean"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

type RecoveryEntry = {
  id: string;
  savedAt: string;
  // "local": edits from this PC that were not saved. "server": what another
  // window had saved. "replaced": what was on screen before a restore.
  source: "local" | "server" | "replaced";
  data: AppData;
};

function readRecovery(): RecoveryEntry[] {
  try {
    const parsed: unknown = JSON.parse(readStorage(RECOVERY_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry): entry is RecoveryEntry =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as RecoveryEntry).id === "string" &&
          isAppDataLike((entry as RecoveryEntry).data),
      )
      .map((entry) => ({
        ...entry,
        data: normalizeAppData(entry.data) as AppData,
      }));
  } catch {
    return [];
  }
}

type LoadOutcome =
  | { kind: "data"; data: AppData; revision: number }
  | { kind: "empty"; reset: boolean }
  | { kind: "failed" };

async function loadControllerData(): Promise<LoadOutcome> {
  try {
    const response = await fetch(`${CONTROLLER_URL}/data`, {
      cache: "no-store",
    });
    if (response.ok) {
      const result = (await response.json()) as {
        data?: unknown;
        revision?: unknown;
      };
      return isAppDataLike(result.data)
        ? {
            kind: "data",
            data: normalizeAppData(result.data) as AppData,
            revision:
              typeof result.revision === "number" ? result.revision : 0,
          }
        : { kind: "failed" };
    }
    if (response.status === 404) {
      const result = (await response.json().catch(() => ({}))) as {
        reset?: boolean;
      };
      return { kind: "empty", reset: Boolean(result.reset) };
    }
  } catch {
    // Fall through: an unreadable store is never treated as an empty one.
  }
  return { kind: "failed" };
}

type SaveConflict = { server: AppData; serverRevision: number };

export default function Home() {
  const [data, setData] = useState<AppData>(cloneSample);
  const [hydrated, setHydrated] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [conflict, setConflict] = useState<SaveConflict | null>(null);
  const [recovery, setRecovery] = useState<RecoveryEntry[]>(readRecovery);
  const [{ view, monitor }] = useState(readViewMode);
  const dataRef = useRef(data);
  // The exact state object known to be stored in SQLite. Identity, not a
  // timestamp, decides whether a save is needed.
  const syncedData = useRef<AppData | null>(null);
  // Fallback for the base revision when localStorage is unavailable.
  const memoryBase = useRef(0);
  const saving = useRef(false);
  const conflicted = useRef(false);
  const retryTimer = useRef<number | undefined>(undefined);
  const displayRevision = useRef<number | null>(null);

  // The base revision is shared by every administrator window of this
  // profile, so a second window never saves from a revision another window
  // has already moved past.
  const currentBase = () => readSyncMeta()?.baseRevision ?? memoryBase.current;
  const setBase = (baseRevision: number, dirty: boolean) => {
    memoryBase.current = baseRevision;
    writeStorage(SYNC_KEY, JSON.stringify({ baseRevision, dirty }));
  };

  const stashRecovery = useCallback(
    (source: RecoveryEntry["source"], version: AppData) => {
      setRecovery((current) => {
        if (current.some((entry) => sameAppData(entry.data, version))) {
          return current;
        }
        const next = [
          {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            savedAt: new Date().toISOString(),
            source,
            data: version,
          },
          ...current,
        ].slice(0, RECOVERY_LIMIT);
        writeStorage(RECOVERY_KEY, JSON.stringify(next));
        return next;
      });
    },
    [],
  );

  // Saves are strictly serialized: one request at a time, each based on the
  // revision returned by the previous one. A request can therefore never
  // conflict with this window's own earlier request.
  const pump = useCallback(async () => {
    if (saving.current || conflicted.current) return;
    saving.current = true;
    window.clearTimeout(retryTimer.current);
    try {
      for (;;) {
        const pending = dataRef.current;
        if (syncedData.current === pending) break;
        const base = currentBase();
        let response: Response | null = null;
        try {
          response = await fetch(`${CONTROLLER_URL}/data`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-CGV-Base-Revision": String(base),
            },
            body: JSON.stringify(pending),
          });
        } catch {
          response = null;
        }

        if (response?.ok) {
          const result = (await response.json().catch(() => ({}))) as {
            revision?: unknown;
          };
          syncedData.current = pending;
          setBase(
            typeof result.revision === "number" ? result.revision : base,
            dataRef.current !== pending,
          );
          setSaveFailed(false);
          continue;
        }

        if (response?.status === 409) {
          const latest = await loadControllerData();
          if (latest.kind === "data") {
            if (sameAppData(latest.data, pending)) {
              // SQLite already holds exactly this state: an earlier request
              // was stored but its reply was lost, or another window saved
              // the same edit. Nothing differs, so there is no conflict.
              syncedData.current = pending;
              setBase(latest.revision, dataRef.current !== pending);
              setSaveFailed(false);
              continue;
            }
            // Different data was saved elsewhere first. Keep this window's
            // edits untouched and let the operator decide.
            conflicted.current = true;
            setConflict({
              server: latest.data,
              serverRevision: latest.revision,
            });
            setSaveFailed(false);
            break;
          }
          if (latest.kind === "empty") {
            // The store was emptied while this window stayed open. The
            // operator's visible inventory is written back rather than lost.
            setBase(0, true);
            continue;
          }
        }

        setSaveFailed(true);
        retryTimer.current = window.setTimeout(() => void pump(), 3000);
        break;
      }
    } finally {
      saving.current = false;
    }
    // Refs and storage helpers only; nothing here changes between renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let disposed = false;
    let hydrateTimer: number | undefined;
    document.body.classList.toggle("display-mode", view === "display");
    const localData = readLocalData();

    const finish = (initialData: AppData, stored: boolean) => {
      syncedData.current = stored ? initialData : null;
      setData(initialData);
      setLoadFailed(false);
      setHydrated(true);
    };

    const hydrate = async () => {
      const outcome = await loadControllerData();
      if (disposed) return;

      if (outcome.kind === "data") {
        displayRevision.current = outcome.revision;
        const meta = readSyncMeta();
        const unsavedLocal =
          view === "admin" &&
          localData !== null &&
          meta?.dirty === true &&
          !sameAppData(localData, outcome.data);
        if (unsavedLocal && localData) {
          if (meta?.baseRevision !== outcome.revision) {
            // Edits made here never reached SQLite (for example the server
            // stopped), and different data has been saved since. Neither
            // version is dropped: the operator chooses.
            conflicted.current = true;
            setConflict({
              server: outcome.data,
              serverRevision: outcome.revision,
            });
          }
          // Otherwise the edits are based on what is stored and are simply
          // saved now.
          finish(localData, false);
          return;
        }
        if (view === "admin") setBase(outcome.revision, false);
        finish(outcome.data, true);
        return;
      }
      if (outcome.kind === "empty") {
        if (view === "admin") setBase(0, false);
        finish((outcome.reset ? null : localData) ?? cloneSample(), false);
        return;
      }
      // The store could not be read. A display may keep showing its last
      // copy, but the administrator must not start from (and then save) a
      // stale or sample copy over the real inventory.
      if (view === "display" && localData) {
        finish(localData, false);
        return;
      }
      setLoadFailed(true);
      hydrateTimer = window.setTimeout(() => void hydrate(), 2000);
    };
    void hydrate();

    const onStorage = (event: StorageEvent) => {
      if (event.key === RECOVERY_KEY) {
        setRecovery(readRecovery());
        return;
      }
      if (event.key === STORAGE_KEY && event.newValue) {
        try {
          const incoming: unknown = JSON.parse(event.newValue);
          if (isAppDataLike(incoming)) {
            // Another administrator window of this profile made this edit
            // and is responsible for saving it; this window only mirrors it.
            const mirrored = normalizeAppData(incoming) as AppData;
            syncedData.current = mirrored;
            setData(mirrored);
          }
        } catch {
          // Ignore malformed storage events and retain the current inventory.
        }
      }
    };
    // Only administrator windows exchange edits through localStorage.
    // Display windows follow SQLite through the controller alone.
    if (view === "admin") window.addEventListener("storage", onStorage);
    return () => {
      disposed = true;
      window.clearTimeout(hydrateTimer);
      window.removeEventListener("storage", onStorage);
    };
  }, [view]);

  useEffect(() => {
    dataRef.current = data;
    // Display windows are read-only consumers: they never write shared
    // storage, so a late poll response cannot roll back administrator edits.
    if (!hydrated || view !== "admin") return;
    const kept = writeStorage(STORAGE_KEY, JSON.stringify(data));
    if (syncedData.current === data) return;
    // The local copy is marked as holding unsaved edits only when it really
    // contains them; otherwise a later start could mistake an older copy
    // for newer work.
    if (kept) setBase(currentBase(), true);
    void pump();
  }, [data, hydrated, view, pump]);

  useEffect(() => () => window.clearTimeout(retryTimer.current), []);

  // Conflict resolution. Whichever version is not chosen is set aside in
  // the recovery list first, so neither one is ever discarded.
  const keepLocalVersion = useCallback(async () => {
    const latest = await loadControllerData();
    if (latest.kind === "failed") return false;
    if (latest.kind === "data") {
      if (!sameAppData(latest.data, dataRef.current)) {
        stashRecovery("server", latest.data);
      }
      setBase(latest.revision, true);
    } else {
      setBase(0, true);
    }
    conflicted.current = false;
    setConflict(null);
    void pump();
    return true;
  }, [pump, stashRecovery]);

  const adoptServerVersion = useCallback(async () => {
    const latest = await loadControllerData();
    if (latest.kind !== "data") return false;
    if (!sameAppData(latest.data, dataRef.current)) {
      stashRecovery("local", dataRef.current);
    }
    syncedData.current = latest.data;
    setBase(latest.revision, false);
    conflicted.current = false;
    setConflict(null);
    setData(latest.data);
    return true;
  }, [stashRecovery]);

  const restoreRecovery = useCallback(
    (id: string) => {
      const entry = recovery.find((candidate) => candidate.id === id);
      if (!entry) return;
      if (!sameAppData(entry.data, dataRef.current)) {
        stashRecovery("replaced", dataRef.current);
      }
      setRecovery((current) => {
        const next = current.filter((candidate) => candidate.id !== id);
        writeStorage(RECOVERY_KEY, JSON.stringify(next));
        return next;
      });
      setData((current) => ({
        ...entry.data,
        updatedAt: nextUpdatedAt(current.updatedAt),
      }));
    },
    [recovery, stashRecovery],
  );

  const deleteRecovery = useCallback((id: string) => {
    setRecovery((current) => {
      const next = current.filter((candidate) => candidate.id !== id);
      writeStorage(RECOVERY_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const readyTitle =
      view === "display"
        ? monitor
          ? "CGV 구로 경품 모니터링"
          : "CGV 구로 경품 전시 화면"
        : "CGV 구로 경품 관리";
    document.title = readyTitle;
    document.documentElement.dataset.appReady = "true";
  }, [hydrated, view, monitor]);

  useEffect(() => {
    if (!hydrated || view !== "display") return;

    let disposed = false;
    const syncDisplayData = async () => {
      try {
        const response = await fetch(`${CONTROLLER_URL}/data`, {
          cache: "no-store",
          // Lets the controller confirm that the real display is alive.
          headers: monitor ? undefined : { "X-CGV-Client": "display" },
        });
        if (!response.ok) return;
        const result = (await response.json()) as {
          data?: unknown;
          revision?: unknown;
        };
        const incoming = result.data;
        if (!disposed && isAppDataLike(incoming)) {
          const next = normalizeAppData(incoming) as AppData;
          const revision =
            typeof result.revision === "number" && result.revision > 0
              ? result.revision
              : null;
          const revisionChanged =
            revision !== null && revision !== displayRevision.current;
          displayRevision.current = revision;
          setData((current) =>
            revisionChanged || next.updatedAt !== current.updatedAt
              ? next
              : current,
          );
        }
      } catch {
        // Keep showing the last received inventory until the controller returns.
      }
    };

    void syncDisplayData();
    const timer = window.setInterval(syncDisplayData, 1000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [hydrated, view, monitor]);

  if (!hydrated) {
    return (
      <div className="boot-screen" role="status">
        {loadFailed
          ? "데이터를 불러오지 못했습니다. 자동으로 다시 시도하고 있습니다."
          : "화면을 준비하고 있습니다."}
      </div>
    );
  }

  return view === "display" ? (
    <DisplayScreen data={data} />
  ) : (
    <AdminScreen
      data={data}
      setData={setData}
      saveFailed={saveFailed}
      conflict={conflict}
      onKeepLocal={keepLocalVersion}
      onUseServer={adoptServerVersion}
      recovery={recovery}
      onRestoreRecovery={restoreRecovery}
      onDeleteRecovery={deleteRecovery}
    />
  );
}

const SETTING_LABELS: Record<keyof DisplaySettings, string> = {
  location: "지점명",
  title: "화면 제목",
  notices: "주의사항",
  pageSeconds: "페이지 전환",
  showSoldout: "소진 항목 표시",
  rotateNotices: "공지 순환",
};

function describeItem(item: GiftItem) {
  return `${item.movie || "(영화명 없음)"} · ${item.gift || "(경품명 없음)"}`;
}

/** Plain-language list of what differs between two versions. */
function describeDifferences(local: AppData, server: AppData) {
  const lines: string[] = [];
  for (const key of Object.keys(SETTING_LABELS) as (keyof DisplaySettings)[]) {
    if (!sameAppData(local.settings[key], server.settings[key])) {
      lines.push(`설정이 다름: ${SETTING_LABELS[key]}`);
    }
  }
  const serverItems = new Map(server.items.map((item) => [item.id, item]));
  const localIds = new Set(local.items.map((item) => item.id));
  for (const item of local.items) {
    const other = serverItems.get(item.id);
    if (!other) lines.push(`이 창에만 있음: ${describeItem(item)}`);
    else if (!sameAppData(item, other)) {
      lines.push(`내용이 다름: ${describeItem(item)}`);
    }
  }
  for (const item of server.items) {
    if (!localIds.has(item.id)) {
      lines.push(`저장된 내용에만 있음: ${describeItem(item)}`);
    }
  }
  if (
    !lines.length &&
    !sameAppData(
      local.items.map((item) => item.id),
      server.items.map((item) => item.id),
    )
  ) {
    lines.push("항목 순서가 다름");
  }
  return lines;
}

function describeVersion(version: AppData) {
  const edited = new Date(version.updatedAt);
  const time = Number.isNaN(edited.getTime())
    ? ""
    : ` · ${edited.toLocaleString("ko-KR")} 수정`;
  return `경품 ${version.items.length}개 · 주의사항 ${version.settings.notices.length}개${time}`;
}

const RECOVERY_LABELS: Record<RecoveryEntry["source"], string> = {
  local: "이 PC에서 수정했지만 저장하지 않은 내용",
  server: "다른 창에서 저장했던 내용",
  replaced: "복원하기 전에 사용하던 내용",
};

function downloadVersion(entry: RecoveryEntry) {
  const blob = new Blob([JSON.stringify(entry.data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `cgv-gift-version-${entry.savedAt.replace(/[:.]/g, "-")}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function AdminScreen({
  data,
  setData,
  saveFailed,
  conflict,
  onKeepLocal,
  onUseServer,
  recovery,
  onRestoreRecovery,
  onDeleteRecovery,
}: {
  data: AppData;
  setData: React.Dispatch<React.SetStateAction<AppData>>;
  saveFailed: boolean;
  conflict: SaveConflict | null;
  onKeepLocal: () => Promise<boolean>;
  onUseServer: () => Promise<boolean>;
  recovery: RecoveryEntry[];
  onRestoreRecovery: (id: string) => void;
  onDeleteRecovery: (id: string) => void;
}) {
  // A new conflict always opens the dialog; "나중에 선택" only hides it.
  const [conflictDialogOpen, setConflictDialogOpen] = useState(false);
  const [conflictBusy, setConflictBusy] = useState(false);
  const [conflictError, setConflictError] = useState(false);
  const conflictRevision = conflict?.serverRevision ?? null;
  useEffect(() => {
    if (conflictRevision !== null) setConflictDialogOpen(true);
  }, [conflictRevision]);
  const resolveConflict = async (resolve: () => Promise<boolean>) => {
    setConflictBusy(true);
    setConflictError(false);
    const resolved = await resolve();
    setConflictBusy(false);
    setConflictError(!resolved);
    if (resolved) setConflictDialogOpen(false);
  };
  const [savedPulse, setSavedPulse] = useState(false);
  const [expandedDayRow, setExpandedDayRow] = useState<string | null>(null);
  const [expiryPromptOpen, setExpiryPromptOpen] = useState(false);
  const [resetPromptOpen, setResetPromptOpen] = useState(false);
  // One-step undo for destructive actions. `restore` re-applies what was
  // removed onto the current state, so edits made in between are kept.
  const [undo, setUndo] = useState<{
    id: number;
    message: string;
    restore: (current: AppData) => AppData;
  } | null>(null);
  const undoSequence = useRef(0);
  const pendingFocusId = useRef<string | null>(null);
  const movieInputs = useRef(new Map<string, HTMLTextAreaElement>());
  const [displayAction, setDisplayAction] = useState<
    "opening" | "closing" | null
  >(null);
  const [displayMessage, setDisplayMessage] = useState("");
  const [monitorStatus, setMonitorStatus] =
    useState<DisplayMonitorStatus | null>(null);
  const [abnormalExit, setAbnormalExit] = useState<{
    id: string;
    at: string | null;
  } | null>(null);
  const lastIncidentId = useRef<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  // "running" only proves that a display window exists; "responding" proves
  // that the display page itself is still fetching inventory.
  const displayHealth = !monitorStatus?.controller
    ? "offline"
    : !monitorStatus.running
      ? "standby"
      : monitorStatus.responding === false
        ? "unresponsive"
        : "online";
  const displaySyncAt =
    displayHealth === "online" && monitorStatus?.displaySeenAt
      ? monitorStatus.displaySeenAt
      : (monitorStatus?.lastSyncAt ?? null);
  const todayItems = data.items.filter(
    (item) => item.visible && getScheduleState(item, now).active,
  );
  const expiredItems = data.items.filter(
    (item) => getScheduleState(item, now).reason === "expired",
  );

  useEffect(() => {
    const clock = window.setInterval(() => setNow(new Date()), 30000);
    return () => window.clearInterval(clock);
  }, []);

  useEffect(() => {
    let disposed = false;

    const checkDisplayStatus = async () => {
      try {
        const response = await fetch(
          `${CONTROLLER_URL}/display/status`,
          { cache: "no-store" },
        );
        if (!response.ok) throw new Error("status unavailable");
        const result = (await response.json()) as DisplayMonitorStatus;
        if (disposed) return;
        setMonitorStatus({ ...result, controller: true });

        if (
          result.abnormal &&
          result.incidentId &&
          result.incidentId !== lastIncidentId.current
        ) {
          lastIncidentId.current = result.incidentId;
          setAbnormalExit({
            id: result.incidentId,
            at: result.incidentAt,
          });
        }
      } catch {
        if (!disposed) {
          setMonitorStatus({
            controller: false,
            running: false,
            expected: false,
            abnormal: false,
            incidentId: null,
            incidentAt: null,
            lastSyncAt: null,
          });
        }
      }
    };

    void checkDisplayStatus();
    const statusTimer = window.setInterval(checkDisplayStatus, 5000);
    return () => {
      disposed = true;
      window.clearInterval(statusTimer);
    };
  }, []);

  useEffect(() => {
    const id = pendingFocusId.current;
    if (!id) return;
    pendingFocusId.current = null;
    const input = movieInputs.current.get(id);
    if (!input) return;
    input.closest("tr")?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    input.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    input.focus({ preventScroll: true });
    input.select();
  }, [data.items]);

  const updateDates = (id: string, dates: { startDate: string; endDate: string }) => {
    setData((current) => ({
      ...current,
      updatedAt: nextUpdatedAt(current.updatedAt),
      items: current.items.map((item) => item.id === id ? { ...item, ...dates } : item),
    }));
    pulseSaved();
  };

  const updateItem = <K extends keyof GiftItem>(
    id: string,
    key: K,
    value: GiftItem[K],
  ) => {
    setData((current) => ({
      ...current,
      updatedAt: nextUpdatedAt(current.updatedAt),
      items: current.items.map((item) =>
        item.id === id ? { ...item, [key]: value } : item,
      ),
    }));
    setSavedPulse(true);
    window.setTimeout(() => setSavedPulse(false), 900);
  };

  const updateSettings = <K extends keyof DisplaySettings>(
    key: K,
    value: DisplaySettings[K],
  ) => {
    setData((current) => ({
      ...current,
      updatedAt: nextUpdatedAt(current.updatedAt),
      settings: { ...current.settings, [key]: value },
    }));
    setSavedPulse(true);
    window.setTimeout(() => setSavedPulse(false), 900);
  };

  const pulseSaved = () => {
    setSavedPulse(true);
    window.setTimeout(() => setSavedPulse(false), 900);
  };

  const addItem = () => {
    const dates = newItemDates();
    const id = `gift-${crypto.randomUUID()}`;
    pendingFocusId.current = id;
    setData((current) => ({
      ...current,
      updatedAt: nextUpdatedAt(current.updatedAt),
      items: [
        ...current.items,
        {
          id,
          movie: "새 영화",
          format: "전체",
          gift: "경품명을 입력하세요",
          status: "available",
          ...dates,
          days: ALL_DAYS,
          visible: true,
        },
      ],
    }));
  };

  const moveItem = (id: string, direction: -1 | 1) => {
    setData((current) => {
      const currentIndex = current.items.findIndex((item) => item.id === id);
      const nextIndex = currentIndex + direction;

      if (
        currentIndex < 0 ||
        nextIndex < 0 ||
        nextIndex >= current.items.length
      ) {
        return current;
      }

      const items = [...current.items];
      [items[currentIndex], items[nextIndex]] = [
        items[nextIndex],
        items[currentIndex],
      ];

      return {
        ...current,
        updatedAt: nextUpdatedAt(current.updatedAt),
        items,
      };
    });
    pulseSaved();
  };

  const groupSameMovies = () => {
    setData((current) => ({
      ...current,
      updatedAt: nextUpdatedAt(current.updatedAt),
      items: stableGroupItemsByMovie(current.items),
    }));
    pulseSaved();
    showDisplayMessage("같은 영화 항목끼리 모았습니다.");
  };

  const offerUndo = (
    message: string,
    restore: (current: AppData) => AppData,
  ) => {
    const id = ++undoSequence.current;
    setUndo({ id, message, restore });
    window.setTimeout(
      () => setUndo((current) => (current?.id === id ? null : current)),
      15000,
    );
  };

  const applyUndo = () => {
    if (!undo) return;
    const { restore } = undo;
    setUndo(null);
    setData((current) => ({
      ...restore(current),
      updatedAt: nextUpdatedAt(current.updatedAt),
    }));
    pulseSaved();
  };

  const restoreItems = (
    current: AppData,
    removed: { item: GiftItem; index: number }[],
  ): AppData => {
    const items = [...current.items];
    for (const { item, index } of removed) {
      if (items.some((existing) => existing.id === item.id)) continue;
      items.splice(Math.min(index, items.length), 0, item);
    }
    return { ...current, items };
  };

  const removeItem = (id: string) => {
    const index = data.items.findIndex((item) => item.id === id);
    if (index < 0) return;
    const removed = [{ item: data.items[index], index }];
    setData((current) => ({
      ...current,
      updatedAt: nextUpdatedAt(current.updatedAt),
      items: current.items.filter((item) => item.id !== id),
    }));
    offerUndo("항목 1개를 삭제했습니다.", (current) =>
      restoreItems(current, removed),
    );
  };

  const removeExpiredItems = () => {
    const expiredIds = new Set(expiredItems.map((item) => item.id));
    const isRemoved = (item: GiftItem) =>
      expiredIds.has(item.id) &&
      getScheduleState(item, new Date()).reason === "expired";
    const removed = data.items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => isRemoved(item));
    setData((current) => ({
      ...current,
      updatedAt: nextUpdatedAt(current.updatedAt),
      items: current.items.filter((item) => !isRemoved(item)),
    }));
    setExpiryPromptOpen(false);
    if (removed.length) {
      offerUndo(`만료 항목 ${removed.length}개를 삭제했습니다.`, (current) =>
        restoreItems(current, removed),
      );
    }
  };

  const removeNotice = (index: number) => {
    const notice = data.settings.notices[index];
    if (notice === undefined) return;
    updateSettings(
      "notices",
      data.settings.notices.filter((_, noticeIndex) => noticeIndex !== index),
    );
    offerUndo("주의사항 1개를 삭제했습니다.", (current) => {
      const notices = [...current.settings.notices];
      if (notices.length >= 5) return current;
      notices.splice(Math.min(index, notices.length), 0, notice);
      return { ...current, settings: { ...current.settings, notices } };
    });
  };

  const resetToSample = () => {
    const previous = data;
    setData((current) => ({
      ...cloneSample(),
      updatedAt: nextUpdatedAt(current.updatedAt),
    }));
    setResetPromptOpen(false);
    offerUndo("예시 데이터로 초기화했습니다.", () => previous);
  };

  const toggleDay = (item: GiftItem, day: number) => {
    const next = item.days.includes(day)
      ? item.days.filter((value) => value !== day)
      : [...item.days, day].sort();
    updateItem(item.id, "days", next);
  };

  const toggleDayRow = (id: string) => {
    setExpandedDayRow((current) => (current === id ? null : id));
  };

  const setEveryDay = (item: GiftItem) => {
    updateItem(item.id, "days", ALL_DAYS);
    setExpandedDayRow(null);
  };

  const showDisplayMessage = (message: string, duration = 3200) => {
    setDisplayMessage(message);
    window.setTimeout(() => setDisplayMessage(""), duration);
  };

  const requestDisplayController = async (action: "open" | "close") => {
    const response = await fetch(`${CONTROLLER_URL}/display/${action}`, {
      method: "POST",
    });
    if (!response.ok) {
      const result = (await response.json().catch(() => ({}))) as {
        message?: string;
      };
      throw new Error(result.message || `HTTP ${response.status}`);
    }
  };

  const openDisplay = async () => {
    setDisplayAction("opening");
    try {
      const syncResponse = await fetch(`${CONTROLLER_URL}/data`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!syncResponse.ok) throw new Error("데이터 저장 실패");
      await requestDisplayController("open");
      showDisplayMessage("모니터 2에 전시 화면을 열었습니다.");
    } catch (error) {
      // The fallback window is a plain preview: it is not tracked by the
      // controller, so the status badge keeps reporting the real display.
      window.open(
        `${window.location.pathname}?view=display&monitor=1`,
        "cgv-gift-display",
        "popup,width=1280,height=1024",
      );
      const reason = error instanceof Error && error.message ? error.message : "";
      showDisplayMessage(
        `전시 화면을 자동으로 열지 못해 일반 창으로 열었습니다.${
          reason ? ` (${reason})` : ""
        }`,
        8000,
      );
    } finally {
      setDisplayAction(null);
    }
  };

  const closeDisplay = async () => {
    setDisplayAction("closing");
    try {
      await requestDisplayController("close");
      showDisplayMessage("전시 화면을 종료했습니다.");
    } catch (error) {
      const reason = error instanceof Error && error.message ? error.message : "";
      showDisplayMessage(
        `전시 화면을 종료하지 못했습니다.${reason ? ` (${reason})` : ""}`,
        8000,
      );
    } finally {
      setDisplayAction(null);
    }
  };

  const openMonitor = () => {
    window.open(
      `${window.location.pathname}?view=display&monitor=1`,
      "cgv-gift-monitor",
      "popup,width=720,height=576",
    );
  };

  return (
    <main className="admin-app">
      <header className="admin-topbar">
        <div className="brand-lockup">
          <div className="mini-logo">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/assets/cgv-logo.png"
              alt="CGV"
              className="brand-source-image"
            />
          </div>
          <div>
            <p className="eyebrow">LOCAL DISPLAY MANAGER</p>
            <h1>경품 안내 화면 관리</h1>
          </div>
        </div>
        <div className="topbar-actions">
          {displayMessage && (
            <span className="display-action-message" role="status">
              {displayMessage}
            </span>
          )}
          <span
            className={`save-state ${
              conflict || saveFailed ? "failed" : savedPulse ? "active" : ""
            }`}
            role="status"
            title={
              conflict
                ? "다른 창에서 먼저 저장한 데이터가 있어 이 창의 수정 내용을 저장하지 않았습니다. 수정 내용은 이 PC에 보관되어 있습니다."
                : saveFailed
                  ? "변경 내용이 아직 SQLite에 저장되지 않았습니다. 서버 연결이 복구되면 자동으로 저장합니다."
                  : undefined
            }
          >
            <i />
            {conflict
              ? "저장 충돌 · 저장 보류"
              : saveFailed
                ? "저장 실패 · 재시도 중"
                : savedPulse
                  ? "저장됨"
                  : "자동 저장"}
          </span>
          {conflict && !conflictDialogOpen && (
            <button
              type="button"
              className="resolve-conflict-button"
              onClick={() => setConflictDialogOpen(true)}
            >
              충돌 해결
            </button>
          )}
          <div
            className={`monitor-health ${
              displayHealth === "unresponsive" ? "offline" : displayHealth
            }`}
            title={
              displayHealth === "unresponsive"
                ? "전시 창은 열려 있지만 화면이 데이터를 받아 가지 않습니다. 보조 모니터를 확인하고 전시 화면을 다시 열어 주세요."
                : displaySyncAt
                  ? `마지막 동기화: ${serverDate(displaySyncAt).toLocaleString(
                      "ko-KR",
                    )}`
                  : "동기화 정보 없음"
            }
          >
            <i />
            <span>
              <strong>
                {displayHealth === "offline"
                  ? "제어 연결 끊김"
                  : displayHealth === "online"
                    ? "전시 정상"
                    : displayHealth === "unresponsive"
                      ? "전시 응답 없음"
                      : "전시 대기"}
              </strong>
              <small>
                {displayHealth === "unresponsive"
                  ? "보조 모니터 확인 필요"
                  : displaySyncAt
                    ? `동기화 ${serverDate(displaySyncAt).toLocaleTimeString(
                        "ko-KR",
                        { hour: "2-digit", minute: "2-digit" },
                      )}`
                    : "동기화 확인 중"}
              </small>
            </span>
          </div>
          <button className="monitor-button" onClick={openMonitor}>
            모니터링 열기
          </button>
          <button
            className="stop-display-button"
            onClick={closeDisplay}
            disabled={displayAction !== null}
          >
            전시 종료
          </button>
          <button
            className="display-button"
            onClick={openDisplay}
            disabled={displayAction !== null}
          >
            <span>↗</span>
            {displayAction === "opening" ? "여는 중" : "전시 화면 열기"}
          </button>
        </div>
      </header>

      <section className="admin-content">
        <div className="intro-card">
          <div>
            <p className="section-kicker">오늘의 운영 현황</p>
            <h2>{data.settings.location} 지점 경품 안내</h2>
            <p className="admin-today">
              오늘{" "}
              {new Intl.DateTimeFormat("ko-KR", {
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
                weekday: "short",
              }).format(now)}
              <span>현재 노출 기준</span>
            </p>
          </div>
          <div className="summary-grid">
            <div>
              <strong>{todayItems.length}</strong>
              <span>오늘 노출</span>
            </div>
            <div>
              <strong>
                {
                  todayItems.filter(
                    (item) =>
                      item.status === "available" ||
                      item.status === "depleting" ||
                      item.status === "low",
                  ).length
                }
              </strong>
              <span>제공 중</span>
            </div>
            <div>
              <strong>
                {todayItems.filter((item) => item.status === "soldout").length}
              </strong>
              <span>재고 소진</span>
            </div>
          </div>
        </div>

        <section className="panel">
          <div className="panel-heading">
            <div>
              <p className="section-kicker">DISPLAY SETTINGS</p>
              <h3>전시 화면 설정</h3>
            </div>
          </div>
          <div className="settings-grid">
            <label>
              <span>지점명</span>
              <input
                value={data.settings.location}
                onChange={(event) =>
                  updateSettings("location", event.target.value)
                }
              />
            </label>
            <label>
              <span>화면 제목</span>
              <input
                value={data.settings.title}
                onChange={(event) => updateSettings("title", event.target.value)}
              />
            </label>
            <label>
              <span>페이지 전환</span>
              <div className="input-with-suffix">
                <input
                  type="number"
                  min="3"
                  max="30"
                  value={data.settings.pageSeconds}
                  onChange={(event) =>
                    updateSettings("pageSeconds", Number(event.target.value))
                  }
                />
                <em>초</em>
              </div>
            </label>
            <label className="toggle-setting">
              <span>공지 순환</span>
              <button type="button" role="switch" aria-checked={data.settings.rotateNotices}
                aria-label="공지 순환" className={`switch ${data.settings.rotateNotices ? "on" : ""}`}
                onClick={() => updateSettings("rotateNotices", !data.settings.rotateNotices)}><i /></button>
            </label>
            <label className="toggle-setting">
              <span>소진 항목 표시</span>
              <button
                type="button"
                className={`switch ${data.settings.showSoldout ? "on" : ""}`}
                aria-label="소진 항목 표시"
                onClick={() =>
                  updateSettings("showSoldout", !data.settings.showSoldout)
                }
              >
                <i />
              </button>
            </label>
          </div>
        </section>

        <section className="panel data-panel">
          <div className="panel-heading">
            <div>
              <p className="section-kicker">GIFT INVENTORY</p>
              <h3>경품 데이터</h3>
            </div>
            <div className="inventory-heading-actions">
              <button type="button" className="group-movies-button"
                disabled={!expiredItems.length} onClick={() => setExpiryPromptOpen(true)}>
                만료 항목 정리 ({expiredItems.length})
              </button>
              <button
                type="button"
                className="group-movies-button"
                onClick={groupSameMovies}
              >
                같은 영화 모아 정렬
              </button>
              <button className="add-button" onClick={addItem}>
                + 항목 추가
              </button>
            </div>
          </div>

          <div className="data-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>순서</th>
                  <th>노출</th>
                  <th>영화명</th>
                  <th>관람 포맷</th>
                  <th>경품</th>
                  <th>재고 현황</th>
                  <th>유효 기간</th>
                  <th>표시 요일</th>
                  <th aria-label="삭제" />
                </tr>
              </thead>
              <tbody>
                {data.items.map((item, itemIndex) => {
                  const scheduleState = getScheduleState(item, now);
                  const effectivelyVisible =
                    item.visible && scheduleState.active;
                  const rowClassName = [
                    !item.visible ? "muted-row" : "",
                    scheduleState.reason === "invalid" ? "invalid-range-row" : "",
                    scheduleState.reason === "expired" ? "expired-row" : "",
                    scheduleState.reason === "offday"
                      ? "schedule-paused-row"
                      : "",
                    scheduleState.reason === "upcoming"
                      ? "upcoming-row"
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" ");

                  return (
                  <Fragment key={item.id}>
                  <tr className={rowClassName}>
                    <td>
                      <div className="order-controls">
                        <button
                          type="button"
                          aria-label={`${item.movie} 위로 이동`}
                          title="위로 이동"
                          disabled={itemIndex === 0}
                          onClick={() => moveItem(item.id, -1)}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          aria-label={`${item.movie} 아래로 이동`}
                          title="아래로 이동"
                          disabled={itemIndex === data.items.length - 1}
                          onClick={() => moveItem(item.id, 1)}
                        >
                          ↓
                        </button>
                      </div>
                    </td>
                    <td>
                      <div className="visibility-cell">
                        <button
                          type="button"
                          className={`visibility-toggle ${
                            effectivelyVisible ? "on" : ""
                          } ${item.visible ? "manual-enabled" : ""}`}
                          aria-label={`${item.movie} 노출 전환`}
                          aria-pressed={effectivelyVisible}
                          title={
                            scheduleState.active
                              ? item.visible
                                ? "현재 전시 화면에 노출 중"
                                : "수동으로 노출하지 않음"
                              : `${scheduleState.label}: 유효한 날짜와 요일에 자동 노출됩니다.`
                          }
                          onClick={() =>
                            updateItem(item.id, "visible", !item.visible)
                          }
                        >
                          <i />
                        </button>
                        {!scheduleState.active && (
                          <span
                            className={`schedule-badge ${scheduleState.reason}`}
                          >
                            {scheduleState.label}
                          </span>
                        )}
                      </div>
                    </td>
                    <td>
                      <textarea
                        ref={(element) => {
                          if (element) movieInputs.current.set(item.id, element);
                          else movieInputs.current.delete(item.id);
                        }}
                        aria-label={`${item.movie} 영화명`}
                        className="cell-input cell-textarea movie-input"
                        rows={2}
                        value={item.movie}
                        onChange={(event) =>
                          updateItem(item.id, "movie", event.target.value)
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.preventDefault();
                        }}
                      />
                    </td>
                    <td>
                      <textarea
                        className="cell-input cell-textarea"
                        rows={2}
                        value={item.format}
                        onChange={(event) =>
                          updateItem(item.id, "format", event.target.value)
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.preventDefault();
                        }}
                      />
                    </td>
                    <td>
                      <textarea
                        className="cell-input cell-textarea gift-input"
                        rows={2}
                        value={item.gift}
                        onChange={(event) =>
                          updateItem(item.id, "gift", event.target.value)
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.preventDefault();
                        }}
                      />
                    </td>
                    <td>
                      <select
                        className={`status-select ${STATUS_META[item.status].className}`}
                        value={item.status}
                        onChange={(event) =>
                          updateItem(
                            item.id,
                            "status",
                            event.target.value as GiftStatus,
                          )
                        }
                      >
                        {Object.entries(STATUS_META).map(([value, meta]) => (
                          <option key={value} value={value}>
                            {meta.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <DateRangeEditor dates={item} movie={item.movie}
                        invalid={scheduleState.reason === "invalid"}
                        onCommit={(dates) => updateDates(item.id, dates)} />
                    </td>
                    <td>
                      <div
                        className={`day-mode-control ${
                          expandedDayRow === item.id ? "expanded" : ""
                        }`}
                      >
                        <button
                          type="button"
                          className={`day-mode-button ${
                            item.days.length === ALL_DAYS.length ? "active" : ""
                          }`}
                          onClick={() => setEveryDay(item)}
                        >
                          전체
                        </button>
                        <button
                          type="button"
                          className={`day-mode-button custom ${
                            item.days.length !== ALL_DAYS.length ? "active" : ""
                          }`}
                          onClick={() => toggleDayRow(item.id)}
                        >
                          {item.days.length === ALL_DAYS.length
                            ? "개별 설정"
                            : `개별 ${item.days.length}일`}
                          <span>›</span>
                        </button>
                      </div>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="delete-button"
                        aria-label={`${item.movie} 삭제`}
                        onClick={() => removeItem(item.id)}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                  {expandedDayRow === item.id && (
                    <tr className="day-picker-row">
                      <td colSpan={9}>
                        <div className="day-picker-panel">
                          <div className="day-picker-copy">
                            <strong>{item.movie}</strong>
                            <span>전시 화면에 표시할 요일을 선택하세요.</span>
                          </div>
                          <div className="day-picker">
                            {DAYS.map((label, day) => (
                              <button
                                type="button"
                                key={label}
                                className={
                                  item.days.includes(day) ? "selected" : ""
                                }
                                onClick={() => toggleDay(item, day)}
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel notice-panel">
          <div className="panel-heading">
            <div>
              <p className="section-kicker">NOTICE</p>
              <h3>공지사항</h3>
            </div>
            <button
              className="notice-add-button"
              disabled={data.settings.notices.length >= 5}
              onClick={() =>
                updateSettings("notices", [
                  ...data.settings.notices,
                  "새 주의사항을 입력하세요.",
                ])
              }
            >
              + 주의사항 추가
            </button>
          </div>
          <div className="notice-fields">
            {data.settings.notices.map((notice, index) => (
              <div className="notice-field-row" key={index}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <textarea
                  aria-label={`주의사항 ${index + 1}`}
                  rows={2}
                  value={notice}
                  onChange={(event) => {
                    const notices = [...data.settings.notices];
                    notices[index] = event.target.value;
                    updateSettings("notices", notices);
                  }}
                />
                <button
                  type="button"
                  aria-label={`주의사항 ${index + 1} 삭제`}
                  onClick={() => removeNotice(index)}
                >
                  ×
                </button>
              </div>
            ))}
            {!data.settings.notices.length && (
              <div className="empty-notices">
                주의사항이 없습니다. 오른쪽 위 버튼으로 추가할 수 있습니다.
              </div>
            )}
          </div>
        </section>

        {recovery.length > 0 && (
          <section className="panel recovery-panel" aria-label="보관된 버전">
            <div className="panel-heading">
              <div>
                <p className="section-kicker">KEPT VERSIONS</p>
                <h3>보관된 버전</h3>
              </div>
            </div>
            <p className="recovery-description">
              저장 충돌을 해결하거나 버전을 복원할 때 선택하지 않은 내용입니다.
              직접 삭제하기 전까지 이 PC에 남아 있으며, 최근 {RECOVERY_LIMIT}
              개까지 보관합니다.
            </p>
            <ul className="recovery-list">
              {recovery.map((entry) => (
                <li key={entry.id}>
                  <div>
                    <strong>{RECOVERY_LABELS[entry.source]}</strong>
                    <span>
                      {new Date(entry.savedAt).toLocaleString("ko-KR")} 보관 ·{" "}
                      {describeVersion(entry.data)}
                    </span>
                  </div>
                  <div className="recovery-actions">
                    <button
                      type="button"
                      onClick={() => onRestoreRecovery(entry.id)}
                      disabled={conflict !== null}
                      title={
                        conflict
                          ? "저장 충돌을 먼저 해결해 주세요."
                          : "현재 내용은 보관된 버전으로 옮기고 이 버전을 사용합니다."
                      }
                    >
                      이 버전으로 복원
                    </button>
                    <button type="button" onClick={() => downloadVersion(entry)}>
                      파일로 저장
                    </button>
                    <button
                      type="button"
                      className="recovery-delete"
                      onClick={() => onDeleteRecovery(entry.id)}
                    >
                      삭제
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        <UpdateCheck />

        <div className="admin-footer">
          <div className="storage-notice">
            <strong>SQLite 자동 저장</strong>
            <p>
              데이터는 이 PC의 로컬 저장소에 보관되어 브라우저 데이터를
              삭제해도 유지됩니다.
            </p>
            <small>
              저장 위치: %LOCALAPPDATA%\CGVGiftDisplay\inventory.db · 일일
              백업: 같은 폴더의 backups · 데이터 초기화: reset-data.bat ·
              백업과 운영 구성까지 제거: clean-uninstall.bat
            </small>
          </div>
          <button onClick={() => setResetPromptOpen(true)}>
            예시 데이터로 초기화
          </button>
        </div>
      </section>

      {expiryPromptOpen && expiredItems.length > 0 && (
        <div className="modal-backdrop">
          <section
            className="expiry-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="expiry-modal-title"
          >
            <div className="modal-alert-icon">!</div>
            <p className="section-kicker">EXPIRED ITEMS</p>
            <h2 id="expiry-modal-title">
              유효 기간이 지난 항목이 {expiredItems.length}개 있습니다
            </h2>
            <p className="modal-description">
              만료된 항목은 전시 화면에서만 제외되며 목록에 보관됩니다.
              아래 항목을 관리 목록에서도 삭제할까요?
            </p>
            <ul>
              {expiredItems.slice(0, 5).map((item) => (
                <li key={item.id}>
                  <strong>{item.movie}</strong>
                  <span>{item.gift}</span>
                  <em>{item.endDate} 종료</em>
                </li>
              ))}
            </ul>
            {expiredItems.length > 5 && (
              <p className="modal-more">
                외 {expiredItems.length - 5}개 항목
              </p>
            )}
            <div className="modal-actions">
              <button
                className="modal-cancel"
                onClick={() => setExpiryPromptOpen(false)}
              >
                나중에
              </button>
              <button className="modal-confirm" onClick={removeExpiredItems}>
                만료 항목 삭제
              </button>
            </div>
          </section>
        </div>
      )}

      {conflict && conflictDialogOpen && (
        <div className="modal-backdrop conflict-backdrop">
          <section
            className="expiry-modal conflict-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="conflict-modal-title"
          >
            <div className="modal-alert-icon">!</div>
            <p className="section-kicker">SAVE CONFLICT</p>
            <h2 id="conflict-modal-title">
              이 창의 수정 내용을 저장하지 않았습니다
            </h2>
            <p className="modal-description">
              이 창에서 수정하는 동안 다른 창에서 다른 내용이 먼저
              저장되었습니다. 아무것도 덮어쓰거나 지우지 않았습니다. 사용할
              내용을 선택해 주세요. 선택하지 않은 내용은 화면 아래{" "}
              <strong>보관된 버전</strong>에 남아 언제든 복원할 수 있습니다.
            </p>
            <div className="conflict-versions">
              <div>
                <strong>이 창의 내용 (저장 안 됨)</strong>
                <span>{describeVersion(data)}</span>
              </div>
              <div>
                <strong>저장된 최신 내용</strong>
                <span>{describeVersion(conflict.server)}</span>
              </div>
            </div>
            {(() => {
              const differences = describeDifferences(data, conflict.server);
              return (
                <>
                  <ul className="conflict-differences">
                    {differences.slice(0, 6).map((line, index) => (
                      <li key={index}>{line}</li>
                    ))}
                  </ul>
                  {differences.length > 6 && (
                    <p className="modal-more">
                      외 {differences.length - 6}개 차이
                    </p>
                  )}
                </>
              );
            })()}
            {conflictError && (
              <p className="conflict-error" role="alert">
                서버에 연결하지 못했습니다. 잠시 후 다시 선택해 주세요.
              </p>
            )}
            <div className="modal-actions conflict-actions">
              <button
                className="modal-cancel"
                disabled={conflictBusy}
                onClick={() => setConflictDialogOpen(false)}
              >
                나중에 선택
              </button>
              <button
                className="modal-cancel"
                disabled={conflictBusy}
                onClick={() => void resolveConflict(onUseServer)}
              >
                저장된 최신 내용 사용
              </button>
              <button
                className="modal-confirm"
                disabled={conflictBusy}
                onClick={() => void resolveConflict(onKeepLocal)}
              >
                이 창의 내용으로 저장
              </button>
            </div>
          </section>
        </div>
      )}

      {resetPromptOpen && (
        <div className="modal-backdrop">
          <section
            className="expiry-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="reset-modal-title"
          >
            <div className="modal-alert-icon">!</div>
            <p className="section-kicker">RESET TO SAMPLE</p>
            <h2 id="reset-modal-title">
              모든 데이터를 예시 데이터로 바꿀까요?
            </h2>
            <p className="modal-description">
              현재 등록된 경품 {data.items.length}개와 주의사항{" "}
              {data.settings.notices.length}개가 예시 데이터로 교체되며,
              전시 화면에도 바로 반영됩니다.
            </p>
            <div className="modal-actions">
              <button
                className="modal-cancel"
                onClick={() => setResetPromptOpen(false)}
              >
                취소
              </button>
              <button className="modal-confirm" onClick={resetToSample}>
                예시 데이터로 바꾸기
              </button>
            </div>
          </section>
        </div>
      )}

      {undo && (
        <div className="undo-toast" role="status">
          <span>{undo.message}</span>
          <button type="button" className="undo-action" onClick={applyUndo}>
            되돌리기
          </button>
          <button
            type="button"
            className="undo-dismiss"
            aria-label="알림 닫기"
            onClick={() => setUndo(null)}
          >
            ×
          </button>
        </div>
      )}

      {abnormalExit && (
        <div className="modal-backdrop abnormal-backdrop">
          <section
            className="expiry-modal monitor-alert-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="monitor-alert-title"
          >
            <div className="modal-alert-icon">!</div>
            <p className="section-kicker">DISPLAY DISCONNECTED</p>
            <h2 id="monitor-alert-title">
              전시 화면이 비정상적으로 종료되었습니다
            </h2>
            <p className="modal-description">
              정상 종료 요청 없이 전시 창이 닫힌 것을 감지했습니다.
              {abnormalExit.at && (
                <>
                  <br />
                  감지 시각:{" "}
                  {serverDate(abnormalExit.at).toLocaleString("ko-KR")}
                </>
              )}
            </p>
            <div className="modal-actions">
              <button
                className="modal-cancel"
                onClick={() => setAbnormalExit(null)}
              >
                확인
              </button>
              <button
                className="modal-confirm"
                onClick={() => {
                  setAbnormalExit(null);
                  void openDisplay();
                }}
              >
                전시 화면 다시 열기
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

function DisplayScreen({ data }: { data: AppData }) {
  const [pageIndex, setPageIndex] = useState(0);
  const [now, setNow] = useState(new Date());
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const updateScale = () =>
      setScale(Math.min(window.innerWidth / 1280, window.innerHeight / 1024));
    updateScale();
    window.addEventListener("resize", updateScale);
    const clock = window.setInterval(() => setNow(new Date()), 30000);
    return () => {
      window.removeEventListener("resize", updateScale);
      window.clearInterval(clock);
    };
  }, []);

  const pages = useMemo(() => {
    const valid = data.items.filter(
      (item) => item.visible && getScheduleState(item, now).active &&
        (data.settings.showSoldout || item.status !== "soldout"),
    );
    return buildDisplayPages(paginateGroups(groupItems(valid), 8), data.settings.notices, data.settings.rotateNotices);
  }, [data, now]);

  useEffect(() => {
    setPageIndex((current) => Math.min(current, pages.length - 1));
    if (pages.length <= 1) return;
    const interval = window.setInterval(
      () => setPageIndex((current) => (current + 1) % pages.length),
      Math.max(3, data.settings.pageSeconds) * 1000,
    );
    return () => window.clearInterval(interval);
  }, [pages.length, data.settings.pageSeconds]);

  const safePageIndex = Math.min(pageIndex, pages.length - 1);
  const selectedPage = pages[safePageIndex];
  const currentPage = selectedPage.kind === "gifts" ? selectedPage.groups : [];
  const currentRowCount = currentPage.reduce(
    (total, group) => total + group.items.length,
    0,
  );
  const tableDensity =
    currentRowCount <= 6
      ? "spacious"
      : currentRowCount >= 8
        ? "compact"
        : "standard";
  const formattedDate = new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).format(now);
  return (
    <main className="display-viewport">
      <div
        className={`display-canvas ${data.settings.rotateNotices ? "rotating-notices" : ""}`}
        style={{
          transform: `translate(-50%, -50%) scale(${scale})`,
          width: 1280,
          height: 1024,
        }}
      >
        <header className="display-header">
          <div className="display-logo">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/assets/cgv-logo.png"
              alt="CGV"
              className="brand-source-image"
            />
          </div>
          <div className="header-meta">
            <span>GIFT INFORMATION</span>
            <strong>{formattedDate}</strong>
          </div>
        </header>

        <section className="display-title">
          <p>CGV {data.settings.location}</p>
          <h1>{selectedPage.kind === "notices" ? "공지사항" : data.settings.title}</h1>
          <span className="title-rule" />
        </section>

        {selectedPage.kind === "notices" ? (
          <section className="notice-page" aria-label="공지사항">
            <ul>{selectedPage.notices.map((notice, index) => <li key={index}>
              <span className="notice-number">{String(notice.number).padStart(2, "0")}{notice.continued && <small>계속</small>}</span>
              <p>{notice.lines.map((line, lineIndex) => <span key={lineIndex}>{line || "\u00a0"}</span>)}</p>
            </li>)}</ul>
          </section>
        ) : <section className="display-table-wrap">
          {currentPage.length ? (
            <table className={`display-table ${tableDensity}`}>
              <thead>
                <tr>
                  <th>영화명</th>
                  <th>관람 포맷</th>
                  <th>경품</th>
                  <th>재고 현황</th>
                </tr>
              </thead>
              <tbody>
                {currentPage.map((group) =>
                  group.items.map((item, itemIndex) => (
                    <tr key={item.id}>
                      {itemIndex === 0 && (
                        <th rowSpan={group.items.length}>
                          <span className="display-cell-text">
                            {group.movie}
                          </span>
                        </th>
                      )}
                      <td>
                        <span className="display-cell-text">{item.format}</span>
                      </td>
                      <td>
                        <span className="display-cell-text">{item.gift}</span>
                      </td>
                      <td>
                        <span
                          className={`display-status ${STATUS_META[item.status].className}`}
                        >
                          <i />
                          {STATUS_META[item.status].short}
                        </span>
                      </td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          ) : (
            <div className="empty-display">
              <span>NOTICE</span>
              <strong>현재 제공 중인 경품이 없습니다.</strong>
              <p>새로운 경품이 준비되는 대로 안내해 드리겠습니다.</p>
            </div>
          )}
        </section>}

        {!data.settings.rotateNotices && <footer
          className={`display-footer ${
            data.settings.notices.length > 3 ? "dense" : ""
          }`}
        >
          <div className="notice-title">
            <span>꼭 확인해 주세요</span>
            <strong>NOTICE</strong>
          </div>
          <ul>
            {data.settings.notices.map((notice, index) => (
              <li key={index}>{notice}</li>
            ))}
          </ul>
        </footer>}

        {pages.length > 1 && (
          <div className="page-indicator">
            {pages.map((_, index) => (
              <i
                key={index}
                className={index === safePageIndex ? "active" : ""}
              />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
