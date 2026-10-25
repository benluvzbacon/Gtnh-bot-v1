'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const Vec3 = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const { normalizeItemId } = require('../protocol/forgeHandshake');

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
    this.navigator = navigator;
    this.craftingEngine = craftingEngine;
    this.multiblockBuilder = multiblockBuilder;
    this.hazardMonitor = hazardMonitor;
    this.registryBridge = registryBridge;

    this.stateFilePath =
      options.stateFilePath ??
      path.resolve(process.cwd(), '.gtl-runtime-state.json');
    this.persistState = options.persistState ?? true;
    this.stepIntervalMs = options.stepIntervalMs ?? 650;
    this.searchRadius = options.searchRadius ?? 64;
    this.actionDelayScale = options.actionDelayScale ?? 1;

    this.vanillaMaxStateId = this._computeVanillaMaxStateId();

    this.worldState = {
      baseAnchor: null,
      stations: {
        craftingTable: null,
        furnace: null,
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

  /**
   * Starts continuous autonomous survival progression on the live Mineflayer bot.
   */
  start() {
    if (this._running) return;
    this._running = true;

    this._log(
      'info',
      'Autonomous GregTech Leisure progression loop ENGAGED — goal: beat the modpack from scratch!'
    );

    if (typeof this.bot?.on === 'function') {
      this._onDeath = () => {
        this._log('warn', 'Bot died! Waiting for respawn to recover and continue progression...');
        this.navigator?.stop();
      };
      this._onRespawn = () => {
        this._log('info', 'Respawned in survival world — resuming autonomous progression!');
      };
      this.bot.on('death', this._onDeath);
      this.bot.on('spawn', this._onRespawn);
    }

    const tick = async () => {
      if (!this._running) return;
      if (!this._loopBusy) {
        this._loopBusy = true;
        try {
          await this.runSingleCycle();
        } catch (err) {
          this._log('warn', `Recovered from cycle interruption: ${err.message}`);
        } finally {
          this._loopBusy = false;
        }
      }
      if (this._running) {
        this._loopTimer = setTimeout(tick, this.stepIntervalMs);
        this._loopTimer.unref?.();
      }
    };

    this._loopTimer = setTimeout(tick, 250);
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
   * Handles hunger, nearby creepers/hostiles, and rain/hazard checks before every progression step.
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
   * Walks over nearby dropped item entities so mined logs/ores/cobblestone enter `bot.inventory`.
   */
  async collectNearbyDrops(centerPos, radius = 7) {
    if (!this.bot?.entities || !this.bot?.entity) return;
    await this._delay(220);

    const origin = centerPos
      ? new Vec3(centerPos.x, centerPos.y, centerPos.z)
      : this.bot.entity.position;

    const drops = Object.values(this.bot.entities)
      .filter((ent) => {
        if (!ent || !ent.position) return false;
        const n = String(ent.name || ent.objectType || '').toLowerCase();
        const isItem = n === 'item' || n === 'minecraft:item' || ent.type === 'object';
        return isItem && ent.position.distanceTo(origin) <= radius;
      })
      .sort((a, b) => a.position.distanceTo(origin) - b.position.distanceTo(origin))
      .slice(0, 6);

    for (const drop of drops) {
      if (!this.bot.entities[drop.id]) continue;
      await this._safeGotoNear(drop.position, 1, 5000);
      await this._delay(180);
    }
  }

  async digAndCollectBlock(block) {
    if (!block || !this.bot) return false;
    const targetPos = block.position.clone();
    const reached = await this._safeGotoNear(targetPos, 3, 14000);
    if (!reached && this.bot.entity?.position?.distanceTo(targetPos) > 4.6) {
      this._blacklistPos(targetPos);
      return false;
    }

    const freshBlock = this.bot.blockAt ? this.bot.blockAt(targetPos) : block;
    if (!freshBlock || freshBlock.name === 'air' || freshBlock.type === 0) {
      return true;
    }

    await this.equipBestToolForBlock(freshBlock);
    if (typeof this.bot.dig === 'function') {
      try {
        await this.bot.dig(freshBlock);
      } catch (_) {
        this._blacklistPos(targetPos, 60000);
        return false;
      }
    }
    await this.collectNearbyDrops(targetPos, 6);
    return true;
  }

  /**
   * Establishes (or validates) a flat, dry Base Camp anchor near spawn.
   */
  ensureBaseAnchor() {
    if (this.worldState.baseAnchor) {
      // Verify the saved base anchor is within reasonable distance or in loaded world
      const saved = this.worldState.baseAnchor;
      const myPos = this.bot?.entity?.position;
      if (!myPos || myPos.distanceTo(new Vec3(saved.x, saved.y, saved.z)) < 512) {
        return new Vec3(saved.x, saved.y, saved.z);
      }
    }

    const origin = this.bot?.entity?.position
      ? this.bot.entity.position.floored()
      : new Vec3(0, 64, 0);

    let bestPos = origin;
    if (typeof this.bot?.blockAt === 'function') {
      outer: for (let r = 0; r <= 12; r += 2) {
        for (let dx = -r; dx <= r; dx += 2) {
          for (let dz = -r; dz <= r; dz += 2) {
            for (let dy = 4; dy >= -6; dy--) {
              const cand = origin.offset(dx, dy, dz);
              const ground = this.bot.blockAt(cand.offset(0, -1, 0));
              const feet = this.bot.blockAt(cand);
              const head = this.bot.blockAt(cand.offset(0, 1, 0));
              if (
                ground &&
                ground.boundingBox === 'block' &&
                !String(ground.name || '').includes('leaves') &&
                feet &&
                feet.boundingBox === 'empty' &&
                !String(feet.name || '').includes('water') &&
                head &&
                head.boundingBox === 'empty'
              ) {
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

    await this._delay(200);

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
   * Finds and chops full tree trunks (including rubber trees when needed) and picks up dropped logs.
   */
  async gatherWood(targetTotalLogs = 8, includeRubberTrees = false) {
    if (!this.bot?.findBlocks) return false;

    const logBlockIds = [];
    for (const name of VANILLA_LOG_BLOCKS) {
      const b = this.bot.registry?.blocksByName?.[name];
      if (b) logBlockIds.push(b.id);
    }
    if (includeRubberTrees) {
      const rub = this.bot.registry?.blocksByName?.['gtceu:rubber_log'] ||
        this.bot.registry?.blocksByName?.rubber_log;
      if (rub) logBlockIds.push(rub.id);
    }

    const candidates = this.bot
      .findBlocks({
        matching: logBlockIds,
        maxDistance: this.searchRadius,
        count: 16
      })
      .filter((p) => !this._isBlacklisted(p));

    if (candidates.length === 0) {
      await this.exploreNextRing();
      return false;
    }

    const trunkBase = candidates[0];
    this._log(
      'info',
      `Chopping tree at (${trunkBase.x}, ${trunkBase.y}, ${trunkBase.z}) [logs: ${this.countInventory('#logs')}/${targetTotalLogs}]...`
    );

    // Chop up to 5 vertical trunk blocks from bottom to top
    for (let dy = 0; dy < 5; dy++) {
      const pos = trunkBase.offset(0, dy, 0);
      const blk = this.bot.blockAt(pos);
      if (!blk || !String(blk.name || '').includes('log')) break;
      const ok = await this.digAndCollectBlock(blk);
      if (!ok) break;
    }

    await this.collectNearbyDrops(trunkBase, 7);
    return this.countInventory('#logs') >= targetTotalLogs;
  }

  /**
   * Mines cobblestone / stone (uncovering dirt/grass overburden if needed), clay, sand, or gravel.
   */
  async gatherSurfaceBlocks(blockNames, targetSpec, targetCount) {
    if (!this.bot?.findBlocks) return false;

    const blockIds = [];
    for (const n of blockNames) {
      const entry = this.bot.registry?.blocksByName?.[n];
      if (entry) blockIds.push(entry.id);
    }

    let positions = this.bot
      .findBlocks({
        matching: blockIds,
        maxDistance: this.searchRadius,
        count: 24
      })
      .filter((p) => !this._isBlacklisted(p));

    // If mining stone/cobblestone in grassy plains where stone is 2-3 blocks under dirt, dig down 3 blocks near Base!
    if (positions.length === 0 && blockNames.includes('stone') && this.bot.blockAt) {
      const quarrySpot = this.ensureBaseAnchor().offset(-5, -1, -5);
      const topBlk = this.bot.blockAt(quarrySpot);
      if (topBlk && (topBlk.name === 'grass_block' || topBlk.name === 'dirt')) {
        await this.digAndCollectBlock(topBlk);
        positions = this.bot
          .findBlocks({
            matching: blockIds,
            maxDistance: 24,
            count: 12
          })
          .filter((p) => !this._isBlacklisted(p));
      }
    }

    if (positions.length === 0) {
      await this.exploreNextRing();
      return false;
    }

    const batch = positions.slice(0, Math.min(8, Math.max(2, targetCount - this.countInventory(targetSpec))));
    for (const pos of batch) {
      if (this.countInventory(targetSpec) >= targetCount) break;
      // Skip blocks adjacent to lava/water when mining underground stone
      if (this.navigator?.hasAdjacentLava(pos)) continue;
      const blk = this.bot.blockAt(pos);
      if (!blk || blk.type === 0) continue;
      await this.digAndCollectBlock(blk);
    }

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
      for (const pos of knownMatches.slice(0, 8)) {
        if (this.countTotalStock(spec) >= targetCount) break;
        if (this.navigator?.hasAdjacentLava(pos)) continue;
        const blk = this.bot.blockAt(pos);
        if (blk && blk.type !== 0) {
          await this.digAndCollectBlock(blk);
        }
      }
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
   * Crafts vanilla items (`planks`, `stick`, `crafting_table`, `wooden_pickaxe`, `stone_pickaxe`,
   * `furnace`, `chest`, `iron_pickaxe`, `bucket`, `blast_furnace`) via Mineflayer's `bot.craft`.
   */
  async craftVanillaItem(itemShortName, count = 1, requireTable = false) {
    if (!this.bot?.recipesFor || !this.bot?.craft) return false;
    const clean = itemShortName.replace(/^minecraft:/, '');
    const entry = this.bot.registry?.itemsByName?.[clean];
    if (!entry) return false;

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
   * Crafts ANY vanilla OR modded (`gtceu:*` / `kubejs:*`) 2x2 or 3x3 shaped/shapeless recipe
   * directly on a live Crafting Table (or 2x2 inventory grid) by placing matched ingredients into
   * grid slots `1..9`, waiting for Forge 1.20.1's server-computed `ResultSlot` (`0`), shift-clicking
   * slot `0` into inventory, and reclaiming any remaining GTCEu hand tools from `1..9`!
   *
   * @param {Array<Array<string|null>>} gridRows - e.g. `[['minecraft:iron_ingot','minecraft:iron_ingot','minecraft:iron_ingot'],['minecraft:iron_ingot','minecraft:iron_ingot','minecraft:iron_ingot'],[null,'minecraft:stick',null]]`
   * @param {number} [times=1]
   */
  async craftShapedLive(gridRows, times = 1) {
    if (!this.bot?.clickWindow) return false;
    const height = gridRows.length;
    const width = Math.max(...gridRows.map((r) => r.length));
    const needsTable = height > 2 || width > 2;

    let window = this.bot.inventory;
    let gridWidth = 2;
    let openedTableWindow = null;

    if (needsTable) {
      const tableBlock = this.getValidStationBlock('craftingTable', 'crafting_table');
      if (!tableBlock || typeof this.bot.openBlock !== 'function') return false;
      await this._safeGotoNear(tableBlock.position, 2, 10000);
      openedTableWindow = await this.bot.openBlock(tableBlock);
      window = openedTableWindow;
      gridWidth = 3;
    }

    try {
      for (let iter = 0; iter < times; iter++) {
        // Place each non-null cell 1 item at a time into crafting grid slots 1..(gridWidth*gridHeight)
        for (let r = 0; r < gridRows.length; r++) {
          for (let c = 0; c < gridRows[r].length; c++) {
            const spec = gridRows[r][c];
            if (!spec) continue;
            const destSlot = 1 + c + r * gridWidth;

            const srcSlotObj = window.slots
              .slice(window.inventoryStart ?? 10, window.inventoryEnd ?? window.slots.length)
              .find((s) => s && matchesItemSpec(this.registryBridge.toCanonicalItemId(s), spec));

            if (!srcSlotObj) {
              return false;
            }

            // Pick up stack from inventory, right-click 1 into destSlot, return remainder to srcSlot
            await this.bot.clickWindow(srcSlotObj.slot, 0, 0);
            await this.bot.clickWindow(destSlot, 1, 0);
            if (window.selectedItem) {
              await this.bot.clickWindow(srcSlotObj.slot, 0, 0);
            }
          }
        }

        // Wait up to 450ms for the Forge server to populate Crafting Result slot 0
        for (let wait = 0; wait < 9; wait++) {
          if (window.slots[0]) break;
          await this._delay(50);
        }

        // Shift-click result slot 0 (`mode = 1` quick_move) into player inventory
        await this.bot.clickWindow(0, 0, 1);
        await this._delay(80);

        // Reclaim any remaining GTCEu tools (Hammer, File, Wrench, Mortar, etc.) left in grid 1..9
        const maxGridSlot = gridWidth * gridWidth;
        for (let g = 1; g <= maxGridSlot; g++) {
          if (window.slots[g]) {
            await this.bot.clickWindow(g, 0, 1);
          }
        }
      }
      return true;
    } finally {
      if (openedTableWindow && typeof this.bot.closeWindow === 'function') {
        try {
          await this.bot.closeWindow(openedTableWindow);
        } catch (_) {
          // Safe close fallback
        }
      }
    }
  }

  /**
   * Ensures sufficient furnace fuel (`coal`/`lignite` first, or converts `1 log -> 4 planks`
   * for 4x smelting efficiency under GTL's `harderCharcoalRecipe: true`).
   */
  async ensureFurnaceFuel(minFuelItems = 6) {
    if (this.countInventory('#furnace_fuel') >= minFuelItems) return true;

    if (this.countInventory('#logs') > 0) {
      for (const plankName of [
        'oak_planks',
        'birch_planks',
        'spruce_planks',
        'jungle_planks',
        'acacia_planks',
        'dark_oak_planks',
        'cherry_planks',
        'mangrove_planks'
      ]) {
        if (await this.craftVanillaItem(plankName, 2, false)) break;
      }
      if (this.countInventory('#furnace_fuel') >= minFuelItems) return true;
    }

    // Try nearby coal veins first, otherwise chop wood
    const coalScan = this.scanChunkMemoryForGtceuVeins('coal');
    if (coalScan.knownMatches.length > 0) {
      await this.prospectAndMineOre('coal', minFuelItems);
    } else {
      await this.gatherWood(3, false);
    }
    return this.countInventory('#furnace_fuel') >= minFuelItems;
  }

  /**
   * Smelts items inside Base Camp's `minecraft:blast_furnace` (1-tick instant smelting in GTL!)
   * or `minecraft:furnace` using available coal / planks / logs / sticks fuel.
   */
  async smeltItemsLive(inputSpec, count = 4, preferBlastFurnace = true) {
    if (typeof this.bot?.openFurnace !== 'function') return false;

    const blastBlock = preferBlastFurnace
      ? this.getValidStationBlock('blastFurnace', 'blast_furnace')
      : null;
    const furnaceBlock = blastBlock || this.getValidStationBlock('furnace', 'furnace');
    if (!furnaceBlock) return false;

    const inputItem = this.findInventoryItem(inputSpec);
    if (!inputItem) return false;

    if (this.countInventory('#furnace_fuel') === 0) {
      await this.ensureFurnaceFuel(4);
    }
    const fuelItem = this.findInventoryItem('#furnace_fuel');
    if (!fuelItem) return false;

    const batchCount = Math.min(count, inputItem.count || 1);
    const isFastBlast = Boolean(blastBlock && furnaceBlock === blastBlock);

    await this._safeGotoNear(furnaceBlock.position, 2, 10000);
    const furnace = await this.bot.openFurnace(furnaceBlock);

    try {
      if (!furnace.fuelItem()) {
        const fuelQty = Math.min(fuelItem.count || 1, Math.max(2, Math.ceil(batchCount / 2)));
        await furnace.putFuel(fuelItem.type, null, fuelQty);
      }
      if (furnace.outputItem()) {
        await furnace.takeOutput();
      }
      await furnace.putInput(inputItem.type, null, batchCount);

      // In GregTech Leisure (`开荒加速`), Blast Furnace takes 1 tick (50ms/item)!
      // Standard Furnace takes 40 ticks (2s) for Wrought Iron or 200 ticks (10s) for ores.
      const waitMs = isFastBlast
        ? Math.min(2500, 250 + batchCount * 120)
        : Math.min(14000, 1200 + batchCount * 2200);
      await this._delay(waitMs);

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
  // ORDERED MODPACK PROGRESSION MILESTONES (ZERO -> ENDGAME)
  // ===========================================================================

  /**
   * Executes one intelligent decision cycle of the autonomous GregTech Leisure progression ladder.
   */
  async runSingleCycle() {
    if (await this.performSurvivalSelfCare()) {
      return { stage: 'SELF_CARE' };
    }

    // -------------------------------------------------------------------------
    // MILESTONE 1: Starter Wood, Planks & Sticks (Survival Zero Bootstrap)
    // -------------------------------------------------------------------------
    if (!this.hasMilestone('M01_WOOD_BOOTSTRAP')) {
      this._currentMilestoneId = 'M01_WOOD_BOOTSTRAP';
      const logs = this.countInventory('#logs');
      const planks = this.countInventory('#planks');
      if (logs + Math.floor(planks / 4) < 6) {
        await this.gatherWood(6, false);
        return { stage: 'M01_WOOD_BOOTSTRAP' };
      }

      if (planks < 16 && logs > 0) {
        for (const plankName of [
          'oak_planks',
          'birch_planks',
          'spruce_planks',
          'jungle_planks',
          'acacia_planks',
          'dark_oak_planks',
          'cherry_planks',
          'mangrove_planks'
        ]) {
          if (await this.craftVanillaItem(plankName, 4, false)) break;
        }
      }

      if (this.countInventory('minecraft:stick') < 8 && this.countInventory('#planks') >= 4) {
        await this.craftVanillaItem('stick', 2, false);
      }

      if (this.countInventory('#planks') >= 8 && this.countInventory('minecraft:stick') >= 4) {
        this.markMilestoneComplete('M01_WOOD_BOOTSTRAP');
      }
      return { stage: 'M01_WOOD_BOOTSTRAP' };
    }

    // -------------------------------------------------------------------------
    // MILESTONE 2: Establish Base Camp, Place Crafting Table & Wooden Pickaxe
    // -------------------------------------------------------------------------
    if (!this.getValidStationBlock('craftingTable', 'crafting_table')) {
      this._currentMilestoneId = 'M02_BASE_AND_CRAFTING_TABLE';
      if (this.countInventory('minecraft:crafting_table') === 0) {
        if (this.countInventory('#planks') < 4) {
          await this.gatherWood(3, false);
          for (const p of ['oak_planks', 'birch_planks', 'spruce_planks']) {
            if (await this.craftVanillaItem(p, 2, false)) break;
          }
          return { stage: 'M02_BASE_AND_CRAFTING_TABLE' };
        }
        await this.craftVanillaItem('crafting_table', 1, false);
      }
      await this.placeStationAtBase('minecraft:crafting_table', 'craftingTable', { x: 2, y: 0, z: 0 });
      return { stage: 'M02_BASE_AND_CRAFTING_TABLE' };
    }

    if (!this.findInventoryItem('#pickaxe')) {
      this._currentMilestoneId = 'M02_BASE_AND_CRAFTING_TABLE';
      if (this.countInventory('#cobblestone') >= 3 && this.countInventory('minecraft:stick') >= 2) {
        await this.craftVanillaItem('stone_pickaxe', 1, true);
      } else {
        if (this.countInventory('#planks') < 3) await this.gatherWood(2, false);
        if (this.countInventory('minecraft:stick') < 2) await this.craftVanillaItem('stick', 1, false);
        await this.craftVanillaItem('wooden_pickaxe', 1, true);
      }
      this.markMilestoneComplete('M02_BASE_AND_CRAFTING_TABLE');
      return { stage: 'M02_BASE_AND_CRAFTING_TABLE' };
    }

    // -------------------------------------------------------------------------
    // MILESTONE 3: Stone Tools, Furnace & Base Warehouse Chest
    // -------------------------------------------------------------------------
    if (!this.hasMilestone('M03_STONE_TOOLS_AND_FURNACE')) {
      this._currentMilestoneId = 'M03_STONE_TOOLS_AND_FURNACE';
      if (this.countInventory('#cobblestone') < 28) {
        this._log('info', `Mining cobblestone for Stone Tools & Furnace (${this.countInventory('#cobblestone')}/28)...`);
        await this.gatherSurfaceBlocks(['stone', 'cobblestone', 'deepslate'], '#cobblestone', 28);
        return { stage: 'M03_STONE_TOOLS_AND_FURNACE' };
      }

      if (this.countInventory('minecraft:stick') < 8) {
        if (this.countInventory('#planks') < 4) await this.gatherWood(3, false);
        await this.craftVanillaItem('stick', 2, false);
      }

      if (!this.findInventoryItem(['minecraft:stone_pickaxe', '#iron_tier_pickaxe'])) {
        await this.craftVanillaItem('stone_pickaxe', 1, true);
      }
      if (!this.findInventoryItem('#axe')) {
        await this.craftVanillaItem('stone_axe', 1, true);
      }
      if (!this.findInventoryItem(['minecraft:stone_sword', 'minecraft:iron_sword'])) {
        await this.craftVanillaItem('stone_sword', 1, true);
      }

      if (!this.getValidStationBlock('furnace', 'furnace')) {
        if (this.countInventory('minecraft:furnace') === 0) {
          await this.craftVanillaItem('furnace', 1, true);
        }
        await this.placeStationAtBase('minecraft:furnace', 'furnace', { x: 3, y: 0, z: 0 });
      }

      if (this.worldState.stations.chests.length === 0) {
        if (this.countInventory('minecraft:chest') === 0) {
          if (this.countInventory('#planks') < 8) {
            await this.gatherWood(3, false);
            for (const p of ['oak_planks', 'birch_planks', 'spruce_planks']) {
              if (await this.craftVanillaItem(p, 2, false)) break;
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
    // MILESTONE 4: Prospect GTCEu Iron & Coal Veins -> Smelt First Iron Ingots
    // -------------------------------------------------------------------------
    if (!this.hasMilestone('M04_PROSPECT_COAL_AND_IRON')) {
      this._currentMilestoneId = 'M04_PROSPECT_COAL_AND_IRON';
      if (!(await this.ensureFurnaceFuel(6))) {
        return { stage: 'M04_PROSPECT_COAL_AND_IRON' };
      }

      const ironIngots = this.countTotalStock('minecraft:iron_ingot');
      const rawIron = this.countInventory('#ore:iron');
      if (ironIngots + rawIron < 14) {
        await this.prospectAndMineOre('iron', 14 - ironIngots);
        return { stage: 'M04_PROSPECT_COAL_AND_IRON' };
      }

      if (ironIngots < 12 && rawIron > 0) {
        this._log('info', `Smelting Iron Ingots (${ironIngots}/12)...`);
        await this.smeltItemsLive('#ore:iron', Math.min(8, rawIron), true);
        return { stage: 'M04_PROSPECT_COAL_AND_IRON' };
      }

      if (this.countTotalStock('minecraft:iron_ingot') >= 12) {
        this.markMilestoneComplete('M04_PROSPECT_COAL_AND_IRON');
      }
      return { stage: 'M04_PROSPECT_COAL_AND_IRON' };
    }

    // -------------------------------------------------------------------------
    // MILESTONE 5: GTL 1-Tick Blast Furnace + Iron Pickaxe & Bucket
    // -------------------------------------------------------------------------
    if (!this.hasMilestone('M05_FAST_BLAST_FURNACE_AND_IRON_KIT')) {
      this._currentMilestoneId = 'M05_FAST_BLAST_FURNACE_AND_IRON_KIT';

      if (!this.findInventoryItem('#iron_tier_pickaxe')) {
        if (this.countInventory('minecraft:stick') < 2) await this.craftVanillaItem('stick', 1, false);
        await this.craftVanillaItem('iron_pickaxe', 1, true);
      }

      if (!this.findInventoryItem('minecraft:bucket') && this.countInventory('minecraft:iron_ingot') >= 3) {
        await this.craftVanillaItem('bucket', 1, true);
      }

      if (!this.getValidStationBlock('blastFurnace', 'blast_furnace')) {
        if (this.countInventory('minecraft:blast_furnace') === 0) {
          if (this.countInventory('minecraft:smooth_stone') < 3) {
            if (this.countInventory('minecraft:stone') < 3) {
              if (this.countInventory('minecraft:cobblestone') < 4) {
                await this.gatherSurfaceBlocks(['stone', 'cobblestone'], '#cobblestone', 6);
                return { stage: 'M05_FAST_BLAST_FURNACE_AND_IRON_KIT' };
              }
              await this.smeltItemsLive('minecraft:cobblestone', 3, false);
              return { stage: 'M05_FAST_BLAST_FURNACE_AND_IRON_KIT' };
            }
            await this.smeltItemsLive('minecraft:stone', 3, false);
            return { stage: 'M05_FAST_BLAST_FURNACE_AND_IRON_KIT' };
          }
          if (this.countInventory('minecraft:furnace') === 0) {
            if (this.countInventory('#cobblestone') < 8) {
              await this.gatherSurfaceBlocks(['stone', 'cobblestone'], '#cobblestone', 8);
              return { stage: 'M05_FAST_BLAST_FURNACE_AND_IRON_KIT' };
            }
            await this.craftVanillaItem('furnace', 1, true);
          }
          if (this.countInventory('minecraft:iron_ingot') < 5) {
            if (this.countInventory('#ore:iron') < 5) {
              await this.prospectAndMineOre('iron', 6);
              return { stage: 'M05_FAST_BLAST_FURNACE_AND_IRON_KIT' };
            }
            await this.smeltItemsLive('#ore:iron', 5, false);
            return { stage: 'M05_FAST_BLAST_FURNACE_AND_IRON_KIT' };
          }
          await this.craftVanillaItem('blast_furnace', 1, true);
        }

        if (this.countInventory('minecraft:blast_furnace') > 0) {
          await this.placeStationAtBase('minecraft:blast_furnace', 'blastFurnace', { x: 4, y: 0, z: 0 });
          this._log('info', 'Placed GTL 1-Tick Blast Furnace at Base Camp — instant ore/wrought-iron/bronze/firebrick smelting unlocked!');
        }
      }

      if (this.getValidStationBlock('blastFurnace', 'blast_furnace')) {
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

      if (this.countInventory('minecraft:stick') < 4) {
        if (this.countInventory('#planks') < 4) await this.ensureFurnaceFuel(4);
        await this.craftVanillaItem('stick', 2, false);
      }

      // 1. GTCEu Iron Hammer: [I I _] / [I I S] / [I I _]
      if (!hasHammer) {
        this._log('info', 'Crafting GTCEu Iron Hammer on Crafting Table...');
        await this.craftShapedLive([
          ['minecraft:iron_ingot', 'minecraft:iron_ingot', null],
          ['minecraft:iron_ingot', 'minecraft:iron_ingot', 'minecraft:stick'],
          ['minecraft:iron_ingot', 'minecraft:iron_ingot', null]
        ]);
      }

      // 2. GTCEu Iron Mortar: [_ I _] / [S I S] / [S S S] (Stone + Iron Ingot)
      if (!hasMortar) {
        if (this.countInventory('minecraft:stone') < 5) {
          if (this.countInventory('minecraft:cobblestone') < 5) {
            await this.gatherSurfaceBlocks(['stone', 'cobblestone'], '#cobblestone', 6);
            return { stage: 'M06_GTCEU_HAND_TOOLS' };
          }
          await this.smeltItemsLive('minecraft:cobblestone', 5, false);
          return { stage: 'M06_GTCEU_HAND_TOOLS' };
        }
        await this.craftShapedLive([
          [null, 'minecraft:iron_ingot', null],
          ['minecraft:stone', 'minecraft:iron_ingot', 'minecraft:stone'],
          ['minecraft:stone', 'minecraft:stone', 'minecraft:stone']
        ]);
      }

      // 3. Hammer Iron Plates (`2x iron_ingot` + Hammer -> `1x gtceu:iron_plate`) for Wrench & File!
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

      // 4. GTCEu Iron Wrench: [P H P] / [P P P] / [_ P _]
      if (!hasWrench && this.countInventory('gtceu:iron_plate') >= 6) {
        await this.craftShapedLive([
          ['gtceu:iron_plate', '#gtceu:hammer', 'gtceu:iron_plate'],
          ['gtceu:iron_plate', 'gtceu:iron_plate', 'gtceu:iron_plate'],
          [null, 'gtceu:iron_plate', null]
        ]);
      }

      // 5. GTCEu Iron File: [P _ _] / [P _ _] / [S _ _]
      if (!hasFile && this.countInventory('gtceu:iron_plate') >= 2) {
        await this.craftShapedLive([
          ['gtceu:iron_plate', null, null],
          ['gtceu:iron_plate', null, null],
          ['minecraft:stick', null, null]
        ]);
      }

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

      // Grind Copper & Tin Ingots with Mortar -> Bronze Dust -> 1-Tick Blast Furnace -> Bronze Ingot!
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
