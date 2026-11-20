// A theme word with an ending added or taken off isn't a detour: SPEAR on a board with SPEARS, or BAKED, BAKER and
// BAKING on one with BAKE, would be fare for running one letter past an answer. tools/make-puzzles.mjs leaves them out
// of the detours, and the tests check every board again. Erring wide is fine: a word left out here just doesn't earn
// fare (CORN, beside CORNER, goes too).

// The word with each ending on: -s, -es, -d, -ed, -er, -ing, with the spellings those take (BAKER and BAKING, BERRIES
// and CARRIED, STOPPED and PLANNER).
function endings(w) {
  const out = ['s', 'es', 'd', 'ed', 'er', 'ing'].map(e => w + e);
  if (w.endsWith('e')) out.push(w + 'r', w.slice(0, -1) + 'ing');
  if (/[^aeiou]y$/.test(w)) out.push(...['ies', 'ied', 'ier'].map(e => w.slice(0, -1) + e));
  if (/[aeiou][bdgklmnprt]$/.test(w)) out.push(...['ed', 'er', 'ing'].map(e => w + w.at(-1) + e));
  return out;
}

// Is `word` one of `answers` with an ending added or taken off? Capitals or not.
export function nearAnswer(word, answers) {
  const w = word.toLowerCase(), mine = endings(w);
  return answers.some(a => { a = a.toLowerCase(); return mine.includes(a) || endings(a).includes(w); });
}
