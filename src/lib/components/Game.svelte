<script>
  import { onMount } from 'svelte';
  import { createGrid, trySwap, findMatches, clearMatches, applyGravity, matchesToProjectiles, COLS, ROWS, ELEMENTS } from '$lib/game/Grid.js';
  import { createBattlefield, spawnEnemy, spawnBoss, fireProjectiles, updateBattlefield, getWaveConfig, getMusicPulseFreq, rollPerks, hasPerk, ELEMENT_COLORS, PERK_POOL } from '$lib/game/Battlefield.js';
  import { getHighScores, saveHighScores } from '$lib/game/HighScores.js';
  import audio from '$lib/game/Audio.js';

  // --- Splash state ---
  let splashActive = $state(true);
  let splashLine1 = $state(false);
  let splashLine2 = $state(false);
  let splashLine3 = $state(false);
  let splashLine4 = $state(false);
  let splashFading = $state(false);

  function skipSplash() {
    if (!splashFading) {
      splashFading = true;
      setTimeout(() => { splashActive = false; }, 400);
    }
  }

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
  let waveHostileCount = $state(0);        // enemy count for wave announcement
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

  // --- Perk selection state ---
  let perkPhase = $state(false);
  let perkChoices = $state([]);            // 3 perks to choose from

  // --- High scores ---
  let highScores = $state({ bestScore: 0, bestWave: 0, bestCombo: 0, totalGames: 0 });
  let isNewBest = $state(false);

  // --- Grid reaction state ---
  let gridJitter = $state(false);
  let gridDimmed = $state(false);
  let gridBorderPulseColor = $state(null);

  // --- Boss flash state ---
  let bossFlash = $state(false);

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
    // Pause game loop during perk selection
    if (perkPhase) {
      animFrame = requestAnimationFrame(gameLoop);
      return;
    }

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

      // Check if perk selection should trigger (every 3 waves)
      if (bf.wave % 3 === 0 && bf.wave > 0) {
        perkPhase = true;
        perkChoices = rollPerks(bf);
      } else {
        setTimeout(() => startNextWave(), 3000);
      }
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
          // Grid jitter + dim on player hit
          gridJitter = true;
          gridDimmed = true;
          setTimeout(() => { gridJitter = false; }, 200);
          setTimeout(() => { gridDimmed = false; }, 300);
          break;
        case 'gameOver':
          audio.gameOver();
          // Save high scores on game over
          const result = saveHighScores(bf.score, bf.wave, bf.maxCombo);
          isNewBest = result.isNewBest;
          highScores = getHighScores();
          break;
        case 'bossAttack':
          triggerShake(2);
          bossFlash = true;
          setTimeout(() => { bossFlash = false; }, 200);
          break;
        case 'bossKill':
          audio.bossKill();
          addFloat('+100', ev.enemy.x, ev.enemy.y - 5, '#ffcc00');
          addFloat('BOSS DOWN!', 50, 30, '#ff6644');
          triggerShake(3);
          break;
        case 'weaknessHit':
          audio.weaknessHit();
          addFloat('WEAKNESS!', ev.enemy.x, ev.enemy.y - 8, '#ffd700');
          break;
        case 'crit':
          audio.crit();
          addFloat('CRIT!', ev.enemy.x, ev.enemy.y - 8, '#ffffff');
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
    waveSpawnQueue = [...config.enemies];
    waveSpawnTimer = config.enemies[0]?.delay || 0.5;

    // Boss system: if wave config says boss, spawn one
    if (config.boss) {
      spawnBoss(bf, bf.wave);
      audio.bossAppear();
    }

    // Track hostile count for wave announcement
    waveHostileCount = config.enemies.length + (config.boss ? 1 : 0);

    // Update music pulse
    audio.updatePulse(getMusicPulseFreq(bf.wave));

    waveAnnouncement = bf.wave;
    audio.waveStart();
    setTimeout(() => { waveAnnouncement = null; }, 2000);
    bf = bf;
  }

  function selectPerk(perk) {
    bf.perks.push(perk);
    audio.perkSelect();
    perkPhase = false;
    perkChoices = [];
    bf = bf;
    // Start next wave after 1s delay
    setTimeout(() => startNextWave(), 1000);
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
    waveHostileCount = 0;
    lastMatchElement = null;
    matchLineCells = [];
    matchLineElement = null;
    perkPhase = false;
    perkChoices = [];
    isNewBest = false;
    gridJitter = false;
    gridDimmed = false;
    gridBorderPulseColor = null;
    bossFlash = false;

    // Load high scores
    highScores = getHighScores();

    // Start background music pulse
    audio.startPulse(45);

    lastTime = performance.now();
    animFrame = requestAnimationFrame(gameLoop);
    setTimeout(() => startNextWave(), 2000);
  }

  // --- Grid interaction ---
  function selectTile(r, c) {
    if (processing || bf.gameOver || perkPhase) return;

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

      // Combo feedback: "+X COMBO" floating text on battlefield
      if (combo >= 2) {
        addFloat(`+${combo} COMBO`, 30, 25, '#ffcc00');
      }

      if (totalSize >= 4) {
        triggerShake(0.3);
        // Grid border pulse for big matches (4+ tiles)
        const pulseElement = matches[matches.length - 1].element;
        gridBorderPulseColor = ELEMENT_COLORS[pulseElement] || '#ffffff';
        setTimeout(() => { gridBorderPulseColor = null; }, 500);
      }

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
    // Splash skip with space/enter
    if (splashActive) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        skipSplash();
      }
      return;
    }

    if (bf.gameOver || processing || perkPhase) return;

    // Allow starting the game with Enter from title screen
    if (!gameStarted && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      startGame();
      return;
    }

    if (!gameStarted) return;

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

  // --- Boss HP derived ---
  let bossHpPercent = $derived(bf.boss ? Math.max(0, bf.boss.hp / bf.boss.maxHp * 100) : 0);

  // --- Grid glow derived ---
  let gridGlowColor = $derived(
    combo > 0 && lastMatchElement ? ELEMENT_COLORS[lastMatchElement] : null
  );

  // --- Combo glow gold at 3+ ---
  let comboGoldGlow = $derived(combo >= 3);

  // --- Enemy approach warning: any enemy at x < 25% ---
  let enemyApproaching = $derived(
    gameStarted && !bf.gameOver && bf.enemies.some(e => e.x < 25)
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

  // --- Enemy bob offset helper ---
  const BOB_SPEEDS = { grunt: 2.2, rusher: 1.6, tank: 3.0, shielded: 2.6, boss: 1.8 };
  function enemyBobVars(enemy) {
    const speed = BOB_SPEEDS[enemy.type] || 2.2;
    const offset = (enemy.id * 0.7) % 6.28; // pseudo-random phase offset per enemy
    return `--bob-speed: ${speed}s; --bob-offset: ${offset}s;`;
  }

  // --- Perk icon element helper ---
  function perkIconElement(perk) {
    return perk.element || null;
  }

  // --- Lifecycle ---
  onMount(() => {
    highScores = getHighScores();

    // Splash timers
    setTimeout(() => splashLine1 = true, 400);
    setTimeout(() => splashLine2 = true, 1400);
    setTimeout(() => splashLine3 = true, 2400);
    setTimeout(() => splashLine4 = true, 3400);
    setTimeout(() => skipSplash(), 5200);

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

  // Perk card border color helper
  function perkBorderColor(perk) {
    if (perk.element && ELEMENT_COLORS[perk.element]) {
      return ELEMENT_COLORS[perk.element];
    }
    return '#ffffff';
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="game" class:shaking class:boss-flash={bossFlash}>

  <!-- SPLASH SCREEN -->
  {#if splashActive}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="splash-screen" class:splash-fading={splashFading} onclick={skipSplash}>
      <div class="splash-glow"></div>
      <div class="splash-brand">
        {#if splashLine1}
          <p class="splash-studio" class:splash-visible={splashLine1}>adarkfable</p>
        {/if}
        {#if splashLine2}
          <p class="splash-or" class:splash-visible={splashLine2}>or</p>
        {/if}
        {#if splashLine3}
          <p class="splash-tale" class:splash-visible={splashLine3}>a cautionary tale</p>
        {/if}
        {#if splashLine4}
          <div class="splash-divider" class:splash-visible={splashLine4}></div>
          <p class="splash-presents" class:splash-visible={splashLine4}>presents</p>
        {/if}
      </div>
    </div>
  {/if}

  <!-- TITLE SCREEN OVERLAY -->
  {#if !gameStarted && !splashActive}
    <div class="title-overlay">
      <div class="title-content">
        <h1 class="title-logo">GRIDFIRE</h1>
        <p class="title-subtitle">MATCH. LOAD. FIRE.</p>
        <button class="title-start" onclick={startGame}>START</button>
        {#if highScores.totalGames > 0}
          <div class="title-best">
            <span>BEST: {highScores.bestScore.toLocaleString()}</span>
            <span>WAVE: {highScores.bestWave}</span>
          </div>
        {/if}
        <div class="title-credit">adarkfable</div>
      </div>
    </div>
  {/if}

  <!-- HUD -->
  <div class="hud">
    <div class="hud-score">
      <span class="hud-label">SCORE</span>
      <span class="hud-value">{bf.score.toLocaleString()}</span>
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
    <div class="combo-display" class:combo-big={combo >= 3}>
      COMBO x{combo}
    </div>
  {/if}

  <!-- Battlefield -->
  <div class="battlefield" class:enemy-approaching={enemyApproaching} bind:this={bfContainer}>
    <!-- Wave badge — always visible during gameplay -->
    {#if gameStarted && !bf.gameOver}
      <div class="wave-badge">
        {#if waveAnnouncement}
          WAVE {waveAnnouncement}
        {:else if bf.waveActive}
          WAVE {bf.wave}
        {:else if betweenWaves}
          GET READY
        {:else}
          WAVE {bf.wave}
        {/if}
      </div>
    {/if}

    <!-- Boss HP bar -->
    {#if bf.boss}
      <div class="boss-hp-bar-container">
        <div class="boss-hp-label">
          <span class="boss-hp-name">BOSS — WAVE {bf.wave}</span>
          <span class="boss-hp-pct">{Math.ceil(bossHpPercent)}%</span>
        </div>
        <div class="boss-hp-bar">
          <div
            class="boss-hp-fill"
            style="width: {bossHpPercent}%; background: {ELEMENT_COLORS[bf.boss.element] || '#ff6644'};"
          ></div>
        </div>
      </div>
    {/if}

    <!-- Parallax background layers -->
    <div class="parallax-far"></div>
    <div class="parallax-near"></div>

    <!-- Background silhouettes for depth -->
    <div class="bf-silhouettes">
      <div class="bf-sil bf-sil-1"></div>
      <div class="bf-sil bf-sil-2"></div>
      <div class="bf-sil bf-sil-3"></div>
    </div>

    <!-- Ground line and lane markers -->
    <div class="bf-lane">
      <div class="bf-ground"></div>
    </div>

    <!-- Player -->
    <div class="player" style="left: {bf.player.x / 100 * 100}%; top: {bf.player.y}%">
      <svg class="player-svg" viewBox="0 0 44 44" width="44" height="44">
        <!-- Multi-layer shield arcs (force field) -->
        <path d="M 7 6 Q 0 22 7 38" fill="none" stroke="var(--ice)" stroke-width="1.5" stroke-linecap="round" opacity="0.25" class="shield-arc shield-arc-1"/>
        <path d="M 9 9 Q 3 22 9 35" fill="none" stroke="var(--ice)" stroke-width="1.8" stroke-linecap="round" opacity="0.35" class="shield-arc shield-arc-2"/>
        <path d="M 11 12 Q 6 22 11 32" fill="none" stroke="var(--text-dim)" stroke-width="2" stroke-linecap="round" opacity="0.5" class="shield-arc shield-arc-3"/>
        <!-- Wider platform base -->
        <rect x="8" y="24" width="26" height="12" rx="3" ry="3" fill="var(--panel-light)" stroke="var(--text)" stroke-width="1.5"/>
        <line x1="10" y1="30" x2="32" y2="30" stroke="var(--text-dim)" stroke-width="0.8" opacity="0.3"/>
        <!-- Turret housing -->
        <rect x="14" y="14" width="14" height="14" rx="2" ry="2" fill="var(--panel-light)" stroke="var(--text)" stroke-width="1.5"/>
        <!-- Barrel with detail -->
        <rect x="28" y="17" width="13" height="7" rx="2" ry="2" fill="var(--text)" opacity="0.9"/>
        <line x1="30" y1="19" x2="30" y2="22" stroke="var(--panel)" stroke-width="0.8" opacity="0.5"/>
        <line x1="33" y1="19" x2="33" y2="22" stroke="var(--panel)" stroke-width="0.8" opacity="0.5"/>
        <!-- Muzzle tip glow -->
        <circle cx="41" cy="20.5" r="2.5" fill="var(--fire)" opacity="0.7" class="muzzle-glow"/>
        <circle cx="41" cy="20.5" r="4" fill="var(--fire)" opacity="0.15" class="muzzle-glow"/>
        <!-- Radar dish / antenna on top -->
        <line x1="21" y1="14" x2="21" y2="8" stroke="var(--text-dim)" stroke-width="1" stroke-linecap="round"/>
        <circle cx="21" cy="7" r="2" fill="none" stroke="var(--text-dim)" stroke-width="1" opacity="0.6"/>
        <circle cx="21" cy="7" r="0.8" fill="var(--text-dim)" opacity="0.8"/>
        <!-- Turret detail -->
        <line x1="16" y1="21" x2="26" y2="21" stroke="var(--text-dim)" stroke-width="1" opacity="0.4"/>
        <circle cx="21" cy="21" r="2" fill="var(--text)" opacity="0.5"/>
        <circle cx="21" cy="21" r="0.8" fill="var(--fire)" opacity="0.4"/>
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
        class:boss-enemy={enemy.type === 'boss'}
        style="
          left: {enemy.x}%;
          top: {enemy.y}%;
          --ecolor: {enemy.color};
          --esize: {enemy.size}px;
          {enemyBobVars(enemy)}
        "
      >
        <div class="enemy-hp-bar">
          <div class="enemy-hp-fill" style="width: {Math.max(0, enemy.hp / enemy.maxHp * 100)}%"></div>
        </div>
        <div class="enemy-body" style="width: {enemy.size}px; height: {enemy.size}px;">
          {#if enemy.type === 'boss'}
            <svg viewBox="0 0 20 20" width={enemy.size} height={enemy.size} class="enemy-svg">
              <!-- Crown spikes on top -->
              <polygon points="6,2 7,5 5,5" fill="var(--ecolor)" stroke="rgba(255,255,255,0.3)" stroke-width="0.4"/>
              <polygon points="10,0.5 11,4 9,4" fill="var(--ecolor)" stroke="rgba(255,255,255,0.4)" stroke-width="0.4"/>
              <polygon points="14,2 15,5 13,5" fill="var(--ecolor)" stroke="rgba(255,255,255,0.3)" stroke-width="0.4"/>
              <!-- Outer hexagon -->
              <polygon points="10,2 18.5,6 18.5,14 10,18 1.5,14 1.5,6" fill="var(--ecolor)" stroke="rgba(255,255,255,0.5)" stroke-width="1.2"/>
              <!-- Inner hexagon detail -->
              <polygon points="10,4.5 15.5,7 15.5,13 10,15.5 4.5,13 4.5,7" fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="0.5"/>
              <!-- Power lines -->
              <line x1="4.5" y1="10" x2="8" y2="10" stroke="rgba(255,255,255,0.15)" stroke-width="0.5"/>
              <line x1="12" y1="10" x2="15.5" y2="10" stroke="rgba(255,255,255,0.15)" stroke-width="0.5"/>
              <line x1="10" y1="4.5" x2="10" y2="7" stroke="rgba(255,255,255,0.15)" stroke-width="0.5"/>
              <line x1="10" y1="13" x2="10" y2="15.5" stroke="rgba(255,255,255,0.15)" stroke-width="0.5"/>
              <!-- Eyes with glow highlights -->
              <circle cx="7" cy="9" r="2.2" fill="rgba(0,0,0,0.7)"/>
              <circle cx="13" cy="9" r="2.2" fill="rgba(0,0,0,0.7)"/>
              <circle cx="7.5" cy="8.5" r="1" fill="rgba(255,100,100,0.7)"/>
              <circle cx="13.5" cy="8.5" r="1" fill="rgba(255,100,100,0.7)"/>
              <circle cx="7" cy="8.2" r="0.4" fill="rgba(255,255,255,0.8)"/>
              <circle cx="13" cy="8.2" r="0.4" fill="rgba(255,255,255,0.8)"/>
              <!-- Wide menacing grin -->
              <path d="M5.5 12.5 Q7 14 10 14.5 Q13 14 14.5 12.5" fill="none" stroke="rgba(0,0,0,0.6)" stroke-width="1" stroke-linecap="round"/>
              <path d="M6.5 12.8 L7.5 13.2 M9 13.5 L10 13.8 L11 13.5 M12.5 13.2 L13.5 12.8" fill="none" stroke="rgba(0,0,0,0.3)" stroke-width="0.4"/>
            </svg>
          {:else if enemy.type === 'grunt'}
            <svg viewBox="0 0 20 20" width={enemy.size} height={enemy.size} class="enemy-svg">
              <!-- Antenna/horn bumps on top -->
              <line x1="7" y1="2" x2="6" y2="0" stroke="var(--ecolor)" stroke-width="1.2" stroke-linecap="round"/>
              <circle cx="6" cy="0" r="0.6" fill="rgba(255,255,255,0.4)"/>
              <line x1="13.5" y1="2" x2="14.5" y2="0.5" stroke="var(--ecolor)" stroke-width="1" stroke-linecap="round"/>
              <circle cx="14.5" cy="0.5" r="0.5" fill="rgba(255,255,255,0.3)"/>
              <!-- Slightly asymmetric hexagon body -->
              <polygon points="10,1.5 18.2,5.8 18.8,14.2 10.2,19 1.5,14.5 1.2,5.5" fill="var(--ecolor)" stroke="rgba(255,255,255,0.3)" stroke-width="1.2"/>
              <!-- Body pattern lines -->
              <line x1="3" y1="9" x2="17" y2="9" stroke="rgba(255,255,255,0.12)" stroke-width="0.8"/>
              <line x1="2.5" y1="12" x2="17.5" y2="12" stroke="rgba(255,255,255,0.1)" stroke-width="0.8"/>
              <!-- Eyes -->
              <circle cx="7" cy="10" r="1.8" fill="rgba(0,0,0,0.6)"/>
              <circle cx="13" cy="10" r="1.8" fill="rgba(0,0,0,0.6)"/>
              <circle cx="7" cy="9.8" r="0.5" fill="rgba(255,255,255,0.4)"/>
              <circle cx="13" cy="9.8" r="0.5" fill="rgba(255,255,255,0.4)"/>
              <!-- Angry grimace mouth -->
              <path d="M7 14 L9 13.5 L11 14 L13 13.5" fill="none" stroke="rgba(0,0,0,0.5)" stroke-width="0.8" stroke-linecap="round"/>
            </svg>
          {:else if enemy.type === 'rusher'}
            <svg viewBox="0 0 20 20" width={enemy.size} height={enemy.size} class="enemy-svg">
              <!-- Speed lines trailing behind -->
              <line x1="16" y1="6" x2="20" y2="6" stroke="rgba(255,255,255,0.2)" stroke-width="0.6" stroke-linecap="round"/>
              <line x1="17" y1="10" x2="20" y2="10" stroke="rgba(255,255,255,0.25)" stroke-width="0.7" stroke-linecap="round"/>
              <line x1="16" y1="14" x2="20" y2="14" stroke="rgba(255,255,255,0.2)" stroke-width="0.6" stroke-linecap="round"/>
              <!-- Sharper chevron body -->
              <polygon points="0,10 7,2 13,2 19,10 13,18 7,18" fill="var(--ecolor)" stroke="rgba(255,255,255,0.25)" stroke-width="0.8"/>
              <!-- Jagged teeth at front -->
              <path d="M0,10 L2,8.5 L1,10 L2,11.5 Z" fill="rgba(255,255,255,0.2)"/>
              <line x1="0" y1="10" x2="3" y2="8" stroke="var(--ecolor)" stroke-width="0.6"/>
              <line x1="0" y1="10" x2="3" y2="12" stroke="var(--ecolor)" stroke-width="0.6"/>
              <!-- Leading edge highlights -->
              <line x1="0" y1="10" x2="5" y2="6" stroke="rgba(255,255,255,0.35)" stroke-width="0.8"/>
              <line x1="0" y1="10" x2="5" y2="14" stroke="rgba(255,255,255,0.35)" stroke-width="0.8"/>
              <!-- Single large angry eye -->
              <circle cx="10" cy="9" r="2.5" fill="rgba(0,0,0,0.7)"/>
              <circle cx="10.5" cy="8.5" r="1.2" fill="rgba(255,100,100,0.5)"/>
              <circle cx="10" cy="8.2" r="0.5" fill="rgba(255,255,255,0.6)"/>
              <!-- Angry brow line above eye -->
              <line x1="7.5" y1="6.5" x2="12.5" y2="5.5" stroke="rgba(0,0,0,0.4)" stroke-width="0.8" stroke-linecap="round"/>
            </svg>
          {:else if enemy.type === 'tank'}
            <svg viewBox="0 0 20 20" width={enemy.size} height={enemy.size} class="enemy-svg">
              <!-- Armored rectangle body -->
              <rect x="1" y="2" width="18" height="16" rx="3" ry="3" fill="var(--ecolor)" stroke="rgba(255,255,255,0.3)" stroke-width="1.2"/>
              <!-- Armor line (more prominent) -->
              <line x1="1" y1="10" x2="19" y2="10" stroke="rgba(255,255,255,0.25)" stroke-width="2"/>
              <!-- Rivet dots at corners -->
              <circle cx="3.5" cy="4.5" r="1" fill="rgba(255,255,255,0.25)"/>
              <circle cx="16.5" cy="4.5" r="1" fill="rgba(255,255,255,0.25)"/>
              <circle cx="3.5" cy="15.5" r="1" fill="rgba(255,255,255,0.25)"/>
              <circle cx="16.5" cy="15.5" r="1" fill="rgba(255,255,255,0.25)"/>
              <!-- Viewport slit instead of square eyes -->
              <rect x="4" y="5" width="12" height="2.5" rx="1" fill="rgba(0,0,0,0.4)"/>
              <rect x="5" y="5.5" width="10" height="1.5" rx="0.5" fill="rgba(255,200,200,0.2)"/>
              <!-- Cross-hatch armor on lower half -->
              <line x1="3" y1="12" x2="17" y2="16" stroke="rgba(255,255,255,0.08)" stroke-width="0.6"/>
              <line x1="3" y1="14" x2="17" y2="18" stroke="rgba(255,255,255,0.08)" stroke-width="0.6"/>
              <line x1="3" y1="16" x2="17" y2="12" stroke="rgba(255,255,255,0.08)" stroke-width="0.6"/>
              <line x1="3" y1="18" x2="17" y2="14" stroke="rgba(255,255,255,0.08)" stroke-width="0.6"/>
              <line x1="5" y1="11" x2="15" y2="11" stroke="rgba(255,255,255,0.06)" stroke-width="0.5"/>
            </svg>
          {:else if enemy.type === 'shielded'}
            <svg viewBox="0 0 20 20" width={enemy.size} height={enemy.size} class="enemy-svg">
              <circle cx="10" cy="10" r="7" fill="var(--ecolor)" stroke="rgba(255,255,255,0.25)" stroke-width="0.8"/>
              <!-- Flat eyebrows (determined expression) -->
              <line x1="5.5" y1="7" x2="8.5" y2="7.5" stroke="rgba(0,0,0,0.5)" stroke-width="0.8" stroke-linecap="round"/>
              <line x1="11.5" y1="7.5" x2="14.5" y2="7" stroke="rgba(0,0,0,0.5)" stroke-width="0.8" stroke-linecap="round"/>
              <!-- Eyes -->
              <circle cx="7.5" cy="9.5" r="1.5" fill="rgba(0,0,0,0.5)"/>
              <circle cx="12.5" cy="9.5" r="1.5" fill="rgba(0,0,0,0.5)"/>
              <circle cx="7.5" cy="9.3" r="0.5" fill="rgba(255,255,255,0.4)"/>
              <circle cx="12.5" cy="9.3" r="0.5" fill="rgba(255,255,255,0.4)"/>
              <!-- Small determined mouth -->
              <path d="M8.5 13 L10 12.5 L11.5 13" fill="none" stroke="rgba(0,0,0,0.4)" stroke-width="0.7" stroke-linecap="round"/>
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
        <!-- Weakness indicator dot -->
        {#if enemy.weakness && ELEMENT_COLORS[enemy.weakness]}
          <div class="enemy-weakness-dot" style="background: {ELEMENT_COLORS[enemy.weakness]}; box-shadow: 0 0 4px {ELEMENT_COLORS[enemy.weakness]};"></div>
        {/if}
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
      <div class="wave-announce">
        <span class="wave-announce-line-left"></span>
        <div class="wave-announce-text">
          <span class="wave-announce-title">WAVE {waveAnnouncement}</span>
          <span class="wave-announce-sub">{waveHostileCount} HOSTILE{waveHostileCount !== 1 ? 'S' : ''}</span>
        </div>
        <span class="wave-announce-line-right"></span>
      </div>
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

    <!-- Active perks tray -->
    {#if bf.perks.length > 0}
      <div class="perks-tray">
        {#each bf.perks as perk (perk.id)}
          <div
            class="perk-pip"
            style="color: {perk.element ? ELEMENT_COLORS[perk.element] || '#ffffff' : '#ffffff'};"
            title={perk.name}
          >
            {#if perk.element === 'fire'}
              <svg viewBox="0 0 20 20" width="16" height="16">
                <path d="M10 2 C10 2 6 7 6 11 C6 14 7.5 16 10 17 C12.5 16 14 14 14 11 C14 7 10 2 10 2Z" fill="currentColor" opacity="0.9"/>
              </svg>
            {:else if perk.element === 'ice'}
              <svg viewBox="0 0 20 20" width="16" height="16">
                <line x1="10" y1="2" x2="10" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                <line x1="3.1" y1="6" x2="16.9" y2="14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                <line x1="3.1" y1="14" x2="16.9" y2="6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              </svg>
            {:else if perk.element === 'lightning'}
              <svg viewBox="0 0 20 20" width="16" height="16">
                <polygon points="11,1 5,11 9,11 7,19 15,9 11,9 13,1" fill="currentColor"/>
              </svg>
            {:else if perk.element === 'kinetic'}
              <svg viewBox="0 0 20 20" width="16" height="16">
                <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="2" opacity="0.8"/>
                <circle cx="10" cy="10" r="4" fill="currentColor" opacity="0.9"/>
              </svg>
            {:else}
              <svg viewBox="0 0 20 20" width="16" height="16">
                <polygon points="10,1 12.5,7 19,8 14,12.5 15.5,19 10,15.5 4.5,19 6,12.5 1,8 7.5,7" fill="currentColor" opacity="0.9"/>
              </svg>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <!-- HUD bar between battlefield and grid -->
  <div class="bf-grid-hud-bar">
    <span class="hud-bar-title">GRIDFIRE</span>
    <span class="hud-bar-wave">{gameStarted ? `WAVE ${bf.wave}` : ''}</span>
  </div>

  <!-- Separator line between battlefield and grid -->
  <div class="bf-grid-separator"></div>

  <!-- Match-3 Grid -->
  <div
    class="grid-area"
    class:combo-glow={combo > 0 && gridGlowColor}
    class:combo-gold-glow={comboGoldGlow}
    class:grid-jitter={gridJitter}
    class:grid-dimmed={gridDimmed}
    class:grid-border-pulse={gridBorderPulseColor != null}
    style="{gridGlowColor ? `--glow-color: ${gridGlowColor};` : ''}{gridBorderPulseColor ? `--pulse-color: ${gridBorderPulseColor};` : ''}"
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
            disabled={processing || bf.gameOver || perkPhase || !gameStarted}
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

  <!-- Perk Selection Overlay -->
  {#if perkPhase}
    <div class="perk-overlay">
      <div class="perk-content">
        <h2 class="perk-title">CHOOSE A PERK</h2>
        <div class="perk-cards">
          {#each perkChoices as perk (perk.id)}
            <button
              class="perk-card"
              style="--perk-border: {perkBorderColor(perk)};"
              onclick={() => selectPerk(perk)}
            >
              {#if perk.element}
                <div class="perk-element-icon" style="color: {ELEMENT_COLORS[perk.element]};">
                  {#if perk.element === 'fire'}
                    <svg viewBox="0 0 20 20" width="24" height="24">
                      <path d="M10 2 C10 2 6 7 6 11 C6 14 7.5 16 10 17 C12.5 16 14 14 14 11 C14 7 10 2 10 2Z" fill="currentColor" opacity="0.9"/>
                    </svg>
                  {:else if perk.element === 'ice'}
                    <svg viewBox="0 0 20 20" width="24" height="24">
                      <line x1="10" y1="2" x2="10" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                      <line x1="3.1" y1="6" x2="16.9" y2="14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                      <line x1="3.1" y1="14" x2="16.9" y2="6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                    </svg>
                  {:else if perk.element === 'lightning'}
                    <svg viewBox="0 0 20 20" width="24" height="24">
                      <polygon points="11,1 5,11 9,11 7,19 15,9 11,9 13,1" fill="currentColor"/>
                    </svg>
                  {:else if perk.element === 'kinetic'}
                    <svg viewBox="0 0 20 20" width="24" height="24">
                      <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="2" opacity="0.8"/>
                      <circle cx="10" cy="10" r="4" fill="currentColor" opacity="0.9"/>
                    </svg>
                  {/if}
                </div>
              {/if}
              <span class="perk-name">{perk.name}</span>
              <span class="perk-desc">{perk.desc}</span>
            </button>
          {/each}
        </div>
      </div>
    </div>
  {/if}

  <!-- Game Over Overlay -->
  {#if bf.gameOver}
    <div class="game-over-overlay">
      <div class="game-over-box">
        <div class="go-game-title">GRIDFIRE</div>
        {#if isNewBest}
          <div class="new-best-banner">NEW BEST!</div>
        {/if}
        <h1 class="go-title">GAME OVER</h1>
        <div class="go-summary">Survived {bf.wave} waves with {bf.enemiesKilled} kills</div>
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
        {#if highScores.totalGames > 0}
          <div class="go-personal-best">
            <div class="go-pb-title">PERSONAL BEST</div>
            <div class="go-pb-stats">
              <div class="go-pb-stat">
                <span class="go-pb-label">BEST SCORE</span>
                <span class="go-pb-value">{highScores.bestScore.toLocaleString()}</span>
              </div>
              <div class="go-pb-stat">
                <span class="go-pb-label">BEST WAVE</span>
                <span class="go-pb-value">{highScores.bestWave}</span>
              </div>
              <div class="go-pb-stat">
                <span class="go-pb-label">BEST COMBO</span>
                <span class="go-pb-value">x{highScores.bestCombo}</span>
              </div>
            </div>
          </div>
        {/if}
        <button class="go-restart" onclick={restartGame}>PLAY AGAIN</button>
        <div class="go-credit">adarkfable</div>
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
  .game.boss-flash {
    animation: bossFlashAnim 0.2s ease-out;
  }
  @keyframes bossFlashAnim {
    0% { filter: brightness(1); }
    30% { filter: brightness(1.8) saturate(1.5); }
    100% { filter: brightness(1); }
  }

  /* =============================== TITLE SCREEN =============================== */
  .title-overlay {
    position: absolute;
    inset: 0;
    z-index: 100;
    background: rgba(0, 0, 0, 0.82);
    display: flex;
    align-items: center;
    justify-content: center;
    animation: fadeIn 0.6s ease-out;
  }
  .title-content {
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--s3);
  }
  .title-logo {
    font-size: 48px;
    color: var(--fire);
    letter-spacing: 8px;
    text-shadow:
      0 0 20px rgba(255, 102, 68, 0.6),
      0 0 40px rgba(255, 102, 68, 0.3),
      0 0 80px rgba(255, 102, 68, 0.15);
    animation: titlePulse 3s ease-in-out infinite;
  }
  @keyframes titlePulse {
    0%, 100% { text-shadow: 0 0 20px rgba(255, 102, 68, 0.6), 0 0 40px rgba(255, 102, 68, 0.3), 0 0 80px rgba(255, 102, 68, 0.15); }
    50% { text-shadow: 0 0 30px rgba(255, 102, 68, 0.8), 0 0 60px rgba(255, 102, 68, 0.4), 0 0 100px rgba(255, 102, 68, 0.2); }
  }
  .title-subtitle {
    font-size: var(--fs-sm);
    color: var(--text-dim);
    letter-spacing: 6px;
    margin-top: var(--s1);
  }
  .title-start {
    font-size: var(--fs-xl);
    padding: var(--s4) var(--s7);
    border: 2px solid var(--fire);
    color: var(--fire);
    letter-spacing: 6px;
    margin-top: var(--s5);
    background: var(--fire-dim);
    transition: all 0.2s var(--ease-out);
    cursor: pointer;
  }
  .title-start:hover {
    background: var(--fire);
    color: var(--bg);
    box-shadow: 0 0 30px rgba(255, 102, 68, 0.5);
  }
  .title-best {
    display: flex;
    gap: var(--s5);
    margin-top: var(--s3);
    font-size: var(--fs-xs);
    color: var(--text-dim);
    letter-spacing: 2px;
  }
  .title-credit {
    position: absolute;
    bottom: var(--s5);
    font-size: 9px;
    color: var(--text-dark);
    letter-spacing: 3px;
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
    transition: transform 0.15s ease;
  }
  .combo-display.combo-big {
    font-size: var(--fs-2xl, 1.8rem);
    transform: translateX(-50%) scale(1.3);
    text-shadow: 0 0 20px rgba(255, 170, 34, 0.8), 0 0 40px rgba(255, 170, 34, 0.4);
  }

  /* =============================== WAVE BADGE =============================== */
  .wave-badge {
    position: absolute;
    top: 6px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 16;
    font-size: var(--fs-xs);
    color: var(--text-dim);
    letter-spacing: 2px;
    padding: 2px 10px;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: rgba(0, 0, 0, 0.5);
    pointer-events: none;
    white-space: nowrap;
  }

  /* =============================== BOSS HP BAR =============================== */
  .boss-hp-bar-container {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    z-index: 18;
    padding: 4px 8px;
    background: rgba(0, 0, 0, 0.6);
    animation: bossBarAppear 0.5s ease-out;
  }
  @keyframes bossBarAppear {
    0% { opacity: 0; transform: translateY(-100%); }
    100% { opacity: 1; transform: translateY(0); }
  }
  .boss-hp-label {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 2px;
  }
  .boss-hp-name {
    font-size: var(--fs-xs);
    color: var(--fire);
    font-weight: bold;
    letter-spacing: 2px;
    text-shadow: 0 0 8px rgba(255, 102, 68, 0.5);
  }
  .boss-hp-pct {
    font-size: var(--fs-xs);
    color: var(--text-dim);
    font-weight: bold;
  }
  .boss-hp-bar {
    width: 100%;
    height: 8px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 4px;
    overflow: hidden;
    border: 1px solid rgba(255, 255, 255, 0.15);
  }
  .boss-hp-fill {
    height: 100%;
    border-radius: 3px;
    transition: width 0.2s linear;
    box-shadow: 0 0 8px currentColor;
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

  /* Enemy approach warning — red pulse on left edge */
  .battlefield.enemy-approaching::after {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    bottom: 0;
    width: 30px;
    z-index: 14;
    pointer-events: none;
    background: linear-gradient(90deg, rgba(255, 50, 30, 0.25) 0%, transparent 100%);
    animation: warningPulse 0.8s ease-in-out infinite;
  }
  @keyframes warningPulse {
    0%, 100% { opacity: 0.3; }
    50% { opacity: 1; }
  }

  /* --- Parallax background layers --- */
  .parallax-far {
    position: absolute;
    inset: 0;
    z-index: 0;
    pointer-events: none;
    opacity: 0.08;
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
    opacity: 0.12;
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

  /* --- Background silhouettes for depth --- */
  .bf-silhouettes {
    position: absolute;
    inset: 0;
    z-index: 0;
    pointer-events: none;
    overflow: hidden;
  }
  .bf-sil {
    position: absolute;
    bottom: 30%;
    background: rgba(255, 255, 255, 0.035);
  }
  .bf-sil-1 {
    right: 10%;
    width: 0;
    height: 0;
    border-left: 40px solid transparent;
    border-right: 35px solid transparent;
    border-bottom: 60px solid rgba(255, 255, 255, 0.04);
    background: none;
  }
  .bf-sil-2 {
    right: 25%;
    width: 0;
    height: 0;
    border-left: 55px solid transparent;
    border-right: 45px solid transparent;
    border-bottom: 80px solid rgba(255, 255, 255, 0.03);
    background: none;
  }
  .bf-sil-3 {
    right: 50%;
    width: 0;
    height: 0;
    border-left: 30px solid transparent;
    border-right: 50px solid transparent;
    border-bottom: 50px solid rgba(255, 255, 255, 0.035);
    background: none;
  }

  /* Lane view */
  .bf-lane { position: absolute; inset: 0; pointer-events: none; z-index: 1; }
  .bf-ground {
    position: absolute; left: 0; right: 0; top: 70%;
    height: 2px;
    background: linear-gradient(90deg, rgba(255,102,68,0.15), rgba(255,255,255,0.1), rgba(68,204,255,0.12), rgba(255,255,255,0.06), transparent);
    opacity: 0.7;
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
    animation: playerBreathe 3s ease-in-out infinite;
  }
  @keyframes playerBreathe {
    0%, 100% { transform: translate(-50%, -50%) scale(1); }
    50% { transform: translate(-50%, -50%) scale(1.03); }
  }
  .player-svg {
    display: block;
    filter: drop-shadow(0 0 6px rgba(255, 102, 68, 0.3));
  }
  /* Muzzle glow pulse */
  .muzzle-glow {
    animation: muzzlePulse 1.5s ease-in-out infinite;
  }
  @keyframes muzzlePulse {
    0%, 100% { opacity: 0.4; }
    50% { opacity: 0.9; }
  }
  /* Shield arc animations */
  .shield-arc-1 { animation: shieldArcPulse 2.5s ease-in-out infinite 0s; }
  .shield-arc-2 { animation: shieldArcPulse 2.5s ease-in-out infinite 0.4s; }
  .shield-arc-3 { animation: shieldArcPulse 2.5s ease-in-out infinite 0.8s; }
  @keyframes shieldArcPulse {
    0%, 100% { opacity: 0.15; }
    50% { opacity: 0.5; }
  }

  .player-hp-bar {
    width: 44px;
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

  /* =============================== ENEMIES =============================== */
  /* Enemy bob animation */
  @keyframes enemyBob {
    0%, 100% { transform: translate(-50%, -50%) translateY(0); }
    50% { transform: translate(-50%, -50%) translateY(-3px); }
  }
  .enemy {
    position: absolute;
    transform: translate(-50%, -50%);
    z-index: 3;
    transition: none;
    animation: enemyBob var(--bob-speed, 2.2s) ease-in-out infinite;
    animation-delay: var(--bob-offset, 0s);
  }
  .enemy.boss-enemy {
    z-index: 4;
    filter: drop-shadow(0 0 12px var(--ecolor));
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

  /* Weakness indicator dot */
  .enemy-weakness-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    margin-top: 2px;
    margin-left: auto;
    margin-right: auto;
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

  /* =============================== WAVE ANNOUNCEMENT =============================== */
  .wave-announce {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 15;
    animation: waveIn 2s var(--ease-out) forwards;
    pointer-events: none;
    display: flex;
    align-items: center;
    gap: var(--s4);
    width: 90%;
    max-width: 400px;
  }
  .wave-announce-line-left,
  .wave-announce-line-right {
    flex: 1;
    height: 2px;
    background: linear-gradient(90deg, transparent, rgba(255, 102, 68, 0.6));
  }
  .wave-announce-line-right {
    background: linear-gradient(90deg, rgba(255, 102, 68, 0.6), transparent);
  }
  .wave-announce-text {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    white-space: nowrap;
  }
  .wave-announce-title {
    font-size: var(--fs-3xl);
    font-weight: bold;
    color: var(--text);
    text-shadow:
      0 0 20px rgba(255, 102, 68, 0.6),
      0 0 40px rgba(255, 102, 68, 0.3),
      0 0 60px rgba(255, 102, 68, 0.15);
    letter-spacing: 4px;
  }
  .wave-announce-sub {
    font-size: var(--fs-sm);
    color: var(--fire);
    letter-spacing: 3px;
    opacity: 0.8;
    text-shadow: 0 0 10px rgba(255, 102, 68, 0.5);
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

  /* =============================== PERKS TRAY =============================== */
  .perks-tray {
    position: absolute;
    bottom: 6px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 12;
    display: flex;
    gap: 4px;
    pointer-events: none;
  }
  .perk-pip {
    width: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0.6;
    filter: drop-shadow(0 0 3px currentColor);
    pointer-events: auto;
    cursor: default;
  }
  .perk-pip svg {
    display: block;
  }

  /* =============================== HUD BAR =============================== */
  .bf-grid-hud-bar {
    height: 20px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 var(--s3);
    background: rgba(0, 0, 0, 0.4);
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
  }
  .hud-bar-title {
    font-size: 9px;
    color: var(--text-dark);
    letter-spacing: 3px;
    font-weight: bold;
  }
  .hud-bar-wave {
    font-size: 9px;
    color: var(--text-dark);
    letter-spacing: 2px;
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
    position: relative;
    background:
      /* Hex-grid pattern using conic gradients */
      repeating-conic-gradient(
        from 30deg at 50% 50%,
        rgba(255, 255, 255, 0.02) 0deg 60deg,
        transparent 60deg 120deg
      ),
      repeating-conic-gradient(
        from 0deg at calc(50% + 18px) calc(50% + 10px),
        rgba(255, 255, 255, 0.015) 0deg 60deg,
        transparent 60deg 120deg
      ),
      radial-gradient(ellipse at 50% 40%, rgba(255,255,255,0.03) 0%, transparent 60%),
      var(--bg);
    background-size: 36px 20px, 36px 20px, 100% 100%, 100% 100%;
    padding: var(--s3);
    border-top: 1px solid var(--border);
    transition: box-shadow 0.4s ease, opacity 0.15s ease, border-color 0.3s ease;
    /* Subtle always-on inner glow */
    box-shadow: inset 0 0 40px rgba(255, 255, 255, 0.02);
    animation: gridIdleGlow 4s ease-in-out infinite;
  }
  @keyframes gridIdleGlow {
    0%, 100% { box-shadow: inset 0 0 30px rgba(255, 255, 255, 0.015); }
    50% { box-shadow: inset 0 0 50px rgba(255, 255, 255, 0.04); }
  }
  /* Corner bracket pseudo-elements */
  .grid-area::before,
  .grid-area::after {
    content: '';
    position: absolute;
    width: 20px;
    height: 20px;
    border-color: rgba(255, 255, 255, 0.12);
    border-style: solid;
    pointer-events: none;
    z-index: 5;
  }
  .grid-area::before {
    top: 8px;
    left: 8px;
    border-width: 2px 0 0 2px;
  }
  .grid-area::after {
    bottom: 8px;
    right: 8px;
    border-width: 0 2px 2px 0;
  }

  .grid-area.combo-glow {
    box-shadow:
      inset 0 0 30px color-mix(in srgb, var(--glow-color, #ffffff) 20%, transparent),
      inset 0 0 60px color-mix(in srgb, var(--glow-color, #ffffff) 8%, transparent);
    animation: none;
  }
  .grid-area.combo-gold-glow {
    box-shadow:
      inset 0 0 30px rgba(255, 204, 0, 0.25),
      inset 0 0 60px rgba(255, 204, 0, 0.1);
    border-color: rgba(255, 204, 0, 0.5);
    animation: none;
  }
  .grid-area.grid-jitter {
    animation: gridJitterAnim 0.2s ease-out;
  }
  @keyframes gridJitterAnim {
    0% { transform: translate(0, 0); }
    20% { transform: translate(-2px, 1px); }
    40% { transform: translate(2px, -1px); }
    60% { transform: translate(-1px, 2px); }
    80% { transform: translate(1px, -1px); }
    100% { transform: translate(0, 0); }
  }
  .grid-area.grid-dimmed {
    opacity: 0.6;
  }
  .grid-area.grid-border-pulse {
    border-color: var(--pulse-color, #ffffff);
    box-shadow:
      inset 0 0 20px color-mix(in srgb, var(--pulse-color, #ffffff) 30%, transparent),
      0 0 15px color-mix(in srgb, var(--pulse-color, #ffffff) 20%, transparent);
    animation: none;
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

  /* =============================== TILE =============================== */
  .tile {
    position: relative;
    border-radius: 10px;
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
    overflow: hidden;
  }
  .tile:active:not(:disabled) {
    transform: scale(0.9);
  }

  /* Element colors — crisper borders, inner glow, more opaque backgrounds + drop shadow */
  .tile.fire {
    background: var(--fire-dim);
    color: var(--fire);
    border-color: rgba(255, 102, 68, 0.4);
    box-shadow: inset 0 0 8px rgba(255, 102, 68, 0.1), 0 2px 6px rgba(0, 0, 0, 0.3);
  }
  .tile.ice {
    background: var(--ice-dim);
    color: var(--ice);
    border-color: rgba(68, 204, 255, 0.4);
    box-shadow: inset 0 0 8px rgba(68, 204, 255, 0.1), 0 2px 6px rgba(0, 0, 0, 0.3);
  }
  .tile.lightning {
    background: var(--lightning-dim);
    color: var(--lightning);
    border-color: rgba(255, 221, 34, 0.4);
    box-shadow: inset 0 0 8px rgba(255, 221, 34, 0.1), 0 2px 6px rgba(0, 0, 0, 0.3);
  }
  .tile.kinetic {
    background: var(--kinetic-dim);
    color: var(--kinetic);
    border-color: rgba(221, 153, 255, 0.4);
    box-shadow: inset 0 0 8px rgba(221, 153, 255, 0.1), 0 2px 6px rgba(0, 0, 0, 0.3);
  }

  /* Tile inner texture patterns via ::before pseudo-elements */
  .tile.fire::before {
    content: '';
    position: absolute;
    inset: 0;
    opacity: 0.04;
    pointer-events: none;
    background: repeating-linear-gradient(
      45deg,
      transparent,
      transparent 3px,
      currentColor 3px,
      currentColor 4px
    );
    border-radius: 8px;
  }
  .tile.ice::before {
    content: '';
    position: absolute;
    inset: 0;
    opacity: 0.04;
    pointer-events: none;
    background: repeating-linear-gradient(
      0deg,
      transparent,
      transparent 4px,
      currentColor 4px,
      currentColor 5px
    );
    border-radius: 8px;
  }
  .tile.lightning::before {
    content: '';
    position: absolute;
    inset: 0;
    opacity: 0.04;
    pointer-events: none;
    background:
      repeating-linear-gradient(
        135deg,
        transparent,
        transparent 3px,
        currentColor 3px,
        currentColor 4px
      ),
      repeating-linear-gradient(
        45deg,
        transparent,
        transparent 3px,
        currentColor 3px,
        currentColor 4px
      );
    border-radius: 8px;
  }
  .tile.kinetic::before {
    content: '';
    position: absolute;
    inset: 0;
    opacity: 0.04;
    pointer-events: none;
    background:
      radial-gradient(circle at center, transparent 4px, currentColor 4px, currentColor 5px, transparent 5px),
      radial-gradient(circle at center, transparent 10px, currentColor 10px, currentColor 11px, transparent 11px),
      radial-gradient(circle at center, transparent 16px, currentColor 16px, currentColor 17px, transparent 17px);
    border-radius: 8px;
  }

  .tile-icon {
    pointer-events: none;
    filter: drop-shadow(0 0 4px currentColor);
  }
  .tile-icon-svg {
    pointer-events: none;
    filter: drop-shadow(0 0 4px currentColor);
    position: relative;
    z-index: 1;
  }

  /* Selected tile — sharper white border, stronger glow */
  .tile.selected {
    border-color: rgba(255, 255, 255, 1) !important;
    box-shadow: 0 0 16px rgba(255, 255, 255, 0.6), 0 0 4px rgba(255, 255, 255, 0.8), inset 0 0 10px rgba(255, 255, 255, 0.15);
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

  /* =============================== PERK OVERLAY =============================== */
  .perk-overlay {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.85);
    z-index: 60;
    display: flex;
    align-items: center;
    justify-content: center;
    animation: fadeIn 0.4s ease-out;
  }
  .perk-content {
    text-align: center;
    padding: var(--s4);
    max-width: 95%;
  }
  .perk-title {
    font-size: var(--fs-2xl, 1.8rem);
    color: var(--gold);
    letter-spacing: 4px;
    margin-bottom: var(--s5);
    text-shadow: 0 0 20px rgba(255, 204, 0, 0.5);
    animation: pop 0.5s var(--ease-bounce);
  }
  .perk-cards {
    display: flex;
    gap: var(--s3);
    justify-content: center;
    flex-wrap: wrap;
  }
  .perk-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--s2);
    width: 140px;
    padding: var(--s4) var(--s3);
    background: rgba(255, 255, 255, 0.05);
    border: 2px solid var(--perk-border, #ffffff);
    border-radius: 10px;
    cursor: pointer;
    transition: all 0.2s ease;
    color: var(--text);
  }
  .perk-card:hover {
    background: rgba(255, 255, 255, 0.12);
    transform: translateY(-4px);
    box-shadow: 0 0 20px color-mix(in srgb, var(--perk-border, #ffffff) 30%, transparent);
  }
  .perk-element-icon {
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    filter: drop-shadow(0 0 4px currentColor);
  }
  .perk-name {
    font-size: var(--fs-sm);
    font-weight: bold;
    color: var(--text);
    letter-spacing: 1px;
  }
  .perk-desc {
    font-size: var(--fs-xs);
    color: var(--text-dim);
    line-height: 1.4;
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
  .go-game-title {
    font-size: var(--fs-sm);
    color: var(--text-dark);
    letter-spacing: 4px;
    margin-bottom: var(--s2);
  }
  .new-best-banner {
    font-size: var(--fs-xl);
    color: var(--gold);
    font-weight: bold;
    letter-spacing: 4px;
    margin-bottom: var(--s3);
    text-shadow: 0 0 20px rgba(255, 204, 0, 0.6);
    animation: pop 0.6s var(--ease-bounce);
  }
  .go-title {
    font-size: var(--fs-3xl);
    color: var(--fire);
    letter-spacing: 6px;
    margin-bottom: var(--s3);
    text-shadow: 0 0 30px rgba(255, 102, 68, 0.5);
    animation: pop 0.5s var(--ease-bounce);
  }
  .go-summary {
    font-size: var(--fs-sm);
    color: var(--text-dim);
    margin-bottom: var(--s6);
    letter-spacing: 1px;
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
  .go-personal-best {
    margin-bottom: var(--s5);
    padding: var(--s3) var(--s4);
    border: 1px solid rgba(255, 204, 0, 0.2);
    border-radius: 8px;
    background: rgba(255, 204, 0, 0.03);
  }
  .go-pb-title {
    font-size: var(--fs-sm);
    color: var(--gold);
    letter-spacing: 2px;
    font-weight: bold;
    margin-bottom: var(--s2);
  }
  .go-pb-stats {
    display: flex;
    justify-content: space-around;
    gap: var(--s3);
  }
  .go-pb-stat {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .go-pb-label {
    font-size: 9px;
    color: var(--text-dim);
    letter-spacing: 0.5px;
  }
  .go-pb-value {
    font-size: var(--fs-sm);
    color: var(--text);
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
    box-shadow: 0 0 20px rgba(255, 102, 68, 0.4);
  }
  .go-credit {
    font-size: 9px;
    color: var(--text-dark);
    letter-spacing: 3px;
    margin-top: var(--s5);
  }
</style>
