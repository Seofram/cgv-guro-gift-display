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

/** @template {{settings: object}} T @param {T} data */
export function normalizeAppData(data) {
  return { ...data, settings: { ...data.settings, rotateNotices: "rotateNotices" in data.settings && data.settings.rotateNotices === true } };
}
