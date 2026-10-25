'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const Vec3 = require('vec3');
const {
  ForgeRegistryBridge,
  normalizeItemId
} = require('./protocol/forgeHandshake');

const HORIZONTAL_FACINGS = ['NORTH', 'EAST', 'SOUTH', 'WEST'];

/**
 * Minecraft 1.7.10 / 1.8 `block_place` packet face direction indices:
 * 0 = -Y (Bottom), 1 = +Y (Top), 2 = -Z (North), 3 = +Z (South), 4 = -X (West), 5 = +X (East)
 */
const PLACE_FACES = [
  { dirIndex: 1, refOffset: new Vec3(0, -1, 0), normal: new Vec3(0, 1, 0), name: 'top' },
  { dirIndex: 0, refOffset: new Vec3(0, 1, 0), normal: new Vec3(0, -1, 0), name: 'bottom' },
  { dirIndex: 3, refOffset: new Vec3(0, 0, -1), normal: new Vec3(0, 0, 1), name: 'south' },
  { dirIndex: 2, refOffset: new Vec3(0, 0, 1), normal: new Vec3(0, 0, -1), name: 'north' },
  { dirIndex: 5, refOffset: new Vec3(-1, 0, 0), normal: new Vec3(1, 0, 0), name: 'east' },
  { dirIndex: 4, refOffset: new Vec3(1, 0, 0), normal: new Vec3(-1, 0, 0), name: 'west' }
];

const SPECIALIZED_HATCH_ROLES = new Set([
  'input_hatch',
  'input_bus',
  'output_hatch',
  'output_bus',
  'maintenance_hatch',
  'energy_hatch',
  'dynamo_hatch',
  'muffler_hatch'
]);

const ROLE_BUILD_PRIORITY = Object.freeze({
  casing: 1,
  frame: 1,
  coil: 2,
  glass: 2,
  input_bus: 3,
  input_hatch: 3,
  output_bus: 3,
  output_hatch: 3,
  energy_hatch: 4,
  dynamo_hatch: 4,
  maintenance_hatch: 4,
  muffler_hatch: 5,
  controller: 6
});

/**
 * Rotates an anchor-relative `(dx, dy, dz)` vector authored in `canonicalFacing`
 * (`'NORTH'`, where front face points toward `-Z` and depth extends toward `+Z`)
 * into `targetFacing` (`'NORTH'|'EAST'|'SOUTH'|'WEST'`).
 */
function rotateRelativeOffset(offset, canonicalFacing = 'NORTH', targetFacing = 'NORTH') {
  const fromIdx = HORIZONTAL_FACINGS.indexOf(String(canonicalFacing).toUpperCase());
  const toIdx = HORIZONTAL_FACINGS.indexOf(String(targetFacing).toUpperCase());
  const steps = (((toIdx === -1 ? 0 : toIdx) - (fromIdx === -1 ? 0 : fromIdx)) % 4 + 4) % 4;

  let x = offset.x;
  const y = offset.y;
  let z = offset.z;

  // Clockwise 90-degree rotation in Minecraft XZ plane (NORTH -Z -> EAST +X -> SOUTH +Z -> WEST -X):
  // (x, z) -> (-z, x)
  for (let i = 0; i < steps; i++) {
    const nextX = -z;
    const nextZ = x;
    x = nextX;
    z = nextZ;
  }

  return new Vec3(x, y, z);
}

/**
 * Resolves a semantic block-local facing ('front', 'back', 'west', 'east', 'up', 'down')
 * into a world cardinal direction given the multiblock's overall `targetFacing`.
 */
function resolveWorldBlockFacing(semanticFacing, targetFacing = 'NORTH') {
  if (!semanticFacing) return null;
  const lower = String(semanticFacing).toLowerCase();
  if (lower === 'up' || lower === 'down') return lower.toUpperCase();

  const baseIdx = HORIZONTAL_FACINGS.indexOf(String(targetFacing).toUpperCase());
  const idx = baseIdx === -1 ? 0 : baseIdx;

  switch (lower) {
    case 'front':
    case 'north':
      return HORIZONTAL_FACINGS[idx];
    case 'east':
    case 'right':
      return HORIZONTAL_FACINGS[(idx + 1) % 4];
    case 'back':
    case 'south':
      return HORIZONTAL_FACINGS[(idx + 2) % 4];
    case 'west':
    case 'left':
      return HORIZONTAL_FACINGS[(idx + 3) % 4];
    default:
      return lower.toUpperCase();
  }
}

/**
 * 3D Structural Blueprint Parser & Spatial Multiblock Printer for GregTech: New Horizons.
 */
class MultiblockBuilder extends EventEmitter {
  /**
   * @param {Object} [options]
   * @param {import('mineflayer').Bot|null} [options.bot]
   * @param {import('./navigation/gtnhNavigator').GTNHNavigator|null} [options.navigator]
   * @param {import('./craftingEngine').CraftingEngine|null} [options.craftingEngine]
   * @param {import('./craftingEngine').WarehouseTracker|null} [options.warehouse]
   * @param {ForgeRegistryBridge} [options.registryBridge]
   */
  constructor(options = {}) {
    super();
    this.bot = options.bot || null;
    this.navigator = options.navigator || null;
    this.craftingEngine = options.craftingEngine || null;
    this.warehouse =
      options.warehouse ||
      (this.craftingEngine ? this.craftingEngine.warehouse : null);
    this.registryBridge =
      options.registryBridge ||
      (this.craftingEngine ? this.craftingEngine.registryBridge : new ForgeRegistryBridge());

    this.blueprints = new Map();
    this.activeBuildCheckpoint = null;
    this.placementPacketLog = [];
  }

  /**
   * Loads a 3D multiblock JSON schematic from disk and caches it by `blueprintId`.
   */
  loadBlueprintFromFile(filePath) {
    const resolved = path.resolve(filePath);
    const raw = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    return this.registerBlueprint(raw);
  }

  /**
   * Parses and validates a Litematica/Schematica-style 3D matrix blueprint or voxel list.
   */
  registerBlueprint(rawBlueprint) {
    const parsed = this.parseBlueprint(rawBlueprint);
    this.blueprints.set(parsed.blueprintId, parsed);
    return parsed;
  }

  /**
   * Parses a raw JSON blueprint into anchor-relative 3D voxel descriptors and bill-of-materials.
   */
  parseBlueprint(raw) {
    if (!raw || typeof raw !== 'object') {
      throw new TypeError('Blueprint must be a valid JSON object');
    }

    const blueprintId = raw.blueprintId || raw.name || 'unnamed_multiblock';
    const canonicalFacing = (raw.canonicalFacing || 'NORTH').toUpperCase();
    const anchorIdx = raw.anchorGridIndex || { x: 0, y: 0, z: 0 };
    const palette = raw.palette || {};
    const voxels = [];

    if (Array.isArray(raw.layers)) {
      for (let layerPos = 0; layerPos < raw.layers.length; layerPos++) {
        const layer = raw.layers[layerPos];
        const yGrid = layer.yIndex ?? layerPos;
        const matrix = layer.matrix || [];

        for (let zGrid = 0; zGrid < matrix.length; zGrid++) {
          const row = matrix[zGrid];
          const cells = typeof row === 'string' ? row.split('') : row;
          for (let xGrid = 0; xGrid < cells.length; xGrid++) {
            const symbol = cells[xGrid];
            if (symbol === null || symbol === undefined || symbol === ' ') continue;

            const entry = palette[symbol];
            if (!entry) {
              throw new Error(
                `Blueprint '${blueprintId}' references undefined palette symbol '${symbol}' at grid (${xGrid}, ${yGrid}, ${zGrid})`
              );
            }

            const relOffset = new Vec3(
              xGrid - anchorIdx.x,
              yGrid - anchorIdx.y,
              zGrid - anchorIdx.z
            );

            voxels.push({
              symbol,
              gridIndex: new Vec3(xGrid, yGrid, zGrid),
              relativeOffset: relOffset,
              itemId: normalizeItemId(entry.itemId),
              blockName: entry.blockName || entry.itemId.split(':')[1] || 'air',
              metadata: entry.metadata ?? 0,
              role: entry.role || 'casing',
              facing: entry.facing || null,
              voltageTier: entry.voltageTier || null,
              sneakPlace: Boolean(entry.sneakPlace || SPECIALIZED_HATCH_ROLES.has(entry.role) || entry.role === 'controller'),
              label: entry.label || entry.itemId
            });
          }
        }
      }
    } else if (Array.isArray(raw.voxels)) {
      for (const v of raw.voxels) {
        const off = Array.isArray(v.offset)
          ? new Vec3(v.offset[0], v.offset[1], v.offset[2])
          : new Vec3(v.offset.x, v.offset.y, v.offset.z);
        voxels.push({
          symbol: v.symbol || '#',
          gridIndex: off.clone(),
          relativeOffset: off,
          itemId: normalizeItemId(v.itemId),
          blockName: v.blockName || v.itemId.split(':')[1] || 'air',
          metadata: v.metadata ?? 0,
          role: v.role || 'casing',
          facing: v.facing || null,
          voltageTier: v.voltageTier || null,
          sneakPlace: Boolean(v.sneakPlace || SPECIALIZED_HATCH_ROLES.has(v.role) || v.role === 'controller'),
          label: v.label || v.itemId
        });
      }
    } else {
      throw new Error(`Blueprint '${blueprintId}' must define either 'layers' or 'voxels'`);
    }

    const billOfMaterials = new Map();
    const roleCounts = {};
    for (const v of voxels) {
      roleCounts[v.role] = (roleCounts[v.role] || 0) + 1;
      if (v.role !== 'air') {
        billOfMaterials.set(v.itemId, (billOfMaterials.get(v.itemId) || 0) + 1);
      }
    }

    const parsed = {
      blueprintId,
      displayName: raw.displayName || blueprintId,
      era: raw.era || 'STEAM_TIER',
      dimensions: raw.dimensions || null,
      canonicalFacing,
      anchorGridIndex: anchorIdx,
      gtnhConstraints: raw.gtnhConstraints || {},
      voxels,
      billOfMaterials: Object.fromEntries(billOfMaterials),
      roleCounts
    };

    const validation = this.validateBlueprintStructure(parsed);
    if (!validation.valid) {
      throw new Error(
        `Invalid GTNH Multiblock Blueprint '${blueprintId}': ${validation.errors.join('; ')}`
      );
    }

    return parsed;
  }

  /**
   * Validates GTNH structural constraints: controller at anchor `[0,0,0]`, required
   * specialized hatches present, and minimum casing count respected.
   */
  validateBlueprintStructure(parsedBlueprint) {
    const errors = [];
    const controllers = parsedBlueprint.voxels.filter((v) => v.role === 'controller');

    if (controllers.length !== 1) {
      errors.push(`Expected exactly 1 controller block, found ${controllers.length}`);
    } else {
      const c = controllers[0].relativeOffset;
      if (c.x !== 0 || c.y !== 0 || c.z !== 0) {
        errors.push(
          `Controller must sit at anchor relative [0, 0, 0], found [${c.x}, ${c.y}, ${c.z}]`
        );
      }
    }

    const constraints = parsedBlueprint.gtnhConstraints || {};
    if (Array.isArray(constraints.requiredRoles)) {
      for (const reqRole of constraints.requiredRoles) {
        if (!parsedBlueprint.roleCounts[reqRole]) {
          errors.push(`Missing required GTNH hatch/structural role '${reqRole}'`);
        }
      }
    }

    if (Number.isFinite(constraints.minCasings)) {
      const actualCasings = parsedBlueprint.roleCounts.casing || 0;
      if (actualCasings < constraints.minCasings) {
        errors.push(
          `Insufficient casings: blueprint has ${actualCasings}, GTNH minimum is ${constraints.minCasings}`
        );
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Projects a parsed blueprint onto concrete world coordinates anchored at `anchorPos`
   * with cardinal orientation `targetFacing` ('NORTH', 'EAST', 'SOUTH', 'WEST').
   */
  projectToWorld(blueprintOrId, anchorPos, targetFacing = 'NORTH') {
    const bp = typeof blueprintOrId === 'string'
      ? this.blueprints.get(blueprintOrId)
      : blueprintOrId;
    if (!bp) {
      throw new Error(`Unknown blueprint '${blueprintOrId}'`);
    }

    const anchor = anchorPos instanceof Vec3
      ? anchorPos.floored()
      : new Vec3(anchorPos.x, anchorPos.y, anchorPos.z).floored();

    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;

    const cells = bp.voxels.map((voxel) => {
      const rotated = rotateRelativeOffset(
        voxel.relativeOffset,
        bp.canonicalFacing,
        targetFacing
      );
      const worldPos = anchor.plus(rotated);
      const worldFacing = resolveWorldBlockFacing(voxel.facing, targetFacing);

      minX = Math.min(minX, worldPos.x);
      minY = Math.min(minY, worldPos.y);
      minZ = Math.min(minZ, worldPos.z);
      maxX = Math.max(maxX, worldPos.x);
      maxY = Math.max(maxY, worldPos.y);
      maxZ = Math.max(maxZ, worldPos.z);

      return {
        ...voxel,
        rotatedOffset: rotated,
        worldPos,
        worldFacing,
        isSpecializedHatch: SPECIALIZED_HATCH_ROLES.has(voxel.role)
      };
    });

    let chimneyWorldPos = null;
    if (bp.gtnhConstraints?.openChimneyRelativeOffset) {
      const rotChimney = rotateRelativeOffset(
        new Vec3(
          bp.gtnhConstraints.openChimneyRelativeOffset.x,
          bp.gtnhConstraints.openChimneyRelativeOffset.y,
          bp.gtnhConstraints.openChimneyRelativeOffset.z
        ),
        bp.canonicalFacing,
        targetFacing
      );
      chimneyWorldPos = anchor.plus(rotChimney);
    }

    return {
      blueprint: bp,
      anchor,
      facing: targetFacing.toUpperCase(),
      boundingBox: {
        min: new Vec3(minX, minY, minZ),
        max: new Vec3(maxX, maxY, maxZ)
      },
      chimneyWorldPos,
      cells
    };
  }

  /**
   * Scans the target 3D bounding box using chunk cache (`bot.blockAt`) AND raycast
   * visibility analysis (`navigator.hasLineOfSight` / `bot.world.raycast`) to detect
   * satisfied, missing, mismatched, and obstructed-air blocks.
   */
  scanStructureState(projection, botInstance = null) {
    const bot = botInstance || this.bot;
    if (!bot || typeof bot.blockAt !== 'function') {
      throw new Error('Cannot scan world bounding box without a bot instance implementing blockAt()');
    }

    const satisfied = [];
    const missing = [];
    const mismatched = [];
    const obstructedAir = [];
    const unloaded = [];

    const eyePos = bot.entity?.position ? bot.entity.position.offset(0, 1.62, 0) : null;

    for (const cell of projection.cells) {
      const currentBlock = bot.blockAt(cell.worldPos);
      if (!currentBlock) {
        unloaded.push({ cell, reason: 'chunk_unloaded' });
        continue;
      }

      const visibleByRaycast =
        eyePos && this.navigator
          ? this.navigator.hasLineOfSight(cell.worldPos, eyePos, 6.0)
          : true;

      const currentIsAir = this._isAirOrReplaceable(currentBlock);

      if (cell.role === 'air') {
        if (currentIsAir) {
          satisfied.push({ cell, visibleByRaycast });
        } else {
          obstructedAir.push({
            cell,
            actualBlock: this._describeWorldBlock(currentBlock),
            visibleByRaycast
          });
        }
        continue;
      }

      if (currentIsAir) {
        missing.push({ cell, visibleByRaycast });
        continue;
      }

      if (this._blockMatchesCell(currentBlock, cell)) {
        satisfied.push({ cell, visibleByRaycast });
      } else {
        mismatched.push({
          cell,
          actualBlock: this._describeWorldBlock(currentBlock),
          visibleByRaycast
        });
      }
    }

    let chimneyClear = true;
    if (projection.chimneyWorldPos) {
      const exhaustBlock = bot.blockAt(projection.chimneyWorldPos);
      if (exhaustBlock && !this._isAirOrReplaceable(exhaustBlock)) {
        chimneyClear = false;
      }
    }

    const neededItems = new Map();
    for (const entry of [...missing, ...mismatched]) {
      const id = entry.cell.itemId;
      neededItems.set(id, (neededItems.get(id) || 0) + 1);
    }

    return {
      isComplete:
        unloaded.length === 0 &&
        missing.length === 0 &&
        mismatched.length === 0 &&
        obstructedAir.length === 0 &&
        chimneyClear,
      chimneyClear,
      counts: {
        total: projection.cells.length,
        satisfied: satisfied.length,
        missing: missing.length,
        mismatched: mismatched.length,
        obstructedAir: obstructedAir.length,
        unloaded: unloaded.length
      },
      satisfied,
      missing,
      mismatched,
      obstructedAir,
      unloaded,
      neededItems: Object.fromEntries(neededItems)
    };
  }

  _isAirOrReplaceable(block) {
    if (!block) return true;
    const name = (block.name || '').toLowerCase();
    return (
      block.type === 0 ||
      name === 'air' ||
      name === 'cave_air' ||
      name === 'void_air' ||
      name === 'tallgrass' ||
      name === 'snow_layer'
    );
  }

  _describeWorldBlock(block) {
    const canonical = this.registryBridge.toCanonicalItemId({
      type: block.type,
      name: block.name,
      metadata: block.metadata ?? 0
    });
    return canonical || `${block.name}:${block.metadata ?? 0}`;
  }

  _blockMatchesCell(block, cell) {
    const actualCanonical = this._describeWorldBlock(block);
    if (actualCanonical === cell.itemId) return true;

    const blockShort = (block.name || '').replace(/^minecraft:/, '').replace(/^gregtech:/, '');
    const expectedShort = (cell.blockName || '').replace(/^minecraft:/, '').replace(/^gregtech:/, '');
    const actualMeta = block.metadata ?? 0;
    return blockShort === expectedShort && actualMeta === cell.metadata;
  }

  /**
   * Orders missing/mismatched placement cells safely:
   *  - Bottom-up (`y` ascending) so every layer has solid floor/casing support
   *  - Casings & coils before specialized hatches & controller on the same layer
   *  - Back-to-front relative to controller (`rotatedOffset.z` descending for NORTH)
   */
  _sortPlacementOrder(entries, anchorPos) {
    return entries.slice().sort((a, b) => {
      if (a.cell.worldPos.y !== b.cell.worldPos.y) {
        return a.cell.worldPos.y - b.cell.worldPos.y;
      }
      const prioA = ROLE_BUILD_PRIORITY[a.cell.role] ?? 3;
      const prioB = ROLE_BUILD_PRIORITY[b.cell.role] ?? 3;
      if (prioA !== prioB) {
        return prioA - prioB;
      }
      const distA = a.cell.worldPos.distanceTo(anchorPos);
      const distB = b.cell.worldPos.distanceTo(anchorPos);
      return distB - distA;
    });
  }

  /**
   * Executes the full 3D multiblock construction loop for `blueprintOrId` at `anchorPos`:
   *  a. Scans the 3D bounding box via chunk cache & raycast analysis.
   *  b. Checks available casings, specialized hatches (Input/Output/Maintenance/Energy/Muffler),
   *     and controller in bot inventory + `WarehouseTracker`.
   *  c. GTNH Missing-Component Rule: if any component is missing, pauses construction,
   *     saves a resumable checkpoint, and dispatches `craftingEngine.requestCraft(...)`
   *     for every missing item before resuming.
   *  d. Excavates obstructions/mismatches, fetches components from warehouse chests,
   *     pathfinds to safe placement poses, and sends sneak-guarded `block_place` packets.
   *
   * @param {string|Object} blueprintOrId
   * @param {Vec3|{x:number,y:number,z:number}} anchorPos
   * @param {Object} [options]
   * @param {string} [options.facing='NORTH']
   * @param {Function} [options.onCraftRequired] - Optional async hook `(craftJobs) => Promise<boolean>` to fulfill crafts inline and auto-resume!
   */
  async executeBuild(blueprintOrId, anchorPos, options = {}) {
    const facing = (options.facing || 'NORTH').toUpperCase();
    const projection = this.projectToWorld(blueprintOrId, anchorPos, facing);
    const scan = this.scanStructureState(projection);

    if (scan.unloaded.length > 0) {
      return {
        status: 'UNLOADED_CHUNKS',
        blueprintId: projection.blueprint.blueprintId,
        unloadedCount: scan.unloaded.length,
        scan
      };
    }

    if (scan.isComplete) {
      this._protectCompletedStructure(projection);
      this.activeBuildCheckpoint = null;
      return {
        status: 'COMPLETED',
        blueprintId: projection.blueprint.blueprintId,
        placedCount: 0,
        dugCount: 0,
        scan
      };
    }

    // Cross-reference all needed casings, hatches, and controller against inventory + warehouse
    const combinedStock = this.warehouse
      ? this.warehouse.getCombinedStock(this.bot, options.inventoryOverride || null)
      : this._readBotInventoryMap();

    const missingMaterials = [];
    for (const [itemId, neededCount] of Object.entries(scan.neededItems)) {
      const available = combinedStock.get(itemId) || 0;
      if (available < neededCount) {
        missingMaterials.push({
          itemId,
          needed: neededCount,
          available,
          deficit: neededCount - available
        });
      }
    }

    if (missingMaterials.length > 0) {
      const craftJobs = [];
      if (this.craftingEngine) {
        for (const deficitEntry of missingMaterials) {
          const job = this.craftingEngine.requestCraft(
            deficitEntry.itemId,
            deficitEntry.deficit,
            {
              requestedBy: `MultiblockBuilder:${projection.blueprint.blueprintId}`,
              planOptions: options.planOptions || {}
            }
          );
          craftJobs.push(job);
        }
      }

      this.activeBuildCheckpoint = {
        blueprintId: projection.blueprint.blueprintId,
        anchor: projection.anchor.clone(),
        facing,
        pausedAt: Date.now(),
        missingMaterials,
        craftJobs
      };

      this.emit('buildPausedMissingMaterials', this.activeBuildCheckpoint);

      // If caller provided an inline craft fulfillment callback, run it and immediately resume!
      if (typeof options.onCraftRequired === 'function') {
        const fulfilled = await options.onCraftRequired(craftJobs, missingMaterials);
        if (fulfilled) {
          this.activeBuildCheckpoint = null;
          return this.executeBuild(blueprintOrId, anchorPos, {
            ...options,
            onCraftRequired: null // Prevent unbounded recursion if still short
          });
        }
      }

      return {
        status: 'PAUSED_MISSING_MATERIALS',
        blueprintId: projection.blueprint.blueprintId,
        missingMaterials,
        craftJobs,
        checkpoint: this.activeBuildCheckpoint,
        scan
      };
    }

    let dugCount = 0;
    let placedCount = 0;

    // Step 1: Clear obstructed interior air blocks and mismatched blocks (top-down)
    const digTargets = [...scan.obstructedAir, ...scan.mismatched].sort(
      (a, b) => b.cell.worldPos.y - a.cell.worldPos.y
    );

    for (const entry of digTargets) {
      await this._excavateBlock(entry.cell.worldPos);
      dugCount++;
    }

    // Also clear chimney obstruction if present
    if (!scan.chimneyClear && projection.chimneyWorldPos) {
      await this._excavateBlock(projection.chimneyWorldPos);
      dugCount++;
    }

    // Step 2: Place all missing + formerly-mismatched structural blocks bottom-up
    const toPlace = this._sortPlacementOrder(
      [...scan.missing, ...scan.mismatched],
      projection.anchor
    );

    for (const entry of toPlace) {
      await this._ensureItemReadyForPlacement(entry.cell.itemId, 1);
      await this._placeStructuralVoxel(entry.cell);
      placedCount++;
      this.emit('voxelPlaced', {
        blueprintId: projection.blueprint.blueprintId,
        role: entry.cell.role,
        itemId: entry.cell.itemId,
        worldPos: entry.cell.worldPos
      });
    }

    // Step 3: Re-scan to verify complete GTNH multiblock formation
    const finalScan = this.scanStructureState(projection);
    if (finalScan.isComplete) {
      this._protectCompletedStructure(projection);
      this.activeBuildCheckpoint = null;
    }

    const result = {
      status: finalScan.isComplete ? 'COMPLETED' : 'PARTIAL',
      blueprintId: projection.blueprint.blueprintId,
      placedCount,
      dugCount,
      scan: finalScan
    };
    this.emit('buildFinished', result);
    return result;
  }

  /**
   * Resumes a previously paused multiblock construction from `this.activeBuildCheckpoint`.
   */
  async resumePausedBuild(options = {}) {
    if (!this.activeBuildCheckpoint) {
      return { status: 'NO_ACTIVE_CHECKPOINT' };
    }
    const { blueprintId, anchor, facing } = this.activeBuildCheckpoint;
    return this.executeBuild(blueprintId, anchor, { ...options, facing });
  }

  _protectCompletedStructure(projection) {
    if (this.navigator && typeof this.navigator.registerProtectedStructure === 'function') {
      const id = `${projection.blueprint.blueprintId}@${projection.anchor.x},${projection.anchor.y},${projection.anchor.z}`;
      this.navigator.registerProtectedStructure(
        id,
        projection.boundingBox.min,
        projection.boundingBox.max
      );
    }
  }

  _readBotInventoryMap() {
    const map = new Map();
    if (!this.bot?.inventory?.items) return map;
    for (const item of this.bot.inventory.items()) {
      const id = this.registryBridge.toCanonicalItemId(item);
      if (id) {
        map.set(id, (map.get(id) || 0) + (item.count ?? 1));
      }
    }
    return map;
  }

  async _ensureItemReadyForPlacement(itemId, count = 1) {
    const botInv = this._readBotInventoryMap();
    const inHandOrInv = botInv.get(itemId) || 0;

    if (inHandOrInv < count && this.warehouse) {
      const needed = count - inHandOrInv;
      const source = this.warehouse.locateItemSources(
        itemId,
        needed,
        this.bot?.entity?.position || null
      );
      for (const loc of source.locations) {
        if (this.navigator) {
          await this.navigator.gotoBlockAdjacent(loc.position);
        }
        await this._withdrawFromWarehouseContainer(loc.position, itemId, loc.takeCount);
      }
    }

    await this._equipCanonicalItem(itemId);
  }

  async _withdrawFromWarehouseContainer(containerPos, itemId, count) {
    if (this.bot && typeof this.bot.openContainer === 'function') {
      const block = this.bot.blockAt(containerPos);
      if (block) {
        const win = await this.bot.openContainer(block);
        try {
          const matchingItem = (win.containerItems?.() || []).find(
            (it) => this.registryBridge.toCanonicalItemId(it) === itemId
          );
          if (matchingItem && typeof win.withdraw === 'function') {
            await win.withdraw(matchingItem.type, matchingItem.metadata ?? null, count);
          }
        } finally {
          if (typeof win.close === 'function') win.close();
        }
      }
    }
    if (this.warehouse) {
      this.warehouse.adjustContainerStock(containerPos, itemId, -count);
    }
  }

  async _equipCanonicalItem(itemId) {
    if (!this.bot?.inventory?.items) return null;
    const match = this.bot.inventory
      .items()
      .find((it) => this.registryBridge.toCanonicalItemId(it) === itemId);
    if (match && typeof this.bot.equip === 'function') {
      await this.bot.equip(match, 'hand');
    }
    return match || null;
  }

  async _excavateBlock(worldPos) {
    if (!this.bot) return;
    const block = this.bot.blockAt(worldPos);
    if (!block || this._isAirOrReplaceable(block)) return;

    if (this.navigator) {
      await this.navigator.gotoPlacementPose(worldPos, 4.2);
    }
    if (typeof this.bot.dig === 'function') {
      await this.bot.dig(block);
    }
  }

  /**
   * Navigates to a safe adjacent standing pose, selects a solid neighbor reference face,
   * engages sneaking (preventing GregTech controller/hatch GUIs from intercepting right-click!),
   * sends the `block_place` network packet, and orients directional hatches if needed.
   */
  async _placeStructuralVoxel(cell) {
    const targetPos = cell.worldPos;
    if (this.navigator) {
      await this.navigator.gotoPlacementPose(targetPos, 4.2);
    }

    const refChoice = this._selectReferenceBlockFace(targetPos);
    const wireHeldItem = this._buildWireHeldItem(cell.itemId);

    if (this.bot && typeof this.bot.lookAt === 'function') {
      const hitPoint = refChoice.refBlockPos.offset(0.5, 0.5, 0.5).plus(
        refChoice.face.normal.scaled(0.5)
      );
      await this.bot.lookAt(hitPoint, true);
    }

    if (cell.sneakPlace && this.bot && typeof this.bot.setControlState === 'function') {
      this.bot.setControlState('sneak', true);
    }

    try {
      const packetPayload = {
        location: {
          x: refChoice.refBlockPos.x,
          y: refChoice.refBlockPos.y,
          z: refChoice.refBlockPos.z
        },
        direction: refChoice.face.dirIndex,
        heldItem: wireHeldItem,
        cursorX: 8,
        cursorY: 8,
        cursorZ: 8
      };

      this.placementPacketLog.push({
        timestamp: Date.now(),
        role: cell.role,
        itemId: cell.itemId,
        targetPos: targetPos.clone(),
        worldFacing: cell.worldFacing,
        packet: packetPayload
      });

      if (this.bot?._client && typeof this.bot._client.write === 'function') {
        this.bot._client.write('block_place', packetPayload);
      }

      if (this.bot && typeof this.bot._ApplyVirtualPlacement === 'function') {
        this.bot._ApplyVirtualPlacement(targetPos, cell);
      }

      // If placing a directional GTNH hatch/controller, apply GregTech Wrench sub-grid click vector
      if (cell.worldFacing && (cell.isSpecializedHatch || cell.role === 'controller')) {
        await this._orientGregTechHatchIfNeeded(targetPos, cell.worldFacing);
      }
    } finally {
      if (cell.sneakPlace && this.bot && typeof this.bot.setControlState === 'function') {
        this.bot.setControlState('sneak', false);
      }
    }
  }

  _selectReferenceBlockFace(targetPos) {
    if (this.bot && typeof this.bot.blockAt === 'function') {
      for (const face of PLACE_FACES) {
        const refPos = targetPos.plus(face.refOffset);
        const refBlk = this.bot.blockAt(refPos);
        if (refBlk && !this._isAirOrReplaceable(refBlk)) {
          return { refBlockPos: refPos, face };
        }
      }
    }
    // Fallback to top face of block below targetPos
    return {
      refBlockPos: targetPos.offset(0, -1, 0),
      face: PLACE_FACES[0]
    };
  }

  _buildWireHeldItem(itemId) {
    const mapped = this.registryBridge.fromCanonicalItemId(itemId, this.bot?.registry);
    return {
      blockId: mapped.blockId !== -1 ? mapped.blockId : 1,
      itemCount: 1,
      itemDamage: mapped.itemDamage,
      nbtData: undefined
    };
  }

  /**
   * Simulates GregTech 3x3 wrench hit-box sub-quadrant orientation click on `targetPos`
   * when a wrench is present in the bot's toolkit.
   */
  async _orientGregTechHatchIfNeeded(targetPos, desiredWorldFacing) {
    if (!this.bot?.inventory?.items || !this.bot?._client?.write) return;

    const wrench = this.bot.inventory.items().find((it) => {
      const id = this.registryBridge.toCanonicalItemId(it) || '';
      return id.includes('metatool') || (it.name || '').toLowerCase().includes('wrench');
    });
    if (!wrench) return;

    await this.bot.equip(wrench, 'hand');

    const faceMap = {
      DOWN: 0,
      UP: 1,
      NORTH: 2,
      SOUTH: 3,
      WEST: 4,
      EAST: 5
    };
    const dirIndex = faceMap[desiredWorldFacing] ?? 2;

    // GregTech 5 center sub-grid (cursor 8, 8, 8) sets main output/front facing to clicked face
    this.bot._client.write('block_place', {
      location: { x: targetPos.x, y: targetPos.y, z: targetPos.z },
      direction: dirIndex,
      heldItem: {
        blockId: wrench.type ?? 7150,
        itemCount: 1,
        itemDamage: wrench.metadata ?? 16
      },
      cursorX: 8,
      cursorY: 8,
      cursorZ: 8
    });
  }
}

module.exports = {
  HORIZONTAL_FACINGS,
  PLACE_FACES,
  SPECIALIZED_HATCH_ROLES,
  MultiblockBuilder,
  rotateRelativeOffset,
  resolveWorldBlockFacing
};
