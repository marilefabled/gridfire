<script>
  import { onMount } from 'svelte';
  import { createGrid, trySwap, findMatches, clearMatches, applyGravity, matchesToProjectiles, COLS, ROWS, ELEMENTS } from '$lib/game/Grid.js';
  import { createBattlefield, spawnEnemy, fireProjectiles, updateBattlefield, getWaveConfig, ELEMENT_COLORS } from '$lib/game/Battlefield.js';
  import audio from '$lib/game/Audio.js';

  const TILE_SYMBOLS = { fire: '\u25B2', ice: '\u25C7', lightning: '\u26A1', kinetic: '\u25CF' };

  // --- Core state ---
  let grid = $state(createGrid());
  let bf = $state(createBattlefield());
  let selected = $state(null);     // {r, c}
  let processing = $state(false);  // lock grid during resolution
  let combo = $state(0);
  let shaking = $state(false);
  let gameStarted = $state(false);

  // --- Animation state ---
  let clearingCells = $state(new Set());   // "r,c" keys currently clearing
  let fallingCells = $state(new Set());    // "r,c" keys currently falling
  let swappingCells = $state(null);        // { a: {r,c}, b: {r,c} } during swap anim
  let badSwapCells = $state(null);         // same shape, for invalid swap shake

  // --- Wave management ---
  let waveAnnouncement = $state(null);     // wave number or null
  let waveSpawnQueue = $state([]);
  let waveSpawnTimer = $state(0);
  let betweenWaves = $state(false);

  // --- Floating text ---
  let floatingTexts = $state([]);
  let nextFloatId = 0;

  // --- Game loop ---
  let animFrame;
  let lastTime = 0;

  function addFloat(text, x, y, color = '#fff') {
    const id = nextFloatId++;
    floatingTexts.push({ id, text, x, y, color, born: performance.now() });
    setTimeout(() => {
      floatingTexts = floatingTexts.filter(f => f.id !== id);
    }, 900);
  }

  function triggerShake(intensity = 1) {
    shaking = true;
    setTimeout(() => shaking = false, 150 + intensity * 100);
  }

  // --- Battlefield game loop ---
  function gameLoop(time) {
    if (!gameStarted) return;
    const dt = Math.min((time - lastTime) / 1000, 0.05);
    lastTime = time;

    // Wave spawn queue
    if (waveSpawnQueue.length > 0) {
      waveSpawnTimer -= dt;
      if (waveSpawnTimer <= 0) {
        const next = waveSpawnQueue.shift();
        spawnEnemy(bf, next.type);
        waveSpawnQueue = [...waveSpawnQueue];
        if (waveSpawnQueue.length > 0) {
          waveSpawnTimer = waveSpawnQueue[0].delay - (next.delay || 0);
        }
      }
    }

    // Check wave completion
    if (bf.waveActive && waveSpawnQueue.length === 0 && bf.enemies.length === 0 && !betweenWaves) {
      bf.waveActive = false;
      betweenWaves = true;
      setTimeout(() => startNextWave(), 3000);
    }

    // Tick battlefield
    const events = updateBattlefield(bf, dt);
    // Force reactivity by reassignment
    bf = bf;

    // Process events
    for (const ev of events) {
      switch (ev.type) {
        case 'hit':
          audio.hit();
          break;
        case 'kill':
          audio.kill();
          addFloat(`+${ev.enemy.points}`, ev.enemy.x, ev.enemy.y, '#ffcc00');
          triggerShake(0.5);
          break;
        case 'playerHit':
          audio.playerHit();
          triggerShake(2);
          break;
        case 'gameOver':
          audio.gameOver();
          break;
      }
    }

    if (!bf.gameOver) {
      animFrame = requestAnimationFrame(gameLoop);
    }
  }

  function startNextWave() {
    betweenWaves = false;
    bf.wave++;
    bf.waveActive = true;
    const config = getWaveConfig(bf.wave);
    waveSpawnQueue = [...config];
    waveSpawnTimer = config[0]?.delay || 0.5;

    waveAnnouncement = bf.wave;
    audio.waveStart();
    setTimeout(() => { waveAnnouncement = null; }, 2000);
    bf = bf;
  }

  function startGame() {
    grid = createGrid();
    bf = createBattlefield();
    selected = null;
    processing = false;
    combo = 0;
    gameStarted = true;
    floatingTexts = [];
    waveSpawnQueue = [];
    betweenWaves = false;
    waveAnnouncement = null;
    lastTime = performance.now();
    animFrame = requestAnimationFrame(gameLoop);
    setTimeout(() => startNextWave(), 2000);
  }

  // --- Grid interaction ---
  function selectTile(r, c) {
    if (processing || bf.gameOver) return;

    if (selected === null) {
      selected = { r, c };
      return;
    }

    if (selected.r === r && selected.c === c) {
      selected = null;
      return;
    }

    const dr = Math.abs(r - selected.r);
    const dc = Math.abs(c - selected.c);
    if (dr + dc !== 1) {
      // Not adjacent — just reselect
      selected = { r, c };
      return;
    }

    attemptSwap(selected.r, selected.c, r, c);
  }

  async function attemptSwap(r1, c1, r2, c2) {
    processing = true;
    selected = null;

    // Animate swap
    swappingCells = { a: { r: r1, c: c1 }, b: { r: r2, c: c2 } };
    await delay(120);
    swappingCells = null;

    const valid = trySwap(grid, r1, c1, r2, c2);
    grid = grid;

    if (!valid) {
      audio.badSwap();
      badSwapCells = { a: { r: r1, c: c1 }, b: { r: r2, c: c2 } };
      await delay(250);
      badSwapCells = null;
      processing = false;
      return;
    }

    audio.swap();
    // Resolve matches (with cascading)
    await resolveMatches();
    processing = false;
  }

  async function resolveMatches() {
    let cascadeCount = 0;

    while (true) {
      const matches = findMatches(grid);
      if (matches.length === 0) break;

      cascadeCount++;
      combo++;
      if (combo > bf.maxCombo) bf.maxCombo = combo;

      const totalSize = matches.reduce((s, m) => s + m.size, 0);
      audio.match(totalSize);

      if (cascadeCount > 1 || combo > 1) {
        audio.combo(combo);
        addFloat(`COMBO x${combo}!`, 50, 40, '#ffcc00');
      }

      if (totalSize >= 4) triggerShake(0.3);

      // Mark cells as clearing
      const clearing = new Set();
      for (const m of matches) {
        for (const [r, c] of m.cells) clearing.add(`${r},${c}`);
      }
      clearingCells = clearing;
      await delay(250);
      clearingCells = new Set();

      // Clear and convert to projectiles
      clearMatches(grid, matches);
      grid = grid;

      const projectiles = matchesToProjectiles(matches);
      fireProjectiles(bf, projectiles);
      for (const p of projectiles) audio.fire(p.element);

      // Add score
      const baseScore = matches.reduce((s, m) => s + m.size * 5, 0);
      bf.score += baseScore * combo;
      addFloat(`+${baseScore * combo}`, 20, 80, '#ffffff');
      bf = bf;

      // Gravity
      await delay(100);
      const moves = applyGravity(grid);
      const falling = new Set();
      for (const m of moves) falling.add(`${m.to[0]},${m.to[1]}`);
      fallingCells = falling;
      grid = grid;
      await delay(250);
      fallingCells = new Set();
    }

    // Reset combo if no match found on player action
    // Actually, combo persists across cascades; it resets on next move if no match
    if (combo > 0) {
      // Schedule combo reset after a delay if no new match happens
      const currentCombo = combo;
      setTimeout(() => {
        if (combo === currentCombo && !processing) combo = 0;
      }, 2000);
    }
  }

  function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // --- Keyboard ---
  function handleKeydown(e) {
    if (bf.gameOver || processing) return;

    if (e.key === 'Escape') {
      selected = null;
      return;
    }

    if (!selected) {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
        selected = { r: 0, c: 0 };
      }
      return;
    }

    let { r, c } = selected;
    switch (e.key) {
      case 'ArrowUp':    e.preventDefault(); r = Math.max(0, r - 1); break;
      case 'ArrowDown':  e.preventDefault(); r = Math.min(ROWS - 1, r + 1); break;
      case 'ArrowLeft':  e.preventDefault(); c = Math.max(0, c - 1); break;
      case 'ArrowRight': e.preventDefault(); c = Math.min(COLS - 1, c + 1); break;
      case ' ':
      case 'Enter':
        e.preventDefault();
        // No-op; need a second selection to swap
        return;
      default: return;
    }

    // If we moved, check if it's a swap action or just movement
    if (r !== selected.r || c !== selected.c) {
      const dr = Math.abs(r - selected.r);
      const dc = Math.abs(c - selected.c);
      if (dr + dc === 1) {
        // Adjacent move — perform swap
        attemptSwap(selected.r, selected.c, r, c);
      } else {
        selected = { r, c };
      }
    }
  }

  // --- Player HP derived ---
  let hpPercent = $derived(Math.max(0, bf.player.hp / bf.player.maxHp * 100));
  let hpLow = $derived(hpPercent < 30);

  // --- Lifecycle ---
  onMount(() => {
    startGame();
    return () => {
      if (animFrame) cancelAnimationFrame(animFrame);
    };
  });

  function restartGame() {
    if (animFrame) cancelAnimationFrame(animFrame);
    startGame();
  }

  // Tile state helpers
  function tileClass(r, c) {
    const el = grid[r]?.[c];
    if (!el) return '';
    let cls = el;
    if (selected && selected.r === r && selected.c === c) cls += ' selected';
    if (clearingCells.has(`${r},${c}`)) cls += ' clearing';
    if (fallingCells.has(`${r},${c}`)) cls += ' falling';
    if (swappingCells) {
      const { a, b } = swappingCells;
      if (a.r === r && a.c === c) cls += ' swap-to-b';
      if (b.r === r && b.c === c) cls += ' swap-to-a';
    }
    if (badSwapCells) {
      const { a, b } = badSwapCells;
      if ((a.r === r && a.c === c) || (b.r === r && b.c === c)) cls += ' bad-swap';
    }
    return cls;
  }

  // Swap CSS custom properties for animation direction
  function tileSwapVars(r, c) {
    if (!swappingCells) return '';
    const { a, b } = swappingCells;
    if (a.r === r && a.c === c) {
      return `--dx: ${(b.c - a.c) * 100}%; --dy: ${(b.r - a.r) * 100}%;`;
    }
    if (b.r === r && b.c === c) {
      return `--dx: ${(a.c - b.c) * 100}%; --dy: ${(a.r - b.r) * 100}%;`;
    }
    return '';
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="game" class:shaking>
  <!-- HUD -->
  <div class="hud">
    <div class="hud-score">
      <span class="hud-label">SCORE</span>
      <span class="hud-value">{bf.score.toLocaleString()}</span>
    </div>
    <div class="hud-wave">
      {#if bf.waveActive}
        WAVE {bf.wave}
      {:else if betweenWaves}
        GET READY
      {/if}
    </div>
    <div class="hud-hp">
      <span class="hud-label">HP</span>
      <div class="hp-bar-mini">
        <div
          class="hp-bar-fill"
          class:low={hpLow}
          style="width: {hpPercent}%"
        ></div>
      </div>
    </div>
  </div>

  {#if combo > 1}
    <div class="combo-display">
      COMBO x{combo}
    </div>
  {/if}

  <!-- Battlefield — side-scroll lane view -->
  <div class="battlefield">
    <!-- Ground line and lane markers -->
    <div class="bf-lane">
      <div class="bf-ground"></div>
    </div>

    <!-- Player -->
    <div class="player" style="left: {bf.player.x / 100 * 100}%; top: {bf.player.y}%">
      <div class="player-body">
        <div class="player-shield"></div>
        <div class="player-turret"></div>
      </div>
      <div class="player-hp-bar">
        <div
          class="player-hp-fill"
          class:low={hpLow}
          style="width: {hpPercent}%"
        ></div>
      </div>
    </div>

    <!-- Enemies -->
    {#each bf.enemies as enemy (enemy.id)}
      <div
        class="enemy"
        class:flash={enemy.flashTimer > 0}
        class:slowed={enemy.effects.includes('slow')}
        class:burning={enemy.effects.includes('burn')}
        style="
          left: {enemy.x}%;
          top: {enemy.y}%;
          --ecolor: {enemy.color};
          --esize: {enemy.size}px;
        "
      >
        <div class="enemy-hp-bar">
          <div class="enemy-hp-fill" style="width: {Math.max(0, enemy.hp / enemy.maxHp * 100)}%"></div>
        </div>
        <div class="enemy-body" style="width: {enemy.size}px; height: {enemy.size}px;">
          {#if enemy.shield}
            <div class="enemy-shield" style="border-color: {ELEMENT_COLORS[enemy.shield]}"></div>
          {/if}
        </div>
      </div>
    {/each}

    <!-- Projectiles -->
    {#each bf.projectiles as proj (proj.id)}
      <div
        class="projectile"
        style="
          left: {proj.x}%;
          top: {proj.y}%;
          --pcolor: {ELEMENT_COLORS[proj.element]};
          --psize: {proj.size}px;
        "
      >
        <div class="proj-trail t1"></div>
        <div class="proj-trail t2"></div>
        <div class="proj-core"></div>
      </div>
    {/each}

    <!-- Particles -->
    {#each bf.particles as part (part.id)}
      <div
        class="particle"
        style="
          left: {part.x}%;
          top: {part.y}%;
          width: {part.size}px;
          height: {part.size}px;
          background: {part.color};
          opacity: {Math.max(0, part.life / part.maxLife)};
        "
      ></div>
    {/each}

    <!-- Wave announcement -->
    {#if waveAnnouncement}
      <div class="wave-announce">WAVE {waveAnnouncement}</div>
    {/if}

    <!-- Floating texts -->
    {#each floatingTexts as ft (ft.id)}
      <div
        class="float-text"
        style="
          left: {ft.x}%;
          top: {ft.y}%;
          color: {ft.color};
        "
      >
        {ft.text}
      </div>
    {/each}
  </div>

  <!-- Match-3 Grid -->
  <div class="grid-area">
    <div class="grid" style="--cols: {COLS}; --rows: {ROWS};">
      {#each grid as row, r}
        {#each row as cell, c}
          <button
            class="tile {tileClass(r, c)}"
            style={tileSwapVars(r, c)}
            onclick={() => selectTile(r, c)}
            disabled={processing || bf.gameOver}
            aria-label="{cell} tile at row {r + 1} column {c + 1}"
          >
            {#if cell}
              <span class="tile-icon">{TILE_SYMBOLS[cell]}</span>
            {/if}
          </button>
        {/each}
      {/each}
    </div>
  </div>

  <!-- Game Over Overlay -->
  {#if bf.gameOver}
    <div class="game-over-overlay">
      <div class="game-over-box">
        <h1 class="go-title">GAME OVER</h1>
        <div class="go-stats">
          <div class="go-stat">
            <span class="go-stat-label">FINAL SCORE</span>
            <span class="go-stat-value">{bf.score.toLocaleString()}</span>
          </div>
          <div class="go-stat">
            <span class="go-stat-label">WAVES SURVIVED</span>
            <span class="go-stat-value">{bf.wave}</span>
          </div>
          <div class="go-stat">
            <span class="go-stat-label">ENEMIES KILLED</span>
            <span class="go-stat-value">{bf.enemiesKilled}</span>
          </div>
          <div class="go-stat">
            <span class="go-stat-label">MAX COMBO</span>
            <span class="go-stat-value">x{bf.maxCombo}</span>
          </div>
        </div>
        <button class="go-restart" onclick={restartGame}>PLAY AGAIN</button>
      </div>
    </div>
  {/if}
</div>

<style>
  /* =============================== LAYOUT =============================== */
  .game {
    width: 100%;
    height: 100vh;
    height: 100dvh;
    display: flex;
    flex-direction: column;
    position: relative;
    overflow: hidden;
    background: var(--bg);
  }
  .game.shaking {
    animation: shake 0.25s ease-out;
  }

  /* =============================== HUD =============================== */
  .hud {
    position: absolute;
    top: 0; left: 0; right: 0;
    z-index: 20;
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    padding: var(--s2) var(--s3);
    pointer-events: none;
  }
  .hud-label {
    font-size: var(--fs-xs);
    color: var(--text-dim);
    display: block;
    letter-spacing: 1px;
  }
  .hud-value {
    font-size: var(--fs-lg);
    color: var(--gold);
    font-weight: bold;
  }
  .hud-wave {
    font-size: var(--fs-sm);
    color: var(--text-dim);
    text-align: center;
    padding-top: 2px;
  }
  .hud-hp {
    text-align: right;
  }
  .hp-bar-mini {
    width: 70px;
    height: 6px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 3px;
    overflow: hidden;
    margin-top: 2px;
  }
  .hp-bar-fill {
    height: 100%;
    background: var(--hp-green);
    transition: width 0.3s var(--ease-out);
    border-radius: 2px;
  }
  .hp-bar-fill.low {
    background: var(--hp-red);
  }

  .combo-display {
    position: absolute;
    top: 36px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 20;
    font-size: var(--fs-xl);
    font-weight: bold;
    color: var(--gold);
    text-shadow: 0 0 12px rgba(255, 170, 34, 0.6);
    animation: pulse 0.5s ease-in-out infinite;
    pointer-events: none;
  }

  /* =============================== BATTLEFIELD =============================== */
  .battlefield {
    flex: 0 0 35%;
    position: relative;
    overflow: hidden;
    background:
      radial-gradient(ellipse at 10% 50%, rgba(100, 40, 40, 0.08) 0%, transparent 60%),
      var(--panel);
    border-bottom: 2px solid var(--border);
  }

  /* Lane view */
  .bf-lane { position: absolute; inset: 0; pointer-events: none; }
  .bf-ground {
    position: absolute; left: 0; right: 0; top: 70%;
    height: 1px;
    background: linear-gradient(90deg, var(--border), rgba(255,255,255,0.06), var(--border));
    opacity: 0.5;
  }

  /* Player */
  .player {
    position: absolute;
    transform: translate(-50%, -50%);
    z-index: 5;
  }
  .player-body {
    position: relative;
    width: 28px;
    height: 28px;
  }
  .player-shield {
    width: 28px;
    height: 28px;
    border: 2px solid var(--text);
    border-radius: 4px;
    background: var(--panel-light);
    transform: rotate(45deg);
  }
  .player-turret {
    position: absolute;
    top: 50%;
    left: 60%;
    width: 18px;
    height: 4px;
    background: var(--text);
    border-radius: 0 2px 2px 0;
    transform: translateY(-50%);
  }
  .player-hp-bar {
    width: 32px;
    height: 4px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 2px;
    overflow: hidden;
    margin-top: 4px;
    margin-left: -2px;
  }
  .player-hp-fill {
    height: 100%;
    background: var(--hp-green);
    transition: width 0.3s var(--ease-out);
    border-radius: 1px;
  }
  .player-hp-fill.low { background: var(--hp-red); }

  /* Enemies */
  .enemy {
    position: absolute;
    transform: translate(-50%, -50%);
    z-index: 3;
    transition: none;
  }
  .enemy-body {
    border-radius: 50%;
    background: var(--ecolor);
    position: relative;
    box-shadow: 0 0 8px color-mix(in srgb, var(--ecolor) 40%, transparent);
  }
  .enemy.flash .enemy-body {
    background: #ffffff !important;
    box-shadow: 0 0 16px #ffffff;
  }
  .enemy.slowed .enemy-body {
    box-shadow: 0 0 10px var(--ice);
  }
  .enemy.burning .enemy-body {
    box-shadow: 0 0 10px var(--fire);
  }
  .enemy-shield {
    position: absolute;
    inset: -4px;
    border: 2px dashed;
    border-radius: 50%;
    opacity: 0.6;
  }
  .enemy-hp-bar {
    width: calc(var(--esize) + 8px);
    height: 3px;
    background: rgba(0,0,0,0.5);
    border-radius: 2px;
    overflow: hidden;
    margin-bottom: 3px;
    margin-left: calc((var(--esize) - var(--esize) - 8px) / 2);
  }
  .enemy-hp-fill {
    height: 100%;
    background: var(--hp-red);
    transition: width 0.15s linear;
  }

  /* Projectiles */
  .projectile {
    position: absolute;
    transform: translate(-50%, -50%);
    z-index: 4;
    pointer-events: none;
  }
  .proj-core {
    width: var(--psize);
    height: var(--psize);
    background: var(--pcolor);
    border-radius: 50%;
    box-shadow: 0 0 8px var(--pcolor), 0 0 16px var(--pcolor);
  }
  .proj-trail {
    position: absolute;
    top: 50%;
    border-radius: 50%;
    background: var(--pcolor);
  }
  .proj-trail.t1 {
    width: calc(var(--psize) * 0.7);
    height: calc(var(--psize) * 0.7);
    right: 60%;
    transform: translateY(-50%);
    opacity: 0.4;
  }
  .proj-trail.t2 {
    width: calc(var(--psize) * 0.4);
    height: calc(var(--psize) * 0.4);
    right: 120%;
    transform: translateY(-50%);
    opacity: 0.2;
  }

  /* Particles */
  .particle {
    position: absolute;
    border-radius: 50%;
    pointer-events: none;
    transform: translate(-50%, -50%);
    z-index: 6;
  }

  /* Wave announcement */
  .wave-announce {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    font-size: var(--fs-3xl);
    font-weight: bold;
    color: var(--text);
    text-shadow: 0 0 20px rgba(255, 85, 51, 0.5);
    z-index: 15;
    animation: waveIn 2s var(--ease-out) forwards;
    pointer-events: none;
    letter-spacing: 4px;
  }
  @keyframes waveIn {
    0% { opacity: 0; transform: translate(-50%, -50%) scale(0.5); }
    20% { opacity: 1; transform: translate(-50%, -50%) scale(1.1); }
    30% { transform: translate(-50%, -50%) scale(1); }
    70% { opacity: 1; }
    100% { opacity: 0; transform: translate(-50%, -50%) scale(1) translateY(-20px); }
  }

  /* Floating text */
  .float-text {
    position: absolute;
    transform: translate(-50%, -50%);
    font-size: var(--fs-lg);
    font-weight: bold;
    z-index: 15;
    pointer-events: none;
    animation: fadeUp 0.9s var(--ease-out) forwards;
    text-shadow: 0 1px 4px rgba(0,0,0,0.8);
  }

  /* =============================== GRID =============================== */
  .grid-area {
    flex: 0 0 45%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg);
    padding: var(--s3);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(var(--cols), 1fr);
    grid-template-rows: repeat(var(--rows), 1fr);
    gap: 3px;
    width: 100%;
    max-width: 420px;
    aspect-ratio: var(--cols) / var(--rows);
  }

  /* Tile */
  .tile {
    position: relative;
    border-radius: 6px;
    border: 2px solid transparent;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    padding: 0;
    font-size: clamp(14px, 3.5vw, 22px);
    transition:
      transform 0.12s var(--ease-bounce),
      border-color 0.15s ease,
      opacity 0.15s ease,
      background 0.15s ease;
    -webkit-tap-highlight-color: transparent;
  }
  .tile:active:not(:disabled) {
    transform: scale(0.9);
  }

  /* Element colors */
  .tile.fire {
    background: var(--fire-dim);
    color: var(--fire);
    border-color: rgba(255, 85, 51, 0.25);
  }
  .tile.ice {
    background: var(--ice-dim);
    color: var(--ice);
    border-color: rgba(51, 187, 255, 0.25);
  }
  .tile.lightning {
    background: var(--lightning-dim);
    color: var(--lightning);
    border-color: rgba(255, 204, 0, 0.25);
  }
  .tile.kinetic {
    background: var(--kinetic-dim);
    color: var(--kinetic);
    border-color: rgba(204, 136, 255, 0.25);
  }

  .tile-icon {
    pointer-events: none;
    filter: drop-shadow(0 0 4px currentColor);
  }

  /* Selected tile */
  .tile.selected {
    border-color: #ffffff !important;
    box-shadow: 0 0 12px rgba(255, 255, 255, 0.4), inset 0 0 8px rgba(255, 255, 255, 0.1);
    animation: pulse 0.8s ease-in-out infinite;
    z-index: 2;
  }

  /* Clearing animation */
  .tile.clearing {
    animation: tileClear 0.25s ease-out forwards;
    z-index: 3;
  }
  @keyframes tileClear {
    0% { transform: scale(1); opacity: 1; }
    40% { transform: scale(1.25); opacity: 1; background: rgba(255,255,255,0.3); }
    100% { transform: scale(0); opacity: 0; }
  }

  /* Falling animation */
  .tile.falling {
    animation: tileFall 0.25s var(--ease-bounce);
  }
  @keyframes tileFall {
    0% { transform: translateY(-100%); opacity: 0.5; }
    60% { transform: translateY(5%); opacity: 1; }
    100% { transform: translateY(0); opacity: 1; }
  }

  /* Swap animation */
  .tile.swap-to-b {
    animation: swapMove 0.12s ease-out;
    z-index: 5;
  }
  .tile.swap-to-a {
    animation: swapMove 0.12s ease-out;
    z-index: 5;
  }
  @keyframes swapMove {
    0% { transform: translate(var(--dx, 0), var(--dy, 0)); }
    100% { transform: translate(0, 0); }
  }

  /* Bad swap shake */
  .tile.bad-swap {
    animation: shake 0.25s ease-out;
  }

  /* =============================== GAME OVER =============================== */
  .game-over-overlay {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.75);
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: center;
    animation: fadeIn 0.5s ease-out;
  }
  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  .game-over-box {
    text-align: center;
    padding: var(--s7) var(--s6);
  }
  .go-title {
    font-size: var(--fs-3xl);
    color: var(--fire);
    letter-spacing: 6px;
    margin-bottom: var(--s6);
    text-shadow: 0 0 30px rgba(255, 85, 51, 0.5);
    animation: pop 0.5s var(--ease-bounce);
  }
  .go-stats {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--s4);
    margin-bottom: var(--s6);
  }
  .go-stat {
    display: flex;
    flex-direction: column;
    gap: var(--s1);
  }
  .go-stat-label {
    font-size: var(--fs-xs);
    color: var(--text-dim);
    letter-spacing: 1px;
  }
  .go-stat-value {
    font-size: var(--fs-xl);
    color: var(--gold);
    font-weight: bold;
  }
  .go-restart {
    font-size: var(--fs-lg);
    padding: var(--s3) var(--s6);
    border: 2px solid var(--fire);
    color: var(--fire);
    letter-spacing: 3px;
    margin-top: var(--s4);
    background: var(--fire-dim);
    transition: all 0.2s var(--ease-out);
  }
  .go-restart:hover {
    background: var(--fire);
    color: var(--bg);
    box-shadow: 0 0 20px rgba(255, 85, 51, 0.4);
  }
</style>
