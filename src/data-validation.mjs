// Mirrors Get-AppDataProblem in local-server.ps1; the server remains final authority.
export const DATA_LIMITS = Object.freeze({ items: 500, id: 100, text: 2000,
  date: 20, notices: 20, notice: 4000, seconds: 3600, updatedAt: 40, bytes: 2000000 });

const ITEM_LABELS = { id: "식별자", movie: "영화명", format: "관람 포맷", gift: "경품명",
  status: "재고 현황", startDate: "시작일", endDate: "종료일", days: "표시 요일", visible: "노출 여부" };
const SETTING_LABELS = { location: "지점명", title: "화면 제목", notices: "주의사항",
  pageSeconds: "페이지 전환 시간", showSoldout: "소진 항목 표시", rotateNotices: "공지 순환" };
const text = (value, max) => typeof value === "string" && value.length <= max;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** @param {any} data @returns {string | null} */
export function validateAppData(data) {
  const limit = DATA_LIMITS;
  if (!record(data) || !Array.isArray(data.items)) return "경품 목록 형식을 확인해 주세요.";
  if (data.items.length > limit.items) return `경품은 최대 ${limit.items}개까지 저장할 수 있습니다. 항목을 줄여 주세요.`;
  const ids = new Set();
  for (const [index, item] of data.items.entries()) {
    const label = `경품 ${index + 1}번`;
    if (!record(item)) return `${label}의 내용을 확인해 주세요.`;
    if (!text(item.id, limit.id) || !item.id.trim() || ids.has(item.id)) return `${label}의 식별자가 없거나 중복되었거나 ${limit.id}자를 넘었습니다.`;
    ids.add(item.id);
    for (const field of ["movie", "format", "gift"]) {
      if (!text(item[field], limit.text)) return `${label}의 ${ITEM_LABELS[field]}은(는) ${limit.text}자 이하의 글자로 입력해 주세요.`;
    }
    if (!["available", "depleting", "low", "soldout", "ready"].includes(item.status)) return `${label}의 재고 현황을 확인해 주세요.`;
    for (const field of ["startDate", "endDate"]) {
      if (!text(item[field], limit.date)) return `${label}의 ${ITEM_LABELS[field]}은(는) ${limit.date}자 이하로 입력해 주세요.`;
    }
    if (!Array.isArray(item.days) || item.days.length > 7 || item.days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) return `${label}의 표시 요일을 확인해 주세요.`;
    if (typeof item.visible !== "boolean") return `${label}의 노출 여부를 확인해 주세요.`;
  }
  const settings = data.settings;
  if (!record(settings)) return "화면 설정을 확인해 주세요.";
  for (const field of ["location", "title"]) {
    if (!text(settings[field], limit.text)) return `${SETTING_LABELS[field]}은(는) ${limit.text}자 이하로 입력해 주세요.`;
  }
  if (!Array.isArray(settings.notices) || settings.notices.length > limit.notices) return `주의사항은 최대 ${limit.notices}개까지 저장할 수 있습니다.`;
  for (const [index, notice] of settings.notices.entries()) {
    if (!text(notice, limit.notice)) return `주의사항 ${index + 1}번은 ${limit.notice}자 이하로 입력해 주세요.`;
  }
  if (!Number.isFinite(settings.pageSeconds) || settings.pageSeconds < 0 || settings.pageSeconds > limit.seconds) return `페이지 전환 시간은 0초부터 ${limit.seconds}초까지 입력해 주세요.`;
  for (const field of ["showSoldout", "rotateNotices"]) {
    if ((field !== "rotateNotices" || field in settings) && typeof settings[field] !== "boolean") return `${SETTING_LABELS[field]} 설정을 확인해 주세요.`;
  }
  if (!text(data.updatedAt, limit.updatedAt) || !data.updatedAt) return "수정 시각을 확인할 수 없습니다. 내용을 다시 수정해 주세요.";
  if (new TextEncoder().encode(JSON.stringify(data)).length > limit.bytes) return "전체 데이터가 너무 큽니다. 긴 안내 문구나 경품 항목을 줄여 주세요.";
  return null;
}

/** Map only known schema paths; never display arbitrary server exception text.
 * @param {any} body @returns {string} */
export function validationReplyMessage(body) {
  const message = typeof body?.message === "string" ? body.message : "";
  const item = /^items\[(\d{1,6})\]\.(id|movie|format|gift|status|startDate|endDate|days|visible)(?:\s|$)/.exec(message);
  if (item) return `경품 ${Number(item[1]) + 1}번의 ${ITEM_LABELS[item[2]]}을(를) 확인해 주세요.`;
  const setting = /^settings\.(location|title|notices|pageSeconds|showSoldout|rotateNotices)(?:\s|$)/.exec(message);
  if (setting) return `${SETTING_LABELS[setting[1]]} 설정을 확인해 주세요.`;
  if (message.startsWith("items가 너무 많습니다.")) return `경품은 최대 ${DATA_LIMITS.items}개까지 저장할 수 있습니다.`;
  if (message === "요청 본문이 너무 큽니다.") return "전체 데이터가 너무 큽니다. 긴 안내 문구나 경품 항목을 줄여 주세요.";
  return "입력 내용을 서버에서 저장할 수 없습니다. 항목과 화면 설정을 확인하고 수정해 주세요.";
}
