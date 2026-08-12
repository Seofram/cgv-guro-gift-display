/**
 * Groups identical movie names while preserving both the first appearance
 * order of each movie and the existing order inside each movie group.
 *
 * @template {{ movie: string }} T
 * @param {T[]} items
 * @returns {T[]}
 */
export function stableGroupItemsByMovie(items) {
  const movieOrder = new Map();

  for (const item of items) {
    const movie = item.movie.trim();
    if (!movieOrder.has(movie)) {
      movieOrder.set(movie, movieOrder.size);
    }
  }

  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const movieDifference =
        movieOrder.get(left.item.movie.trim()) -
        movieOrder.get(right.item.movie.trim());
      return movieDifference || left.index - right.index;
    })
    .map(({ item }) => item);
}
