/**
 * Battlefield engine — manages enemies, projectiles, and collisions.
 * Pure logic with state objects. Rendering handled by Svelte.
 */

let nextId = 1;

export const ELEMENT_COLORS = {
  fire: '#ff5533',
  ice: '#33bbff',
  lightning: '#ffcc00',
  kinetic: '#cc88ff',
};

export const ELEMENT_EFFECTS = {
  fire: 'burn',       // DOT
  ice: 'slow',        // reduce speed
  lightning: 'chain',  // hits nearby
  kinetic: 'knockback', // pushes back
};

export function createBattlefield() {
  return {
    enemies: [],
    projectiles: [],
    particles: [],
    player: { x: 8, y: 50, hp: 100, maxHp: 100, alive: true },
    score: 0,
    combo: 0,
    maxCombo: 0,
    wave: 0,
    waveTimer: 0,
    waveActive: false,
    enemiesKilled: 0,
    gameOver: false,
  };
}

/** Spawn an enemy on the right side */
export function spawnEnemy(bf, type = 'grunt') {
  const templates = {
    grunt:    { hp: 3, maxHp: 3, speed: 0.3, size: 18, color: '#aa4444', points: 10 },
    rusher:   { hp: 1, maxHp: 1, speed: 0.7, size: 14, color: '#dd6622', points: 15 },
    tank:     { hp: 8, maxHp: 8, speed: 0.15, size: 24, color: '#664444', points: 25 },
    shielded: { hp: 5, maxHp: 5, speed: 0.25, size: 20, color: '#446666', points: 20, shield: 'ice' },
  };
  const t = templates[type] || templates.grunt;
  const y = 15 + Math.random() * 70; // random vertical position (% of battlefield height)
  bf.enemies.push({
    id: nextId++,
    type,
    x: 105, // start off-screen right (%)
    y,
    ...t,
    effects: [], // active status effects
    flashTimer: 0,
  });
}

/** Fire projectiles from matches */
export function fireProjectiles(bf, projectileList) {
  for (const p of projectileList) {
    const count = p.type === 'double' ? 2 : p.type === 'spread' ? 3 : p.type === 'mega' ? 5 : 1;
    const isBlast = p.type === 'blast';

    for (let i = 0; i < count; i++) {
      const spread = count > 1 ? (i - (count - 1) / 2) * 8 : 0;
      bf.projectiles.push({
        id: nextId++,
        x: 8,
        y: 50 + spread,
        speed: isBlast ? 3 : 2,
        element: p.element,
        damage: p.damage,
        isBlast,
        size: isBlast ? 10 : p.type === 'mega' ? 8 : 5,
      });
    }
  }
}

/** Main update tick — call at 60fps. dt in seconds. */
export function updateBattlefield(bf, dt) {
  if (bf.gameOver) return [];

  const events = [];

  // Update projectiles
  for (let i = bf.projectiles.length - 1; i >= 0; i--) {
    const p = bf.projectiles[i];
    p.x += p.speed * dt * 60;

    // Off screen
    if (p.x > 110) {
      bf.projectiles.splice(i, 1);
      continue;
    }

    // Blast hits everything
    if (p.isBlast) {
      for (const e of bf.enemies) {
        applyDamage(bf, e, p.damage, p.element, events);
      }
      spawnExplosionParticles(bf, p.x, p.y, p.element, 12);
      bf.projectiles.splice(i, 1);
      continue;
    }

    // Check collision with enemies
    for (const e of bf.enemies) {
      const dist = Math.hypot(p.x - e.x, p.y - e.y);
      if (dist < (e.size / 2 + p.size / 2) * 0.15) {
        applyDamage(bf, e, p.damage, p.element, events);
        spawnHitParticles(bf, e.x, e.y, p.element, 6);
        bf.projectiles.splice(i, 1);

        // Lightning chain
        if (p.element === 'lightning') {
          const nearby = bf.enemies.filter(other =>
            other !== e && other.hp > 0 && Math.hypot(other.x - e.x, other.y - e.y) < 15
          );
          if (nearby.length > 0) {
            applyDamage(bf, nearby[0], 1, 'lightning', events);
            spawnHitParticles(bf, nearby[0].x, nearby[0].y, 'lightning', 3);
            events.push({ type: 'chain', from: e, to: nearby[0] });
          }
        }
        break;
      }
    }
  }

  // Update enemies
  for (let i = bf.enemies.length - 1; i >= 0; i--) {
    const e = bf.enemies[i];

    // Flash timer
    if (e.flashTimer > 0) e.flashTimer -= dt;

    // Speed modifier from effects
    let speedMod = 1;
    if (e.effects.includes('slow')) speedMod = 0.4;

    // Knockback
    if (e.effects.includes('knockback')) {
      e.x += 0.5 * dt * 60;
      e.effects = e.effects.filter(ef => ef !== 'knockback');
    }

    // Move left
    e.x -= e.speed * speedMod * dt * 60;

    // Burn DOT
    if (e.effects.includes('burn')) {
      e.hp -= 0.5 * dt;
      if (Math.random() < 0.1) spawnHitParticles(bf, e.x, e.y, 'fire', 1);
    }

    // Decay effects
    e.effects = e.effects.filter(ef => {
      if (ef === 'slow' && Math.random() < dt * 0.5) return false;
      if (ef === 'burn' && Math.random() < dt * 0.3) return false;
      return true;
    });

    // Dead
    if (e.hp <= 0) {
      bf.score += e.points;
      bf.enemiesKilled++;
      spawnExplosionParticles(bf, e.x, e.y, null, 8);
      events.push({ type: 'kill', enemy: e });
      bf.enemies.splice(i, 1);
      continue;
    }

    // Reached the player
    if (e.x < 5) {
      bf.player.hp -= 10;
      events.push({ type: 'playerHit', damage: 10 });
      bf.enemies.splice(i, 1);
      if (bf.player.hp <= 0) {
        bf.player.alive = false;
        bf.gameOver = true;
        events.push({ type: 'gameOver' });
      }
    }
  }

  // Update particles
  for (let i = bf.particles.length - 1; i >= 0; i--) {
    const p = bf.particles[i];
    p.x += p.vx * dt * 60;
    p.y += p.vy * dt * 60;
    p.life -= dt;
    p.vy += 0.02 * dt * 60; // gravity
    if (p.life <= 0) bf.particles.splice(i, 1);
  }

  return events;
}

function applyDamage(bf, enemy, damage, element, events) {
  // Shield check
  if (enemy.shield && enemy.shield === element) {
    events.push({ type: 'shielded', enemy });
    return;
  }

  enemy.hp -= damage;
  enemy.flashTimer = 0.15;

  // Apply element effect
  const effect = ELEMENT_EFFECTS[element];
  if (effect && !enemy.effects.includes(effect)) {
    enemy.effects.push(effect);
  }

  events.push({ type: 'hit', enemy, damage, element });
}

function spawnHitParticles(bf, x, y, element, count) {
  const color = ELEMENT_COLORS[element] || '#ffffff';
  for (let i = 0; i < count; i++) {
    bf.particles.push({
      id: nextId++,
      x, y,
      vx: (Math.random() - 0.5) * 1.5,
      vy: (Math.random() - 0.5) * 1.5,
      life: 0.3 + Math.random() * 0.3,
      maxLife: 0.6,
      color,
      size: 2 + Math.random() * 3,
    });
  }
}

function spawnExplosionParticles(bf, x, y, element, count) {
  const color = element ? ELEMENT_COLORS[element] : '#ffffff';
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    const speed = 0.5 + Math.random() * 1;
    bf.particles.push({
      id: nextId++,
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 0.4 + Math.random() * 0.4,
      maxLife: 0.8,
      color,
      size: 3 + Math.random() * 4,
    });
  }
}

/** Get wave config — escalating difficulty */
export function getWaveConfig(waveNum) {
  const configs = [];
  const base = Math.min(waveNum, 20);

  // More enemies per wave
  const count = 3 + Math.floor(base * 0.8);

  for (let i = 0; i < count; i++) {
    const roll = Math.random();
    let type = 'grunt';
    if (waveNum >= 3 && roll > 0.7) type = 'rusher';
    if (waveNum >= 5 && roll > 0.85) type = 'tank';
    if (waveNum >= 7 && roll > 0.9) type = 'shielded';

    configs.push({ type, delay: i * (0.8 - Math.min(base * 0.03, 0.5)) });
  }

  return configs;
}
