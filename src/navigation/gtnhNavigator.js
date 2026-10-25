'use strict';

const { EventEmitter } = require('events');
const Vec3 = require('vec3');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const navigatePlugin = require('mineflayer-navigate');

const CARDINAL_OFFSETS = [
  new Vec3(1, 0, 0),
  new Vec3(-1, 0, 0),
  new Vec3(0, 1, 0),
  new Vec3(0, -1, 0),
  new Vec3(0, 0, 1),
  new Vec3(0, 0, -1)
];

const DEFAULT_HAZARD_BLOCK_NAMES = [
  'lava',
  'flowing_lava',
  'fire',
  'cactus',
  'web',
  'cobweb',
  'gt.blockfluid.pollution',
  'gt.blockfluid.acid',
  'oil',
  'fluid_oil',
  'poison_fluid'
];

/**
 * Spatial navigation & hazard-aware pathfinding wrapper tailored for Forge 1.7.10
 * and GregTech: New Horizons environmental constraints.
 */
class GTNHNavigator extends EventEmitter {
  /**
   * @param {import('mineflayer').Bot} bot
   * @param {Object} [options]
   * @param {number} [options.maxDropDown=3] - Maximum safe vertical drop (<=3 avoids fall damage & vertical shafts)
   * @param {number} [options.thinkTimeoutMs=6000]
   * @param {boolean} [options.canDigInWild=true]
   * @param {number} [options.pollutionThresholdGibbl=500000]
   */
  constructor(bot, options = {}) {
    super();
    this.bot = bot;
    this.options = {
      maxDropDown: options.maxDropDown ?? 3,
      thinkTimeoutMs: options.thinkTimeoutMs ?? 6000,
      canDigInWild: options.canDigInWild ?? true,
      pollutionThresholdGibbl: options.pollutionThresholdGibbl ?? 500000,
      lavaSafetyMargin: options.lavaSafetyMargin ?? 1
    };

    /** @type {Map<string, { chunkX: number, chunkZ: number, gibbl: number, updatedAt: number }>} */
    this.pollutedChunks = new Map();
    /** @type {Array<{ id: string, min: Vec3, max: Vec3, penalty: number }>} */
    this.pollutionZones = [];
    /** @type {Array<{ id: string, min: Vec3, max: Vec3 }>} */
    this.protectedStructures = [];
    /** @type {Set<string>} */
    this.liveWireCoords = new Set();

    this.movements = null;
    this._initialized = false;

    if (this.bot) {
      this._attachPlugins();
    }
  }

  _attachPlugins() {
    if (!this.bot.pathfinder && typeof this.bot.loadPlugin === 'function' && this.bot.registry) {
      this.bot.loadPlugin(pathfinder);
    }
    if (!this.bot.navigate && typeof this.bot.loadPlugin === 'function' && this.bot.registry) {
      try {
        this.bot.loadPlugin(navigatePlugin);
      } catch (_) {
        // mineflayer-navigate is optional fallback; mineflayer-pathfinder is primary
      }
    }
    if (this.bot.registry && this.bot.pathfinder) {
      this.configureMovements();
    } else if (typeof this.bot.once === 'function') {
      this.bot.once('inject_allowed', () => {
        if (!this.bot.pathfinder && typeof this.bot.loadPlugin === 'function') {
          this.bot.loadPlugin(pathfinder);
        }
      });
      this.bot.once('spawn', () => {
        if (this.bot.registry && this.bot.pathfinder && !this._initialized) {
          this.configureMovements();
        }
      });
    }
  }

  /**
   * Builds and applies GTNH-hardened `Movements` onto `bot.pathfinder`.
   */
  configureMovements() {
    if (!this.bot || !this.bot.registry) return null;

    const moves = new Movements(this.bot);
    moves.maxDropDown = this.options.maxDropDown;
    moves.infiniteLiquidDropdownDistance = false;
    moves.dontCreateFlow = true;
    moves.dontMineUnderFallingBlock = true;
    moves.allow1by1towers = false;
    moves.allowParkour = false; // Prevent risky jumps over shafts/ravines in GTNH
    moves.canDig = Boolean(this.options.canDigInWild);
    moves.digCost = 4;
    moves.liquidCost = 8;

    // Register hazardous vanilla + modded fluids/blocks into blocksToAvoid
    for (const blockName of DEFAULT_HAZARD_BLOCK_NAMES) {
      const entry = this.bot.registry.blocksByName?.[blockName];
      if (entry) {
        moves.blocksToAvoid.add(entry.id);
      }
    }

    // Protect chests, furnaces, and GregTech machine/cable blocks from accidental digging
    if (Array.isArray(this.bot.registry.blocksArray)) {
      for (const blk of this.bot.registry.blocksArray) {
        const lower = (blk.name || '').toLowerCase();
        if (
          lower.includes('chest') ||
          lower.includes('barrel') ||
          lower.includes('machine') ||
          lower.includes('casing') ||
          lower.includes('cable') ||
          lower.includes('pipe')
        ) {
          moves.blocksCantBreak.add(blk.id);
        }
      }
    }

    // Exclusion step callback: pollution clouds, uninsulated live wires, adjacent lava veins, vertical shafts
    moves.exclusionAreasStep.push((block) => this.evaluateStepPenalty(block));

    // Exclusion break callback: protected base structures & adjacent lava pockets
    moves.exclusionAreasBreak.push((block) => this.evaluateBreakPenalty(block));

    // Exclusion place callback: never place scaffolding inside protected multiblock footprints
    moves.exclusionAreasPlace.push((block) => this.evaluatePlacePenalty(block));

    this.movements = moves;
    if (this.bot.pathfinder && typeof this.bot.pathfinder.setMovements === 'function') {
      this.bot.pathfinder.thinkTimeout = this.options.thinkTimeoutMs;
      this.bot.pathfinder.setMovements(moves);
    }
    this._initialized = true;
    return moves;
  }

  /**
   * Computes pathfinding step cost penalty for a candidate foot/body block.
   * Returning >= 100 treats the node as impassable in mineflayer-pathfinder.
   * @param {{ position: Vec3 }} block
   * @returns {number}
   */
  evaluateStepPenalty(block) {
    if (!block || !block.position) return 0;
    const pos = block.position;
    let penalty = 0;

    // 1. Live uninsulated GregTech wires cause severe electrocution damage
    const key = coordKey(pos.x, pos.y, pos.z);
    const belowKey = coordKey(pos.x, pos.y - 1, pos.z);
    if (this.liveWireCoords.has(key) || this.liveWireCoords.has(belowKey)) {
      return 1000;
    }

    // 2. Chunk-level GTNH pollution clouds (gibbl concentration)
    const chunkX = Math.floor(pos.x / 16);
    const chunkZ = Math.floor(pos.z / 16);
    const chunkData = this.pollutedChunks.get(`${chunkX},${chunkZ}`);
    if (chunkData && chunkData.gibbl >= this.options.pollutionThresholdGibbl) {
      // Scale above 100 when lethal (>750k gibbl), high avoidance cost between 500k-750k
      penalty += chunkData.gibbl >= 750000 ? 500 : 80;
    }

    // 3. Explicit 3D pollution cloud bounding boxes
    for (const zone of this.pollutionZones) {
      if (isInsideAABB(pos, zone.min, zone.max)) {
        penalty += zone.penalty;
      }
    }

    // 4. Lava vein proximity check
    if (this.options.lavaSafetyMargin > 0 && this.hasAdjacentLava(pos)) {
      penalty += 200;
    }

    // 5. High-drop vertical shaft detection beneath non-solid blocks
    if (this.isOverDeepShaft(pos, this.options.maxDropDown + 1)) {
      return 1000;
    }

    return penalty;
  }

  /**
   * Computes break penalty for candidate blocks. Protected base structures and
   * blocks holding back lava return infinite/impassable weight.
   */
  evaluateBreakPenalty(block) {
    if (!block || !block.position) return 0;
    const pos = block.position;

    for (const struct of this.protectedStructures) {
      if (isInsideAABB(pos, struct.min, struct.max)) {
        return 1000;
      }
    }

    if (this.hasAdjacentLava(pos)) {
      return 1000;
    }

    return 0;
  }

  evaluatePlacePenalty(block) {
    if (!block || !block.position) return 0;
    const pos = block.position;
    for (const struct of this.protectedStructures) {
      if (isInsideAABB(pos, struct.min, struct.max)) {
        return 1000;
      }
    }
    return 0;
  }

  /**
   * Checks whether any 6-connected neighbor of `pos` is lava or flowing_lava.
   * @param {Vec3} pos
   * @returns {boolean}
   */
  hasAdjacentLava(pos) {
    if (!this.bot || typeof this.bot.blockAt !== 'function') return false;
    for (const offset of CARDINAL_OFFSETS) {
      const neighbor = this.bot.blockAt(pos.plus(offset));
      if (!neighbor) continue;
      const name = (neighbor.name || '').toLowerCase();
      if (name === 'lava' || name === 'flowing_lava') {
        return true;
      }
    }
    return false;
  }

  /**
   * Checks if `pos` has an unbroken vertical drop exceeding `minVoidDepth` blocks
   * (or terminating in lava).
   * @param {Vec3} pos
   * @param {number} minVoidDepth
   * @returns {boolean}
   */
  isOverDeepShaft(pos, minVoidDepth = 4) {
    if (!this.bot || typeof this.bot.blockAt !== 'function') return false;

    const footBlock = this.bot.blockAt(pos);
    const groundBlock = this.bot.blockAt(pos.offset(0, -1, 0));
    if (groundBlock && this.isSolidSupport(groundBlock)) {
      return false;
    }
    if (footBlock && (footBlock.name === 'ladder' || footBlock.name === 'vine')) {
      return false;
    }

    let airRun = 0;
    for (let dy = 1; dy <= minVoidDepth + 1; dy++) {
      const below = this.bot.blockAt(pos.offset(0, -dy, 0));
      if (!below) break;
      const name = (below.name || '').toLowerCase();
      if (name === 'lava' || name === 'flowing_lava') {
        return true;
      }
      if (this.isSolidSupport(below)) {
        return false;
      }
      airRun++;
      if (airRun > this.options.maxDropDown) {
        return true;
      }
    }
    return false;
  }

  isSolidSupport(block) {
    if (!block) return false;
    const name = (block.name || '').toLowerCase();
    if (name === 'air' || name === 'cave_air' || name === 'void_air') return false;
    if (name.includes('water') || name.includes('lava')) return false;
    if (block.boundingBox) return block.boundingBox === 'block';
    return block.type !== 0;
  }

  /**
   * Records or updates pollution concentration (gibbl) for a 16x16 chunk.
   */
  recordChunkPollution(chunkX, chunkZ, gibbl) {
    const key = `${chunkX},${chunkZ}`;
    if (gibbl <= 0) {
      this.pollutedChunks.delete(key);
    } else {
      this.pollutedChunks.set(key, {
        chunkX,
        chunkZ,
        gibbl,
        updatedAt: Date.now()
      });
    }
    this.emit('pollutionUpdated', { chunkX, chunkZ, gibbl });
  }

  /**
   * Registers an explicit 3D pollution cloud AABB to avoid during pathfinding.
   */
  addPollutionZone(id, minPos, maxPos, penalty = 500) {
    const min = toMinVec(minPos, maxPos);
    const max = toMaxVec(minPos, maxPos);
    this.pollutionZones = this.pollutionZones.filter((z) => z.id !== id);
    this.pollutionZones.push({ id, min, max, penalty });
  }

  /**
   * Registers a protected multiblock or base footprint AABB so pathfinder digging
   * never breaks casings, hatches, pipes, or chests.
   */
  registerProtectedStructure(id, minPos, maxPos) {
    const min = toMinVec(minPos, maxPos);
    const max = toMaxVec(minPos, maxPos);
    this.protectedStructures = this.protectedStructures.filter((s) => s.id !== id);
    this.protectedStructures.push({ id, min, max });
  }

  registerLiveWire(pos) {
    const p = toVec3(pos).floored();
    this.liveWireCoords.add(coordKey(p.x, p.y, p.z));
  }

  unregisterLiveWire(pos) {
    const p = toVec3(pos).floored();
    this.liveWireCoords.delete(coordKey(p.x, p.y, p.z));
  }

  /**
   * 3D Amanatides-Woo Voxel DDA Raycaster.
   * Traces a ray from `origin` along `direction` up to `maxDistance` blocks and returns
   * the first solid block intersected along with its hit face normal.
   *
   * @param {Vec3} origin
   * @param {Vec3} direction - Normalized or non-zero direction vector
   * @param {number} [maxDistance=5.0]
   * @returns {{ block: any, position: Vec3, face: Vec3, distance: number } | null}
   */
  raycastVoxel(origin, direction, maxDistance = 5.0) {
    if (!this.bot || typeof this.bot.blockAt !== 'function') return null;

    const dirLen = Math.sqrt(
      direction.x * direction.x +
      direction.y * direction.y +
      direction.z * direction.z
    );
    if (dirLen < 1e-9) return null;

    const dx = direction.x / dirLen;
    const dy = direction.y / dirLen;
    const dz = direction.z / dirLen;

    let x = Math.floor(origin.x);
    let y = Math.floor(origin.y);
    let z = Math.floor(origin.z);

    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;

    const tDeltaX = stepX !== 0 ? Math.abs(1 / dx) : Infinity;
    const tDeltaY = stepY !== 0 ? Math.abs(1 / dy) : Infinity;
    const tDeltaZ = stepZ !== 0 ? Math.abs(1 / dz) : Infinity;

    let tMaxX = stepX > 0 ? (x + 1 - origin.x) * tDeltaX : stepX < 0 ? (origin.x - x) * tDeltaX : Infinity;
    let tMaxY = stepY > 0 ? (y + 1 - origin.y) * tDeltaY : stepY < 0 ? (origin.y - y) * tDeltaY : Infinity;
    let tMaxZ = stepZ > 0 ? (z + 1 - origin.z) * tDeltaZ : stepZ < 0 ? (origin.z - z) * tDeltaZ : Infinity;

    let t = 0;
    let lastFace = new Vec3(0, 1, 0);

    for (let i = 0; i < 128 && t <= maxDistance; i++) {
      const pos = new Vec3(x, y, z);
      const block = this.bot.blockAt(pos);
      if (block && this.isSolidSupport(block)) {
        return {
          block,
          position: pos,
          face: lastFace,
          distance: t
        };
      }

      if (tMaxX < tMaxY) {
        if (tMaxX < tMaxZ) {
          t = tMaxX;
          tMaxX += tDeltaX;
          x += stepX;
          lastFace = new Vec3(-stepX, 0, 0);
        } else {
          t = tMaxZ;
          tMaxZ += tDeltaZ;
          z += stepZ;
          lastFace = new Vec3(0, 0, -stepZ);
        }
      } else if (tMaxY < tMaxZ) {
        t = tMaxY;
        tMaxY += tDeltaY;
        y += stepY;
        lastFace = new Vec3(0, -stepY, 0);
      } else {
        t = tMaxZ;
        tMaxZ += tDeltaZ;
        z += stepZ;
        lastFace = new Vec3(0, 0, -stepZ);
      }
    }

    return null;
  }

  /**
   * Checks whether `targetBlockPos` has unobstructed line-of-sight from `eyePos`
   * (or the bot's current eye position).
   */
  hasLineOfSight(targetBlockPos, eyePos = null, maxReach = 4.5) {
    const target = toVec3(targetBlockPos).floored();
    const eye = eyePos
      ? toVec3(eyePos)
      : this.bot?.entity?.position
        ? this.bot.entity.position.offset(0, 1.62, 0)
        : null;
    if (!eye) return false;

    const targetCenter = target.offset(0.5, 0.5, 0.5);
    const delta = targetCenter.minus(eye);
    const dist = eye.distanceTo(targetCenter);
    if (dist > maxReach + 0.75) return false;

    const hit = this.raycastVoxel(eye, delta, dist + 0.5);
    if (!hit) return true; // Target itself is air (e.g. placement target) and nothing obstructed ray!
    return (
      hit.position.x === target.x &&
      hit.position.y === target.y &&
      hit.position.z === target.z
    );
  }

  /**
   * Computes valid collision-free standing coordinates within reach (`[1.5, maxReach]`)
   * of `targetPos` so the bot never stands inside the block it is about to place!
   */
  findSafePlacementStandPositions(targetPos, maxReach = 4.0) {
    const target = toVec3(targetPos).floored();
    const candidates = [];
    const r = Math.ceil(maxReach);

    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dy = -2; dy <= 2; dy++) {
          const stand = target.offset(dx, dy, dz);
          // Do not overlap bot's 2-block hitbox [stand, stand + (0,1,0)] with targetPos
          if (
            stand.x === target.x &&
            stand.z === target.z &&
            (stand.y === target.y || stand.y + 1 === target.y)
          ) {
            continue;
          }

          const eye = stand.offset(0.5, 1.62, 0.5);
          const dist = eye.distanceTo(target.offset(0.5, 0.5, 0.5));
          if (dist < 1.3 || dist > maxReach) continue;

          if (this.bot && typeof this.bot.blockAt === 'function') {
            const ground = this.bot.blockAt(stand.offset(0, -1, 0));
            const feet = this.bot.blockAt(stand);
            const head = this.bot.blockAt(stand.offset(0, 1, 0));
            if (!ground || !this.isSolidSupport(ground)) continue;
            if ((feet && this.isSolidSupport(feet)) || (head && this.isSolidSupport(head))) continue;
            if (this.evaluateStepPenalty({ position: stand }) >= 100) continue;
          }

          candidates.push({ position: stand, distance: dist });
        }
      }
    }

    candidates.sort((a, b) => a.distance - b.distance);
    return candidates;
  }

  /**
   * Navigates within `range` blocks of `pos` using `mineflayer-pathfinder`.
   */
  async gotoPosition(pos, range = 2, timeoutMs = 30000) {
    const target = toVec3(pos);
    if (!this.bot?.pathfinder) {
      throw new Error('Pathfinder plugin is not initialized on bot instance');
    }
    if (!this._initialized) {
      this.configureMovements();
    }

    const goal = range <= 0
      ? new goals.GoalBlock(target.x, target.y, target.z)
      : new goals.GoalNear(target.x, target.y, target.z, range);

    return this._runGoalWithTimeout(goal, timeoutMs);
  }

  /**
   * Navigates directly adjacent to an interactive block (chest, GT machine, hatch).
   */
  async gotoBlockAdjacent(pos, timeoutMs = 30000) {
    const target = toVec3(pos).floored();
    if (!this.bot?.pathfinder) {
      throw new Error('Pathfinder plugin is not initialized on bot instance');
    }
    if (!this._initialized) {
      this.configureMovements();
    }

    const goal = new goals.GoalNear(target.x, target.y, target.z, 3);
    return this._runGoalWithTimeout(goal, timeoutMs);
  }

  /**
   * Navigates to a safe, non-overlapping placement position with clear reach to `targetPos`.
   */
  async gotoPlacementPose(targetPos, maxReach = 4.0, timeoutMs = 30000) {
    const target = toVec3(targetPos).floored();
    if (this.bot?.entity?.position) {
      const botFeet = this.bot.entity.position.floored();
      const overlaps =
        botFeet.x === target.x &&
        botFeet.z === target.z &&
        (botFeet.y === target.y || botFeet.y + 1 === target.y);
      const eye = this.bot.entity.position.offset(0, 1.62, 0);
      const dist = eye.distanceTo(target.offset(0.5, 0.5, 0.5));
      if (!overlaps && dist <= maxReach && this.hasLineOfSight(target, eye, maxReach)) {
        return botFeet;
      }
    }

    const standCandidates = this.findSafePlacementStandPositions(target, maxReach);
    if (standCandidates.length > 0 && this.bot?.pathfinder?.goto) {
      const compositeGoals = standCandidates
        .slice(0, 8)
        .map((c) => new goals.GoalBlock(c.position.x, c.position.y, c.position.z));
      const goal = new goals.GoalCompositeAny(compositeGoals);
      await this._runGoalWithTimeout(goal, timeoutMs);
      return this.bot.entity?.position?.floored() || standCandidates[0].position;
    }

    if (this.bot?.world && this.bot?.pathfinder?.goto) {
      const placeGoal = new goals.GoalPlaceBlock(target, this.bot.world, {
        range: maxReach,
        LOS: true
      });
      await this._runGoalWithTimeout(placeGoal, timeoutMs);
      return this.bot.entity?.position?.floored() || target;
    }

    return this.gotoPosition(target, 3, timeoutMs);
  }

  /**
   * Computes an escape goal moving at least `safeDistance` blocks away from a hazard/entity.
   */
  async retreatFromPoint(hazardPos, safeDistance = 16, timeoutMs = 15000) {
    const origin = toVec3(hazardPos);
    if (!this.bot?.pathfinder) return null;
    if (!this._initialized) {
      this.configureMovements();
    }

    const invertedGoal = new goals.GoalInvert(
      new goals.GoalNear(origin.x, origin.y, origin.z, safeDistance)
    );
    return this._runGoalWithTimeout(invertedGoal, timeoutMs);
  }

  stop() {
    if (this.bot?.pathfinder && typeof this.bot.pathfinder.setGoal === 'function') {
      this.bot.pathfinder.setGoal(null);
    }
  }

  async _runGoalWithTimeout(goal, timeoutMs) {
    if (typeof this.bot.pathfinder.goto !== 'function') {
      this.bot.pathfinder.setGoal(goal);
      return;
    }

    let timer = null;
    try {
      await Promise.race([
        this.bot.pathfinder.goto(goal),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            this.stop();
            reject(new Error(`Navigation goal timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function toVec3(p) {
  if (p instanceof Vec3) return p;
  if (Array.isArray(p)) return new Vec3(p[0], p[1], p[2]);
  return new Vec3(Number(p.x) || 0, Number(p.y) || 0, Number(p.z) || 0);
}

function toMinVec(a, b) {
  const va = toVec3(a);
  const vb = toVec3(b);
  return new Vec3(Math.min(va.x, vb.x), Math.min(va.y, vb.y), Math.min(va.z, vb.z));
}

function toMaxVec(a, b) {
  const va = toVec3(a);
  const vb = toVec3(b);
  return new Vec3(Math.max(va.x, vb.x), Math.max(va.y, vb.y), Math.max(va.z, vb.z));
}

function isInsideAABB(pos, min, max) {
  return (
    pos.x >= min.x && pos.x <= max.x &&
    pos.y >= min.y && pos.y <= max.y &&
    pos.z >= min.z && pos.z <= max.z
  );
}

function coordKey(x, y, z) {
  return `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
}

module.exports = {
  GTNHNavigator,
  CARDINAL_OFFSETS,
  DEFAULT_HAZARD_BLOCK_NAMES,
  toVec3,
  coordKey
};
