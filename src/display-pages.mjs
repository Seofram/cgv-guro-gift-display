const MAX_LINES_PER_PAGE = 10;
const MAX_ENTRIES_PER_PAGE = 3;

/**
 * Fallback used where text cannot be measured (tests, or before the display
 * has a measuring element): at most 28 Unicode code points per line.
 * @param {string} text
 */
const fitsByCount = (text) => Array.from(text).length <= 28;

/**
 * Wraps one paragraph into lines that satisfy `fits`. Lines break between
 * words, so a word is never split and no line starts with punctuation that
 * belongs to the previous word. Only a single word that is wider than a whole
 * line is split between characters. The space a line breaks at stays at the
 * end of that line, so joining the lines gives back the paragraph exactly.
 * @param {string} paragraph
 * @param {(text: string) => boolean} fits
 */
export function wrapNoticeParagraph(paragraph, fits = fitsByCount) {
  const words = paragraph.match(/\s*\S+\s*/g);
  if (!words) return [paragraph];
  /** @type {string[]} */
  const lines = [];
  let line = "";
  for (const word of words) {
    if (fits(line + word)) {
      line += word;
      continue;
    }
    if (line) {
      lines.push(line);
      line = "";
    }
    let rest = Array.from(word);
    while (rest.length && !fits(rest.join(""))) {
      if (lines.length && !rest.join("").trim()) {
        // Only the break space is left: it stays with the line before it.
        lines[lines.length - 1] += rest.join("");
        rest = [];
        break;
      }
      let count = rest.length - 1;
      while (count > 1 && !fits(rest.slice(0, count).join(""))) count--;
      lines.push(rest.slice(0, Math.max(1, count)).join(""));
      rest = rest.slice(Math.max(1, count));
    }
    line = rest.join("");
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Splits notices into display pages: at most 10 text lines and 3 entries per
 * page. Long notices continue on following pages; no text is truncated or
 * shrunk to fit. `fits` decides whether a line of text fits the notice panel;
 * the display passes a function that measures the rendered width.
 * @param {string[]} notices
 * @param {(text: string) => boolean} [fits]
 */
export function paginateNotices(notices, fits = fitsByCount) {
  /** @type {{number: number, continued: boolean, lines: string[]}[][]} */
  const pages = [];
  /** @type {(typeof pages)[number]} */
  let page = [];
  let lineCount = 0;
  const flush = () => { if (page.length) pages.push(page); page = []; lineCount = 0; };
  notices.forEach((notice, index) => {
    if (!notice.trim()) return;
    const lines = notice.split(/\r?\n/).flatMap((paragraph) => wrapNoticeParagraph(paragraph, fits));
    let offset = 0;
    while (offset < lines.length) {
      if (page.length === MAX_ENTRIES_PER_PAGE || lineCount === MAX_LINES_PER_PAGE) flush();
      const count = Math.min(MAX_LINES_PER_PAGE - lineCount, lines.length - offset);
      page.push({ number: index + 1, continued: offset > 0, lines: lines.slice(offset, offset + count) });
      lineCount += count;
      offset += count;
    }
  });
  flush();
  return pages;
}

/**
 * @template T
 * @param {T[]} giftPages
 * @param {string[]} notices
 * @param {boolean} rotateNotices
 * @param {(text: string) => boolean} [fits]
 */
export function buildDisplayPages(giftPages, notices, rotateNotices, fits) {
  /** @type {({kind: 'gifts', groups: T} | {kind: 'notices', notices: ReturnType<typeof paginateNotices>[number]})[]} */
  const pages = giftPages.map((groups) => ({ kind: 'gifts', groups }));
  if (rotateNotices) pages.push(...paginateNotices(notices, fits).map((entries) => ({ kind: /** @type {const} */ ('notices'), notices: entries })));
  return pages;
}
