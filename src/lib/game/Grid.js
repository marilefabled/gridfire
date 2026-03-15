/**
 * Match-3 grid engine.
 * Pure logic — no rendering. Returns state for the UI to display.
 *
 * Grid is COLS wide × ROWS tall. Tiles fall downward (row 0 = top).
 * Four element types: fire, ice, lightning, kinetic.
 */

export const COLS = 7;
export const ROWS = 5;
export const ELEMENTS = ['fire', 'ice', 'lightning', 'kinetic'];

export function createGrid() {
  const grid = [];
  for (let r = 0; r < ROWS; r++) {
    const row = [];
    for (let c = 0; c < COLS; c++) {
      row.push(randomElement());
    }
    grid.push(row);
  }
  // Resolve any initial matches silently
  let matches = findMatches(grid);
  while (matches.length > 0) {
    for (const m of matches) {
      for (const [r, c] of m.cells) {
        grid[r][c] = randomElement();
      }
    }
    matches = findMatches(grid);
  }
  return grid;
}

export function randomElement() {
  return ELEMENTS[Math.floor(Math.random() * ELEMENTS.length)];
}

/** Swap two adjacent cells. Returns true if valid (produces a match). */
export function trySwap(grid, r1, c1, r2, c2) {
  // Must be adjacent (not diagonal)
  const dr = Math.abs(r1 - r2);
  const dc = Math.abs(c1 - c2);
  if (dr + dc !== 1) return false;

  // Swap
  const temp = grid[r1][c1];
  grid[r1][c1] = grid[r2][c2];
  grid[r2][c2] = temp;

  // Check if this produces matches
  const matches = findMatches(grid);
  if (matches.length === 0) {
    // Swap back — invalid move
    grid[r2][c2] = grid[r1][c1];
    grid[r1][c1] = temp;
    return false;
  }
  return true;
}

/**
 * Find all matches (3+ in a row/column).
 * Returns array of { element, cells: [[r,c],...], size, shape }
 * Shape: 'line3' | 'line4' | 'line5' | 'L' | 'T'
 */
export function findMatches(grid) {
  const matched = new Set();
  const rawGroups = [];

  // Horizontal
  for (let r = 0; r < ROWS; r++) {
    let run = 1;
    for (let c = 1; c <= COLS; c++) {
      if (c < COLS && grid[r][c] === grid[r][c - 1] && grid[r][c] !== null) {
        run++;
      } else {
        if (run >= 3) {
          const cells = [];
          for (let k = c - run; k < c; k++) {
            cells.push([r, k]);
            matched.add(`${r},${k}`);
          }
          rawGroups.push({ element: grid[r][c - 1], cells, dir: 'h' });
        }
        run = 1;
      }
    }
  }

  // Vertical
  for (let c = 0; c < COLS; c++) {
    let run = 1;
    for (let r = 1; r <= ROWS; r++) {
      if (r < ROWS && grid[r][c] === grid[r - 1][c] && grid[r][c] !== null) {
        run++;
      } else {
        if (run >= 3) {
          const cells = [];
          for (let k = r - run; k < r; k++) {
            cells.push([k, c]);
            matched.add(`${k},${c}`);
          }
          rawGroups.push({ element: grid[r - 1][c], cells, dir: 'v' });
        }
        run = 1;
      }
    }
  }

  // Merge overlapping groups of same element into combined matches
  const merged = mergeGroups(rawGroups);
  return merged;
}

function mergeGroups(groups) {
  if (groups.length === 0) return [];

  // Build adjacency — groups that share cells and element
  const used = new Array(groups.length).fill(false);
  const result = [];

  for (let i = 0; i < groups.length; i++) {
    if (used[i]) continue;
    const combined = new Set(groups[i].cells.map(c => `${c[0]},${c[1]}`));
    const element = groups[i].element;
    let dirs = new Set([groups[i].dir]);
    let changed = true;

    while (changed) {
      changed = false;
      for (let j = i + 1; j < groups.length; j++) {
        if (used[j] || groups[j].element !== element) continue;
        const overlap = groups[j].cells.some(c => combined.has(`${c[0]},${c[1]}`));
        if (overlap) {
          for (const c of groups[j].cells) combined.add(`${c[0]},${c[1]}`);
          dirs.add(groups[j].dir);
          used[j] = true;
          changed = true;
        }
      }
    }

    const cells = [...combined].map(s => s.split(',').map(Number));
    let shape = 'line3';
    if (dirs.size > 1) shape = cells.length >= 5 ? 'T' : 'L';
    else if (cells.length >= 5) shape = 'line5';
    else if (cells.length === 4) shape = 'line4';

    result.push({ element, cells, size: cells.length, shape });
    used[i] = true;
  }

  return result;
}

/** Clear matched cells (set to null) and return what was cleared. */
export function clearMatches(grid, matches) {
  for (const m of matches) {
    for (const [r, c] of m.cells) {
      grid[r][c] = null;
    }
  }
}

/** Apply gravity — tiles fall down into empty spaces. Returns list of moves for animation. */
export function applyGravity(grid) {
  const moves = [];
  for (let c = 0; c < COLS; c++) {
    let writeRow = ROWS - 1;
    for (let r = ROWS - 1; r >= 0; r--) {
      if (grid[r][c] !== null) {
        if (r !== writeRow) {
          moves.push({ from: [r, c], to: [writeRow, c], element: grid[r][c] });
          grid[writeRow][c] = grid[r][c];
          grid[r][c] = null;
        }
        writeRow--;
      }
    }
    // Fill empty spaces at top with new tiles
    for (let r = writeRow; r >= 0; r--) {
      const el = randomElement();
      grid[r][c] = el;
      moves.push({ from: [-1, c], to: [r, c], element: el, isNew: true });
    }
  }
  return moves;
}

/** Convert matches to projectile commands for the battlefield. */
export function matchesToProjectiles(matches) {
  const projectiles = [];
  for (const m of matches) {
    switch (m.shape) {
      case 'line3':
        projectiles.push({ element: m.element, type: 'single', damage: 2 });
        break;
      case 'line4':
        projectiles.push({ element: m.element, type: 'double', damage: 3 });
        break;
      case 'line5':
        projectiles.push({ element: m.element, type: 'blast', damage: 5 });
        break;
      case 'L':
        projectiles.push({ element: m.element, type: 'spread', damage: 3 });
        break;
      case 'T':
        projectiles.push({ element: m.element, type: 'mega', damage: 6 });
        break;
    }
  }
  return projectiles;
}

/** Check if any valid moves exist on the board. */
export function hasValidMoves(grid) {
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      // Try swap right
      if (c < COLS - 1) {
        swap(grid, r, c, r, c + 1);
        if (findMatches(grid).length > 0) { swap(grid, r, c, r, c + 1); return true; }
        swap(grid, r, c, r, c + 1);
      }
      // Try swap down
      if (r < ROWS - 1) {
        swap(grid, r, c, r + 1, c);
        if (findMatches(grid).length > 0) { swap(grid, r, c, r + 1, c); return true; }
        swap(grid, r, c, r + 1, c);
      }
    }
  }
  return false;
}

function swap(grid, r1, c1, r2, c2) {
  const t = grid[r1][c1];
  grid[r1][c1] = grid[r2][c2];
  grid[r2][c2] = t;
}
