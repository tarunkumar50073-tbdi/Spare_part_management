// The page the user came from, for a screen with a Back of its own (Kiosk, 28
// Oct 2026: back par click karne par bhi main board par ja rha h — opened from
// the main board, Back and Home went to the same place). ScrollToTop notes
// every route change; a screen asks once, as it opens, where it was opened from.
let current = null;
let previous = null;

export function notePage(path) {
  if (path === current) return;
  previous = current;
  current = path;
}

/** The page before `path`: right as `path` opens (not noted yet) or after. */
export function pageBefore(path) {
  return current === path ? previous : current;
}
