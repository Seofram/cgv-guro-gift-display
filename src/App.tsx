"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";

import {
  closeDesktopDisplay,
  getDesktopDisplayStatus,
  isDesktopRuntime,
  loadDesktopData,
  markDesktopReady,
  openDesktopDisplay,
  saveDesktopData,
  subscribeToDesktopData,
} from "./desktop-runtime";

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
};

const STORAGE_KEY = "cgv-guro-gift-display-v1";
const CONTROLLER_URL = "http://127.0.0.1:3210";
const DAYS = ["일", "월", "화", "수", "목", "금", "토"];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

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
  },
  updatedAt: new Date().toISOString(),
};

function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getScheduleState(item: GiftItem, date: Date) {
  const today = localDateString(date);
  if (item.endDate && item.endDate < today) {
    return { active: false, reason: "expired", label: "만료" } as const;
  }
  if (item.startDate && item.startDate > today) {
    return { active: false, reason: "upcoming", label: "시작 전" } as const;
  }
  if (!item.days.includes(date.getDay())) {
    return { active: false, reason: "offday", label: "오늘 제외" } as const;
  }
  return { active: true, reason: "active", label: "노출 중" } as const;
}

function cloneSample(): AppData {
  return JSON.parse(JSON.stringify(SAMPLE_DATA)) as AppData;
}

function groupItems(items: GiftItem[]) {
  const groups: { movie: string; items: GiftItem[] }[] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last?.movie === item.movie) {
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

export default function Home() {
  const [data, setData] = useState<AppData>(cloneSample);
  const [hydrated, setHydrated] = useState(false);
  const [view, setView] = useState<"admin" | "display">("admin");

  useEffect(() => {
    let disposed = false;
    const displayMode =
      new URLSearchParams(window.location.search).get("view") === "display";
    // The URL is the source of truth when a native display window is created.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setView(displayMode ? "display" : "admin");
    document.body.classList.toggle("display-mode", displayMode);

    let localData: AppData | null = null;
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        localData = JSON.parse(stored) as AppData;
      } catch {
        localData = null;
      }
    }

    const hydrate = async () => {
      let controllerData: AppData | null = null;
      let resetRequested = false;
      if (isDesktopRuntime()) {
        try {
          controllerData = await loadDesktopData<AppData>();
        } catch {
          controllerData = null;
        }
      } else {
        try {
          const response = await fetch(`${CONTROLLER_URL}/data`, {
            cache: "no-store",
          });
          const result = (await response.json()) as {
            ok: boolean;
            data?: AppData;
            reset?: boolean;
          };
          if (response.ok) {
            controllerData = result.data ?? null;
          } else if (response.status === 404) {
            resetRequested = Boolean(result.reset);
          }
        } catch {
          controllerData = null;
        }
      }

      if (disposed) return;

      const initialData =
        controllerData ??
        (resetRequested ? null : localData) ??
        cloneSample();
      setData(initialData);
      setHydrated(true);
    };
    void hydrate();

    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY && event.newValue) {
        setData(JSON.parse(event.newValue) as AppData);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      disposed = true;
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    if (view === "admin") {
      if (isDesktopRuntime()) {
        void saveDesktopData(data).catch(() => undefined);
      } else {
        void fetch(`${CONTROLLER_URL}/data`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        }).catch(() => undefined);
      }
    }
  }, [data, hydrated, view]);

  useEffect(() => {
    if (!hydrated) return;
    const readyTitle =
      view === "display"
        ? "CGV 구로 경품 전시 화면"
        : "CGV 구로 경품 관리";
    document.title = readyTitle;
    document.documentElement.dataset.appReady = "true";
    if (isDesktopRuntime()) {
      void markDesktopReady(view).catch(() => undefined);
    }
  }, [hydrated, view]);

  useEffect(() => {
    if (!hydrated || view !== "display") return;

    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    if (isDesktopRuntime()) {
      void subscribeToDesktopData<AppData>((nextData) => {
        if (!disposed) setData(nextData);
      }).then((nextUnsubscribe) => {
        if (disposed) {
          nextUnsubscribe();
        } else {
          unsubscribe = nextUnsubscribe;
        }
      });
      return () => {
        disposed = true;
        unsubscribe?.();
      };
    }

    const syncDisplayData = async () => {
      try {
        const response = await fetch(`${CONTROLLER_URL}/data`, {
          cache: "no-store",
        });
        if (!response.ok) return;
        const result = (await response.json()) as {
          ok: boolean;
          data?: AppData;
        };
        if (!disposed && result.data) {
          setData((current) =>
            result.data!.updatedAt !== current.updatedAt
              ? result.data!
              : current,
          );
        }
      } catch {
        // The localStorage fallback remains available without the controller.
      }
    };

    void syncDisplayData();
    const timer = window.setInterval(syncDisplayData, 1000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [hydrated, view]);

  if (!hydrated) return <div className="boot-screen">화면을 준비하고 있습니다.</div>;

  return view === "display" ? (
    <DisplayScreen data={data} />
  ) : (
    <AdminScreen data={data} setData={setData} />
  );
}

function AdminScreen({
  data,
  setData,
}: {
  data: AppData;
  setData: React.Dispatch<React.SetStateAction<AppData>>;
}) {
  const [savedPulse, setSavedPulse] = useState(false);
  const [expandedDayRow, setExpandedDayRow] = useState<string | null>(null);
  const [expiryPromptOpen, setExpiryPromptOpen] = useState(true);
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
  const today = localDateString(now);
  const todayItems = data.items.filter(
    (item) => item.visible && getScheduleState(item, now).active,
  );
  const expiredItems = data.items.filter(
    (item) => item.endDate && item.endDate < today,
  );

  useEffect(() => {
    const clock = window.setInterval(() => setNow(new Date()), 30000);
    return () => window.clearInterval(clock);
  }, []);

  useEffect(() => {
    let disposed = false;

    const checkDisplayStatus = async () => {
      try {
        const result = isDesktopRuntime()
          ? await getDesktopDisplayStatus()
          : await (async () => {
              const response = await fetch(
                `${CONTROLLER_URL}/display/status`,
                { cache: "no-store" },
              );
              if (!response.ok) throw new Error("status unavailable");
              return (await response.json()) as DisplayMonitorStatus;
            })();
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

  const updateItem = <K extends keyof GiftItem>(
    id: string,
    key: K,
    value: GiftItem[K],
  ) => {
    setData((current) => ({
      ...current,
      updatedAt: new Date().toISOString(),
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
      updatedAt: new Date().toISOString(),
      settings: { ...current.settings, [key]: value },
    }));
    setSavedPulse(true);
    window.setTimeout(() => setSavedPulse(false), 900);
  };

  const addItem = () => {
    const today = localDateString();
    const yearEnd = `${new Date().getFullYear()}-12-31`;
    setData((current) => ({
      ...current,
      updatedAt: new Date().toISOString(),
      items: [
        ...current.items,
        {
          id: `gift-${Date.now()}`,
          movie: "새 영화",
          format: "전체",
          gift: "경품명을 입력하세요",
          status: "available",
          startDate: today,
          endDate: yearEnd,
          days: ALL_DAYS,
          visible: true,
        },
      ],
    }));
  };

  const removeItem = (id: string) => {
    setData((current) => ({
      ...current,
      updatedAt: new Date().toISOString(),
      items: current.items.filter((item) => item.id !== id),
    }));
  };

  const removeExpiredItems = () => {
    const expiredIds = new Set(expiredItems.map((item) => item.id));
    setData((current) => ({
      ...current,
      updatedAt: new Date().toISOString(),
      items: current.items.filter((item) => !expiredIds.has(item.id)),
    }));
    setExpiryPromptOpen(false);
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

  const showDisplayMessage = (message: string) => {
    setDisplayMessage(message);
    window.setTimeout(() => setDisplayMessage(""), 3200);
  };

  const requestDisplayController = async (action: "open" | "close") => {
    if (isDesktopRuntime()) {
      if (action === "open") await openDesktopDisplay(false);
      else await closeDesktopDisplay();
      return;
    }

    const response = await fetch(`http://127.0.0.1:3210/display/${action}`, {
      method: "POST",
    });
    if (!response.ok) throw new Error("display controller unavailable");
  };

  const openDisplay = async () => {
    setDisplayAction("opening");
    try {
      if (isDesktopRuntime()) {
        await saveDesktopData(data);
      } else {
        const syncResponse = await fetch(`${CONTROLLER_URL}/data`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
        if (!syncResponse.ok) throw new Error("display data sync failed");
      }
      await requestDisplayController("open");
      showDisplayMessage("모니터 2에 전시 화면을 열었습니다.");
    } catch {
      window.open(
        `${window.location.pathname}?view=display`,
        "cgv-gift-display",
        "popup,width=1280,height=1024",
      );
      showDisplayMessage(
        "보조 실행기가 없어 일반 전시 창으로 열었습니다.",
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
    } catch {
      showDisplayMessage("전시 화면을 종료하지 못했습니다.");
    } finally {
      setDisplayAction(null);
    }
  };

  const openMonitor = () => {
    if (isDesktopRuntime()) {
      void openDesktopDisplay(true).catch(() => {
        showDisplayMessage("미리보기 창을 열지 못했습니다.");
      });
      return;
    }

    window.open(
      `${window.location.pathname}?view=display`,
      "cgv-gift-monitor",
      "popup,width=720,height=576",
    );
  };

  return (
    <main className="admin-app">
      <header className="admin-topbar">
        <div className="brand-lockup">
          <div className="mini-logo">
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
          <span className={`save-state ${savedPulse ? "active" : ""}`}>
            <i />
            {savedPulse ? "저장됨" : "자동 저장"}
          </span>
          <div
            className={`monitor-health ${
              !monitorStatus?.controller
                ? "offline"
                : monitorStatus.running
                  ? "online"
                  : "standby"
            }`}
            title={
              monitorStatus?.lastSyncAt
                ? `마지막 동기화: ${new Date(
                    monitorStatus.lastSyncAt,
                  ).toLocaleString("ko-KR")}`
                : "동기화 정보 없음"
            }
          >
            <i />
            <span>
              <strong>
                {!monitorStatus?.controller
                  ? "제어 연결 끊김"
                  : monitorStatus.running
                    ? "전시 정상"
                    : "전시 대기"}
              </strong>
              <small>
                {monitorStatus?.lastSyncAt
                  ? `동기화 ${new Date(
                      monitorStatus.lastSyncAt,
                    ).toLocaleTimeString("ko-KR", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}`
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
            <button className="add-button" onClick={addItem}>
              + 항목 추가
            </button>
          </div>

          <div className="data-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
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
                {data.items.map((item) => {
                  const scheduleState = getScheduleState(item, now);
                  const effectivelyVisible =
                    item.visible && scheduleState.active;
                  const rowClassName = [
                    !item.visible ? "muted-row" : "",
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
                      <div className="date-range">
                        <input
                          type="date"
                          value={item.startDate}
                          onChange={(event) =>
                            updateItem(item.id, "startDate", event.target.value)
                          }
                        />
                        <span>—</span>
                        <input
                          type="date"
                          value={item.endDate}
                          onChange={(event) =>
                            updateItem(item.id, "endDate", event.target.value)
                          }
                        />
                      </div>
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
                      <td colSpan={8}>
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
              <h3>하단 주의사항</h3>
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
                  onClick={() =>
                    updateSettings(
                      "notices",
                      data.settings.notices.filter(
                        (_, noticeIndex) => noticeIndex !== index,
                      ),
                    )
                  }
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

        <div className="admin-footer">
          <div className="storage-notice">
            <strong>SQLite 자동 저장</strong>
            <p>
              데이터는 이 PC의 로컬 저장소에 보관되어 브라우저 데이터를
              삭제해도 유지됩니다.
            </p>
            <small>
              저장 위치: %LOCALAPPDATA%\CGVGiftDisplay\inventory.db · 데이터
              초기화: reset-data.bat · 운영 구성까지 제거:
              clean-uninstall.bat
            </small>
          </div>
          <button
            onClick={() => {
              const sample = cloneSample();
              sample.updatedAt = new Date().toISOString();
              setData(sample);
            }}
          >
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
              만료된 항목은 전시 화면에 나타나지 않습니다. 관리 목록에서도
              삭제할까요?
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
                  {new Date(abnormalExit.at).toLocaleString("ko-KR")}
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
    const today = localDateString(now);
    const day = now.getDay();
    const valid = data.items.filter(
      (item) =>
        item.visible &&
        item.startDate <= today &&
        item.endDate >= today &&
        item.days.includes(day) &&
        (data.settings.showSoldout || item.status !== "soldout"),
    );
    return paginateGroups(groupItems(valid), 8);
  }, [data, now]);

  useEffect(() => {
    // Reset pagination whenever filtering changes the number of pages.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPageIndex(0);
  }, [pages.length]);

  useEffect(() => {
    if (pages.length <= 1) return;
    const interval = window.setInterval(
      () => setPageIndex((current) => (current + 1) % pages.length),
      Math.max(3, data.settings.pageSeconds) * 1000,
    );
    return () => window.clearInterval(interval);
  }, [pages.length, data.settings.pageSeconds]);

  const currentPage = pages[Math.min(pageIndex, pages.length - 1)] ?? [];
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
        className="display-canvas"
        style={{
          transform: `scale(${scale})`,
          width: 1280,
          height: 1024,
        }}
      >
        <header className="display-header">
          <div className="display-logo">
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
          <h1>{data.settings.title}</h1>
          <span className="title-rule" />
        </section>

        <section className="display-table-wrap">
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
        </section>

        <footer
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
        </footer>

        {pages.length > 1 && (
          <div className="page-indicator">
            {pages.map((_, index) => (
              <i key={index} className={index === pageIndex ? "active" : ""} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
