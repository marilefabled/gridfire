<script>
  import { onMount } from 'svelte';
  import { createGrid, trySwap, findMatches, clearMatches, applyGravity, matchesToProjectiles, COLS, ROWS, ELEMENTS } from '$lib/game/Grid.js';
  import { createBattlefield, spawnEnemy, fireProjectiles, updateBattlefield, getWaveConfig, ELEMENT_COLORS } from '$lib/game/Battlefield.js';
  import audio from '$lib/game/Audio.js';

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

  // --- Match line effect state ---
  let matchLineCells = $state([]);         // array of {r,c} for the current match line
  let matchLineElement = $state(null);     // element color for the match line

  // --- Wave management ---
  let waveAnnouncement = $state(null);     // wave number or null
  let waveSpawnQueue = $state([]);
  let waveSpawnTimer = $state(0);
  let betweenWaves = $state(false);

  // --- Floating text ---
  let floatingTexts = $state([]);
  let nextFloatId = 0;

  // --- Canvas VFX ---
  let vfxCanvas;
  let bfContainer;

  // --- Grid glow state ---
  let lastMatchElement = $state(null);     // element of last match, for grid glow

  // --- Game loop ---
  let animFrame;
  let lastTime = 0;

  // Resize canvas to match battlefield
  $effect(() => {
    if (!vfxCanvas || !bfContainer) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        vfxCanvas.width = width * devicePixelRatio;
        vfxCanvas.height = height * devicePixelRatio;
        vfxCanvas.style.width = width + 'px';
        vfxCanvas.style.height = height + 'px';
      }
    });
    ro.observe(bfContainer);
    return () => ro.disconnect();
  });

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

  // --- Canvas VFX rendering ---
  function renderVFX() {
    if (!vfxCanvas) return;
    const ctx = vfxCanvas.getContext('2d');
    if (!ctx) return;
    const w = vfxCanvas.width;
    const h = vfxCanvas.height;
    ctx.clearRect(0, 0, w, h);

    const dpr = devicePixelRatio || 1;
    ctx.save();
    ctx.scale(dpr, dpr);
    const cw = w / dpr;
    const ch = h / dpr;

    // Additive blending for glowing particles
    ctx.globalCompositeOperation = 'lighter';

    // Render particles
    for (const part of bf.particles) {
      const px = (part.x / 100) * cw;
      const py = (part.y / 100) * ch;
      const alpha = Math.max(0, part.life / part.maxLife);
      ctx.beginPath();
      ctx.arc(px, py, part.size, 0, Math.PI * 2);
      ctx.fillStyle = hexToRgba(part.color, alpha);
      ctx.fill();
      // Outer glow
      ctx.beginPath();
      ctx.arc(px, py, part.size * 2, 0, Math.PI * 2);
      ctx.fillStyle = hexToRgba(part.color, alpha * 0.25);
      ctx.fill();
    }

    // Render projectile trails
    for (const proj of bf.projectiles) {
      const px = (proj.x / 100) * cw;
      const py = (proj.y / 100) * ch;
      const color = ELEMENT_COLORS[proj.element] || '#ffffff';

      // Estimate trailing positions from velocity (projectile moves rightward)
      const trailSpacing = proj.size * 1.8;
      for (let t = 1; t <= 4; t++) {
        const tx = px - t * trailSpacing;
        const ty = py;
        const trailAlpha = (1 - t / 5) * 0.5;
        const trailSize = proj.size * (1 - t * 0.18);
        if (trailSize > 0) {
          ctx.beginPath();
          ctx.arc(tx, ty, trailSize, 0, Math.PI * 2);
          ctx.fillStyle = hexToRgba(color, trailAlpha);
          ctx.fill();
        }
      }

      // Projectile core glow
      ctx.beginPath();
      ctx.arc(px, py, proj.size * 1.5, 0, Math.PI * 2);
      ctx.fillStyle = hexToRgba(color, 0.3);
      ctx.fill();
    }

    // Reset composite operation
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
  }

  function hexToRgba(hex, alpha) {
    // Handle named colors or already rgba
    if (!hex || !hex.startsWith('#')) return `rgba(255,255,255,${alpha})`;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
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

    // Canvas VFX rendering
    renderVFX();

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
    lastMatchElement = null;
    matchLineCells = [];
    matchLineElement = null;
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
      // Not adjacent -- just reselect
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

      // Track last match element for grid glow
      lastMatchElement = matches[matches.length - 1].element;

      // Build match line cells
      const allMatchCells = [];
      for (const m of matches) {
        for (const [r, c] of m.cells) {
          allMatchCells.push({ r, c });
        }
      }
      matchLineCells = allMatchCells;
      matchLineElement = lastMatchElement;

      // Mark cells as clearing
      const clearing = new Set();
      for (const m of matches) {
        for (const [r, c] of m.cells) clearing.add(`${r},${c}`);
      }
      clearingCells = clearing;
      await delay(250);
      clearingCells = new Set();
      matchLineCells = [];
      matchLineElement = null;

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
    if (combo > 0) {
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
        return;
      default: return;
    }

    if (r !== selected.r || c !== selected.c) {
      const dr = Math.abs(r - selected.r);
      const dc = Math.abs(c - selected.c);
      if (dr + dc === 1) {
        attemptSwap(selected.r, selected.c, r, c);
      } else {
        selected = { r, c };
      }
    }
  }

  // --- Player HP derived ---
  let hpPercent = $derived(Math.max(0, bf.player.hp / bf.player.maxHp * 100));
  let hpLow = $derived(hpPercent < 30);

  // --- Grid glow derived ---
  let gridGlowColor = $derived(
    combo > 0 && lastMatchElement ? ELEMENT_COLORS[lastMatchElement] : null
  );

  // --- Match line SVG path ---
  let matchLinePath = $derived.by(() => {
    if (matchLineCells.length < 2) return '';
    // Sort cells for a connected path: order by row then col
    const sorted = [...matchLineCells].sort((a, b) => a.r - b.r || a.c - b.c);
    // Build path through cell centers
    const pts = sorted.map(({ r, c }) => ({
      x: (c + 0.5) / COLS * 100,
      y: (r + 0.5) / ROWS * 100
    }));
    let d = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 1; i < pts.length; i++) {
      d += ` L ${pts[i].x} ${pts[i].y}`;
    }
    return d;
  });

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

  <!-- Battlefield -->
  <div class="battlefield" bind:this={bfContainer}>
    <!-- Parallax background layers -->
    <div class="parallax-far"></div>
    <div class="parallax-near"></div>

    <!-- Ground line and lane markers -->
    <div class="bf-lane">
      <div class="bf-ground"></div>
    </div>

    <!-- Player -->
    <div class="player" style="left: {bf.player.x / 100 * 100}%; top: {bf.player.y}%">
      <svg class="player-svg" viewBox="0 0 40 40" width="40" height="40">
        <!-- Shield arc on the left -->
        <path d="M 8 8 Q 2 20 8 32" fill="none" stroke="var(--text-dim)" stroke-width="2" stroke-linecap="round" opacity="0.6"/>
        <!-- Platform base -->
        <rect x="10" y="22" width="20" height="10" rx="3" ry="3" fill="var(--panel-light)" stroke="var(--text)" stroke-width="1.5"/>
        <!-- Turret housing -->
        <rect x="14" y="14" width="12" height="12" rx="2" ry="2" fill="var(--panel-light)" stroke="var(--text)" stroke-width="1.5"/>
        <!-- Barrel -->
        <rect x="26" y="17" width="12" height="6" rx="2" ry="2" fill="var(--text)" opacity="0.9"/>
        <!-- Barrel tip glow -->
        <circle cx="38" cy="20" r="2" fill="var(--fire)" opacity="0.6"/>
        <!-- Details -->
        <line x1="16" y1="20" x2="24" y2="20" stroke="var(--text-dim)" stroke-width="1" opacity="0.4"/>
        <circle cx="20" cy="20" r="1.5" fill="var(--text)" opacity="0.5"/>
      </svg>
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
          {#if enemy.type === 'grunt'}
            <svg viewBox="0 0 20 20" width={enemy.size} height={enemy.size} class="enemy-svg">
              <polygon points="10,1 18.66,6 18.66,14 10,19 1.34,14 1.34,6" fill="var(--ecolor)" stroke="rgba(255,255,255,0.2)" stroke-width="0.8"/>
              <circle cx="7" cy="10" r="1.5" fill="rgba(0,0,0,0.6)"/>
              <circle cx="13" cy="10" r="1.5" fill="rgba(0,0,0,0.6)"/>
            </svg>
          {:else if enemy.type === 'rusher'}
            <svg viewBox="0 0 20 20" width={enemy.size} height={enemy.size} class="enemy-svg">
              <polygon points="1,10 8,3 14,3 20,10 14,17 8,17" fill="var(--ecolor)" stroke="rgba(255,255,255,0.2)" stroke-width="0.8"/>
              <line x1="1" y1="10" x2="6" y2="7" stroke="rgba(255,255,255,0.3)" stroke-width="0.8"/>
              <line x1="1" y1="10" x2="6" y2="13" stroke="rgba(255,255,255,0.3)" stroke-width="0.8"/>
              <circle cx="11" cy="9" r="1.2" fill="rgba(0,0,0,0.6)"/>
              <circle cx="15" cy="9" r="1.2" fill="rgba(0,0,0,0.6)"/>
            </svg>
          {:else if enemy.type === 'tank'}
            <svg viewBox="0 0 20 20" width={enemy.size} height={enemy.size} class="enemy-svg">
              <rect x="1" y="2" width="18" height="16" rx="3" ry="3" fill="var(--ecolor)" stroke="rgba(255,255,255,0.2)" stroke-width="0.8"/>
              <line x1="1" y1="10" x2="19" y2="10" stroke="rgba(255,255,255,0.15)" stroke-width="1.5"/>
              <rect x="3" y="4" width="5" height="3" rx="1" fill="rgba(0,0,0,0.3)"/>
              <rect x="12" y="4" width="5" height="3" rx="1" fill="rgba(0,0,0,0.3)"/>
              <circle cx="7" cy="7" r="1" fill="rgba(255,200,200,0.4)"/>
              <circle cx="13" cy="7" r="1" fill="rgba(255,200,200,0.4)"/>
            </svg>
          {:else if enemy.type === 'shielded'}
            <svg viewBox="0 0 20 20" width={enemy.size} height={enemy.size} class="enemy-svg">
              <circle cx="10" cy="10" r="7" fill="var(--ecolor)" stroke="rgba(255,255,255,0.2)" stroke-width="0.8"/>
              <circle cx="8" cy="9" r="1.3" fill="rgba(0,0,0,0.5)"/>
              <circle cx="12" cy="9" r="1.3" fill="rgba(0,0,0,0.5)"/>
            </svg>
          {:else}
            <svg viewBox="0 0 20 20" width={enemy.size} height={enemy.size} class="enemy-svg">
              <circle cx="10" cy="10" r="8" fill="var(--ecolor)"/>
            </svg>
          {/if}
          {#if enemy.shield}
            <div class="enemy-shield" style="border-color: {ELEMENT_COLORS[enemy.shield]}"></div>
          {/if}
        </div>
      </div>
    {/each}

    <!-- Projectiles (DOM markers for positioning; trails rendered on canvas) -->
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
        <div class="proj-core"></div>
      </div>
    {/each}

    <!-- Canvas VFX overlay (particles + projectile trails) -->
    <canvas class="vfx-canvas" bind:this={vfxCanvas}></canvas>

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

  <!-- Separator line between battlefield and grid -->
  <div class="bf-grid-separator"></div>

  <!-- Match-3 Grid -->
  <div
    class="grid-area"
    class:combo-glow={combo > 0 && gridGlowColor}
    style={gridGlowColor ? `--glow-color: ${gridGlowColor}` : ''}
  >
    <div class="grid" style="--cols: {COLS}; --rows: {ROWS};">
      <!-- Match line SVG overlay -->
      {#if matchLinePath}
        <svg class="match-line-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
          <path
            d={matchLinePath}
            fill="none"
            stroke={matchLineElement ? ELEMENT_COLORS[matchLineElement] : '#ffffff'}
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            opacity="0.7"
          />
          <path
            d={matchLinePath}
            fill="none"
            stroke="#ffffff"
            stroke-width="0.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            opacity="0.4"
          />
        </svg>
      {/if}

      {#each grid as row, r}
        {#each row as cell, c}
          <button
            class="tile {tileClass(r, c)}"
            style={tileSwapVars(r, c)}
            onclick={() => selectTile(r, c)}
            disabled={processing || bf.gameOver}
            aria-label="{cell} tile at row {r + 1} column {c + 1}"
          >
            {#if cell === 'fire'}
              <svg class="tile-icon-svg" viewBox="0 0 20 20" width="20" height="20">
                <path d="M10 2 C10 2 6 7 6 11 C6 14 7.5 16 10 17 C12.5 16 14 14 14 11 C14 7 10 2 10 2Z" fill="currentColor" opacity="0.9"/>
                <path d="M10 6 C10 6 8 9 8 11.5 C8 13 9 14.5 10 15 C11 14.5 12 13 12 11.5 C12 9 10 6 10 6Z" fill="currentColor" opacity="0.5"/>
                <path d="M10 9 C10 9 9 11 9 12 C9 13 9.5 13.5 10 14 C10.5 13.5 11 13 11 12 C11 11 10 9 10 9Z" fill="rgba(255,255,255,0.4)"/>
              </svg>
            {:else if cell === 'ice'}
              <svg class="tile-icon-svg" viewBox="0 0 20 20" width="20" height="20">
                <line x1="10" y1="2" x2="10" y2="18" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                <line x1="3.1" y1="6" x2="16.9" y2="14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                <line x1="3.1" y1="14" x2="16.9" y2="6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                <line x1="10" y1="2" x2="8" y2="4" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>
                <line x1="10" y1="2" x2="12" y2="4" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>
                <line x1="10" y1="18" x2="8" y2="16" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>
                <line x1="10" y1="18" x2="12" y2="16" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>
                <line x1="3.1" y1="6" x2="4.5" y2="8" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>
                <line x1="16.9" y1="6" x2="15.5" y2="8" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>
                <line x1="3.1" y1="14" x2="4.5" y2="12" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>
                <line x1="16.9" y1="14" x2="15.5" y2="12" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>
                <circle cx="10" cy="10" r="2" fill="currentColor" opacity="0.4"/>
              </svg>
            {:else if cell === 'lightning'}
              <svg class="tile-icon-svg" viewBox="0 0 20 20" width="20" height="20">
                <polygon points="11,1 5,11 9,11 7,19 15,9 11,9 13,1" fill="currentColor"/>
                <polygon points="11,3 7,10.5 9.5,10.5 8,17 13.5,9.5 11,9.5 12.5,3" fill="rgba(255,255,255,0.25)"/>
              </svg>
            {:else if cell === 'kinetic'}
              <svg class="tile-icon-svg" viewBox="0 0 20 20" width="20" height="20">
                <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.6"/>
                <circle cx="10" cy="10" r="5" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.8"/>
                <circle cx="10" cy="10" r="3" fill="currentColor" opacity="0.9"/>
              </svg>
            {:else if cell}
              <span class="tile-icon">{cell}</span>
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
    border-bottom: none;
  }

  /* --- Parallax background layers --- */
  .parallax-far {
    position: absolute;
    inset: 0;
    z-index: 0;
    pointer-events: none;
    opacity: 0.05;
    background-image:
      radial-gradient(circle 1px, #ffffff 0.5px, transparent 1px);
    background-size: 60px 40px;
    animation: parallax-scroll-far 20s linear infinite;
  }
  .parallax-near {
    position: absolute;
    inset: 0;
    z-index: 0;
    pointer-events: none;
    opacity: 0.08;
    background-image:
      radial-gradient(circle 1.5px, #ffffff 0.8px, transparent 1px);
    background-size: 90px 55px;
    background-position: 30px 15px;
    animation: parallax-scroll-near 12s linear infinite;
  }
  @keyframes parallax-scroll-far {
    from { background-position: 0 0; }
    to { background-position: -60px 0; }
  }
  @keyframes parallax-scroll-near {
    from { background-position: 30px 15px; }
    to { background-position: -60px 15px; }
  }

  /* Lane view */
  .bf-lane { position: absolute; inset: 0; pointer-events: none; z-index: 1; }
  .bf-ground {
    position: absolute; left: 0; right: 0; top: 70%;
    height: 1px;
    background: linear-gradient(90deg, var(--border), rgba(255,255,255,0.06), var(--border));
    opacity: 0.5;
  }

  /* --- Canvas VFX overlay --- */
  .vfx-canvas {
    position: absolute;
    inset: 0;
    z-index: 8;
    pointer-events: none;
  }

  /* Player */
  .player {
    position: absolute;
    transform: translate(-50%, -50%);
    z-index: 5;
  }
  .player-svg {
    display: block;
    filter: drop-shadow(0 0 6px rgba(255, 85, 51, 0.3));
  }
  .player-hp-bar {
    width: 40px;
    height: 4px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 2px;
    overflow: hidden;
    margin-top: 4px;
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
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .enemy-svg {
    display: block;
    filter: drop-shadow(0 0 4px var(--ecolor));
  }
  .enemy.flash .enemy-body {
    filter: brightness(3);
  }
  .enemy.flash .enemy-svg {
    filter: brightness(3) drop-shadow(0 0 10px #ffffff);
  }
  .enemy.slowed .enemy-svg {
    filter: drop-shadow(0 0 8px var(--ice));
  }
  .enemy.burning .enemy-svg {
    filter: drop-shadow(0 0 8px var(--fire));
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

  /* =============================== SEPARATOR =============================== */
  .bf-grid-separator {
    height: 2px;
    flex-shrink: 0;
    background: linear-gradient(90deg,
      transparent 0%,
      var(--border) 15%,
      var(--fire) 35%,
      var(--lightning) 50%,
      var(--ice) 65%,
      var(--border) 85%,
      transparent 100%
    );
    opacity: 0.4;
  }

  /* =============================== GRID =============================== */
  .grid-area {
    flex: 0 0 65%;
    display: flex;
    align-items: center;
    justify-content: center;
    background:
      radial-gradient(ellipse at 50% 40%, rgba(255,255,255,0.03) 0%, transparent 60%),
      var(--bg);
    padding: var(--s3);
    border-top: 1px solid var(--border);
    transition: box-shadow 0.4s ease;
  }
  .grid-area.combo-glow {
    box-shadow:
      inset 0 0 30px color-mix(in srgb, var(--glow-color, #ffffff) 20%, transparent),
      inset 0 0 60px color-mix(in srgb, var(--glow-color, #ffffff) 8%, transparent);
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(var(--cols), 1fr);
    grid-template-rows: repeat(var(--rows), 1fr);
    gap: 3px;
    width: 100%;
    max-width: 420px;
    aspect-ratio: var(--cols) / var(--rows);
    position: relative;
  }

  /* Match line SVG overlay */
  .match-line-svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    z-index: 10;
    pointer-events: none;
    animation: matchLineFlash 0.25s ease-out forwards;
  }
  @keyframes matchLineFlash {
    0% { opacity: 0; }
    30% { opacity: 1; }
    100% { opacity: 0; }
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
  .tile-icon-svg {
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
