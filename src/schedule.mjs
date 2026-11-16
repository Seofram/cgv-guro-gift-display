export function localDateString(date = new Date()) {
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function newItemDates(now = new Date()) {
  const start = new Date(now);
  start.setHours(12, 0, 0, 0);
  start.setDate(start.getDate() + 1);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return { startDate: localDateString(start), endDate: localDateString(end) };
}

/** @param {string} value */
function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(12, 0, 0, 0);
  return year > 0 && localDateString(date) === value;
}

/** @param {{startDate: string, endDate: string, days: number[]}} item @param {Date} date */
export function getScheduleState(item, date) {
  if (!validDate(item.startDate) || !validDate(item.endDate) || item.startDate > item.endDate) {
    return { active: false, reason: "invalid", label: "기간 오류" };
  }
  const today = localDateString(date);
  if (item.endDate < today) return { active: false, reason: "expired", label: "만료 · 미노출" };
  if (item.startDate > today) return { active: false, reason: "upcoming", label: "시작 전" };
  if (!item.days.includes(date.getDay())) return { active: false, reason: "offday", label: "오늘 제외" };
  return { active: true, reason: "active", label: "노출 중" };
}

const STATUSES = ["available", "depleting", "low", "soldout", "ready"];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

/** @param {unknown} value */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @param {string} fallback */
function text(value, fallback) {
  return typeof value === "string" ? value : fallback;
}

/**
 * Returns whether a value has the minimum shape of stored application data.
 * @param {unknown} data
 */
export function isAppDataLike(data) {
  return isRecord(data) && Array.isArray(data.items) && isRecord(data.settings);
}

/**
 * Coerces stored data into a shape the screens can always render. Malformed
 * rows are dropped and missing fields receive safe defaults, so a damaged
 * record can never blank the administrator or display screen.
 * @param {any} data
 */
export function normalizeAppData(data) {
  const source = isRecord(data) ? data : {};
  const settings = isRecord(source.settings) ? source.settings : {};
  const usedIds = new Set();
  const items = (Array.isArray(source.items) ? source.items : [])
    .filter(isRecord)
    .map((/** @type {any} */ item, /** @type {number} */ index) => {
      let id = text(item.id, "") || `gift-recovered-${index}`;
      while (usedIds.has(id)) id = `${id}-${index}`;
      usedIds.add(id);
      return {
        ...item,
        id,
        movie: text(item.movie, ""),
        format: text(item.format, ""),
        gift: text(item.gift, ""),
        status: STATUSES.includes(item.status) ? item.status : "ready",
        startDate: text(item.startDate, ""),
        endDate: text(item.endDate, ""),
        days: Array.isArray(item.days)
          ? item.days.filter((/** @type {unknown} */ day) => ALL_DAYS.includes(/** @type {number} */ (day)))
          : [...ALL_DAYS],
        visible: item.visible !== false,
      };
    });
  return {
    ...source,
    items,
    settings: {
      ...settings,
      location: text(settings.location, "구로"),
      title: text(settings.title, "경품 안내"),
      notices: Array.isArray(settings.notices)
        ? settings.notices.filter((/** @type {unknown} */ notice) => typeof notice === "string")
        : [],
      pageSeconds: Number.isFinite(settings.pageSeconds) ? settings.pageSeconds : 8,
      showSoldout: settings.showSoldout !== false,
      rotateNotices: settings.rotateNotices === true,
    },
    updatedAt: text(source.updatedAt, ""),
  };
}

/**
 * Returns an edit timestamp that is always later than the previous one, even
 * when two edits share a millisecond or the PC clock is set back, so every
 * edit is distinguishable. (Write ordering itself is decided by the
 * controller's revision number, not by this timestamp.)
 * @param {unknown} previous
 * @param {Date} [now]
 */
export function nextUpdatedAt(previous, now = new Date()) {
  const current = now.toISOString();
  if (typeof previous !== "string" || current > previous) return current;
  const parsed = Date.parse(previous);
  return Number.isFinite(parsed) ? new Date(parsed + 1).toISOString() : current;
}

/**
 * Structural equality for stored data, independent of key order. Used to
 * recognise that the controller already holds exactly what a window is
 * trying to save (a lost acknowledgement, or the same edit saved elsewhere).
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
export function sameAppData(left, right) {
  if (left === right) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (typeof left !== "object") return Number.isNaN(left) && Number.isNaN(right);
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) {
    const other = /** @type {unknown[]} */ (right);
    return left.length === other.length && left.every((value, index) => sameAppData(value, other[index]));
  }
  const a = /** @type {Record<string, unknown>} */ (left);
  const b = /** @type {Record<string, unknown>} */ (right);
  const keys = Object.keys(a).filter((key) => a[key] !== undefined);
  return keys.length === Object.keys(b).filter((key) => b[key] !== undefined).length &&
    keys.every((key) => sameAppData(a[key], b[key]));
}
