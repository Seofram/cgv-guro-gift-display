/**
 * Conservative fixed wrapping for the 1280px canvas: 28 Unicode code points
 * per line, at most 10 text lines and 3 entries per page. Long notices continue
 * on subsequent pages; no text is truncated or shrunk to fit.
 * @param {string[]} notices
 */
export function paginateNotices(notices) {
  /** @type {{number: number, continued: boolean, lines: string[]}[][]} */
  const pages = [];
  /** @type {(typeof pages)[number]} */
  let page = [];
  let lineCount = 0;
  const flush = () => { if (page.length) pages.push(page); page = []; lineCount = 0; };
  notices.forEach((notice, index) => {
    if (!notice.trim()) return;
    const lines = notice.split(/\r?\n/).flatMap((paragraph) => {
      const characters = Array.from(paragraph);
      const wrapped = [];
      for (let start = 0; start < characters.length; start += 28) wrapped.push(characters.slice(start, start + 28).join(""));
      return wrapped.length ? wrapped : [""];
    });
    let offset = 0;
    while (offset < lines.length) {
      if (page.length === 3 || lineCount === 10) flush();
      const count = Math.min(10 - lineCount, lines.length - offset);
      page.push({ number: index + 1, continued: offset > 0, lines: lines.slice(offset, offset + count) });
      lineCount += count;
      offset += count;
    }
  });
  flush();
  return pages;
}

/** @template T @param {T[]} giftPages @param {string[]} notices @param {boolean} rotateNotices */
export function buildDisplayPages(giftPages, notices, rotateNotices) {
  /** @type {({kind: 'gifts', groups: T} | {kind: 'notices', notices: ReturnType<typeof paginateNotices>[number]})[]} */
  const pages = giftPages.map((groups) => ({ kind: 'gifts', groups }));
  if (rotateNotices) pages.push(...paginateNotices(notices).map((entries) => ({ kind: /** @type {const} */ ('notices'), notices: entries })));
  return pages;
}
