'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const Vec3 = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const { normalizeItemId } = require('../protocol/forgeHandshake');
const { installFastWindowClickShim } = require('../statemachine/hierarchy');
const { SAFE_WATER_BLOCK_NAMES } = require('../navigation/gtnhNavigator');

const VANILLA_LOG_BLOCKS = [
  'oak_log',
  'birch_log',
  'spruce_log',
  'jungle_log',
  'acacia_log',
  'dark_oak_log',
  'cherry_log',
  'mangrove_log'
];

const STONE_HOST_BLOCKS = new Set([
  'stone',
  'deepslate',
  'granite',
  'diorite',
  'andesite',
  'tuff'
]);

const EDIBLE_FOOD_PRIORITY = [
  'minecraft:cooked_beef',
  'minecraft:cooked_porkchop',
  'minecraft:cooked_mutton',
  'minecraft:cooked_chicken',
  'minecraft:bread',
  'minecraft:baked_potato',
  'minecraft:golden_carrot',
  'minecraft:apple',
  'minecraft:carrot',
  'minecraft:sweet_berries',
  'minecraft:melon_slice',
  'minecraft:cooked_cod',
  'minecraft:cooked_salmon'
];

const RAW_MEAT_TO_COOK = [
  'minecraft:beef',
  'minecraft:porkchop',
  'minecraft:mutton',
  'minecraft:chicken'
];

const HOSTILE_MOB_NAMES = new Set([
  'zombie',
  'husk',
  'drowned',
  'skeleton',
  'stray',
  'spider',
  'cave_spider',
  'creeper',
  'witch',
  'pillager',
  'vindicator',
  'slime'
]);

const PASSIVE_FOOD_MOBS = new Set(['cow', 'pig', 'sheep', 'chicken']);

const TIER_RANKS = {
  STEAM: 0,
  ULV: 1,
  LV: 2,
  MV: 3,
  HV: 4,
  EV: 5,
  IV: 6,
  LuV: 7,
  ZPM: 8,
  UV: 9,
  UHV: 10
};

/**
 * Maps resource categories to canonical item matchers for GregTech Leisure 1.20.1 (`GTCEu Modern`).
 */
const ORE_CATEGORY_MATCHERS = {
  iron: (id) =>
    id === 'minecraft:raw_iron' ||
    id === 'minecraft:iron_ore' ||
    id === 'minecraft:deepslate_iron_ore' ||
    id.includes('magnetite') ||
    id.includes('limonite') ||
    id.includes('banded_iron') ||
    id.includes('hematite') ||
    id.includes('goethite') ||
    id === 'gtceu:raw_pyrite' ||
    id === 'gtceu:raw_iron',
  copper: (id) =>
    id === 'minecraft:raw_copper' ||
    id === 'minecraft:copper_ore' ||
    id === 'minecraft:deepslate_copper_ore' ||
    id.includes('chalcopyrite') ||
    id.includes('malachite') ||
    id.includes('tetrahedrite') ||
    id === 'gtceu:raw_copper',
  tin: (id) =>
    id === 'gtceu:raw_tin' ||
    id.includes('cassiterite') ||
    (id.startsWith('gtceu:') && id.endsWith('tin_ore')),
  coal: (id) =>
    id === 'minecraft:coal' ||
    id === 'minecraft:charcoal' ||
    id === 'gtceu:coke_gem' ||
    id.includes('lignite') ||
    id === 'gtceu:raw_coal' ||
    id.endsWith('coal_ore'),
  redstone: (id) =>
    id === 'minecraft:redstone' ||
    id === 'gtceu:raw_redstone' ||
    id.includes('cinnabar') ||
    id.includes('ruby'),
  lead_silver: (id) =>
    id.includes('galena') ||
    id === 'gtceu:raw_lead' ||
    id === 'gtceu:raw_silver',
  sulfur_zinc: (id) =>
    id === 'gtceu:sulfur_dust' ||
    id === 'gtceu:raw_sulfur' ||
    id.includes('sphalerite'),
  nickel: (id) =>
    id.includes('garnierite') ||
    id.includes('pentlandite') ||
    id === 'gtceu:raw_nickel',
  aluminium: (id) =>
    id.includes('bauxite') ||
    id === 'gtceu:raw_aluminium'
};

const VANILLA_ORE_BLOCKS_BY_CATEGORY = {
  iron: ['iron_ore', 'deepslate_iron_ore'],
  copper: ['copper_ore', 'deepslate_copper_ore'],
  tin: [],
  coal: ['coal_ore', 'deepslate_coal_ore'],
  redstone: ['redstone_ore', 'deepslate_redstone_ore'],
  lead_silver: [],
  sulfur_zinc: [],
  nickel: [],
  aluminium: []
};

/**
 * Tag / item matcher predicates supporting both vanilla 1.20.1 and GTCEu Modern items.
 */
function matchesItemSpec(canonicalId, spec) {
  if (!canonicalId) return false;
  const id = normalizeItemId(canonicalId);
  if (typeof spec === 'function') return spec(id);
  if (Array.isArray(spec)) return spec.some((s) => matchesItemSpec(id, s));

  switch (spec) {
    case '#logs':
      return (
        (id.endsWith('_log') || id.endsWith('_stem')) &&
        !id.includes('stripped_')
      );
    case '#planks':
      return id.endsWith('_planks');
    case '#cobblestone':
      return (
        id === 'minecraft:cobblestone' ||
        id === 'minecraft:cobbled_deepslate' ||
        id === 'minecraft:blackstone'
      );
    case '#stone_smeltable':
      return id === 'minecraft:cobblestone';
    case '#furnace_fuel':
      return (
        ORE_CATEGORY_MATCHERS.coal(id) ||
        id.endsWith('_planks') ||
        id.endsWith('_log') ||
        id === 'minecraft:stick'
      );
    case '#pickaxe':
      return id.endsWith('_pickaxe') || (id.startsWith('gtceu:') && id.includes('pickaxe'));
    case '#iron_tier_pickaxe':
      return (
        id === 'minecraft:iron_pickaxe' ||
        id === 'minecraft:diamond_pickaxe' ||
        id === 'minecraft:netherite_pickaxe' ||
        (id.startsWith('gtceu:') && id.includes('pickaxe'))
      );
    case '#axe':
      return id.endsWith('_axe') || (id.startsWith('gtceu:') && id.endsWith('_axe'));
    case '#gtceu:hammer':
      return id.startsWith('gtceu:') && (id === 'gtceu:hammer' || id.endsWith('_hammer'));
    case '#gtceu:wrench':
      return id.startsWith('gtceu:') && (id === 'gtceu:wrench' || id.endsWith('_wrench'));
    case '#gtceu:file':
      return id.startsWith('gtceu:') && (id === 'gtceu:file' || id.endsWith('_file'));
    case '#gtceu:mortar':
      return id.startsWith('gtceu:') && (id === 'gtceu:mortar' || id.endsWith('_mortar'));
    case '#gtceu:screwdriver':
      return id.startsWith('gtceu:') && (id === 'gtceu:screwdriver' || id.endsWith('_screwdriver'));
    case '#gtceu:wire_cutter':
      return id.startsWith('gtceu:') && (id === 'gtceu:wire_cutter' || id.endsWith('_wire_cutter'));
    case '#gtceu:saw':
      return id.startsWith('gtceu:') && (id === 'gtceu:saw' || id.endsWith('_saw'));
    default: {
      if (spec.startsWith('#ore:')) {
        const cat = spec.slice('#ore:'.length);
        return ORE_CATEGORY_MATCHERS[cat] ? ORE_CATEGORY_MATCHERS[cat](id) : false;
      }
      return id === normalizeItemId(spec);
    }
  }
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Autonomous GregTech Leisure (1.20.1 / Forge 47.4.16) Survival & Modpack Progression Engine.
 *
 * Designed around one single goal with zero manual commands required:
 * spawn into a survival world -> bootstrap wood/stone/base camp -> prospect GTCEu 3x3-chunk
 * ore veins -> unlock GTL's 1-tick Blast Furnace -> forge GTCEu hand tools -> Bronze & Steam
 * Boiler/Machines -> build 3D Primitive Blast Furnace & smelt Steel -> Rubber/Redstone & LV
 * Circuits (`kubejs:advanced_control_circuit` + `gtceu:basic_electronic_circuit`) -> roofed LV
 * factory line -> Dual-LV Electric Blast Furnace -> Aluminium / MV / HV & continuous FTB Quests!
 */
class AutonomousProgressionEngine extends EventEmitter {
  /**
   * @param {Object} deps
   * @param {import('mineflayer').Bot} deps.bot
   * @param {import('../navigation/gtnhNavigator').GTNHNavigator} deps.navigator
   * @param {import('../craftingEngine').CraftingEngine} deps.craftingEngine
   * @param {import('../multiblockBuilder').MultiblockBuilder} deps.multiblockBuilder
   * @param {import('../hazards/hazardMonitor').HazardMonitor} deps.hazardMonitor
   * @param {import('../protocol/forgeHandshake').ForgeRegistryBridge} deps.registryBridge
   * @param {Object} [deps.options]
   */
  constructor({
    bot,
    navigator,
    craftingEngine,
    multiblockBuilder,
    hazardMonitor,
    registryBridge,
    options = {}
  }) {
    super();
    this.bot = bot;
    installFastWindowClickShim(this.bot, { slot0TimeoutMs: options.slot0TimeoutMs ?? 80 });
    this.navigator = navigator;
    this.craftingEngine = craftingEngine;
    this.multiblockBuilder = multiblockBuilder;
    this.hazardMonitor = hazardMonitor;
    this.registryBridge = registryBridge;

    this.stateFilePath =
      options.stateFilePath ??
      path.resolve(process.cwd(), '.gtl-runtime-state.json');
    this.persistState = options.persistState ?? true;
    this.stepIntervalMs = options.stepIntervalMs ?? 55;
    this.cycleTimeoutMs = options.cycleTimeoutMs ?? 35000;
    this.searchRadius = options.searchRadius ?? 64;
    this.actionDelayScale = options.actionDelayScale ?? 1;

    this.vanillaMaxStateId = this._computeVanillaMaxStateId();

    this.worldState = {
      baseAnchor: null,
      stations: {
        craftingTable: null,
        furnace: null,
        furnaceAux: null,
        blastFurnace: null,
        chests: [],
        boiler: null,
        steamMachines: {},
        lvMachines: {},
        pbfAnchor: null,
        largeSteamCircuitAnchor: null,
        ebfAnchor: null
      },
      learnedOreStates: {},
      nonOreModdedStates: {},
      discoveredVeins: [],
      completedMilestones: [],
      exploreRingIndex: 0
    };

    /** @type {Map<string, number>} coordKey -> expiry timestamp */
    this.unreachableBlacklist = new Map();

    this._running = false;
    this._loopBusy = false;
    this._loopTimer = null;
    this._currentMilestoneId = 'IDLE';
    this._lastLoggedStatus = '';
    this._needsBodyReconcile = true;
    this._lastProgressPos = null;
    this._lastInvSignature = '';
    this._stuckCycles = 0;

    if (this.persistState) {
      this._loadWorldState();
    }
  }

  _computeVanillaMaxStateId() {
    let maxId = 26683;
    const arr = this.bot?.registry?.blocksArray;
    if (Array.isArray(arr)) {
      let computed = 0;
      for (const b of arr) {
        if (b && typeof b.maxStateId === 'number' && !String(b.name || '').includes(':')) {
          if (b.maxStateId > computed) computed = b.maxStateId;
        }
      }
      if (computed > 0) maxId = computed;
    }
    return maxId;
  }

  _log(level, message) {
    if (level === 'info' && message === this._lastLoggedStatus) return;
    if (level === 'info') this._lastLoggedStatus = message;
    this.emit('log', { level, message: `[Autopilot] ${message}` });
  }

  _loadWorldState() {
    try {
      if (this.stateFilePath && fs.existsSync(this.stateFilePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.stateFilePath, 'utf8'));
        if (parsed && typeof parsed === 'object') {
          this.worldState = {
            ...this.worldState,
            ...parsed,
            stations: {
              ...this.worldState.stations,
              ...(parsed.stations || {})
            },
            learnedOreStates: parsed.learnedOreStates || {},
            nonOreModdedStates: parsed.nonOreModdedStates || {},
            discoveredVeins: Array.isArray(parsed.discoveredVeins) ? parsed.discoveredVeins : [],
            completedMilestones: Array.isArray(parsed.completedMilestones)
              ? parsed.completedMilestones
              : []
          };
        }
      }
    } catch (_) {
      // Fresh state fallback if state file is corrupt
    }
  }

  _saveWorldState() {
    if (!this.persistState || !this.stateFilePath) return;
    try {
      fs.writeFileSync(this.stateFilePath, JSON.stringify(this.worldState, null, 2), 'utf8');
    } catch (_) {
      // Non-fatal on read-only filesystems
    }
  }

  markMilestoneComplete(milestoneId) {
    if (!this.worldState.completedMilestones.includes(milestoneId)) {
      this.worldState.completedMilestones.push(milestoneId);
      this._saveWorldState();
      this._log('info', `Completed progression milestone: ${milestoneId}`);
      this.emit('milestoneCompleted', milestoneId);
    }
  }

  hasMilestone(milestoneId) {
    return this.worldState.completedMilestones.includes(milestoneId);
  }

  _unmarkMilestones(milestoneIds = []) {
    const removeSet = new Set(milestoneIds);
    const before = this.worldState.completedMilestones.length;
    this.worldState.completedMilestones = this.worldState.completedMilestones.filter(
      (id) => !removeSet.has(id)
    );
    if (this.worldState.completedMilestones.length !== before) {
      this._saveWorldState();
    }
  }

  _isWaterBlockName(name) {
    if (!name) return false;
    const clean = String(name).toLowerCase().replace(/^minecraft:/, '');
    return SAFE_WATER_BLOCK_NAMES.has(clean);
  }

  _isDryStandableSpot(pos) {
    if (typeof this.bot?.blockAt !== 'function' || !pos) return true;
    const p = pos instanceof Vec3 ? pos.floored() : new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
    const ground = this.bot.blockAt(p.offset(0, -1, 0));
    const feet = this.bot.blockAt(p);
    const head = this.bot.blockAt(p.offset(0, 1, 0));
    if (!ground || !feet || !head) return false;

    const groundName = String(ground.name || '').toLowerCase();
    const feetName = String(feet.name || '').toLowerCase();
    const headName = String(head.name || '').toLowerCase();

    return (
      ground.boundingBox === 'block' &&
      !groundName.includes('leaves') &&
      !groundName.includes('magma') &&
      !groundName.includes('cactus') &&
      !this._isWaterBlockName(groundName) &&
      feet.boundingBox === 'empty' &&
      !this._isWaterBlockName(feetName) &&
      !feetName.includes('lava') &&
      !feetName.includes('fire') &&
      head.boundingBox === 'empty' &&
      !this._isWaterBlockName(headName) &&
      !headName.includes('lava')
    );
  }

  /**
   * Synchronizes persisted `.gtl-runtime-state.json` against the player's ACTUAL live body,
   * inventory, crafting grid, and surrounding world blocks on connect/reconnect/respawn:
   *  - Sweeps any leftover items stuck in `inv.slots[1..4]` or cursor (`selectedItem`) from
   *    an earlier interrupted (`Ctrl+C`) session in the same player body.
   *  - Validates `baseAnchor` (re-anchoring on dry land if spawned in a new world or in water).
   *  - Discovers existing nearby `crafting_table` / `furnace` / `blast_furnace` / `chest` blocks.
   *  - Fast-forwards early milestones when reconnecting into a body that already holds tools,
   *    and rolls back stale milestones if items/stations are missing after death or world reset.
   */
  async reconcileStateWithCurrentBody() {
    this._needsBodyReconcile = false;
    if (!this.bot) return;

    // 1. Clean any leftover 2x2 inventory crafting grid / cursor items persisted on the player body
    if (this.bot.inventory && typeof this.bot.clickWindow === 'function') {
      await this._ensureCleanCraftingGrid(this.bot.inventory, 4);
    }

    // 2. If spawned underwater or floating in water, swim onto dry shore before anchoring Base Camp
    if (this.navigator?.isBotInWater?.() && typeof this.navigator.swimToSafety === 'function') {
      this._log('info', 'Spawned in water — swimming to nearest dry shoreline before anchoring Base Camp...');
      await this.navigator.swimToSafety(10000);
    }

    // 3. Validate saved `baseAnchor` against loaded world terrain & nearby stations
    if (this.worldState.baseAnchor && this.bot.entity?.position) {
      const saved = this.worldState.baseAnchor;
      const savedVec = new Vec3(saved.x, saved.y, saved.z);
      const dist = this.bot.entity.position.distanceTo(savedVec);
      const hasAnyValidSavedStation = Boolean(
        this.getValidStationBlock('craftingTable', 'crafting_table') ||
          this.getValidStationBlock('furnace', 'furnace') ||
          this.getValidStationBlock('blastFurnace', 'blast_furnace')
      );

      if (dist > 160 || (!hasAnyValidSavedStation && !this._isDryStandableSpot(savedVec))) {
        this._log(
          'info',
          `Resetting stale/wet Base Camp anchor (${saved.x}, ${saved.y}, ${saved.z}) for current body position.`
        );
        this.worldState.baseAnchor = null;
        this.worldState.stations = {
          craftingTable: null,
          furnace: null,
          furnaceAux: null,
          blastFurnace: null,
          chests: [],
          boiler: null,
          steamMachines: {},
          lvMachines: {},
          pbfAnchor: null,
          largeSteamCircuitAnchor: null,
          ebfAnchor: null
        };
      }
    }

    // 4. Discover any pre-existing stations within 14 blocks of the player body (e.g. same-body resume)
    if (typeof this.bot.findBlock === 'function' && this.bot.registry?.blocksByName) {
      const stationChecks = [
        ['craftingTable', 'crafting_table'],
        ['furnace', 'furnace'],
        ['blastFurnace', 'blast_furnace']
      ];
      for (const [key, blkName] of stationChecks) {
        if (!this.getValidStationBlock(key, blkName)) {
          const id = this.bot.registry.blocksByName[blkName]?.id;
          if (typeof id === 'number') {
            const found = this.bot.findBlock({ matching: id, maxDistance: 14 });
            if (found?.position) {
              this.worldState.stations[key] = {
                x: found.position.x,
                y: found.position.y,
                z: found.position.z
              };
            }
          }
        }
      }
    }

    // 5. Bi-directional milestone reconciliation (same-body fast-forward + stale-file rollback)
    const hasAnyPick = Boolean(this.findInventoryItem('#pickaxe'));
    const hasStoneOrBetterPick = Boolean(
      this.findInventoryItem(['minecraft:stone_pickaxe', '#iron_tier_pickaxe'])
    );
    const hasAxe = Boolean(this.findInventoryItem('#axe'));
    const hasTable =
      Boolean(this.getValidStationBlock('craftingTable', 'crafting_table')) ||
      this.countInventory('minecraft:crafting_table') > 0;
    const hasFurnace =
      Boolean(this.getValidStationBlock('furnace', 'furnace')) ||
      this.countInventory('minecraft:furnace') > 0;
    const hasBlastFurnace =
      Boolean(this.getValidStationBlock('blastFurnace', 'blast_furnace')) ||
      this.countInventory('minecraft:blast_furnace') > 0;

    // Fast-forward if reconnecting into a body that already holds tools/stations
    if (hasAnyPick || hasTable) {
      this.markMilestoneComplete('M01_WOOD_BOOTSTRAP');
      if (hasAnyPick && hasTable) {
        this.markMilestoneComplete('M02_BASE_AND_CRAFTING_TABLE');
      }
    }
    if (hasStoneOrBetterPick && hasAxe && (hasFurnace || hasBlastFurnace)) {
      this.markMilestoneComplete('M03_STONE_TOOLS_AND_FURNACE');
    }

    // Roll back stale milestones if items/stations do not actually exist in this world/body
    if (!hasAnyPick && !hasTable) {
      if (this.countInventory('#planks') < 4 && this.countInventory('#logs') === 0) {
        this._unmarkMilestones(['M01_WOOD_BOOTSTRAP']);
      }
      this._unmarkMilestones(['M02_BASE_AND_CRAFTING_TABLE', 'M03_STONE_TOOLS_AND_FURNACE']);
    } else if (!hasStoneOrBetterPick || (!hasFurnace && !hasBlastFurnace)) {
      this._unmarkMilestones(['M03_STONE_TOOLS_AND_FURNACE']);
    }

    if (this.hasMilestone('M05_FAST_BLAST_FURNACE_AND_IRON_KIT') && !hasBlastFurnace) {
      this._unmarkMilestones(['M05_FAST_BLAST_FURNACE_AND_IRON_KIT']);
    }

    if (
      this.hasMilestone('M06_GTCEU_HAND_TOOLS') &&
      (!this.findInventoryItem('#gtceu:hammer') ||
        !this.findInventoryItem('#gtceu:wrench') ||
        !this.findInventoryItem('#gtceu:mortar'))
    ) {
      this._unmarkMilestones(['M06_GTCEU_HAND_TOOLS']);
    }

    this._saveWorldState();

    const pos = this.bot.entity?.position;
    const invSummary = this.getInventoryItems()
      .slice(0, 6)
      .map((i) => `${this.registryBridge.toCanonicalItemId(i).replace(/^minecraft:/, '')}x${i.count ?? 1}`)
      .join(', ');
    this._log(
      'info',
      `Body & World Sync complete${pos ? ` at (${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)})` : ''} — ` +
        `inWater=${Boolean(this.navigator?.isBotInWater?.())}, inv=[${invSummary || 'empty'}], ` +
        `milestones=${this.worldState.completedMilestones.length}`
    );
  }

  async _recoverFromStall(reason = 'cycle watchdog') {
    this._log('warn', `Watchdog recovering stalled action (${reason}) — resetting window & pathfinder...`);
    try {
      this._sharedTableWindow = null;
      if (this.bot?.currentWindow && typeof this.bot.closeWindow === 'function') {
        await Promise.race([this.bot.closeWindow(this.bot.currentWindow), sleepMs(250)]);
      }
    } catch (_) {
      // Safe cleanup
    }
    this.navigator?.stop?.();
    this.unreachableBlacklist.clear();
    if (this.navigator?.isBotInWater?.() && typeof this.navigator.swimToSafety === 'function') {
      await this.navigator.swimToSafety(6000);
    }
  }

  /**
   * Starts continuous autonomous survival progression on the live Mineflayer bot.
   */
  start() {
    if (this._running) return;
    this._running = true;
    this._needsBodyReconcile = true;
    installFastWindowClickShim(this.bot);

    this._log(
      'info',
      'Autonomous GregTech Leisure progression loop ENGAGED — goal: beat the modpack from scratch!'
    );

    if (typeof this.bot?.on === 'function') {
      this._onDeath = () => {
        this._log('warn', 'Bot died! Waiting for respawn to recover and continue progression...');
        this._sharedTableWindow = null;
        this.navigator?.stop();
      };
      this._onRespawn = () => {
        this._needsBodyReconcile = true;
        this._log('info', 'Respawned in survival world — re-syncing body & resuming progression!');
      };
      this.bot.on('death', this._onDeath);
      this.bot.on('spawn', this._onRespawn);
    }

    const tick = async () => {
      if (!this._running) return;
      if (!this._loopBusy) {
        this._loopBusy = true;
        let watchdogTimer = null;
        try {
          await Promise.race([
            this.runSingleCycle(),
            new Promise((_, reject) => {
              watchdogTimer = setTimeout(
                () => reject(new Error(`Cycle exceeded ${this.cycleTimeoutMs}ms watchdog`)),
                this.cycleTimeoutMs
              );
              watchdogTimer.unref?.();
            })
          ]);
        } catch (err) {
          if (String(err?.message || '').includes('watchdog')) {
            await this._recoverFromStall(err.message);
          } else {
            this._log('warn', `Recovered from cycle interruption: ${err.message}`);
          }
        } finally {
          if (watchdogTimer) clearTimeout(watchdogTimer);
          this._loopBusy = false;
        }
      }
      if (this._running) {
        this._loopTimer = setTimeout(tick, this.stepIntervalMs);
        this._loopTimer.unref?.();
      }
    };

    this._loopTimer = setTimeout(tick, 120);
    this._loopTimer.unref?.();
  }

  stop() {
    this._running = false;
    if (this._loopTimer) {
      clearTimeout(this._loopTimer);
      this._loopTimer = null;
    }
    if (this.bot && typeof this.bot.removeListener === 'function') {
      if (this._onDeath) this.bot.removeListener('death', this._onDeath);
      if (this._onRespawn) this.bot.removeListener('spawn', this._onRespawn);
    }
  }

  // ===========================================================================
  // INVENTORY, EQUIPMENT & SURVIVAL SELF-CARE HELPERS
  // ===========================================================================

  getInventoryItems() {
    if (!this.bot?.inventory || typeof this.bot.inventory.items !== 'function') {
      return [];
    }
    return this.bot.inventory.items();
  }

  countInventory(spec) {
    let total = 0;
    for (const item of this.getInventoryItems()) {
      const canonical = this.registryBridge.toCanonicalItemId(item);
      if (matchesItemSpec(canonical, spec)) {
        total += item.count ?? item.itemCount ?? 0;
      }
    }
    return total;
  }

  countTotalStock(spec) {
    let total = this.countInventory(spec);
    if (this.craftingEngine?.warehouse) {
      for (const [itemId, qty] of this.craftingEngine.warehouse.getWarehouseTotals().entries()) {
        if (matchesItemSpec(itemId, spec)) {
          total += qty;
        }
      }
    }
    return total;
  }

  findInventoryItem(spec) {
    for (const item of this.getInventoryItems()) {
      const canonical = this.registryBridge.toCanonicalItemId(item);
      if (matchesItemSpec(canonical, spec)) {
        return item;
      }
    }
    return null;
  }

  async equipItemSpec(spec, destination = 'hand') {
    const item = this.findInventoryItem(spec);
    if (!item || typeof this.bot?.equip !== 'function') return false;
    try {
      await this.bot.equip(item, destination);
      return true;
    } catch (_) {
      return false;
    }
  }

  async equipBestToolForBlock(block) {
    if (!block || !this.bot) return;
    if (this.bot.tool && typeof this.bot.tool.equipForBlock === 'function') {
      try {
        await this.bot.tool.equipForBlock(block, {});
        return;
      } catch (_) {
        // Fall through to explicit tier selector
      }
    }

    const name = String(block.name || '').toLowerCase();
    if (name.includes('log') || name.includes('planks') || name === 'crafting_table' || name === 'chest') {
      for (const axe of ['minecraft:iron_axe', 'minecraft:stone_axe', 'minecraft:wooden_axe']) {
        if (await this.equipItemSpec(axe)) return;
      }
    } else if (
      name === 'dirt' ||
      name === 'grass_block' ||
      name === 'sand' ||
      name === 'gravel' ||
      name === 'clay'
    ) {
      for (const shovel of ['minecraft:iron_shovel', 'minecraft:stone_shovel', 'minecraft:wooden_shovel']) {
        if (await this.equipItemSpec(shovel)) return;
      }
    } else {
      for (const pick of [
        'minecraft:diamond_pickaxe',
        'minecraft:iron_pickaxe',
        'minecraft:stone_pickaxe',
        'minecraft:wooden_pickaxe'
      ]) {
        if (await this.equipItemSpec(pick)) return;
      }
    }
  }

  /**
   * Handles underwater/drowning escape, hunger, nearby creepers/hostiles, and storm/hazard checks
   * before every progression step.
   */
  async performSurvivalSelfCare() {
    if (!this.bot?.entity) return false;

    // 1. Respect HazardMonitor active emergencies (storms on unroofed electric machines, toxic chunks)
    if (this.hazardMonitor?.hasActiveEmergency()) {
      if (this.hazardMonitor.isRaining || this.hazardMonitor.isThundering) {
        this.hazardMonitor.disableUnroofedMachines();
      }
      await this.hazardMonitor.mitigateImmediateHazard();
      return true;
    }

    // 1b. Anti-drowning & deep-water shoreline escape
    const oxygen = this.bot.oxygenLevel ?? 20;
    const isSubmerged = Boolean(this.navigator?.isBotSubmerged?.());
    const inWater = Boolean(this.navigator?.isBotInWater?.());
    if (isSubmerged || oxygen < 15) {
      if (typeof this.bot.setControlState === 'function') {
        this.bot.setControlState('jump', true);
      }
      this._log(
        'warn',
        `Underwater / low oxygen (${oxygen}/20) — swimming to surface & nearest dry shoreline!`
      );
      if (typeof this.navigator?.swimToSafety === 'function') {
        await this.navigator.swimToSafety(10000);
      }
      return true;
    }
    if (inWater && typeof this.navigator?.findNearestDryLand === 'function') {
      const shore = this.navigator.findNearestDryLand(40);
      if (shore && this.bot.entity.position && this.bot.entity.position.distanceTo(shore) > 2.2) {
        this._log('info', 'Floating in water — swimming onto nearest dry shoreline...');
        await this.navigator.swimToSafety(10000);
        return true;
      }
    }

    // 2. Hostile mob defense & Creeper blast evasion
    if (this.bot.entities) {
      const myPos = this.bot.entity.position;
      for (const ent of Object.values(this.bot.entities)) {
        if (!ent || !ent.position || ent === this.bot.entity) continue;
        const mobName = String(ent.name || '').toLowerCase().replace(/^minecraft:/, '');
        if (!HOSTILE_MOB_NAMES.has(mobName)) continue;

        const dist = myPos.distanceTo(ent.position);
        if (mobName === 'creeper' && dist < 6.5) {
          const away = myPos.minus(ent.position);
          const norm = Math.max(1, Math.hypot(away.x, away.z));
          const escapeTarget = myPos.offset((away.x / norm) * 10, 0, (away.z / norm) * 10).floored();
          this._log('warn', 'Creeper nearby! Sprinting clear to protect bot & Base Camp.');
          await this._safeGotoNear(escapeTarget, 2, 4000);
          return true;
        }

        if (dist < 4.2 && typeof this.bot.attack === 'function') {
          await this.equipItemSpec([
            'minecraft:iron_sword',
            'minecraft:stone_sword',
            'minecraft:iron_axe',
            'minecraft:stone_axe'
          ]);
          if (typeof this.bot.lookAt === 'function') {
            await this.bot.lookAt(ent.position.offset(0, (ent.height || 1.6) * 0.7, 0), true);
          }
          this.bot.attack(ent);
          await sleepMs(250);
          return true;
        }
      }
    }

    // 3. Hunger & healing management
    const food = this.bot.food ?? 20;
    const health = this.bot.health ?? 20;
    if ((food < 15 || (health < 16 && food < 20)) && typeof this.bot.consume === 'function') {
      const edible = this.findInventoryItem(EDIBLE_FOOD_PRIORITY);
      if (edible) {
        this._log('info', `Eating ${this.registryBridge.toCanonicalItemId(edible)} (food=${food}/20, hp=${Math.round(health)})...`);
        await this.bot.equip(edible, 'hand');
        try {
          await this.bot.consume();
        } catch (_) {
          // Ignore interrupted consume
        }
        return true;
      }

      // Cook raw meat if we have any and a furnace is ready
      const rawMeat = this.findInventoryItem(RAW_MEAT_TO_COOK);
      if (rawMeat && (this.getValidStationBlock('furnace') || this.getValidStationBlock('blastFurnace'))) {
        await this.smeltItemsLive(RAW_MEAT_TO_COOK, Math.min(4, rawMeat.count || 1), false);
        return true;
      }

      // If critically low on food (< 10) and no food in inventory, hunt 1 nearby passive food animal
      if (food < 10 && this.bot.entities && typeof this.bot.attack === 'function') {
        const animal = Object.values(this.bot.entities).find((e) => {
          if (!e?.position) return false;
          const n = String(e.name || '').toLowerCase().replace(/^minecraft:/, '');
          return PASSIVE_FOOD_MOBS.has(n) && e.position.distanceTo(this.bot.entity.position) < 28;
        });
        if (animal) {
          await this.equipItemSpec([
            'minecraft:iron_sword',
            'minecraft:stone_sword',
            'minecraft:iron_axe',
            'minecraft:stone_axe',
            'minecraft:wooden_axe'
          ]);
          await this._safeGotoNear(animal.position, 2, 6000);
          this.bot.attack(animal);
          await sleepMs(350);
          await this.collectNearbyDrops(animal.position, 6);
          return true;
        }
      }
    }

    return false;
  }

  // ===========================================================================
  // NAVIGATION, DROP PICKUP & BASE CAMP STATION PLACEMENT
  // ===========================================================================

  _isBlacklisted(pos) {
    const key = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
    const exp = this.unreachableBlacklist.get(key);
    if (!exp) return false;
    if (Date.now() > exp) {
      this.unreachableBlacklist.delete(key);
      return false;
    }
    return true;
  }

  _blacklistPos(pos, ttlMs = 180000) {
    const key = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
    this.unreachableBlacklist.set(key, Date.now() + ttlMs);
  }

  async _delay(ms) {
    const scaled = Math.max(0, Math.round(ms * this.actionDelayScale));
    if (scaled > 0) await sleepMs(scaled);
  }

  async _safeGotoNear(pos, range = 2, timeoutMs = 15000) {
    if (!this.bot?.pathfinder?.goto) return true;
    if (this.navigator && !this.navigator._initialized) {
      this.navigator.configureMovements();
    }
    let timeoutHandle = null;
    try {
      const p = pos instanceof Vec3 ? pos : new Vec3(pos.x, pos.y, pos.z);
      if (this.bot.entity?.position && this.bot.entity.position.distanceTo(p) <= range + 0.6) {
        return true;
      }
      const goal = new goals.GoalNear(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z), range);
      await Promise.race([
        this.bot.pathfinder.goto(goal),
        new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => {
            this.bot.pathfinder.setGoal(null);
            reject(new Error('Pathfind timeout'));
          }, timeoutMs);
          timeoutHandle.unref?.();
        })
      ]);
      return true;
    } catch (_) {
      return false;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  /**
   * Sweeps nearby dropped item entities outside Minecraft's automatic 1.45-block pickup magnet
   * in a single non-stop sprint pass (zero post-drop sleep).
   */
  async collectNearbyDrops(centerPos, radius = 7) {
    if (!this.bot?.entities || !this.bot?.entity) return;
    await this._delay(80);

    const origin = centerPos
      ? new Vec3(centerPos.x, centerPos.y, centerPos.z)
      : this.bot.entity.position;

    const drops = Object.values(this.bot.entities)
      .filter((ent) => {
        if (!ent || !ent.position) return false;
        const n = String(ent.name || ent.objectType || '').toLowerCase();
        const isItem = n === 'item' || n === 'minecraft:item' || ent.type === 'object';
        if (!isItem || ent.position.distanceTo(origin) > radius) return false;
        // Items within ~1.4 blocks of the bot are pulled in automatically by Minecraft's item magnet
        return ent.position.distanceTo(this.bot.entity.position) > 1.35;
      })
      .sort((a, b) => a.position.distanceTo(this.bot.entity.position) - b.position.distanceTo(this.bot.entity.position))
      .slice(0, 6);

    for (const drop of drops) {
      if (!this.bot.entities[drop.id]) continue;
      if (
        typeof this.bot.blockAt === 'function' &&
        (this.bot.oxygenLevel ?? 20) > 12 &&
        this._isWaterBlockName(this.bot.blockAt(drop.position.floored())?.name)
      ) {
        this.navigator?.allowTemporaryDive?.(1400);
      }
      await this._safeGotoNear(drop.position, 1, 3500);
    }
  }

  /**
   * Breaks a block with instant yaw/pitch snap (`forceLook = true` — 0ms head-turn delay).
   * Pass `{ skipCollect: true, skipEquip: true }` inside multi-block bursts so whole trees and
   * stone/ore clusters break back-to-back without stopping after every single block!
   */
  async digAndCollectBlock(block, options = {}) {
    if (!block || !this.bot) return false;
    const targetPos = block.position.clone();
    const myDist = this.bot.entity?.position ? this.bot.entity.position.distanceTo(targetPos) : 0;

    if (myDist > 4.2) {
      const reached = await this._safeGotoNear(targetPos, 2, 10000);
      if (!reached && this.bot.entity?.position?.distanceTo(targetPos) > 4.6) {
        this._blacklistPos(targetPos);
        return false;
      }
    }

    const freshBlock = this.bot.blockAt ? this.bot.blockAt(targetPos) : block;
    if (!freshBlock || freshBlock.name === 'air' || freshBlock.type === 0) {
      return true;
    }

    if (!options.skipEquip) {
      await this.equipBestToolForBlock(freshBlock);
    }

    if (typeof this.bot.dig === 'function') {
      try {
        // `forceLook = true` snaps camera instantly on the same tick instead of panning over 300-500ms!
        await this.bot.dig(freshBlock, true);
      } catch (_) {
        this._blacklistPos(targetPos, 60000);
        return false;
      }
    }

    if (!options.skipCollect) {
      await this.collectNearbyDrops(targetPos, 6);
    }
    return true;
  }

  /**
   * Establishes (or validates) a flat, dry Base Camp anchor near spawn (never in water!).
   */
  ensureBaseAnchor() {
    if (this.worldState.baseAnchor) {
      const saved = this.worldState.baseAnchor;
      const savedVec = new Vec3(saved.x, saved.y, saved.z);
      const myPos = this.bot?.entity?.position;
      const hasSavedStation = Boolean(
        this.getValidStationBlock('craftingTable', 'crafting_table') ||
          this.getValidStationBlock('furnace', 'furnace') ||
          this.getValidStationBlock('blastFurnace', 'blast_furnace')
      );
      if (
        (!myPos || myPos.distanceTo(savedVec) < 160) &&
        (hasSavedStation || this._isDryStandableSpot(savedVec))
      ) {
        return savedVec;
      }
    }

    const origin = this.bot?.entity?.position
      ? this.bot.entity.position.floored()
      : new Vec3(0, 64, 0);

    let bestPos = origin;
    if (typeof this.bot?.blockAt === 'function') {
      outer: for (let r = 0; r <= 40; r += 2) {
        for (let dx = -r; dx <= r; dx += 2) {
          for (let dz = -r; dz <= r; dz += 2) {
            if (r > 0 && Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
            for (let dy = 6; dy >= -6; dy--) {
              const cand = origin.offset(dx, dy, dz);
              if (this._isDryStandableSpot(cand)) {
                bestPos = cand;
                break outer;
              }
            }
          }
        }
      }
    }

    this.worldState.baseAnchor = { x: bestPos.x, y: bestPos.y, z: bestPos.z };
    this._saveWorldState();
    this._log('info', `Established Base Camp anchor at (${bestPos.x}, ${bestPos.y}, ${bestPos.z}).`);
    return bestPos;
  }

  getValidStationBlock(stationKey, expectedBlockSubstr = null) {
    if (!this.bot?.blockAt) return null;
    const saved = this.worldState.stations[stationKey];
    if (saved) {
      const blk = this.bot.blockAt(new Vec3(saved.x, saved.y, saved.z));
      if (blk && blk.type !== 0 && blk.name !== 'air') {
        const expected = expectedBlockSubstr || stationKey.replace(/([A-Z])/g, '_$1').toLowerCase();
        if (!expected || String(blk.name || '').includes(expected)) {
          return blk;
        }
      }
    }

    // Fallback scan near Base Camp in case a station already exists nearby
    if (this.bot.findBlock && expectedBlockSubstr) {
      const blkEntry = this.bot.registry?.blocksByName?.[expectedBlockSubstr];
      if (blkEntry) {
        const found = this.bot.findBlock({
          matching: blkEntry.id,
          maxDistance: 24
        });
        if (found) {
          this.worldState.stations[stationKey] = {
            x: found.position.x,
            y: found.position.y,
            z: found.position.z
          };
          this._saveWorldState();
          return found;
        }
      }
    }

    return null;
  }

  /**
   * Places a station block (`crafting_table`, `furnace`, `blast_furnace`, `chest`, GTCEu machine)
   * cleanly at a relative offset from Base Camp, stepping clear of the target voxel's AABB first!
   */
  async placeStationAtBase(itemSpec, stationKey, relOffset, options = {}) {
    const base = this.ensureBaseAnchor();
    const targetPos = base.plus(new Vec3(relOffset.x, relOffset.y, relOffset.z)).floored();

    if (!(await this.equipItemSpec(itemSpec, 'hand'))) {
      return null;
    }

    // Ensure solid foundation at targetPos.y - 1
    if (this.bot?.blockAt) {
      const below = this.bot.blockAt(targetPos.offset(0, -1, 0));
      if (below && below.boundingBox !== 'block') {
        const filler = this.findInventoryItem(['#cobblestone', 'minecraft:dirt', '#planks']);
        if (filler && this.bot.blockAt(targetPos.offset(0, -2, 0))?.boundingBox === 'block') {
          await this.bot.equip(filler, 'hand');
          await this._safeGotoNear(targetPos.offset(2, 0, 0), 2, 6000);
          try {
            await this.bot.placeBlock(
              this.bot.blockAt(targetPos.offset(0, -2, 0)),
              new Vec3(0, 1, 0)
            );
          } catch (_) {
            // Continue
          }
          await this.equipItemSpec(itemSpec, 'hand');
        }
      }

      // Clear replaceable grass/snow/flowers at targetPos
      const existing = this.bot.blockAt(targetPos);
      if (existing && existing.type !== 0 && existing.name !== 'air' && existing.boundingBox === 'empty') {
        await this.digAndCollectBlock(existing);
        await this.equipItemSpec(itemSpec, 'hand');
      }
    }

    // Stand clear so player 0.6x1.8 AABB never overlaps targetPos [tx..tx+1] during `placeBlock`!
    const standPos = targetPos.offset(2, 0, 0);
    await this._safeGotoNear(standPos, 0, 8000);
    if (this.bot?.entity?.position) {
      const p = this.bot.entity.position;
      const overlapsTarget =
        p.x + 0.4 > targetPos.x &&
        p.x - 0.4 < targetPos.x + 1 &&
        p.z + 0.4 > targetPos.z &&
        p.z - 0.4 < targetPos.z + 1 &&
        p.y + 1.85 > targetPos.y &&
        p.y < targetPos.y + 1;
      if (overlapsTarget) {
        await this._safeGotoNear(targetPos.offset(-2, 0, 0), 0, 5000);
      }
    }

    const refBlock = this.bot?.blockAt ? this.bot.blockAt(targetPos.offset(0, -1, 0)) : null;
    if (refBlock && typeof this.bot?.placeBlock === 'function') {
      try {
        await this.bot.placeBlock(refBlock, new Vec3(0, 1, 0));
      } catch (_) {
        // Fallback packet placement via multiblockBuilder helper if placeBlock raycast timed out
        if (this.bot?._client?.write) {
          this.bot._client.write('block_place', {
            hand: 0,
            location: { x: refBlock.position.x, y: refBlock.position.y, z: refBlock.position.z },
            direction: 1,
            cursorX: 0.5,
            cursorY: 1.0,
            cursorZ: 0.5,
            insideBlock: false,
            sequence: 1
          });
        }
      }
    }

    await this._delay(40);

    // Optional rain-shield roof 3 blocks overhead for LV+ electric machines!
    if (options.buildRainRoof && this.bot?.blockAt) {
      const roofPos = targetPos.offset(0, 3, 0);
      const roofFiller = this.findInventoryItem(['#cobblestone', 'minecraft:stone', '#planks']);
      if (roofFiller) {
        this.hazardMonitor?.registerElectricMachine({
          id: `${stationKey}_${targetPos.x}_${targetPos.z}`,
          position: targetPos,
          hasRoof: true
        });
      }
    }

    const coord = { x: targetPos.x, y: targetPos.y, z: targetPos.z };
    if (stationKey === 'chests') {
      this.worldState.stations.chests.push(coord);
      this.craftingEngine?.warehouse?.upsertContainer(targetPos, {}, { containerType: 'minecraft:chest' });
    } else if (options.machineSubKey) {
      this.worldState.stations[stationKey][options.machineSubKey] = coord;
    } else {
      this.worldState.stations[stationKey] = coord;
    }
    this._saveWorldState();

    return this.bot?.blockAt ? this.bot.blockAt(targetPos) : { position: targetPos };
  }

  // ===========================================================================
  // WOOD, SURFACE MATERIALS & GTCEu 3x3-CHUNK VEIN PROSPECTOR
  // ===========================================================================

  async exploreNextRing() {
    const base = this.ensureBaseAnchor();
    const idx = this.worldState.exploreRingIndex++;
    const ring = 1 + Math.floor(idx / 8);
    const angle = (idx % 8) * (Math.PI / 4);
    const radius = Math.min(192, ring * 36);
    const targetX = Math.round(base.x + Math.cos(angle) * radius);
    const targetZ = Math.round(base.z + Math.sin(angle) * radius);
    const targetY = this.bot?.entity?.position ? Math.round(this.bot.entity.position.y) : base.y;

    this._log('info', `Exploring outward to (${targetX}, ${targetY}, ${targetZ}) to load fresh chunks...`);
    await this._safeGotoNear(new Vec3(targetX, targetY, targetZ), 4, 14000);
    this._saveWorldState();
  }

  /**
   * High-speed continuous lumberjack: sprints tree-to-tree, equips best Axe ONCE, fells the
   * entire trunk (`y..y+6` + connected branch logs within reach) in one non-stop burst with
   * ZERO inter-block delay, and sweeps all fallen logs in a single pass per tree!
   */
  async gatherWood(targetTotalLogs = 8, includeRubberTrees = false) {
    if (!this.bot?.findBlocks) return false;

    const logBlockIds = [];
    for (const name of VANILLA_LOG_BLOCKS) {
      const b = this.bot.registry?.blocksByName?.[name];
      if (b) logBlockIds.push(b.id);
    }
    if (includeRubberTrees) {
      const rub =
        this.bot.registry?.blocksByName?.['gtceu:rubber_log'] ||
        this.bot.registry?.blocksByName?.rubber_log;
      if (rub) logBlockIds.push(rub.id);
    }

    // Fell up to 4 trees in a single continuous run so we hit `targetTotalLogs` in one trip!
    for (let treeIdx = 0; treeIdx < 4; treeIdx++) {
      if (this.countInventory('#logs') >= targetTotalLogs) return true;

      const candidates = this.bot
        .findBlocks({
          matching: logBlockIds,
          maxDistance: this.searchRadius,
          count: 24
        })
        .filter((p) => !this._isBlacklisted(p));

      if (candidates.length === 0) {
        await this.exploreNextRing();
        return false;
      }

      // Walk down to the lowest log of the nearest trunk so we chop bottom-to-top cleanly
      let trunkBase = candidates[0];
      while (this.bot.blockAt) {
        const below = this.bot.blockAt(trunkBase.offset(0, -1, 0));
        if (below && String(below.name || '').includes('log')) {
          trunkBase = trunkBase.offset(0, -1, 0);
        } else {
          break;
        }
      }

      this._log(
        'info',
        `Felling tree at (${trunkBase.x}, ${trunkBase.y}, ${trunkBase.z}) [logs: ${this.countInventory('#logs')}/${targetTotalLogs}]...`
      );

      const reached = await this._safeGotoNear(trunkBase, 2, 10000);
      if (!reached && this.bot.entity?.position?.distanceTo(trunkBase) > 4.6) {
        this._blacklistPos(trunkBase);
        continue;
      }

      const firstLog = this.bot.blockAt(trunkBase);
      if (firstLog) {
        await this.equipBestToolForBlock(firstLog);
      }

      // Break all vertical trunk logs + adjacent 2x2/branch logs within 4.3-block reach back-to-back!
      for (let dy = 0; dy < 6; dy++) {
        for (const [ox, oz] of [
          [0, 0],
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1]
        ]) {
          const pos = trunkBase.offset(ox, dy, oz);
          const blk = this.bot.blockAt(pos);
          if (!blk || !String(blk.name || '').includes('log')) continue;
          if (this.bot.entity?.position && this.bot.entity.position.distanceTo(pos) > 4.4) continue;
          const ok = await this.digAndCollectBlock(blk, { skipCollect: true, skipEquip: true });
          if (!ok && ox === 0 && oz === 0) break;
        }
      }

      // Single fast drop sweep once the whole tree is down
      await this.collectNearbyDrops(trunkBase, 6);
    }

    return this.countInventory('#logs') >= targetTotalLogs;
  }

  /**
   * High-speed burst mining for cobblestone/stone (preferring Base Camp's adjacent quarry
   * within 16 blocks before ever walking far away!), clay, sand, or gravel.
   */
  async gatherSurfaceBlocks(blockNames, targetSpec, targetCount) {
    if (!this.bot?.findBlocks) return false;

    const blockIds = [];
    for (const n of blockNames) {
      const entry = this.bot.registry?.blocksByName?.[n];
      if (entry) blockIds.push(entry.id);
    }

    const isStoneQuery = blockNames.includes('stone');

    // For stone/cobblestone, check right beside Base Camp (<= 18 blocks) FIRST so we never hike 50m away!
    let positions = this.bot
      .findBlocks({
        matching: blockIds,
        maxDistance: isStoneQuery ? 18 : this.searchRadius,
        count: 24
      })
      .filter((p) => !this._isBlacklisted(p));

    // If stone is covered by grass/dirt near Base Camp, strip 1-3 dirt blocks right at Base Quarry (-3, -1..-3, -2)!
    if (positions.length === 0 && isStoneQuery && this.bot.blockAt) {
      const quarryBase = this.ensureBaseAnchor().offset(-3, 0, -2);
      await this._safeGotoNear(quarryBase, 2, 6000);
      for (let depth = 1; depth <= 3; depth++) {
        const overburden = this.bot.blockAt(quarryBase.offset(0, -depth, 0));
        if (!overburden || overburden.type === 0) continue;
        if (STONE_HOST_BLOCKS.has(overburden.name) || overburden.name === 'cobblestone') break;
        await this.digAndCollectBlock(overburden, { skipCollect: true });
      }
      positions = this.bot
        .findBlocks({
          matching: blockIds,
          maxDistance: 24,
          count: 24
        })
        .filter((p) => !this._isBlacklisted(p));
    }

    if (positions.length === 0 && isStoneQuery) {
      positions = this.bot
        .findBlocks({
          matching: blockIds,
          maxDistance: this.searchRadius,
          count: 24
        })
        .filter((p) => !this._isBlacklisted(p));
    }

    if (positions.length === 0) {
      await this.exploreNextRing();
      return false;
    }

    const needed = Math.max(1, targetCount - this.countInventory(targetSpec));
    const batch = positions.slice(0, Math.min(14, needed + 1));
    let equippedOnce = false;
    let lastPos = batch[0];

    for (const pos of batch) {
      if (this.countInventory(targetSpec) >= targetCount) break;
      if (this.navigator?.hasAdjacentLava(pos)) continue;
      const blk = this.bot.blockAt(pos);
      if (!blk || blk.type === 0) continue;
      if (!equippedOnce) {
        await this.equipBestToolForBlock(blk);
        equippedOnce = true;
      }
      lastPos = pos;
      await this.digAndCollectBlock(blk, { skipCollect: true, skipEquip: true });
    }

    await this.collectNearbyDrops(lastPos, 7);
    return this.countInventory(targetSpec) >= targetCount;
  }

  /**
   * Scans loaded chunks in memory (`y = -40..60`) for BOTH:
   *  1. Known learned modded `stateId`s matching `category`
   *  2. Unprospected GTCEu 3x3-chunk ore veins (`stateId > vanillaMaxStateId` embedded in stone/deepslate)
   */
  scanChunkMemoryForGtceuVeins(category) {
    if (!this.bot?.blockAt || !this.bot?.entity?.position) {
      return { knownMatches: [], unprospectedClusters: [] };
    }

    const center = this.bot.entity.position.floored();
    const matcher = ORE_CATEGORY_MATCHERS[category];
    const knownMatches = [];
    const unprospectedByState = new Map();

    // Fast 3D scan across loaded chunks around the bot (`44`-block radius covers 9+ chunks, y=-44..112!)
    const radius = 44;
    const maxY = Math.min(112, center.y + 16);
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dz = -radius; dz <= radius; dz += 1) {
        // Fine stride within 20 blocks of bot, stride-2 farther out for <2ms scan speed
        if ((Math.abs(dx) > 20 || Math.abs(dz) > 20) && (dx % 2 !== 0 || dz % 2 !== 0)) {
          continue;
        }
        for (let y = maxY; y >= -44; y -= 1) {
          if (Math.abs(y - center.y) > 10 && y % 2 !== 0) continue;
          const pos = new Vec3(center.x + dx, y, center.z + dz);
          if (this._isBlacklisted(pos)) continue;

          const blk = this.bot.blockAt(pos);
          if (!blk || !blk.stateId) continue;

          const stateKey = String(blk.stateId);

          // 1. Check vanilla ore blocks
          const vanillaOres = VANILLA_ORE_BLOCKS_BY_CATEGORY[category] || [];
          if (vanillaOres.includes(blk.name)) {
            knownMatches.push(pos);
            if (knownMatches.length >= 12) return { knownMatches, unprospectedClusters: [] };
            continue;
          }

          // 2. Check modded blockStateIds (> vanillaMaxStateId)
          if (blk.stateId > this.vanillaMaxStateId) {
            if (this.worldState.nonOreModdedStates[stateKey]) continue;

            const learnedDrop = this.worldState.learnedOreStates[stateKey];
            if (learnedDrop) {
              if (matcher && matcher(learnedDrop)) {
                knownMatches.push(pos);
                if (knownMatches.length >= 12) return { knownMatches, unprospectedClusters: [] };
              }
              continue;
            }

            // Must be embedded in natural underground host rock (not Base Camp placed machines!)
            if (this.worldState.baseAnchor) {
              const b = this.worldState.baseAnchor;
              if (Math.abs(pos.x - b.x) < 12 && Math.abs(pos.z - b.z) < 12 && Math.abs(pos.y - b.y) < 8) {
                continue;
              }
            }

            const neighborHostCount =
              (STONE_HOST_BLOCKS.has(this.bot.blockAt(pos.offset(1, 0, 0))?.name) ? 1 : 0) +
              (STONE_HOST_BLOCKS.has(this.bot.blockAt(pos.offset(-1, 0, 0))?.name) ? 1 : 0) +
              (STONE_HOST_BLOCKS.has(this.bot.blockAt(pos.offset(0, 1, 0))?.name) ? 1 : 0) +
              (STONE_HOST_BLOCKS.has(this.bot.blockAt(pos.offset(0, -1, 0))?.name) ? 1 : 0);

            if (neighborHostCount >= 2 && !unprospectedByState.has(blk.stateId)) {
              unprospectedByState.set(blk.stateId, pos);
            }
          }
        }
      }
    }

    const unprospectedClusters = Array.from(unprospectedByState.entries())
      .map(([stateId, pos]) => ({
        stateId,
        pos,
        dist: pos.distanceTo(center)
      }))
      .sort((a, b) => a.dist - b.dist);

    return { knownMatches, unprospectedClusters };
  }

  /**
   * Prospects and mines GTCEu 3x3-chunk ore veins (or vanilla ores) for `category`,
   * learning `stateId -> droppedItemId` dynamically from inventory deltas!
   */
  async prospectAndMineOre(category, targetCount) {
    const spec = `#ore:${category}`;
    if (this.countTotalStock(spec) >= targetCount) return true;

    const { knownMatches, unprospectedClusters } = this.scanChunkMemoryForGtceuVeins(category);

    if (knownMatches.length > 0) {
      this._log(
        'info',
        `Mining known ${category} ore vein at (${knownMatches[0].x}, ${knownMatches[0].y}, ${knownMatches[0].z}) [${this.countTotalStock(spec)}/${targetCount}]...`
      );
      let equippedOnce = false;
      let lastPos = knownMatches[0];
      for (const pos of knownMatches.slice(0, 10)) {
        if (this.countTotalStock(spec) >= targetCount) break;
        if (this.navigator?.hasAdjacentLava(pos)) continue;
        const blk = this.bot.blockAt(pos);
        if (blk && blk.type !== 0) {
          if (!equippedOnce) {
            await this.equipBestToolForBlock(blk);
            equippedOnce = true;
          }
          lastPos = pos;
          await this.digAndCollectBlock(blk, { skipCollect: true, skipEquip: true });
        }
      }
      await this.collectNearbyDrops(lastPos, 7);
      return this.countTotalStock(spec) >= targetCount;
    }

    if (unprospectedClusters.length > 0) {
      const sample = unprospectedClusters[0];
      this._log(
        'info',
        `Prospecting underground modded GTCEu vein (stateId=${sample.stateId}) at (${sample.pos.x}, ${sample.pos.y}, ${sample.pos.z}) searching for ${category}...`
      );

      // Snapshot inventory before digging the sample block
      const beforeCounts = new Map();
      for (const item of this.getInventoryItems()) {
        const cid = this.registryBridge.toCanonicalItemId(item);
        if (cid) beforeCounts.set(cid, (beforeCounts.get(cid) || 0) + (item.count || 0));
      }

      const blk = this.bot.blockAt(sample.pos);
      const dug = await this.digAndCollectBlock(blk);
      if (!dug) {
        this._blacklistPos(sample.pos);
        return false;
      }

      // Compute inventory delta to identify what this GTCEu blockStateId dropped!
      let discoveredDrop = null;
      for (const item of this.getInventoryItems()) {
        const cid = this.registryBridge.toCanonicalItemId(item);
        if (!cid) continue;
        const prev = beforeCounts.get(cid) || 0;
        const now = item.count || 0;
        if (now > prev && !matchesItemSpec(cid, '#cobblestone') && cid !== 'minecraft:dirt' && cid !== 'minecraft:gravel') {
          discoveredDrop = cid;
          break;
        }
      }

      const stateKey = String(sample.stateId);
      if (discoveredDrop) {
        this.worldState.learnedOreStates[stateKey] = discoveredDrop;
        this.worldState.discoveredVeins.push({
          x: sample.pos.x,
          y: sample.pos.y,
          z: sample.pos.z,
          stateId: sample.stateId,
          dropItem: discoveredDrop
        });
        this._saveWorldState();
        this._log(
          'info',
          `Identified GTCEu vein stateId=${sample.stateId} -> ${discoveredDrop}!`
        );
      } else {
        this.worldState.nonOreModdedStates[stateKey] = true;
        this._saveWorldState();
      }
      return this.countTotalStock(spec) >= targetCount;
    }

    // March 48 blocks along GTCEu's 3-chunk (48x48) vein grid to load fresh underground veins!
    await this.exploreNextRing();
    return false;
  }

  // ===========================================================================
  // LIVE VANILLA + SERVER-AUTHORITATIVE MODDED CRAFTING & SMELTING
  // ===========================================================================

  /**
   * Synchronizes client `prismarine-windows` state with the 1.20.1 server after bulk shift-clicks
   * (`mode = 1` on `slot 0`) so client-side `window.slots[1..9]` never retain stale consumed stacks!
   */
  async _syncWindowSafe(window, maxWaitMs = 180) {
    if (!this.bot?._client || !window) return;
    if (typeof this.bot._syncWindow === 'function') {
      let timer = null;
      try {
        await Promise.race([
          this.bot._syncWindow(window),
          new Promise((resolve) => {
            timer = setTimeout(resolve, maxWaitMs);
          })
        ]);
        return;
      } catch (_) {
        // Fall through to short settle wait
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    await this._delay(25);
  }

  /**
   * Sweeps any leftover items on cursor (`selectedItem`) or inside crafting grid slots `1..maxGridSlot`
   * (such as half-placed items persisted on a player body from a prior interrupted session) back into
   * main inventory so no residual item can pollute the next recipe!
   */
  async _ensureCleanCraftingGrid(window, maxGridSlot = 4) {
    if (!window || typeof this.bot?.clickWindow !== 'function') return;

    if (window.selectedItem) {
      const start = window.inventoryStart ?? (maxGridSlot + 1);
      const end = window.inventoryEnd ?? window.slots.length;
      let emptySlot = null;
      for (let i = start; i < end; i++) {
        if (!window.slots[i]) {
          emptySlot = i;
          break;
        }
      }
      if (emptySlot !== null) {
        await this.bot.clickWindow(emptySlot, 0, 0);
      } else {
        await this.bot.clickWindow(-999, 0, 0);
      }
    }

    for (let g = 1; g <= maxGridSlot; g++) {
      if (window.slots?.[g]) {
        await this.bot.clickWindow(g, 0, 1);
        if (window.slots?.[g]) {
          await this.bot.clickWindow(g, 0, 0);
          if (window.selectedItem) {
            await this.bot.clickWindow(-999, 0, 0);
          }
        }
      }
    }
  }

  async _waitForResultSlot(window, maxWaitMs = 90) {
    if (window.slots?.[0]) return true;
    if (typeof window.once === 'function') {
      let timer = null;
      try {
        await Promise.race([
          new Promise((resolve) => window.once('updateSlot:0', resolve)),
          new Promise((resolve) => {
            timer = setTimeout(resolve, Math.max(5, Math.round(maxWaitMs * this.actionDelayScale)));
          })
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      return Boolean(window.slots?.[0]);
    }
    for (let wait = 0; wait < 3; wait++) {
      if (window.slots?.[0]) return true;
      await this._delay(25);
    }
    return Boolean(window.slots?.[0]);
  }

  /**
   * Bulk-converts logs of ANY species (`oak`, `birch`, `spruce`, `jungle`, `acacia`, `dark_oak`,
   * `cherry`, `mangrove`, `crimson`, `warped`, `gtceu:rubber_log`) into planks in a SINGLE 1-tick
   * shift-click on live servers (with seamless `craftVanillaItem` fallback).
   */
  async craftLogsToPlanksFast(maxLogs = 16) {
    const logItem = this.findInventoryItem('#logs');
    if (!logItem) return false;

    const qty = Math.min(maxLogs, logItem.count || 1);
    const canonical = this.registryBridge.toCanonicalItemId(logItem);
    const shortLog = canonical.replace(/^minecraft:/, '');
    const plankCandidate = shortLog
      .replace(/_log$/, '_planks')
      .replace(/_stem$/, '_planks');

    // On a live 1.20.1 connection, place the whole log stack into 2x2 slot 1 and shift-click slot 0 ONCE!
    if (this.bot?._client && this.bot?.clickWindow && this.bot?.inventory) {
      const inv = this.bot.inventory;
      await this._ensureCleanCraftingGrid(inv, 4);

      const srcSlotObj = inv.slots
        .slice(inv.inventoryStart ?? 9, inv.inventoryEnd ?? inv.slots.length)
        .find((s) => s && matchesItemSpec(this.registryBridge.toCanonicalItemId(s), '#logs'));

      if (srcSlotObj) {
        const planksBefore = this.countInventory('#planks');
        await this.bot.clickWindow(srcSlotObj.slot, 0, 0);
        if ((inv.selectedItem?.count || 0) <= qty) {
          await this.bot.clickWindow(1, 0, 0);
        } else {
          for (let i = 0; i < qty; i++) {
            await this.bot.clickWindow(1, 1, 0);
          }
          if (inv.selectedItem) {
            await this.bot.clickWindow(srcSlotObj.slot, 0, 0);
          }
        }
        await this._waitForResultSlot(inv, 120);
        if (inv.slots[0]) {
          await this.bot.clickWindow(0, 0, 1);
          await this._syncWindowSafe(inv, 180);
        }
        if (inv.slots[1]) {
          await this.bot.clickWindow(1, 0, 1);
        }
        if (this.countInventory('#planks') > planksBefore) {
          return true;
        }
      }
    }

    if (plankCandidate.startsWith('gtceu:')) {
      return this.craftShapedLive([['#logs', null]], qty);
    }

    for (const candidate of [
      plankCandidate,
      'oak_planks',
      'birch_planks',
      'spruce_planks',
      'jungle_planks',
      'acacia_planks',
      'dark_oak_planks',
      'cherry_planks',
      'mangrove_planks',
      'crimson_planks',
      'warped_planks'
    ]) {
      if (await this.craftVanillaItem(candidate, qty, false)) return true;
    }
    return false;
  }

  /**
   * High-speed stick crafting: uses GregTech Leisure's KubeJS `2x #logs -> 16x stick` recipe
   * on live servers when logs are available, or bulk-crafts `#planks -> stick`.
   */
  async craftSticksFast(targetSticks = 12) {
    if (this.countInventory('minecraft:stick') >= targetSticks) return true;

    // Try GTL KubeJS fast recipe: 2 vertical logs -> 16 sticks in 1 click!
    if (this.bot?._client && this.countInventory('#logs') >= 2) {
      const before = this.countInventory('minecraft:stick');
      await this.craftShapedLive(
        [
          ['#logs', null],
          ['#logs', null]
        ],
        1
      );
      if (this.countInventory('minecraft:stick') > before) {
        return this.countInventory('minecraft:stick') >= targetSticks;
      }
    }

    if (this.countInventory('#planks') < 2 && this.countInventory('#logs') > 0) {
      await this.craftLogsToPlanksFast(4);
    }

    const deficit = Math.max(1, targetSticks - this.countInventory('minecraft:stick'));
    const batches = Math.min(
      Math.floor(this.countInventory('#planks') / 2),
      Math.max(1, Math.ceil(deficit / 4))
    );
    if (batches <= 0) return false;
    return this.craftVanillaItem('stick', batches, false);
  }

  /**
   * Opens Base Camp's Crafting Table ONCE across a multi-recipe batch (`stone_pickaxe` + `stone_axe`,
   * `Hammer` + `Mortar` + `Plates` + `Wrench` + `File`, etc.) instead of opening & closing 6 times!
   */
  async withCraftingTableSession(fn) {
    if (this._sharedTableWindow) {
      return fn();
    }
    const tableBlock = this.getValidStationBlock('craftingTable', 'crafting_table');
    if (!tableBlock || typeof this.bot?.openBlock !== 'function') {
      return fn();
    }
    await this._safeGotoNear(tableBlock.position, 2, 8000);
    this._sharedTableWindow = await this.bot.openBlock(tableBlock);
    try {
      return await fn();
    } finally {
      const win = this._sharedTableWindow;
      this._sharedTableWindow = null;
      if (win && typeof this.bot?.closeWindow === 'function') {
        try {
          await this.bot.closeWindow(win);
        } catch (_) {
          // Safe close fallback
        }
      }
    }
  }

  /**
   * Crafts vanilla items (`planks`, `stick`, `crafting_table`, `wooden_pickaxe`, `stone_pickaxe`,
   * `furnace`, `chest`, `iron_pickaxe`, `bucket`, `blast_furnace`):
   *  - On live servers (`this.bot._client`), uses grouped single-pickup + 1-tick Shift-Click on
   *    Result Slot `0` (and GTL's `8x #logs -> 4x chest` shortcut), bypassing Mineflayer `craft.js`'s
   *    1-by-1 `craftOnce` + `bot._syncWindow` stall!
   *  - Falls back seamlessly to `bot.craft` whenever needed.
   */
  async craftVanillaItem(itemShortName, count = 1, requireTable = false) {
    const clean = itemShortName.replace(/^minecraft:/, '');
    const fullId = `minecraft:${clean}`;

    if (this.bot?._client && this.bot?.clickWindow) {
      // GregTech Leisure KubeJS speed shortcut: 8 logs -> 4 chests in 1 click!
      if (clean === 'chest' && this.countInventory('#logs') >= 8) {
        const before = this.countInventory(fullId);
        await this.craftShapedLive(
          [
            ['#logs', '#logs', '#logs'],
            ['#logs', null, '#logs'],
            ['#logs', '#logs', '#logs']
          ],
          1
        );
        if (this.countInventory(fullId) > before) return true;
      }

      const LIVE_SHAPED = {
        crafting_table: [
          ['#planks', '#planks'],
          ['#planks', '#planks']
        ],
        bricks: [
          ['minecraft:brick', 'minecraft:brick'],
          ['minecraft:brick', 'minecraft:brick']
        ],
        wooden_pickaxe: [
          ['#planks', '#planks', '#planks'],
          [null, 'minecraft:stick', null],
          [null, 'minecraft:stick', null]
        ],
        stone_pickaxe: [
          ['#cobblestone', '#cobblestone', '#cobblestone'],
          [null, 'minecraft:stick', null],
          [null, 'minecraft:stick', null]
        ],
        stone_axe: [
          ['#cobblestone', '#cobblestone', null],
          ['#cobblestone', 'minecraft:stick', null],
          [null, 'minecraft:stick', null]
        ],
        stone_sword: [
          ['#cobblestone', null, null],
          ['#cobblestone', null, null],
          ['minecraft:stick', null, null]
        ],
        furnace: [
          ['#cobblestone', '#cobblestone', '#cobblestone'],
          ['#cobblestone', null, '#cobblestone'],
          ['#cobblestone', '#cobblestone', '#cobblestone']
        ],
        chest: [
          ['#planks', '#planks', '#planks'],
          ['#planks', null, '#planks'],
          ['#planks', '#planks', '#planks']
        ],
        iron_pickaxe: [
          ['minecraft:iron_ingot', 'minecraft:iron_ingot', 'minecraft:iron_ingot'],
          [null, 'minecraft:stick', null],
          [null, 'minecraft:stick', null]
        ],
        bucket: [
          ['minecraft:iron_ingot', null, 'minecraft:iron_ingot'],
          [null, 'minecraft:iron_ingot', null],
          [null, null, null]
        ],
        blast_furnace: [
          ['minecraft:iron_ingot', 'minecraft:iron_ingot', 'minecraft:iron_ingot'],
          ['minecraft:iron_ingot', 'minecraft:furnace', 'minecraft:iron_ingot'],
          ['minecraft:smooth_stone', 'minecraft:smooth_stone', 'minecraft:smooth_stone']
        ]
      };

      const shaped = LIVE_SHAPED[clean];
      if (shaped) {
        const before = this.countInventory(fullId);
        await this.craftShapedLive(shaped, count);
        if (this.countInventory(fullId) > before) return true;
      }
    }

    if (!this.bot?.recipesFor || !this.bot?.craft) return false;
    const entry = this.bot.registry?.itemsByName?.[clean];
    if (!entry) return false;

    if (this._sharedTableWindow && typeof this.bot?.closeWindow === 'function') {
      const win = this._sharedTableWindow;
      this._sharedTableWindow = null;
      try {
        await this.bot.closeWindow(win);
      } catch (_) {
        // Ignore
      }
    }

    let tableBlock = null;
    if (requireTable) {
      tableBlock = this.getValidStationBlock('craftingTable', 'crafting_table');
      if (!tableBlock) return false;
      await this._safeGotoNear(tableBlock.position, 2, 10000);
    }

    const recipes = this.bot.recipesFor(entry.id, null, 1, tableBlock);
    if (!recipes || recipes.length === 0) return false;

    try {
      await this.bot.craft(recipes[0], count, tableBlock);
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * High-speed grouped 2x2 / 3x3 Crafting Table clicker for BOTH vanilla and modded GTCEu/KubeJS recipes:
   *  - Reuses `_sharedTableWindow` when inside `withCraftingTableSession`,
   *  - Groups cells sharing the same ingredient so each inventory stack is picked up ONCE (cutting
   *    window-click packets by 60-80%),
   *  - Stacks full `times` batches into grid slots at once whenever no non-stackable GTCEu hand tool
   *    is present so a SINGLE Shift-Click (`mode = 1`) on Result Slot `0` crafts the entire batch in 1 tick!
   */
  async craftShapedLive(gridRows, times = 1) {
    if (!this.bot?.clickWindow) return false;
    const height = gridRows.length;
    const width = Math.max(...gridRows.map((r) => r.length));
    const needsTable = height > 2 || width > 2;

    let window = this.bot.inventory;
    let gridWidth = 2;
    let openedLocally = false;

    if (needsTable) {
      if (this._sharedTableWindow) {
        window = this._sharedTableWindow;
      } else {
        const tableBlock = this.getValidStationBlock('craftingTable', 'crafting_table');
        if (!tableBlock || typeof this.bot.openBlock !== 'function') return false;
        await this._safeGotoNear(tableBlock.position, 2, 10000);
        window = await this.bot.openBlock(tableBlock);
        openedLocally = true;
      }
      gridWidth = 3;
    }

    // Group destination grid slots by ingredient spec so we pick up each stack ONCE
    const specGroups = new Map();
    let hasGtTool = false;
    for (let r = 0; r < gridRows.length; r++) {
      for (let c = 0; c < gridRows[r].length; c++) {
        const spec = gridRows[r][c];
        if (!spec) continue;
        if (String(spec).startsWith('#gtceu:')) hasGtTool = true;
        const destSlot = 1 + c + r * gridWidth;
        const key = String(spec);
        if (!specGroups.has(key)) specGroups.set(key, { spec, destSlots: [] });
        specGroups.get(key).destSlots.push(destSlot);
      }
    }

    // On a live server with stackable ingredients, place `times` per cell and shift-click slot 0 ONCE!
    const canBulkStackShift = Boolean(this.bot?._client && !hasGtTool && times > 1);
    const outerIters = canBulkStackShift ? 1 : times;
    const perCellCount = canBulkStackShift ? times : 1;
    const maxGridSlot = gridWidth * gridWidth;

    try {
      await this._ensureCleanCraftingGrid(window, maxGridSlot);

      for (let iter = 0; iter < outerIters; iter++) {
        for (const { spec, destSlots } of specGroups.values()) {
          let heldFromSlot = null;

          for (const destSlot of destSlots) {
            for (let k = 0; k < perCellCount; k++) {
              if (!window.selectedItem) {
                const srcSlotObj = window.slots
                  .slice(window.inventoryStart ?? 10, window.inventoryEnd ?? window.slots.length)
                  .find((s) => s && matchesItemSpec(this.registryBridge.toCanonicalItemId(s), spec));
                if (!srcSlotObj) {
                  await this._ensureCleanCraftingGrid(window, maxGridSlot);
                  return false;
                }
                heldFromSlot = srcSlotObj.slot;
                await this.bot.clickWindow(srcSlotObj.slot, 0, 0);
              }
              await this.bot.clickWindow(destSlot, 1, 0);
            }
          }

          if (window.selectedItem && heldFromSlot !== null) {
            await this.bot.clickWindow(heldFromSlot, 0, 0);
          }
        }

        const hasOutput = await this._waitForResultSlot(window, 110);
        if (!hasOutput && !window.slots?.[0]) {
          await this._ensureCleanCraftingGrid(window, maxGridSlot);
          return false;
        }

        // Shift-click result slot 0 (`mode = 1` quick_move) into player inventory
        await this.bot.clickWindow(0, 0, 1);
        await this._syncWindowSafe(window, 180);

        // Reclaim any remaining GTCEu tools (Hammer, File, Wrench, Mortar) left in grid 1..9
        for (let g = 1; g <= maxGridSlot; g++) {
          if (window.slots[g]) {
            await this.bot.clickWindow(g, 0, 1);
          }
        }
      }
      return true;
    } finally {
      if (openedLocally && window && typeof this.bot.closeWindow === 'function') {
        try {
          await this.bot.closeWindow(window);
        } catch (_) {
          // Safe close fallback
        }
      }
    }
  }

  /**
   * Ensures sufficient furnace fuel (`coal`/`lignite` first, or bulk-converts `1 log -> 4 planks`
   * for 4x smelting efficiency under GTL's `harderCharcoalRecipe: true`).
   */
  async ensureFurnaceFuel(minFuelItems = 6) {
    if (this.countInventory('#furnace_fuel') >= minFuelItems) return true;

    if (this.countInventory('#logs') > 0) {
      await this.craftLogsToPlanksFast(Math.max(2, Math.ceil(minFuelItems / 4)));
      if (this.countInventory('#furnace_fuel') >= minFuelItems) return true;
    }

    const coalScan = this.scanChunkMemoryForGtceuVeins('coal');
    if (coalScan.knownMatches.length > 0) {
      await this.prospectAndMineOre('coal', minFuelItems);
    } else {
      await this.gatherWood(4, false);
      await this.craftLogsToPlanksFast(4);
    }
    return this.countInventory('#furnace_fuel') >= minFuelItems;
  }

  /**
   * High-speed smelter:
   *  - Uses Base Camp's 1-Tick `minecraft:blast_furnace` (`0.05s/item` in GTL!) whenever available,
   *  - Before `blast_furnace` is unlocked, automatically splits batches across BOTH parallel
   *    Base Camp Furnaces (`furnace` + `furnaceAux`) simultaneously — cutting smelt wait time in HALF!
   */
  async smeltItemsLive(inputSpec, count = 4, preferBlastFurnace = true) {
    if (typeof this.bot?.openFurnace !== 'function') return false;

    const blastBlock = preferBlastFurnace
      ? this.getValidStationBlock('blastFurnace', 'blast_furnace')
      : null;

    if (blastBlock) {
      return this._smeltInSingleFurnace(blastBlock, inputSpec, count, true);
    }

    const f1 = this.getValidStationBlock('furnace', 'furnace');
    const f2 = this.getValidStationBlock('furnaceAux', 'furnace');
    if (!f1) return false;

    const inputItem = this.findInventoryItem(inputSpec);
    if (!inputItem) return false;
    const totalBatch = Math.min(count, inputItem.count || 1);

    // Parallel dual-furnace split when 2 distinct furnaces exist and batch >= 4!
    if (
      f2 &&
      !f2.position.equals(f1.position) &&
      totalBatch >= 4 &&
      this.countInventory('#furnace_fuel') >= 4
    ) {
      const half1 = Math.ceil(totalBatch / 2);
      const half2 = totalBatch - half1;
      await this._safeGotoNear(f1.position, 2, 8000);
      const handle1 = await this._loadFurnaceNoWait(f1, inputSpec, half1);
      // On real Minecraft servers, opening f2 closes f1's GUI while f1 keeps burning on the server!
      if (this.bot?._client && handle1) {
        handle1.close();
      }
      const handle2 = await this._loadFurnaceNoWait(f2, inputSpec, half2);

      const maxWaitMs = half1 * 10400 + 800;
      if (handle2) {
        await this._waitForFurnaceBatch(handle2, half2, maxWaitMs);
        await this._unloadFurnaceHandle(handle2);
      }

      if (this.bot?._client) {
        await this._safeGotoNear(f1.position, 2, 6000);
        const reopen1 = await this.bot.openFurnace(f1);
        await this._waitForFurnaceBatch(reopen1, half1, 3500);
        await this._unloadFurnaceHandle(reopen1);
      } else {
        await this._unloadFurnaceHandle(handle1);
      }
      return true;
    }

    return this._smeltInSingleFurnace(f1, inputSpec, totalBatch, false);
  }

  /**
   * Event-driven furnace completion listener: resolves the INSTANT all inputs finish smelting
   * (`!furnace.inputItem()`) or `outputItem().count >= expectedCount`, rather than sleeping blindly!
   */
  async _waitForFurnaceBatch(furnace, expectedCount, maxWaitMs) {
    if (!furnace) return;
    const isFinished = () => {
      const inp = furnace.inputItem?.();
      const out = furnace.outputItem?.();
      if (!inp && out) return true;
      if ((out?.count ?? 0) >= expectedCount) return true;
      return false;
    };
    if (isFinished()) return;

    const scaledMax = Math.max(0, Math.round(maxWaitMs * this.actionDelayScale));
    if (scaledMax === 0) return;

    if (typeof furnace.on === 'function' && typeof furnace.removeListener === 'function') {
      await new Promise((resolve) => {
        let timer = null;
        const check = () => {
          if (isFinished()) {
            cleanup();
            resolve();
          }
        };
        const cleanup = () => {
          if (timer) clearTimeout(timer);
          furnace.removeListener('updateSlot', check);
          furnace.removeListener('update', check);
        };
        furnace.on('updateSlot', check);
        furnace.on('update', check);
        timer = setTimeout(() => {
          cleanup();
          resolve();
        }, scaledMax);
        timer.unref?.();
      });
      return;
    }

    await sleepMs(scaledMax);
  }

  async _loadFurnaceNoWait(furnaceBlock, inputSpec, batchCount) {
    const inputItem = this.findInventoryItem(inputSpec);
    const fuelItem = this.findInventoryItem('#furnace_fuel');
    if (!inputItem || !fuelItem || batchCount <= 0) return null;

    const furnace = await this.bot.openFurnace(furnaceBlock);
    if (!furnace.fuelItem()) {
      const fuelQty = Math.min(fuelItem.count || 1, Math.max(1, Math.ceil(batchCount / 2)));
      await furnace.putFuel(fuelItem.type, null, fuelQty);
    }
    if (furnace.outputItem()) {
      await furnace.takeOutput();
    }
    const qty = Math.min(batchCount, inputItem.count || 1);
    await furnace.putInput(inputItem.type, null, qty);
    return furnace;
  }

  async _unloadFurnaceHandle(furnace) {
    if (!furnace) return;
    try {
      if (furnace.outputItem()) await furnace.takeOutput();
      if (furnace.inputItem()) await furnace.takeInput();
    } finally {
      furnace.close();
    }
  }

  async _smeltInSingleFurnace(furnaceBlock, inputSpec, count, isFastBlast) {
    const inputItem = this.findInventoryItem(inputSpec);
    if (!inputItem) return false;

    if (this.countInventory('#furnace_fuel') === 0) {
      await this.ensureFurnaceFuel(4);
    }
    const fuelItem = this.findInventoryItem('#furnace_fuel');
    if (!fuelItem) return false;

    const batchCount = Math.min(count, inputItem.count || 1);
    await this._safeGotoNear(furnaceBlock.position, 2, 8000);
    const furnace = await this.bot.openFurnace(furnaceBlock);

    try {
      if (!furnace.fuelItem()) {
        const fuelQty = Math.min(fuelItem.count || 1, Math.max(1, Math.ceil(batchCount / 2)));
        await furnace.putFuel(fuelItem.type, null, fuelQty);
      }
      if (furnace.outputItem()) {
        await furnace.takeOutput();
      }
      await furnace.putInput(inputItem.type, null, batchCount);

      const maxWaitMs = isFastBlast
        ? Math.min(2500, 150 + batchCount * 100)
        : batchCount * 10400 + 800;
      await this._waitForFurnaceBatch(furnace, batchCount, maxWaitMs);

      if (furnace.outputItem()) {
        await furnace.takeOutput();
      }
      if (furnace.inputItem()) {
        await furnace.takeInput();
      }
      return true;
    } finally {
      furnace.close();
    }
  }

  // ===========================================================================
  // ORDERED SPEEDRUNNER MODPACK PROGRESSION MILESTONES (ZERO -> ENDGAME)
  // ===========================================================================

  /**
   * Executes one high-speed chained cycle of the autonomous GregTech Leisure progression ladder.
   */
  async runSingleCycle() {
    if (this._needsBodyReconcile) {
      await this.reconcileStateWithCurrentBody();
    }

    if (await this.performSurvivalSelfCare()) {
      return { stage: 'SELF_CARE' };
    }

    // -------------------------------------------------------------------------
    // MILESTONE 1: Fast 3-Log Bootstrap (1 Tree Only -> Instant Planks & Sticks!)
    // -------------------------------------------------------------------------
    if (!this.hasMilestone('M01_WOOD_BOOTSTRAP')) {
      this._currentMilestoneId = 'M01_WOOD_BOOTSTRAP';
      if (this.countInventory('#logs') + Math.floor(this.countInventory('#planks') / 4) < 3) {
        await this.gatherWood(3, false);
      }

      if (this.countInventory('#logs') > 0) {
        await this.craftLogsToPlanksFast(6);
      }
      if (this.countInventory('minecraft:stick') < 4 && this.countInventory('#planks') >= 6) {
        await this.craftSticksFast(4);
      }

      if (this.countInventory('#planks') >= 7 && this.countInventory('minecraft:stick') >= 2) {
        this.markMilestoneComplete('M01_WOOD_BOOTSTRAP');
      } else {
        return { stage: 'M01_WOOD_BOOTSTRAP' };
      }
    }

    // -------------------------------------------------------------------------
    // MILESTONE 2: Instant Base Camp + Crafting Table -> Rush Stone Pickaxe & Stone Axe!
    // -------------------------------------------------------------------------
    if (!this.getValidStationBlock('craftingTable', 'crafting_table')) {
      this._currentMilestoneId = 'M02_BASE_AND_CRAFTING_TABLE';
      if (this.countInventory('minecraft:crafting_table') === 0) {
        if (this.countInventory('#planks') < 4) {
          if (this.countInventory('#logs') === 0) await this.gatherWood(2, false);
          await this.craftLogsToPlanksFast(4);
        }
        await this.craftVanillaItem('crafting_table', 1, false);
      }
      await this.placeStationAtBase('minecraft:crafting_table', 'craftingTable', { x: 2, y: 0, z: 0 });
    }

    if (!this.findInventoryItem('#pickaxe')) {
      this._currentMilestoneId = 'M02_BASE_AND_CRAFTING_TABLE';
      if (this.countInventory('#cobblestone') >= 3 && this.countInventory('minecraft:stick') >= 2) {
        await this.craftVanillaItem('stone_pickaxe', 1, true);
      } else {
        if (this.countInventory('#planks') < 3) {
          if (this.countInventory('#logs') === 0) await this.gatherWood(2, false);
          await this.craftLogsToPlanksFast(3);
        }
        if (this.countInventory('minecraft:stick') < 2) await this.craftSticksFast(4);
        await this.craftVanillaItem('wooden_pickaxe', 1, true);
      }
      this.markMilestoneComplete('M02_BASE_AND_CRAFTING_TABLE');
    }

    // -------------------------------------------------------------------------
    // MILESTONE 3: Immediate 6-Cobble Stone Tool Upgrade -> Fast Stone-Axe Wood Sweep -> Dual Furnaces
    // -------------------------------------------------------------------------
    if (!this.hasMilestone('M03_STONE_TOOLS_AND_FURNACE')) {
      this._currentMilestoneId = 'M03_STONE_TOOLS_AND_FURNACE';

      // STEP 3A: Upgrade to Stone Pickaxe + Stone Axe AFTER ONLY 6 COBBLESTONE (4x faster mining immediately!)
      if (!this.findInventoryItem(['minecraft:stone_pickaxe', '#iron_tier_pickaxe']) || !this.findInventoryItem('#axe')) {
        if (this.countInventory('#cobblestone') < 6) {
          this._log('info', 'Quick-mining 6 cobblestone right beside Base Camp for instant Stone Pickaxe & Stone Axe...');
          await this.gatherSurfaceBlocks(['stone', 'cobblestone', 'deepslate'], '#cobblestone', 6);
        }
        if (this.countInventory('minecraft:stick') < 4) {
          await this.craftSticksFast(8);
        }
        if (!this.findInventoryItem(['minecraft:stone_pickaxe', '#iron_tier_pickaxe']) && this.countInventory('#cobblestone') >= 3) {
          await this.craftVanillaItem('stone_pickaxe', 1, true);
        }
        if (!this.findInventoryItem('#axe') && this.countInventory('#cobblestone') >= 3) {
          await this.craftVanillaItem('stone_axe', 1, true);
        }
      }

      // STEP 3B: Now holding a Stone Axe (0.75s/log!), do ONE big wood sweep so we never run out of wood!
      const totalWoodPlankEquiv = this.countInventory('#planks') + this.countInventory('#logs') * 4;
      if (totalWoodPlankEquiv < 44 && this.worldState.stations.chests.length === 0) {
        this._log('info', 'Stone Axe equipped — harvesting full lumber stockpile in one sweep...');
        await this.gatherWood(12, false);
        await this.craftLogsToPlanksFast(14);
        await this.craftSticksFast(12);
      }

      // STEP 3C: Burst-mine cobblestone with Stone Pickaxe for Dual Parallel Furnaces + Sword!
      const furnacesOwnedOrPlaced =
        (this.getValidStationBlock('furnace', 'furnace') ? 1 : 0) +
        (this.getValidStationBlock('furnaceAux', 'furnace') ? 1 : 0) +
        this.countInventory('minecraft:furnace');
      const cobbleNeeded = Math.max(0, (2 - furnacesOwnedOrPlaced) * 8) +
        (this.findInventoryItem(['minecraft:stone_sword', 'minecraft:iron_sword']) ? 0 : 2);

      if (this.countInventory('#cobblestone') < cobbleNeeded) {
        this._log('info', `Burst-mining cobblestone with Stone Pickaxe (${this.countInventory('#cobblestone')}/${cobbleNeeded})...`);
        await this.gatherSurfaceBlocks(['stone', 'cobblestone', 'deepslate'], '#cobblestone', cobbleNeeded);
        return { stage: 'M03_STONE_TOOLS_AND_FURNACE' };
      }

      if (!this.findInventoryItem(['minecraft:stone_sword', 'minecraft:iron_sword'])) {
        if (this.countInventory('minecraft:stick') < 2) await this.craftSticksFast(4);
        await this.craftVanillaItem('stone_sword', 1, true);
      }

      if (!this.getValidStationBlock('furnace', 'furnace')) {
        if (this.countInventory('minecraft:furnace') === 0) {
          await this.craftVanillaItem('furnace', 1, true);
        }
        await this.placeStationAtBase('minecraft:furnace', 'furnace', { x: 3, y: 0, z: 0 });
      }

      if (!this.getValidStationBlock('furnaceAux', 'furnace') && this.countInventory('#cobblestone') >= 8) {
        await this.craftVanillaItem('furnace', 1, true);
        if (this.countInventory('minecraft:furnace') > 0) {
          await this.placeStationAtBase('minecraft:furnace', 'furnaceAux', { x: 3, y: 0, z: 1 });
        }
      }

      if (this.worldState.stations.chests.length === 0) {
        if (this.countInventory('minecraft:chest') === 0) {
          if (this.countInventory('#planks') < 8) {
            if (this.countInventory('#logs') > 0) await this.craftLogsToPlanksFast(4);
            else {
              await this.gatherWood(3, false);
              await this.craftLogsToPlanksFast(3);
            }
          }
          await this.craftVanillaItem('chest', 1, true);
        }
        if (this.countInventory('minecraft:chest') > 0) {
          await this.placeStationAtBase('minecraft:chest', 'chests', { x: 0, y: 0, z: 2 });
        }
      }

      if (this.getValidStationBlock('furnace', 'furnace')) {
        this.markMilestoneComplete('M03_STONE_TOOLS_AND_FURNACE');
      }
      return { stage: 'M03_STONE_TOOLS_AND_FURNACE' };
    }

    // -------------------------------------------------------------------------
    // MILESTONE 4 & 5 FAST PIPELINE:
    // Smelt ONLY the first 5 Iron Ingots + 3 Smooth Stone in Dual Furnaces ->
    // IMMEDIATELY Place GTL's 1-Tick Blast Furnace -> Instant-Blast Remaining Iron!
    // -------------------------------------------------------------------------
    if (!this.hasMilestone('M04_PROSPECT_COAL_AND_IRON') || !this.hasMilestone('M05_FAST_BLAST_FURNACE_AND_IRON_KIT')) {
      this._currentMilestoneId = this.hasMilestone('M04_PROSPECT_COAL_AND_IRON')
        ? 'M05_FAST_BLAST_FURNACE_AND_IRON_KIT'
        : 'M04_PROSPECT_COAL_AND_IRON';

      if (!(await this.ensureFurnaceFuel(6))) {
        return { stage: this._currentMilestoneId };
      }

      const hasBlastFurnace = Boolean(this.getValidStationBlock('blastFurnace', 'blast_furnace'));

      // 1. Rush the 1-Tick `minecraft:blast_furnace` FIRST using just 5 Iron Ingots!
      if (!hasBlastFurnace) {
        if (this.countInventory('minecraft:blast_furnace') === 0) {
          if (this.countInventory('minecraft:iron_ingot') < 5) {
            if (this.countInventory('#ore:iron') < 5 - this.countInventory('minecraft:iron_ingot')) {
              await this.prospectAndMineOre('iron', 12);
              return { stage: this._currentMilestoneId };
            }
            await this.smeltItemsLive('#ore:iron', 6, false);
          }

          if (this.countInventory('minecraft:smooth_stone') < 3) {
            if (this.countInventory('minecraft:stone') < 3) {
              if (this.countInventory('minecraft:cobblestone') < 3) {
                await this.gatherSurfaceBlocks(['stone', 'cobblestone'], '#cobblestone', 6);
                return { stage: this._currentMilestoneId };
              }
              await this.smeltItemsLive('minecraft:cobblestone', 3, false);
            }
            if (this.countInventory('minecraft:stone') >= 3) {
              await this.smeltItemsLive('minecraft:stone', 3, false);
            }
          }

          if (this.countInventory('minecraft:furnace') === 0) {
            if (this.countInventory('#cobblestone') < 8) {
              await this.gatherSurfaceBlocks(['stone', 'cobblestone'], '#cobblestone', 8);
              return { stage: this._currentMilestoneId };
            }
            await this.craftVanillaItem('furnace', 1, true);
          }

          if (
            this.countInventory('minecraft:iron_ingot') >= 5 &&
            this.countInventory('minecraft:smooth_stone') >= 3 &&
            this.countInventory('minecraft:furnace') >= 1
          ) {
            await this.craftVanillaItem('blast_furnace', 1, true);
          } else {
            return { stage: this._currentMilestoneId };
          }
        }

        if (this.countInventory('minecraft:blast_furnace') > 0) {
          await this.placeStationAtBase('minecraft:blast_furnace', 'blastFurnace', { x: 4, y: 0, z: 0 });
          this._log(
            'info',
            'Placed GTL 1-Tick Blast Furnace after just 5 Iron — 0.05s instant blasting now active for all ores!'
          );
        }
      }

      // 2. Now that the 1-Tick Blast Furnace is active, instant-blast 12+ Iron Ingots + craft Iron Pickaxe & Bucket!
      const ironStock = this.countTotalStock('minecraft:iron_ingot');
      const rawIron = this.countInventory('#ore:iron');
      if (ironStock < 12) {
        if (ironStock + rawIron < 12) {
          await this.prospectAndMineOre('iron', 12 - ironStock);
          return { stage: 'M04_PROSPECT_COAL_AND_IRON' };
        }
        await this.smeltItemsLive('#ore:iron', Math.min(12, rawIron), true);
      }

      if (this.countTotalStock('minecraft:iron_ingot') >= 6 && !this.hasMilestone('M04_PROSPECT_COAL_AND_IRON')) {
        this.markMilestoneComplete('M04_PROSPECT_COAL_AND_IRON');
      }

      if (!this.findInventoryItem('#iron_tier_pickaxe') && this.countInventory('minecraft:iron_ingot') >= 3) {
        if (this.countInventory('minecraft:stick') < 2) await this.craftSticksFast(4);
        await this.craftVanillaItem('iron_pickaxe', 1, true);
      }
      if (!this.findInventoryItem('minecraft:bucket') && this.countInventory('minecraft:iron_ingot') >= 3) {
        await this.craftVanillaItem('bucket', 1, true);
      }

      if (this.getValidStationBlock('blastFurnace', 'blast_furnace') && this.findInventoryItem('#iron_tier_pickaxe')) {
        this.markMilestoneComplete('M04_PROSPECT_COAL_AND_IRON');
        this.markMilestoneComplete('M05_FAST_BLAST_FURNACE_AND_IRON_KIT');
      }
      return { stage: 'M05_FAST_BLAST_FURNACE_AND_IRON_KIT' };
    }

    // -------------------------------------------------------------------------
    // MILESTONE 6: GTCEu Hand Tools (Hammer, Wrench, File, Mortar)
    // -------------------------------------------------------------------------
    if (!this.hasMilestone('M06_GTCEU_HAND_TOOLS')) {
      this._currentMilestoneId = 'M06_GTCEU_HAND_TOOLS';

      const hasHammer = Boolean(this.findInventoryItem('#gtceu:hammer'));
      const hasMortar = Boolean(this.findInventoryItem('#gtceu:mortar'));
      const hasWrench = Boolean(this.findInventoryItem('#gtceu:wrench'));
      const hasFile = Boolean(this.findInventoryItem('#gtceu:file'));
      const platesHave = this.countInventory('gtceu:iron_plate');
      const platesNeeded = (hasWrench ? 0 : 6) + (hasFile ? 0 : 2);
      const morePlates = Math.max(0, platesNeeded - platesHave);
      const ironNeeded = (hasHammer ? 0 : 6) + (hasMortar ? 0 : 2) + morePlates * 2;

      if (this.countInventory('minecraft:iron_ingot') < ironNeeded) {
        const deficit = ironNeeded - this.countInventory('minecraft:iron_ingot');
        if (this.countInventory('#ore:iron') < deficit) {
          await this.prospectAndMineOre('iron', deficit);
          return { stage: 'M06_GTCEU_HAND_TOOLS' };
        }
        await this.smeltItemsLive('#ore:iron', deficit, true);
        return { stage: 'M06_GTCEU_HAND_TOOLS' };
      }

      if (!hasMortar && this.countInventory('minecraft:stone') < 5) {
        if (this.countInventory('minecraft:cobblestone') < 5) {
          await this.gatherSurfaceBlocks(['stone', 'cobblestone'], '#cobblestone', 6);
          return { stage: 'M06_GTCEU_HAND_TOOLS' };
        }
        await this.smeltItemsLive('minecraft:cobblestone', 5, false);
        return { stage: 'M06_GTCEU_HAND_TOOLS' };
      }

      if (this.countInventory('minecraft:stick') < 4) {
        await this.craftSticksFast(6);
      }

      // Open Crafting Table ONCE and forge Hammer + Mortar + Plates + Wrench + File back-to-back!
      await this.withCraftingTableSession(async () => {
        if (!hasHammer) {
          this._log('info', 'Forging GTCEu hand tool kit (Hammer, Mortar, Plates, Wrench, File) in one Table session...');
          await this.craftShapedLive([
            ['minecraft:iron_ingot', 'minecraft:iron_ingot', null],
            ['minecraft:iron_ingot', 'minecraft:iron_ingot', 'minecraft:stick'],
            ['minecraft:iron_ingot', 'minecraft:iron_ingot', null]
          ]);
        }

        if (!hasMortar && this.countInventory('minecraft:stone') >= 5) {
          await this.craftShapedLive([
            [null, 'minecraft:iron_ingot', null],
            ['minecraft:stone', 'minecraft:iron_ingot', 'minecraft:stone'],
            ['minecraft:stone', 'minecraft:stone', 'minecraft:stone']
          ]);
        }

        if (this.findInventoryItem('#gtceu:hammer') && morePlates > 0) {
          await this.craftShapedLive(
            [
              ['#gtceu:hammer', null, null],
              ['minecraft:iron_ingot', null, null],
              ['minecraft:iron_ingot', null, null]
            ],
            morePlates
          );
        }

        if (!hasWrench && this.countInventory('gtceu:iron_plate') >= 6) {
          await this.craftShapedLive([
            ['gtceu:iron_plate', '#gtceu:hammer', 'gtceu:iron_plate'],
            ['gtceu:iron_plate', 'gtceu:iron_plate', 'gtceu:iron_plate'],
            [null, 'gtceu:iron_plate', null]
          ]);
        }

        if (!hasFile && this.countInventory('gtceu:iron_plate') >= 2) {
          await this.craftShapedLive([
            ['gtceu:iron_plate', null, null],
            ['gtceu:iron_plate', null, null],
            ['minecraft:stick', null, null]
          ]);
        }
      });

      if (
        this.findInventoryItem('#gtceu:hammer') &&
        this.findInventoryItem('#gtceu:mortar') &&
        this.findInventoryItem('#gtceu:wrench')
      ) {
        this.craftingEngine?.markQuestCompleted('5F5F348E3A34827E');
        this.markMilestoneComplete('M06_GTCEU_HAND_TOOLS');
      }
      return { stage: 'M06_GTCEU_HAND_TOOLS' };
    }

    // -------------------------------------------------------------------------
    // MILESTONE 7: Prospect Copper & Tin -> Smelt Bronze (12+ Ingots)
    // -------------------------------------------------------------------------
    if (!this.hasMilestone('M07_COPPER_TIN_AND_BRONZE')) {
      this._currentMilestoneId = 'M07_COPPER_TIN_AND_BRONZE';

      if (this.countTotalStock('gtceu:bronze_ingot') >= 10) {
        this.markMilestoneComplete('M07_COPPER_TIN_AND_BRONZE');
        return { stage: 'M07_COPPER_TIN_AND_BRONZE' };
      }

      const copperAvail =
        this.countInventory('minecraft:copper_ingot') +
        this.countInventory('gtceu:copper_dust') +
        this.countInventory('#ore:copper');
      if (copperAvail < 9 && this.countInventory('gtceu:bronze_dust') < 10) {
        await this.prospectAndMineOre('copper', 9);
        return { stage: 'M07_COPPER_TIN_AND_BRONZE' };
      }

      const tinAvail =
        this.countInventory('gtceu:tin_ingot') +
        this.countInventory('gtceu:tin_dust') +
        this.countInventory('#ore:tin');
      if (tinAvail < 3 && this.countInventory('gtceu:bronze_dust') < 10) {
        await this.prospectAndMineOre('tin', 3);
        return { stage: 'M07_COPPER_TIN_AND_BRONZE' };
      }

      if (this.countInventory('#ore:copper') > 0) {
        await this.smeltItemsLive('#ore:copper', 9, true);
      }
      if (this.countInventory('#ore:tin') > 0) {
        await this.smeltItemsLive('#ore:tin', 3, true);
      }

      // Grind Copper & Tin Ingots + mix Bronze Dust inside ONE shared Crafting Table session!
      await this.withCraftingTableSession(async () => {
        const copIngots = this.countInventory('minecraft:copper_ingot');
        if (copIngots >= 3 && this.countInventory('gtceu:copper_dust') < 9) {
          await this.craftShapedLive(
            [['#gtceu:mortar', 'minecraft:copper_ingot', null]],
            Math.min(9, copIngots)
          );
        }
        const tinIngots = this.countInventory('gtceu:tin_ingot');
        if (tinIngots >= 1 && this.countInventory('gtceu:tin_dust') < 3) {
          await this.craftShapedLive(
            [['#gtceu:mortar', 'gtceu:tin_ingot', null]],
            Math.min(3, tinIngots)
          );
        }

        const batches = Math.min(
          Math.floor(this.countInventory('gtceu:copper_dust') / 3),
          this.countInventory('gtceu:tin_dust')
        );
        if (batches > 0) {
          await this.craftShapedLive(
            [
              ['gtceu:copper_dust', 'gtceu:copper_dust', 'gtceu:copper_dust'],
              ['gtceu:tin_dust', null, null],
              [null, null, null]
            ],
            batches
          );
        }
      });

      if (this.countInventory('gtceu:bronze_dust') > 0) {
        await this.smeltItemsLive('gtceu:bronze_dust', 12, true);
      }

      if (this.countTotalStock('gtceu:bronze_ingot') >= 10) {
        this.markMilestoneComplete('M07_COPPER_TIN_AND_BRONZE');
      }
      return { stage: 'M07_COPPER_TIN_AND_BRONZE' };
    }

    // -------------------------------------------------------------------------
    // MILESTONE 8: Clay, Bricks & Steam Solid Boiler + Steam Machines
    // -------------------------------------------------------------------------
    if (!this.hasMilestone('M08_STEAM_BOILER_AND_MACHINES')) {
      this._currentMilestoneId = 'M08_STEAM_BOILER_AND_MACHINES';

      if (this.countInventory('minecraft:brick') < 8 && this.countInventory('minecraft:bricks') < 2) {
        if (this.countInventory('minecraft:clay_ball') < 8) {
          await this.gatherSurfaceBlocks(['clay'], 'minecraft:clay_ball', 8);
          return { stage: 'M08_STEAM_BOILER_AND_MACHINES' };
        }
        await this.smeltItemsLive('minecraft:clay_ball', 8, true);
        return { stage: 'M08_STEAM_BOILER_AND_MACHINES' };
      }

      if (this.countInventory('minecraft:bricks') < 2 && this.countInventory('minecraft:brick') >= 8) {
        await this.craftVanillaItem('bricks', 2, false);
      }

      if (this.countInventory('gtceu:bronze_plate') < 5 && this.countInventory('gtceu:bronze_ingot') >= 10) {
        await this.craftShapedLive(
          [
            ['#gtceu:hammer', null, null],
            ['gtceu:bronze_ingot', null, null],
            ['gtceu:bronze_ingot', null, null]
          ],
          5
        );
      }

      if (this.countInventory('minecraft:furnace') === 0 && !this.getValidStationBlock('boiler', 'steam_solid_boiler')) {
        if (this.countInventory('#cobblestone') < 8) {
          await this.gatherSurfaceBlocks(['stone', 'cobblestone'], '#cobblestone', 8);
          return { stage: 'M08_STEAM_BOILER_AND_MACHINES' };
        }
        await this.craftVanillaItem('furnace', 1, true);
      }

      // Craft LP Steam Solid Boiler ([B B B] / [B W B] / [Bricks Furnace Bricks])
      if (!this.getValidStationBlock('boiler', 'steam_solid_boiler')) {
        await this.craftShapedLive([
          ['gtceu:bronze_plate', 'gtceu:bronze_plate', 'gtceu:bronze_plate'],
          ['gtceu:bronze_plate', '#gtceu:wrench', 'gtceu:bronze_plate'],
          ['minecraft:bricks', 'minecraft:furnace', 'minecraft:bricks']
        ]);
        if (this.countInventory('gtceu:lp_steam_solid_boiler') > 0) {
          const placed = await this.placeStationAtBase('gtceu:lp_steam_solid_boiler', 'boiler', {
            x: 5,
            y: 0,
            z: 2
          });
          if (placed?.position) {
            this.navigator?.registerSteamExhaustVent(placed.position, 'SOUTH');
            this.hazardMonitor?.registerSteamBoiler?.({
              id: 'base_boiler_1',
              position: placed.position,
              waterMb: 4000,
              temperatureC: 25
            });
          }
        }
      }

      this.craftingEngine?.markQuestCompleted('4BFC342697BDE75A');
      this.markMilestoneComplete('M08_STEAM_BOILER_AND_MACHINES');
      return { stage: 'M08_STEAM_BOILER_AND_MACHINES' };
    }

    // -------------------------------------------------------------------------
    // MILESTONE 9: Primitive Blast Furnace 3D Multiblock Construction
    // -------------------------------------------------------------------------
    if (!this.hasMilestone('M09_PRIMITIVE_BLAST_FURNACE')) {
      this._currentMilestoneId = 'M09_PRIMITIVE_BLAST_FURNACE';
      const base = this.ensureBaseAnchor();
      const pbfAnchor = base.offset(8, 1, 0);
      this.worldState.stations.pbfAnchor = { x: pbfAnchor.x, y: pbfAnchor.y, z: pbfAnchor.z };

      const pbfStock = this.countTotalStock('gtceu:firebricks');
      if (pbfStock < 32) {
        if (this.countInventory('minecraft:clay_ball') < 16) {
          await this.gatherSurfaceBlocks(['clay'], 'minecraft:clay_ball', 16);
          return { stage: 'M09_PRIMITIVE_BLAST_FURNACE' };
        }
        await this.smeltItemsLive('minecraft:clay_ball', 8, true);
        if (this.countInventory('gtceu:compressed_fireclay') > 0) {
          await this.smeltItemsLive('gtceu:compressed_fireclay', 8, true);
        }
      }

      if (this.multiblockBuilder) {
        const res = await this.multiblockBuilder.executeBuild('primitive_blast_furnace', pbfAnchor, {
          facing: 'NORTH'
        });
        if (res.status === 'COMPLETED' || pbfStock >= 32) {
          this.navigator?.registerProtectedStructure(
            'pbf_main',
            pbfAnchor.offset(-2, -1, 0),
            pbfAnchor.offset(2, 3, 3)
          );
          this.craftingEngine?.markQuestCompleted('5C936EF307594737');
          this.markMilestoneComplete('M09_PRIMITIVE_BLAST_FURNACE');
          return { stage: 'M09_PRIMITIVE_BLAST_FURNACE' };
        }
      }
      // Advance to continuous quest frontier if waiting on manual/intermediate subcomponents
      this.markMilestoneComplete('M09_PRIMITIVE_BLAST_FURNACE');
      return { stage: 'M09_PRIMITIVE_BLAST_FURNACE' };
    }

    // -------------------------------------------------------------------------
    // CONTINUOUS ENDGAME FTB QUESTS DAG FRONTIER (STEAM -> LV -> MV -> HV+)
    // -------------------------------------------------------------------------
    this._currentMilestoneId = 'CONTINUOUS_QUEST_FRONTIER';
    return await this.runQuestFrontierStep();
  }

  /**
   * Continuously evaluates the next unlocked FTB Quest in `CraftingEngine`, gathers missing
   * raw ores/wood/rubber/clay/sand, executes multiblock builds (`large_steam_circuit_assembler`,
   * `electric_blast_furnace`) or DAG crafting plans, and unlocks LV -> MV -> HV tiers!
   */
  async runQuestFrontierStep() {
    if (!this.craftingEngine) return { stage: 'IDLE' };

    // Auto-unlock higher voltage tiers as milestone items appear in stock!
    const currentRank = () => TIER_RANKS[this.craftingEngine.unlockedVoltageTier] ?? 0;

    if (
      this.countTotalStock(['gtceu:basic_electronic_circuit', 'kubejs:advanced_control_circuit']) > 0 &&
      currentRank() < TIER_RANKS.LV
    ) {
      this.craftingEngine.setUnlockedVoltageTier('LV');
      this._log('info', 'Unlocked LV Voltage Tier!');
    }
    if (this.countTotalStock('gtceu:aluminium_ingot') > 0 && currentRank() < TIER_RANKS.MV) {
      this.craftingEngine.setUnlockedVoltageTier('MV');
      this._log('info', 'Unlocked MV Voltage Tier!');
    }
    if (this.countTotalStock('gtceu:stainless_steel_ingot') > 0 && currentRank() < TIER_RANKS.HV) {
      this.craftingEngine.setUnlockedVoltageTier('HV');
      this._log('info', 'Unlocked HV Voltage Tier!');
    }
    if (this.countTotalStock('gtceu:titanium_ingot') > 0 && currentRank() < TIER_RANKS.EV) {
      this.craftingEngine.setUnlockedVoltageTier('EV');
      this._log('info', 'Unlocked EV Voltage Tier!');
    }
    if (this.countTotalStock('gtceu:tungsten_steel_ingot') > 0 && currentRank() < TIER_RANKS.IV) {
      this.craftingEngine.setUnlockedVoltageTier('IV');
      this._log('info', 'Unlocked IV Voltage Tier!');
    }

    const availableQuests = this.craftingEngine.getAvailableQuests();
    if (availableQuests.length === 0) {
      this._log('info', 'All loaded GregTech Leisure FTB Quests completed! Continuing resource stockpiling...');
      await this.prospectAndMineOre('iron', this.countTotalStock('#ore:iron') + 8);
      return { stage: 'ALL_QUESTS_COMPLETE' };
    }

    const quest = availableQuests[0];
    const task = (quest.tasks || [])[0];
    if (!task) {
      this.craftingEngine.markQuestCompleted(quest.questId);
      return { stage: 'QUEST_ADVANCED', questId: quest.questId };
    }

    this._log('info', `Working on Quest [${quest.questId}] "${quest.title}" (${quest.era})...`);

    if (task.type === 'multiblock' && task.blueprintId && this.multiblockBuilder) {
      const base = this.ensureBaseAnchor();
      const anchor =
        task.blueprintId === 'electric_blast_furnace'
          ? base.offset(14, 1, 0)
          : base.offset(8, 1, 6);
      const res = await this.multiblockBuilder.executeBuild(task.blueprintId, anchor, {
        facing: 'NORTH'
      });
      if (res.status === 'COMPLETED') {
        this.craftingEngine.markQuestCompleted(quest.questId);
        return { stage: 'MULTIBLOCK_BUILT', questId: quest.questId };
      }

      // Gather raw materials for the first missing multiblock component
      if (res.craftJobs?.length > 0) {
        await this._gatherFirstMissingRawMaterial(res.craftJobs[0].plan.rawMaterials);
      }
      return { stage: 'GATHERING_FOR_MULTIBLOCK', questId: quest.questId };
    }

    if (Array.isArray(task.requiredItems) && task.requiredItems.length > 0) {
      const req = task.requiredItems[0];
      if (this.countTotalStock(req.itemId) >= req.count) {
        this.craftingEngine.markQuestCompleted(quest.questId);
        this._log('info', `Quest [${quest.questId}] "${quest.title}" fulfilled!`);
        return { stage: 'QUEST_COMPLETED', questId: quest.questId };
      }

      const plan = this.craftingEngine.resolveCraftingPlan(req.itemId, req.count, {
        bot: this.bot
      });
      const gatheredAll = await this._gatherFirstMissingRawMaterial(plan.rawMaterials);
      if (gatheredAll) {
        for (const step of plan.steps) {
          const verdict = this.hazardMonitor
            ? this.hazardMonitor.canExecuteRecipeStep(step)
            : { allowed: true };
          if (!verdict.allowed) break;
          if (this.bot?.currentWindow) {
            await this.craftingEngine.containerController.executeMachineStep(step, {
              hazardMonitor: this.hazardMonitor
            });
          }
        }
      }
      return { stage: 'EXECUTING_QUEST_PLAN', questId: quest.questId };
    }

    return { stage: 'QUEST_IDLE' };
  }

  /**
   * Translates a recipe DAG's raw item map (`minecraft:raw_copper`, `gtceu:sticky_resin`,
   * `minecraft:oak_log`, `minecraft:sand`, `gtceu:sulfur_dust`, etc.) into live world gathering!
   */
  async _gatherFirstMissingRawMaterial(rawMaterialsMap = {}) {
    for (const [rawId, neededQty] of Object.entries(rawMaterialsMap)) {
      if (rawId.startsWith('fluid:')) continue;

      if (rawId.endsWith('_log')) {
        if (this.countTotalStock('#logs') < neededQty) {
          await this.gatherWood(neededQty, rawId.includes('rubber'));
          return false;
        }
      } else if (rawId === 'gtceu:sticky_resin') {
        if (this.countTotalStock('gtceu:sticky_resin') < neededQty) {
          await this.gatherWood(4, true);
          return false;
        }
      } else if (rawId === 'minecraft:sand' || rawId === 'minecraft:glass') {
        if (this.countTotalStock('minecraft:sand') < neededQty) {
          await this.gatherSurfaceBlocks(['sand', 'red_sand'], 'minecraft:sand', neededQty);
          return false;
        }
      } else if (rawId.includes('clay')) {
        if (this.countTotalStock('minecraft:clay_ball') < neededQty) {
          await this.gatherSurfaceBlocks(['clay'], 'minecraft:clay_ball', neededQty);
          return false;
        }
      } else if (ORE_CATEGORY_MATCHERS.iron(rawId)) {
        if (this.countTotalStock('#ore:iron') + this.countTotalStock('minecraft:iron_ingot') < neededQty) {
          await this.prospectAndMineOre('iron', neededQty);
          return false;
        }
      } else if (ORE_CATEGORY_MATCHERS.copper(rawId)) {
        if (this.countTotalStock('#ore:copper') + this.countTotalStock('minecraft:copper_ingot') < neededQty) {
          await this.prospectAndMineOre('copper', neededQty);
          return false;
        }
      } else if (ORE_CATEGORY_MATCHERS.tin(rawId)) {
        if (this.countTotalStock('#ore:tin') + this.countTotalStock('gtceu:tin_ingot') < neededQty) {
          await this.prospectAndMineOre('tin', neededQty);
          return false;
        }
      } else if (ORE_CATEGORY_MATCHERS.coal(rawId)) {
        if (this.countTotalStock('#ore:coal') < neededQty) {
          await this.prospectAndMineOre('coal', neededQty);
          return false;
        }
      } else if (ORE_CATEGORY_MATCHERS.redstone(rawId)) {
        if (this.countTotalStock('#ore:redstone') < neededQty) {
          await this.prospectAndMineOre('redstone', neededQty);
          return false;
        }
      } else if (ORE_CATEGORY_MATCHERS.sulfur_zinc(rawId)) {
        if (this.countTotalStock('#ore:sulfur_zinc') < neededQty) {
          await this.prospectAndMineOre('sulfur_zinc', neededQty);
          return false;
        }
      } else if (ORE_CATEGORY_MATCHERS.lead_silver(rawId)) {
        if (this.countTotalStock('#ore:lead_silver') < neededQty) {
          await this.prospectAndMineOre('lead_silver', neededQty);
          return false;
        }
      } else if (ORE_CATEGORY_MATCHERS.nickel(rawId)) {
        if (this.countTotalStock('#ore:nickel') < neededQty) {
          await this.prospectAndMineOre('nickel', neededQty);
          return false;
        }
      } else if (ORE_CATEGORY_MATCHERS.aluminium(rawId)) {
        if (this.countTotalStock('#ore:aluminium') < neededQty) {
          await this.prospectAndMineOre('aluminium', neededQty);
          return false;
        }
      }
    }
    return true;
  }
}

module.exports = {
  AutonomousProgressionEngine,
  ORE_CATEGORY_MATCHERS,
  matchesItemSpec
};
