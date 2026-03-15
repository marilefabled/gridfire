/**
 * Battlefield engine — manages enemies, projectiles, collisions, bosses, and perks.
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

// Elemental weakness chart: key is weak TO value
export const WEAKNESSES = {
  fire: 'ice',        // fire enemies weak to ice
  ice: 'lightning',   // ice enemies weak to lightning
  lightning: 'kinetic', // lightning enemies weak to kinetic
  kinetic: 'fire',    // kinetic enemies weak to fire
};

export const PERK_POOL = [
  { id: 'fire_dmg', name: 'Inferno Rounds', desc: 'Fire matches deal +50% damage', element: 'fire', stat: 'damage', value: 1.5 },
  { id: 'ice_dur', name: 'Deep Freeze', desc: 'Ice slow lasts twice as long', element: 'ice', stat: 'duration', value: 2 },
  { id: 'light_chain', name: 'Arc Conductor', desc: 'Lightning chains to 2 extra enemies', element: 'lightning', stat: 'chain', value: 2 },
  { id: 'kinetic_push', name: 'Impact Force', desc: 'Kinetic knockback is 3x stronger', element: 'kinetic', stat: 'knockback', value: 3 },
  { id: 'heal_match4', name: 'Siphon', desc: 'Matches of 4+ heal 5 HP', element: null, stat: 'heal', value: 5 },
  { id: 'combo_score', name: 'Momentum', desc: 'Combo multiplier gives 2x score bonus', element: null, stat: 'comboScore', value: 2 },
  { id: 'all_dmg', name: 'Overcharge', desc: 'All projectiles deal +1 damage', element: null, stat: 'allDamage', value: 1 },
  { id: 'hp_regen', name: 'Nano Repair', desc: 'Regenerate 1 HP every 5 seconds', element: null, stat: 'regen', value: 1 },
  { id: 'blast_size', name: 'Wide Blast', desc: '5-match blasts deal +2 damage', element: null, stat: 'blastDamage', value: 2 },
  { id: 'crit', name: 'Precision', desc: '15% chance for double damage on any hit', element: null, stat: 'crit', value: 0.15 },
];

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
    boss: null,        // active boss or null
    perks: [],         // collected perks
    regenTimer: 0,     // for HP regen perk
  };
}

/** Check if player has a specific perk */
export function hasPerk(bf, perkId) {
  return bf.perks.some(p => p.id === perkId);
}

function getPerkValue(bf, perkId) {
  const p = bf.perks.find(p => p.id === perkId);
  return p ? p.value : 0;
}

/** Get 3 random perks for selection (no duplicates of what's owned) */
export function rollPerks(bf) {
  const owned = new Set(bf.perks.map(p => p.id));
  const available = PERK_POOL.filter(p => !owned.has(p.id));
  const shuffled = available.sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(3, shuffled.length));
}

/** Spawn an enemy on the right side — single lane with slight jitter */
export function spawnEnemy(bf, type = 'grunt', elementOverride = null) {
  const templates = {
    grunt:    { hp: 3, maxHp: 3, speed: 0.12, size: 18, color: '#aa4444', points: 10 },
    rusher:   { hp: 1, maxHp: 1, speed: 0.25, size: 14, color: '#dd6622', points: 15 },
    tank:     { hp: 8, maxHp: 8, speed: 0.06, size: 24, color: '#664444', points: 25 },
    shielded: { hp: 5, maxHp: 5, speed: 0.1, size: 20, color: '#446666', points: 20, shield: 'ice' },
  };
  const t = templates[type] || templates.grunt;

  // Assign an elemental affinity (visible weakness) — more common in later waves
  const elements = ['fire', 'ice', 'lightning', 'kinetic'];
  const element = elementOverride || (Math.random() < 0.5 ? elements[Math.floor(Math.random() * elements.length)] : null);
  const weakness = element ? WEAKNESSES[element] : null;

  // Color tint based on element
  const elementTints = {
    fire: '#cc5533',
    ice: '#3388aa',
    lightning: '#aa8822',
    kinetic: '#8855aa',
  };

  const y = 50 + (Math.random() - 0.5) * 16;
  bf.enemies.push({
    id: nextId++,
    type,
    x: 105,
    y,
    ...t,
    color: element ? elementTints[element] : t.color,
    element,       // what element this enemy IS (null = neutral)
    weakness,      // what element deals bonus damage
    effects: [],
    flashTimer: 0,
  });
}

/** Spawn a boss enemy */
export function spawnBoss(bf, waveNum) {
  const tier = Math.floor(waveNum / 5); // boss tier scales
  const element = ['fire', 'ice', 'lightning', 'kinetic'][(tier - 1) % 4];
  const weakness = WEAKNESSES[element];

  bf.boss = {
    id: nextId++,
    type: 'boss',
    x: 85,
    y: 50,
    hp: 20 + tier * 10,
    maxHp: 20 + tier * 10,
    speed: 0.03,
    size: 36,
    color: ELEMENT_COLORS[element],
    element,
    weakness,
    effects: [],
    flashTimer: 0,
    points: 100 + tier * 50,
    attackTimer: 3,    // seconds between attacks
    attackCooldown: 3,
    shield: null,
  };
  bf.enemies.push(bf.boss);
}

/** Fire projectiles from matches */
export function fireProjectiles(bf, projectileList) {
  for (const p of projectileList) {
    const count = p.type === 'double' ? 2 : p.type === 'spread' ? 3 : p.type === 'mega' ? 5 : 1;
    const isBlast = p.type === 'blast';

    // Perk: heal on 4+ matches
    if ((p.type === 'double' || p.type === 'spread' || p.type === 'blast' || p.type === 'mega') && hasPerk(bf, 'heal_match4')) {
      bf.player.hp = Math.min(bf.player.maxHp, bf.player.hp + getPerkValue(bf, 'heal_match4'));
    }

    // Perk: bonus blast damage
    let damage = p.damage;
    if (isBlast && hasPerk(bf, 'blast_size')) {
      damage += getPerkValue(bf, 'blast_size');
    }

    // Perk: all damage bonus
    if (hasPerk(bf, 'all_dmg')) {
      damage += getPerkValue(bf, 'all_dmg');
    }

    // Perk: element-specific damage boost
    if (hasPerk(bf, 'fire_dmg') && p.element === 'fire') {
      damage = Math.ceil(damage * getPerkValue(bf, 'fire_dmg'));
    }

    for (let i = 0; i < count; i++) {
      const spread = count > 1 ? (i - (count - 1) / 2) * 5 : 0;
      bf.projectiles.push({
        id: nextId++,
        x: 12,
        y: 50 + spread,
        speed: isBlast ? 2 : 1.2,
        element: p.element,
        damage,
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

  // HP regen perk
  if (hasPerk(bf, 'hp_regen')) {
    bf.regenTimer += dt;
    if (bf.regenTimer >= 5) {
      bf.regenTimer -= 5;
      bf.player.hp = Math.min(bf.player.maxHp, bf.player.hp + getPerkValue(bf, 'hp_regen'));
      events.push({ type: 'regen' });
    }
  }

  // Boss attack timer
  if (bf.boss && bf.boss.hp > 0) {
    bf.boss.attackTimer -= dt;
    if (bf.boss.attackTimer <= 0) {
      bf.boss.attackTimer = bf.boss.attackCooldown;
      // Boss attacks the player
      bf.player.hp -= 5;
      events.push({ type: 'bossAttack', damage: 5 });
      if (bf.player.hp <= 0) {
        bf.player.alive = false;
        bf.gameOver = true;
        events.push({ type: 'gameOver' });
      }
    }
  }

  // Update projectiles
  for (let i = bf.projectiles.length - 1; i >= 0; i--) {
    const p = bf.projectiles[i];
    p.x += p.speed * dt * 60;

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
      const hitRadius = (e.size / 2 + p.size / 2) * (e.type === 'boss' ? 0.3 : 0.2);
      if (dist < hitRadius) {
        applyDamage(bf, e, p.damage, p.element, events);
        spawnHitParticles(bf, e.x, e.y, p.element, 6);
        bf.projectiles.splice(i, 1);

        // Lightning chain
        if (p.element === 'lightning') {
          const chainCount = 1 + (hasPerk(bf, 'light_chain') ? getPerkValue(bf, 'light_chain') : 0);
          const nearby = bf.enemies
            .filter(other => other !== e && other.hp > 0 && Math.hypot(other.x - e.x, other.y - e.y) < 20)
            .slice(0, chainCount);
          for (const target of nearby) {
            applyDamage(bf, target, 1, 'lightning', events);
            spawnHitParticles(bf, target.x, target.y, 'lightning', 3);
            events.push({ type: 'chain', from: e, to: target });
          }
        }
        break;
      }
    }
  }

  // Update enemies
  for (let i = bf.enemies.length - 1; i >= 0; i--) {
    const e = bf.enemies[i];

    if (e.flashTimer > 0) e.flashTimer -= dt;

    let speedMod = 1;
    if (e.effects.includes('slow')) {
      const slowDur = hasPerk(bf, 'ice_dur') ? 0.25 : 0.5;
      speedMod = 0.4;
      // Slower decay when Deep Freeze perk is active
      e.effects = e.effects.filter(ef => {
        if (ef === 'slow' && Math.random() < dt * slowDur) return false;
        return ef !== 'slow' ? true : true;
      });
    }

    // Knockback
    if (e.effects.includes('knockback')) {
      const pushForce = hasPerk(bf, 'kinetic_push') ? getPerkValue(bf, 'kinetic_push') : 1;
      e.x += 0.5 * pushForce * dt * 60;
      e.effects = e.effects.filter(ef => ef !== 'knockback');
    }

    // Move left (bosses move slower)
    e.x -= e.speed * speedMod * dt * 60;

    // Burn DOT
    if (e.effects.includes('burn')) {
      e.hp -= 0.5 * dt;
      if (Math.random() < 0.1) spawnHitParticles(bf, e.x, e.y, 'fire', 1);
    }

    // Decay effects (except slow handled above)
    e.effects = e.effects.filter(ef => {
      if (ef === 'burn' && Math.random() < dt * 0.3) return false;
      return true;
    });

    // Dead
    if (e.hp <= 0) {
      // Score with combo multiplier
      let scoreBonus = e.points;
      if (bf.combo > 1) {
        const comboMult = hasPerk(bf, 'combo_score') ? getPerkValue(bf, 'combo_score') : 1;
        scoreBonus = Math.floor(e.points * (1 + (bf.combo - 1) * 0.25 * comboMult));
      }
      bf.score += scoreBonus;
      bf.enemiesKilled++;
      spawnExplosionParticles(bf, e.x, e.y, e.element, e.type === 'boss' ? 20 : 8);
      events.push({ type: 'kill', enemy: e, score: scoreBonus });

      // Boss killed
      if (e.type === 'boss') {
        bf.boss = null;
        events.push({ type: 'bossKill', enemy: e });
      }

      bf.enemies.splice(i, 1);
      continue;
    }

    // Reached the player
    if (e.x < 5) {
      const damage = e.type === 'boss' ? 25 : 10;
      bf.player.hp -= damage;
      events.push({ type: 'playerHit', damage });
      bf.enemies.splice(i, 1);
      if (e.type === 'boss') bf.boss = null;
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
    p.vy += 0.02 * dt * 60;
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

  let finalDamage = damage;

  // Weakness bonus — 2x damage
  if (enemy.weakness && enemy.weakness === element) {
    finalDamage = Math.ceil(damage * 2);
    events.push({ type: 'weaknessHit', enemy, element });
  }

  // Crit perk
  if (hasPerk(bf, 'crit') && Math.random() < getPerkValue(bf, 'crit')) {
    finalDamage *= 2;
    events.push({ type: 'crit', enemy });
  }

  enemy.hp -= finalDamage;
  enemy.flashTimer = 0.15;

  const effect = ELEMENT_EFFECTS[element];
  if (effect && !enemy.effects.includes(effect)) {
    enemy.effects.push(effect);
  }

  events.push({ type: 'hit', enemy, damage: finalDamage, element });
}

function spawnHitParticles(bf, x, y, element, count) {
  const color = ELEMENT_COLORS[element] || '#ffffff';
  for (let i = 0; i < count; i++) {
    bf.particles.push({
      id: nextId++, x, y,
      vx: (Math.random() - 0.5) * 1.5,
      vy: (Math.random() - 0.5) * 1.5,
      life: 0.3 + Math.random() * 0.3, maxLife: 0.6,
      color, size: 2 + Math.random() * 3,
    });
  }
}

function spawnExplosionParticles(bf, x, y, element, count) {
  const color = element ? ELEMENT_COLORS[element] : '#ffffff';
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    const speed = 0.5 + Math.random() * 1;
    bf.particles.push({
      id: nextId++, x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 0.4 + Math.random() * 0.4, maxLife: 0.8,
      color, size: 3 + Math.random() * 4,
    });
  }
}

/** Get wave config — escalating difficulty, boss every 5 waves */
export function getWaveConfig(waveNum) {
  const isBossWave = waveNum % 5 === 0 && waveNum > 0;

  if (isBossWave) {
    // Boss wave: just the boss + a couple escorts
    return {
      enemies: [
        { type: 'grunt', delay: 0 },
        { type: 'grunt', delay: 1 },
      ],
      boss: true,
    };
  }

  const configs = [];
  const base = Math.min(waveNum, 20);
  const count = 3 + Math.floor(base * 0.8);

  for (let i = 0; i < count; i++) {
    const roll = Math.random();
    let type = 'grunt';
    if (waveNum >= 3 && roll > 0.7) type = 'rusher';
    if (waveNum >= 5 && roll > 0.85) type = 'tank';
    if (waveNum >= 7 && roll > 0.9) type = 'shielded';

    configs.push({ type, delay: i * (1.5 - Math.min(base * 0.04, 0.8)) });
  }

  return { enemies: configs, boss: false };
}

/** Procedural bass pulse — returns oscillator frequency based on wave */
export function getMusicPulseFreq(waveNum) {
  return 40 + Math.min(waveNum * 2, 30);
}
