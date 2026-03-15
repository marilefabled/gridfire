/**
 * High score persistence — localStorage.
 */

const KEY = 'gridfire_highscores';

export function getHighScores() {
  if (typeof localStorage === 'undefined') return { bestScore: 0, bestWave: 0, bestCombo: 0, totalGames: 0 };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { bestScore: 0, bestWave: 0, bestCombo: 0, totalGames: 0 };
    return JSON.parse(raw);
  } catch {
    return { bestScore: 0, bestWave: 0, bestCombo: 0, totalGames: 0 };
  }
}

export function saveHighScores(score, wave, maxCombo) {
  if (typeof localStorage === 'undefined') return { isNewBest: false };
  const current = getHighScores();
  const isNewBest = score > current.bestScore;
  const updated = {
    bestScore: Math.max(current.bestScore, score),
    bestWave: Math.max(current.bestWave, wave),
    bestCombo: Math.max(current.bestCombo, maxCombo),
    totalGames: current.totalGames + 1,
  };
  localStorage.setItem(KEY, JSON.stringify(updated));
  return { isNewBest, previous: current };
}
