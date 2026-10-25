'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const Vec3 = require('vec3');
const { Graph, alg } = require('@dagrejs/graphlib');
const nbt = require('prismarine-nbt');
const {
  ForgeRegistryBridge,
  normalizeItemId
} = require('./protocol/forgeHandshake');

const VOLTAGE_TIER_ORDER = Object.freeze({
  STONE: 0,
  STEAM: 0.5,
  ULV: 0.8,
  LV: 1,
  MV: 2,
  HV: 3,
  EV: 4,
  IV: 5,
  LuV: 6,
  ZPM: 7,
  UV: 8,
  UHV: 9,
  UEV: 10,
  UIV: 11,
  UXV: 12,
  OpV: 13,
  MAX: 14
});

const EMPTY_SLOT_120 = Object.freeze({ present: false });

/**
 * Spatial warehouse ledger indexing chests, Sophisticated Storage barrels/shulkers,
 * Functional Storage drawers, AE2 interfaces, and GTCEu Super/Quantum Chests + Drums
 * by 3D world coordinates (`dimension:x,y,z`).
 */
class WarehouseTracker extends EventEmitter {
  /**
   * @param {Object} [options]
   * @param {ForgeRegistryBridge} [options.registryBridge]
   */
  constructor(options = {}) {
    super();
    this.registryBridge = options.registryBridge || new ForgeRegistryBridge();
    this.containers = new Map();
  }

  static makeKey(pos, dimension = 'minecraft:overworld') {
    const p = pos instanceof Vec3 ? pos.floored() : new Vec3(pos.x, pos.y, pos.z).floored();
    return `${dimension}:${p.x},${p.y},${p.z}`;
  }

  /**
   * Indexes or updates a storage container's contents at `(x, y, z)`.
   */
  upsertContainer(position, items, meta = {}) {
    const pos = position instanceof Vec3
      ? position.floored()
      : new Vec3(position.x, position.y, position.z).floored();
    const dimension = meta.dimension ?? 'minecraft:overworld';
    const key = WarehouseTracker.makeKey(pos, dimension);

    const contents = new Map();
    const slots = new Map();

    if (Array.isArray(items)) {
      items.forEach((raw, idx) => {
        if (!raw || (raw.count ?? raw.itemCount ?? 0) <= 0) return;
        const count = raw.count ?? raw.itemCount ?? 0;
        const canonical = raw.itemId && typeof raw.itemId === 'string'
          ? normalizeItemId(raw.itemId)
          : this.registryBridge.toCanonicalItemId(raw);
        if (!canonical) return;
        const slotIndex = raw.slot ?? idx;
        contents.set(canonical, (contents.get(canonical) || 0) + count);
        slots.set(slotIndex, { itemId: canonical, count });
      });
    } else if (items && typeof items === 'object') {
      let idx = 0;
      for (const [rawId, count] of Object.entries(items)) {
        if (count <= 0) continue;
        const canonical = rawId.startsWith('fluid:') ? rawId : normalizeItemId(rawId);
        contents.set(canonical, (contents.get(canonical) || 0) + count);
        slots.set(idx++, { itemId: canonical, count });
      }
    }

    const record = {
      key,
      position: pos,
      dimension,
      containerType: meta.containerType || 'chest',
      contents,
      slots,
      lastScannedAt: Date.now()
    };

    this.containers.set(key, record);
    this.emit('containerIndexed', record);
    return record;
  }

  /**
   * Adjusts recorded stock at a specific container coordinate after withdrawal or deposit.
   */
  adjustContainerStock(position, itemId, delta, dimension = 'minecraft:overworld') {
    const key = WarehouseTracker.makeKey(position, dimension);
    const container = this.containers.get(key);
    if (!container) return 0;

    const canonical = itemId.startsWith('fluid:') ? itemId : normalizeItemId(itemId);
    const current = container.contents.get(canonical) || 0;
    const next = Math.max(0, current + delta);
    if (next === 0) {
      container.contents.delete(canonical);
    } else {
      container.contents.set(canonical, next);
    }
    container.lastScannedAt = Date.now();
    return next;
  }

  /**
   * Aggregates all item/fluid counts across every indexed warehouse container.
   * @returns {Map<string, number>}
   */
  getWarehouseTotals() {
    const totals = new Map();
    for (const container of this.containers.values()) {
      for (const [itemId, count] of container.contents.entries()) {
        totals.set(itemId, (totals.get(itemId) || 0) + count);
      }
    }
    return totals;
  }

  /**
   * Reads a Mineflayer bot's live inventory and merges it with indexed warehouse totals.
   */
  getCombinedStock(bot = null, extraStock = null) {
    const stock = this.getWarehouseTotals();

    if (bot && bot.inventory && typeof bot.inventory.items === 'function') {
      for (const item of bot.inventory.items()) {
        const canonical = this.registryBridge.toCanonicalItemId(item);
        const count = item.count ?? item.itemCount ?? 0;
        if (canonical && count > 0) {
          stock.set(canonical, (stock.get(canonical) || 0) + count);
        }
      }
    }

    if (extraStock) {
      const entries = extraStock instanceof Map
        ? extraStock.entries()
        : Object.entries(extraStock);
      for (const [rawId, count] of entries) {
        if (count <= 0) continue;
        const canonical = rawId.startsWith('fluid:') ? rawId : normalizeItemId(rawId);
        stock.set(canonical, (stock.get(canonical) || 0) + count);
      }
    }

    return stock;
  }

  /**
   * Resolves concrete warehouse container coordinates to withdraw `neededCount` of `itemId`,
   * sorted nearest-first relative to `originPos` when provided.
   */
  locateItemSources(itemId, neededCount, originPos = null) {
    const canonical = itemId.startsWith('fluid:') ? itemId : normalizeItemId(itemId);
    const matching = [];

    for (const container of this.containers.values()) {
      const available = container.contents.get(canonical) || 0;
      if (available > 0) {
        const distance = originPos
          ? container.position.distanceTo(
            originPos instanceof Vec3 ? originPos : new Vec3(originPos.x, originPos.y, originPos.z)
          )
          : 0;
        matching.push({ container, available, distance });
      }
    }

    matching.sort((a, b) => a.distance - b.distance);

    const allocations = [];
    let remaining = neededCount;
    for (const entry of matching) {
      if (remaining <= 0) break;
      const takeCount = Math.min(remaining, entry.available);
      allocations.push({
        containerKey: entry.container.key,
        position: entry.container.position.clone(),
        containerType: entry.container.containerType,
        available: entry.available,
        takeCount
      });
      remaining -= takeCount;
    }

    return {
      itemId: canonical,
      requestedCount: neededCount,
      fulfilledCount: neededCount - remaining,
      shortfallCount: remaining,
      locations: allocations
    };
  }
}

/**
 * Packet-level Minecraft 1.20.1 Container & LDLib / GTCEu Modern GUI slot controller.
 * Synchronizes `stateId` across `window_items` and `set_slot` packets, emits 1.20.1
 * `window_click` packets (`stateId`, `changedSlots`, `cursorItem`), and configures
 * GTCEu `gtceu:programmed_circuit` (`{ Configuration: N }`) via Ghost Circuit or physical slot.
 */
class ContainerPacketController extends EventEmitter {
  /**
   * @param {import('mineflayer').Bot|null} bot
   * @param {Object} [options]
   * @param {Object} [options.windowProfiles]
   * @param {ForgeRegistryBridge} [options.registryBridge]
   * @param {number} [options.clickDelayMs=55]
   */
  constructor(bot = null, options = {}) {
    super();
    this.bot = bot;
    this.registryBridge = options.registryBridge || new ForgeRegistryBridge();
    this.windowProfiles = new Map();
    this.calibratedVectors = new Map();
    this.clickDelayMs = options.clickDelayMs ?? 55;

    this._stateId = 0;
    this.activeWindow = null;
    this.progressBars = new Map();
    this.packetLog = [];

    if (options.windowProfiles) {
      this.loadWindowProfiles(options.windowProfiles);
    }

    if (this.bot) {
      this.attachToBot(this.bot);
    }
  }

  loadWindowProfiles(profilesObj) {
    for (const [profileId, profile] of Object.entries(profilesObj || {})) {
      this.windowProfiles.set(profileId, { profileId, ...profile });
    }
  }

  /**
   * Registers or overrides custom click-vector slot calibration for an LDLib / GTCEu GUI.
   */
  calibrateClickVector(machineProfileId, vectorConfig) {
    const existing = this.windowProfiles.get(machineProfileId) || { profileId: machineProfileId };
    const merged = { ...existing, ...vectorConfig };
    this.windowProfiles.set(machineProfileId, merged);
    this.calibratedVectors.set(machineProfileId, vectorConfig);
    return merged;
  }

  getProfile(machineId) {
    if (this.windowProfiles.has(machineId)) {
      return this.windowProfiles.get(machineId);
    }
    return {
      profileId: machineId,
      containerSlotCount: 9,
      inputSlots: [0, 1],
      outputSlots: [2],
      circuitSlot: 3,
      ghostCircuitSelectorSlot: 4,
      playerInventoryOffset: 9
    };
  }

  attachToBot(bot) {
    this.bot = bot;
    const client = bot._client;
    if (!client || typeof client.on !== 'function') return;

    const onWindowOpen = (packet) => {
      this._stateId = 0;
      this.activeWindow = {
        windowId: packet.windowId,
        inventoryType: packet.inventoryType,
        menuTypeName: packet.menuTypeName || null,
        windowTitle: packet.windowTitle,
        extraData: packet.extraData || null,
        stateId: 0,
        slots: [],
        carriedItem: { present: false }
      };
      this.progressBars.clear();
      this.emit('windowOpened', this.activeWindow);
    };

    client.on('open_window', onWindowOpen);
    client.on('fmlOpenContainer', onWindowOpen);

    client.on('window_items', (packet) => {
      if (Number.isInteger(packet.stateId)) {
        this._stateId = packet.stateId;
      }
      if (this.activeWindow && packet.windowId === this.activeWindow.windowId) {
        this.activeWindow.stateId = this._stateId;
        this.activeWindow.slots = (packet.items || []).slice();
        this.activeWindow.carriedItem = packet.carriedItem || { present: false };
        this.emit('windowItemsUpdated', this.activeWindow);
      }
    });

    client.on('set_slot', (packet) => {
      if (Number.isInteger(packet.stateId)) {
        this._stateId = packet.stateId;
      }
      if (this.activeWindow && packet.windowId === this.activeWindow.windowId && packet.slot >= 0) {
        this.activeWindow.stateId = this._stateId;
        this.activeWindow.slots[packet.slot] = packet.item;
        this.emit('slotUpdated', { slot: packet.slot, item: packet.item, stateId: this._stateId });
      }
    });

    client.on('craft_progress_bar', (packet) => {
      if (!this.activeWindow || packet.windowId === this.activeWindow.windowId) {
        this.progressBars.set(packet.property, packet.value);
        this.emit('progressUpdated', { property: packet.property, value: packet.value });
      }
    });
  }

  /**
   * Emits a Minecraft 1.20.1 `window_click` packet targeting an exact container slot index.
   *
   * @param {Object} params
   * @param {number} [params.windowId]
   * @param {number} params.slot
   * @param {number} [params.mouseButton=0] - 0=left, 1=right, 2=middle
   * @param {number} [params.mode=0] - 0=pickup, 1=quick_move(shift), 2=swap, 3=clone
   * @param {Object|null} [params.cursorItem=null] - 1.20.1 `slot` wire payload (`{ present: false }` when empty)
   * @param {Array<{location:number, item:Object}>} [params.changedSlots]
   */
  async sendWindowClick({
    windowId,
    slot,
    mouseButton = 0,
    mode = 0,
    cursorItem = null,
    changedSlots = null
  }) {
    const resolvedWindowId =
      windowId ?? this.activeWindow?.windowId ?? this.bot?.currentWindow?.id ?? 0;
    const stateId = this.activeWindow?.stateId ?? this._stateId ?? 0;

    const wireCursor = cursorItem
      ? this._normalize120Slot(cursorItem)
      : this._readSlotAs120WireItem(resolvedWindowId, slot);

    const resolvedChanges = Array.isArray(changedSlots)
      ? changedSlots.map((entry) => ({
          location: entry.location,
          item: this._normalize120Slot(entry.item)
        }))
      : slot >= 0
        ? [{ location: slot, item: { present: false } }]
        : [];

    const payload = {
      windowId: resolvedWindowId,
      stateId,
      slot,
      mouseButton,
      mode,
      changedSlots: resolvedChanges,
      cursorItem: wireCursor
    };

    this.packetLog.push({ timestamp: Date.now(), type: 'window_click', payload });
    if (this.packetLog.length > 500) {
      this.packetLog.shift();
    }

    if (this.bot?._client && typeof this.bot._client.write === 'function') {
      this.bot._client.write('window_click', payload);
    }

    if (this.clickDelayMs > 0) {
      await sleep(this.clickDelayMs);
    }

    return payload;
  }

  _normalize120Slot(raw) {
    if (!raw || raw.present === false || raw.blockId === -1 || raw.itemId === -1) {
      return { present: false };
    }
    return {
      present: true,
      itemId: raw.itemId ?? raw.type ?? raw.blockId ?? 1,
      itemCount: raw.itemCount ?? raw.count ?? 1,
      nbtData: raw.nbtData ?? raw.nbt ?? undefined
    };
  }

  _readSlotAs120WireItem(windowId, slot) {
    if (slot < 0) return { present: false };
    const winSlot =
      (this.activeWindow && this.activeWindow.windowId === windowId
        ? this.activeWindow.slots[slot]
        : null) ||
      this.bot?.currentWindow?.slots?.[slot] ||
      null;

    return this._normalize120Slot(winSlot);
  }

  /**
   * Moves an item stack from `sourceSlot` to `destSlot` via packet-level cursor pickup & placement.
   */
  async transferSlotToSlot(sourceSlot, destSlot, count = null, windowId = undefined) {
    const clicks = [];
    clicks.push(
      await this.sendWindowClick({ windowId, slot: sourceSlot, mouseButton: 0, mode: 0 })
    );

    if (count !== null && count > 0) {
      for (let i = 0; i < count; i++) {
        clicks.push(
          await this.sendWindowClick({
            windowId,
            slot: destSlot,
            mouseButton: 1,
            mode: 0,
            cursorItem: EMPTY_SLOT_120
          })
        );
      }
      clicks.push(
        await this.sendWindowClick({
          windowId,
          slot: sourceSlot,
          mouseButton: 0,
          mode: 0,
          cursorItem: EMPTY_SLOT_120
        })
      );
    } else {
      clicks.push(
        await this.sendWindowClick({
          windowId,
          slot: destSlot,
          mouseButton: 0,
          mode: 0,
          cursorItem: EMPTY_SLOT_120
        })
      );
    }

    return clicks;
  }

  /**
   * Configures a GTCEu Modern Programmed Circuit (`gtceu:programmed_circuit`, `{ Configuration: N }`)
   * inside a GregTech Leisure machine GUI (`#1..#32`, e.g., `#14` in `gtceu:lv_bender`).
   *
   * Supports two GTL modes:
   *  - `'ghost'` (default in GTL since `gtceu.yaml` sets `ghostCircuit: true`: steps the LDLib
   *    Ghost Circuit widget at `profile.ghostCircuitSelectorSlot`).
   *  - `'physical'` (transfers a physical `gtceu:programmed_circuit` item with NBT `{ Configuration: N }`
   *    into `profile.circuitSlot`).
   */
  async configureProgrammedCircuit(machineProfileId, configNumber, options = {}) {
    if (!Number.isInteger(configNumber) || configNumber < 1 || configNumber > 32) {
      throw new RangeError(
        `Invalid GTCEu Programmed Circuit configuration #${configNumber}; expected integer in [1..32]`
      );
    }

    const profile = this.getProfile(machineProfileId);
    const windowId = options.windowId ?? this.activeWindow?.windowId ?? 1;
    const strategy = options.strategy || 'auto';
    const packetsSent = [];

    const circuitNbt = nbt.comp({
      Configuration: nbt.int(configNumber)
    });

    const resolvedPlayerSlot =
      options.playerCircuitSlot ?? this._findProgrammedCircuitInWindow(profile);

    if (strategy === 'physical' || (strategy === 'auto' && resolvedPlayerSlot !== null)) {
      const sourceContainerSlot =
        resolvedPlayerSlot >= (profile.playerInventoryOffset ?? 0)
          ? resolvedPlayerSlot
          : (profile.playerInventoryOffset ?? 8) + resolvedPlayerSlot;
      const targetCircuitSlot = profile.circuitSlot ?? 3;
      const circuitMapping = this.registryBridge.fromCanonicalItemId(
        'gtceu:programmed_circuit',
        this.bot?.registry,
        { nbtData: circuitNbt }
      );
      const wireCircuitItem = {
        present: true,
        itemId: circuitMapping.itemId !== -1 ? circuitMapping.itemId : 9001,
        itemCount: 1,
        nbtData: circuitNbt
      };

      packetsSent.push(
        await this.sendWindowClick({
          windowId,
          slot: sourceContainerSlot,
          mouseButton: 0,
          mode: 0,
          cursorItem: wireCircuitItem
        })
      );
      packetsSent.push(
        await this.sendWindowClick({
          windowId,
          slot: targetCircuitSlot,
          mouseButton: 0,
          mode: 0,
          cursorItem: EMPTY_SLOT_120
        })
      );

      return {
        mode: 'physical',
        itemId: 'gtceu:programmed_circuit',
        machineProfileId,
        configNumber,
        targetSlot: targetCircuitSlot,
        nbt: circuitNbt,
        packetsSent
      };
    }

    // GTCEu Modern / LDLib Ghost Circuit selector (`gtceu.yaml -> ghostCircuit: true`)
    const ghostSlot = profile.ghostCircuitSelectorSlot ?? profile.circuitSlot ?? 4;
    packetsSent.push(
      await this.sendWindowClick({
        windowId,
        slot: ghostSlot,
        mouseButton: 2,
        mode: 3,
        cursorItem: EMPTY_SLOT_120
      })
    );

    const bigSteps = Math.floor(configNumber / 5);
    const singleSteps = configNumber % 5;

    for (let i = 0; i < bigSteps; i++) {
      packetsSent.push(
        await this.sendWindowClick({
          windowId,
          slot: ghostSlot,
          mouseButton: 1,
          mode: 1,
          cursorItem: EMPTY_SLOT_120
        })
      );
    }
    for (let i = 0; i < singleSteps; i++) {
      packetsSent.push(
        await this.sendWindowClick({
          windowId,
          slot: ghostSlot,
          mouseButton: 1,
          mode: 0,
          cursorItem: EMPTY_SLOT_120
        })
      );
    }

    return {
      mode: 'ghost',
      itemId: 'gtceu:programmed_circuit',
      machineProfileId,
      configNumber,
      targetSlot: ghostSlot,
      nbt: circuitNbt,
      packetsSent
    };
  }

  _findProgrammedCircuitInWindow(profile) {
    const slots = this.activeWindow?.slots || this.bot?.currentWindow?.slots;
    if (!Array.isArray(slots)) return null;

    const start = profile.playerInventoryOffset ?? 0;
    for (let idx = start; idx < slots.length; idx++) {
      const slotItem = slots[idx];
      if (!slotItem || slotItem.present === false) continue;
      const canonical = this.registryBridge.toCanonicalItemId(slotItem) || '';
      if (
        canonical === 'gtceu:programmed_circuit' ||
        canonical.startsWith('gtceu:programmed_circuit')
      ) {
        return idx;
      }
    }
    return null;
  }

  /**
   * Executes a single machine crafting step at the 1.20.1 packet level.
   */
  async executeMachineStep(step, options = {}) {
    const profile = this.getProfile(step.machine);
    const windowId = options.windowId ?? this.activeWindow?.windowId ?? 1;
    const hazardMonitor = options.hazardMonitor || null;

    if (hazardMonitor && typeof hazardMonitor.canExecuteRecipeStep === 'function') {
      const verdict = hazardMonitor.canExecuteRecipeStep(step);
      if (!verdict.allowed) {
        const err = new Error(`Crafting halted by HazardMonitor: ${verdict.reason}`);
        err.code = 'HAZARD_HALT';
        throw err;
      }
    }

    const actions = [];

    if (Number.isInteger(step.programmedCircuit)) {
      const circuitRes = await this.configureProgrammedCircuit(
        step.machine,
        step.programmedCircuit,
        {
          windowId,
          strategy: options.circuitStrategy || 'auto',
          playerCircuitSlot: options.playerCircuitSlot
        }
      );
      actions.push({ type: 'configure_circuit', detail: circuitRes });
    }

    const playerOffset = profile.playerInventoryOffset ?? 8;
    const inputSlots = profile.inputSlots || [0];

    for (let i = 0; i < (step.inputs || []).length; i++) {
      const inputReq = step.inputs[i];
      const targetInputSlot = inputSlots[Math.min(i, inputSlots.length - 1)];
      const sourceSlot = options.inputSourceSlots?.[inputReq.itemId] ?? (playerOffset + i);

      const clicks = await this.transferSlotToSlot(
        sourceSlot,
        targetInputSlot,
        inputReq.count,
        windowId
      );
      actions.push({
        type: 'insert_input',
        itemId: inputReq.itemId,
        count: inputReq.count,
        fromSlot: sourceSlot,
        toSlot: targetInputSlot,
        clicks
      });
    }

    if (options.waitTicks && options.waitMsPerTick > 0) {
      const waitMs = step.durationTicks * options.waitMsPerTick;
      await sleep(waitMs);
    }

    if (hazardMonitor && typeof hazardMonitor.canExecuteRecipeStep === 'function') {
      const verdict = hazardMonitor.canExecuteRecipeStep(step);
      if (!verdict.allowed) {
        const err = new Error(`Mid-cycle emergency halt: ${verdict.reason}`);
        err.code = 'HAZARD_HALT';
        throw err;
      }
    }

    for (const outSlot of profile.outputSlots || []) {
      const extractClick = await this.sendWindowClick({
        windowId,
        slot: outSlot,
        mouseButton: 0,
        mode: 1
      });
      actions.push({ type: 'extract_output', fromSlot: outSlot, click: extractClick });
    }

    return {
      recipeId: step.recipeId,
      machine: step.machine,
      windowId,
      actions
    };
  }
}

/**
 * Graph-Based GregTech Leisure (GTL) FTB Quests & JEI/KubeJS Crafting Engine.
 * Structures the FTB Quests progression chapters and GTCEu/GTLCore/KubeJS recipe
 * registry as Directed Acyclic Graphs (DAGs), enforces voltage-tier and dimension
 * constraints, and resolves multi-tier crafting plans against live bot + warehouse stock.
 */
class CraftingEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.registryBridge = options.registryBridge || new ForgeRegistryBridge();
    this.warehouse = options.warehouse || new WarehouseTracker({
      registryBridge: this.registryBridge
    });
    this.containerController = options.containerController || new ContainerPacketController(
      options.bot || null,
      { registryBridge: this.registryBridge }
    );

    this.unlockedVoltageTier = options.unlockedVoltageTier || 'LV';
    this.currentDimension = options.currentDimension || 'minecraft:overworld';
    this.availableMachines = new Set(
      options.availableMachines || ['crafting_table', 'furnace', 'gt_steam_machine']
    );

    this.questGraph = new Graph({ directed: true });
    this.recipeDag = new Graph({ directed: true });

    this.eras = [];
    this.questsById = new Map();
    this.completedQuests = new Set();

    this.recipesById = new Map();
    this.recipesByOutput = new Map();
    this.prunedCyclicRecipeIds = new Set();

    this.craftQueue = [];
  }

  loadDatabaseFromFile(jsonFilePath) {
    const resolved = path.resolve(jsonFilePath);
    const raw = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    return this.ingestDatabase(raw);
  }

  ingestDatabase(database) {
    if (!database || typeof database !== 'object') {
      throw new TypeError('Database payload must be a non-null JSON object');
    }

    if (database.windowProfiles) {
      this.containerController.loadWindowProfiles(database.windowProfiles);
    }

    if (Array.isArray(database.eras)) {
      this.eras = database.eras.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    }

    if (Array.isArray(database.quests)) {
      this._buildQuestDag(database.quests);
    }

    if (Array.isArray(database.recipes)) {
      this._buildRecipeDag(database.recipes);
    }

    const summary = {
      erasLoaded: this.eras.length,
      questsLoaded: this.questsById.size,
      recipesLoaded: this.recipesById.size,
      prunedCycleEdges: this.prunedCyclicRecipeIds.size,
      isQuestDagAcyclic: alg.isAcyclic(this.questGraph),
      isRecipeDagAcyclic: alg.isAcyclic(this.recipeDag)
    };

    this.emit('databaseIngested', summary);
    return summary;
  }

  _buildQuestDag(quests) {
    this.questGraph = new Graph({ directed: true });
    this.questsById.clear();

    for (const quest of quests) {
      this.questsById.set(quest.questId, quest);
      this.questGraph.setNode(quest.questId, quest);
    }

    for (const quest of quests) {
      for (const depId of quest.dependencies || []) {
        if (this.questsById.has(depId)) {
          this.questGraph.setEdge(depId, quest.questId);
        }
      }
    }

    while (!alg.isAcyclic(this.questGraph)) {
      const cycles = alg.findCycles(this.questGraph);
      if (cycles.length === 0) break;
      const cycle = cycles[0];
      this.questGraph.removeEdge(cycle[cycle.length - 1], cycle[0]);
    }
  }

  _buildRecipeDag(recipes) {
    this.recipeDag = new Graph({ directed: true });
    this.recipesById.clear();
    this.recipesByOutput.clear();
    this.prunedCyclicRecipeIds.clear();

    for (const rawRecipe of recipes) {
      const normalized = {
        ...rawRecipe,
        voltageTier: rawRecipe.voltageTier || 'STONE',
        requiredDimension: rawRecipe.requiredDimension || null,
        euPerTick: rawRecipe.euPerTick ?? 0,
        durationTicks: rawRecipe.durationTicks ?? 20,
        priority: rawRecipe.priority ?? 5,
        inputs: (rawRecipe.inputs || []).map((inp) => ({
          ...inp,
          itemId: normalizeItemId(inp.itemId),
          count: Number(inp.count) || 1
        })),
        fluidInputs: (rawRecipe.fluidInputs || []).map((fl) => ({
          ...fl,
          fluidId: fl.fluidId,
          amountMb: Number(fl.amountMb) || 0
        })),
        outputs: (rawRecipe.outputs || []).map((out) => ({
          ...out,
          itemId: normalizeItemId(out.itemId),
          count: Number(out.count) || 1
        }))
      };

      this.recipesById.set(normalized.recipeId, normalized);

      if (normalized.isStorageRecompression) {
        this.prunedCyclicRecipeIds.add(normalized.recipeId);
        continue;
      }

      for (const out of normalized.outputs) {
        this.recipeDag.setNode(out.itemId);
        if (!this.recipesByOutput.has(out.itemId)) {
          this.recipesByOutput.set(out.itemId, []);
        }
        this.recipesByOutput.get(out.itemId).push(normalized);

        for (const inp of normalized.inputs) {
          this.recipeDag.setNode(inp.itemId);
          this.recipeDag.setEdge(inp.itemId, out.itemId, { recipeId: normalized.recipeId });
          if (!alg.isAcyclic(this.recipeDag)) {
            this.recipeDag.removeEdge(inp.itemId, out.itemId);
            this.prunedCyclicRecipeIds.add(normalized.recipeId);
          }
        }
      }
    }

    for (const [outputId, list] of this.recipesByOutput.entries()) {
      const clean = list.filter((r) => !this.prunedCyclicRecipeIds.has(r.recipeId));
      if (clean.length > 0) {
        this.recipesByOutput.set(outputId, clean);
      }
    }
  }

  getTopologicalQuestOrder() {
    const order = alg.topsort(this.questGraph);
    return order.map((id) => this.questsById.get(id)).filter(Boolean);
  }

  markQuestCompleted(questId) {
    this.completedQuests.add(questId);
    const quest = this.questsById.get(questId);
    if (quest && quest.unlocksEra) {
      const unlockedEra = this.eras.find((e) => e.eraId === quest.unlocksEra);
      if (unlockedEra && unlockedEra.voltageTier) {
        this.setUnlockedVoltageTier(unlockedEra.voltageTier);
      }
    }
    this.emit('questCompleted', { questId, unlockedVoltageTier: this.unlockedVoltageTier });
  }

  setUnlockedVoltageTier(tier) {
    if (VOLTAGE_TIER_ORDER[tier] !== undefined) {
      this.unlockedVoltageTier = tier;
    }
  }

  setCurrentDimension(dimensionId) {
    if (dimensionId) {
      this.currentDimension = String(dimensionId);
    }
  }

  registerMachineAvailable(machineType) {
    this.availableMachines.add(machineType);
  }

  getAvailableQuests() {
    const ordered = this.getTopologicalQuestOrder();
    const available = [];

    for (const quest of ordered) {
      if (this.completedQuests.has(quest.questId)) continue;
      const deps = quest.dependencies || [];
      if (deps.length === 0) {
        available.push(quest);
        continue;
      }

      const logic = (quest.dependencyLogic || 'AND').toUpperCase();
      const satisfied =
        logic === 'OR'
          ? deps.some((d) => this.completedQuests.has(d))
          : deps.every((d) => this.completedQuests.has(d));

      if (satisfied) {
        available.push(quest);
      }
    }

    return available;
  }

  /**
   * Selects the best GTL recipe for `itemId` given unlocked voltage tier, active dimension
   * (e.g. `kubejs:ancient_world` gating in GTL), available machines, and fluid stock.
   */
  selectRecipeForItem(itemId, options = {}) {
    const canonical = normalizeItemId(itemId);
    const candidates = this.recipesByOutput.get(canonical);
    if (!candidates || candidates.length === 0) return null;

    const maxTier = options.maxVoltageTier || this.unlockedVoltageTier;
    const maxTierRank = VOLTAGE_TIER_ORDER[maxTier] ?? VOLTAGE_TIER_ORDER.LV;
    const activeDimension = options.currentDimension || this.currentDimension;
    const enforceMachines = options.enforceAvailableMachines ?? false;
    const stock = options.stockMap || null;

    const dimensionAndTierFilter = (rcp) => {
      if (this.prunedCyclicRecipeIds.has(rcp.recipeId)) return false;
      const rcpRank = VOLTAGE_TIER_ORDER[rcp.voltageTier] ?? 0;
      if (rcpRank > maxTierRank) return false;
      if (
        rcp.requiredDimension &&
        !options.allowCrossDimension &&
        rcp.requiredDimension !== activeDimension
      ) {
        return false;
      }
      return true;
    };

    const eligible = candidates.filter((rcp) => {
      if (!dimensionAndTierFilter(rcp)) return false;
      if (enforceMachines && !this.availableMachines.has(rcp.machine)) return false;
      if (rcp.fluidInputs && rcp.fluidInputs.length > 0 && stock) {
        const hasFluids = rcp.fluidInputs.every(
          (fl) => (stock.get(fl.fluidId) || 0) >= fl.amountMb
        );
        if (!hasFluids && !options.allowMissingFluids) return false;
      }
      return true;
    });

    if (eligible.length === 0) {
      const tierFiltered = candidates.filter(dimensionAndTierFilter);
      if (tierFiltered.length === 0) return null;
      return tierFiltered.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))[0];
    }

    eligible.sort((a, b) => {
      if ((b.priority ?? 0) !== (a.priority ?? 0)) {
        return (b.priority ?? 0) - (a.priority ?? 0);
      }
      return (VOLTAGE_TIER_ORDER[b.voltageTier] ?? 0) - (VOLTAGE_TIER_ORDER[a.voltageTier] ?? 0);
    });

    return eligible[0];
  }

  /**
   * Recursively resolves the complete GTL production chain for `(targetItemId, quantity)`
   * down to raw materials, cross-referencing live bot inventory + warehouse stock,
   * reusing intermediate batch surpluses across sibling branches, and outputting a
   * topologically ordered execution plan.
   */
  resolveCraftingPlan(targetItemId, quantity = 1, options = {}) {
    const canonicalTarget = normalizeItemId(targetItemId);
    const requestedCount = Math.max(1, Math.ceil(Number(quantity) || 1));

    const virtualStock = this.warehouse.getCombinedStock(
      options.bot || null,
      options.inventoryOverride || null
    );
    const initialStockSnapshot = new Map(virtualStock);

    const rawMaterials = new Map();
    const stockConsumed = new Map();
    const orderedSteps = [];
    const activeRecursionStack = new Set();

    const consumeFromVirtualStock = (id, needed) => {
      const avail = virtualStock.get(id) || 0;
      if (avail <= 0) return 0;
      const used = Math.min(avail, needed);
      virtualStock.set(id, avail - used);

      const origAvail = initialStockSnapshot.get(id) || 0;
      const prevConsumed = stockConsumed.get(id) || 0;
      const fromInitial = Math.max(0, Math.min(used, origAvail - prevConsumed));
      if (fromInitial > 0) {
        stockConsumed.set(id, prevConsumed + fromInitial);
      }
      return used;
    };

    const resolveNode = (itemId, neededCount, isRoot = false) => {
      let remaining = neededCount;
      let satisfiedFromStock = 0;

      if (!isRoot || options.deductTargetFromStock !== false) {
        satisfiedFromStock = consumeFromVirtualStock(itemId, remaining);
        remaining -= satisfiedFromStock;
      }

      const node = {
        itemId,
        requested: neededCount,
        fromStock: satisfiedFromStock,
        toCraft: remaining,
        recipeId: null,
        machine: null,
        batches: 0,
        children: []
      };

      if (remaining <= 0) {
        return node;
      }

      if (activeRecursionStack.has(itemId)) {
        rawMaterials.set(itemId, (rawMaterials.get(itemId) || 0) + remaining);
        node.isRawMaterial = true;
        return node;
      }

      const recipe = this.selectRecipeForItem(itemId, {
        maxVoltageTier: options.maxVoltageTier || this.unlockedVoltageTier,
        currentDimension: options.currentDimension || this.currentDimension,
        allowCrossDimension: options.allowCrossDimension ?? false,
        enforceAvailableMachines: options.enforceAvailableMachines ?? false,
        stockMap: virtualStock,
        allowMissingFluids: options.allowMissingFluids ?? false
      });

      if (!recipe) {
        rawMaterials.set(itemId, (rawMaterials.get(itemId) || 0) + remaining);
        node.isRawMaterial = true;
        return node;
      }

      const primaryOut = recipe.outputs.find((o) => o.itemId === itemId) || recipe.outputs[0];
      const yieldPerBatch = Math.max(1, primaryOut.count);
      const batches = Math.ceil(remaining / yieldPerBatch);
      const totalProduced = batches * yieldPerBatch;
      const surplus = totalProduced - remaining;

      node.recipeId = recipe.recipeId;
      node.machine = recipe.machine;
      node.programmedCircuit = recipe.programmedCircuit ?? null;
      node.batches = batches;

      activeRecursionStack.add(itemId);

      const stepInputs = [];
      for (const inp of recipe.inputs) {
        const totalInputNeeded = inp.count * batches;
        stepInputs.push({ itemId: inp.itemId, count: totalInputNeeded });
        const childNode = resolveNode(inp.itemId, totalInputNeeded, false);
        node.children.push(childNode);
      }

      const stepFluids = [];
      for (const fl of recipe.fluidInputs || []) {
        const totalMbNeeded = fl.amountMb * batches;
        const usedMb = consumeFromVirtualStock(fl.fluidId, totalMbNeeded);
        const missingMb = totalMbNeeded - usedMb;
        if (missingMb > 0) {
          rawMaterials.set(fl.fluidId, (rawMaterials.get(fl.fluidId) || 0) + missingMb);
        }
        stepFluids.push({ fluidId: fl.fluidId, amountMb: totalMbNeeded });
      }

      activeRecursionStack.delete(itemId);

      if (surplus > 0) {
        virtualStock.set(itemId, (virtualStock.get(itemId) || 0) + surplus);
      }
      for (const out of recipe.outputs) {
        if (out.itemId !== itemId) {
          const byproductQty = out.count * batches;
          virtualStock.set(out.itemId, (virtualStock.get(out.itemId) || 0) + byproductQty);
        }
      }

      orderedSteps.push({
        recipeId: recipe.recipeId,
        outputItemId: itemId,
        machine: recipe.machine,
        subMachine: recipe.subMachine || null,
        voltageTier: recipe.voltageTier,
        requiredDimension: recipe.requiredDimension || null,
        euPerTick: recipe.euPerTick,
        durationTicks: recipe.durationTicks * batches,
        totalEu: recipe.euPerTick * recipe.durationTicks * batches,
        programmedCircuit: recipe.programmedCircuit ?? null,
        nonConsumedTools: recipe.nonConsumedTools || [],
        batches,
        inputs: stepInputs,
        fluidInputs: stepFluids,
        outputs: recipe.outputs.map((o) => ({
          itemId: o.itemId,
          count: o.count * batches
        })),
        surplusGenerated: surplus
      });

      return node;
    };

    const dependencyTree = resolveNode(canonicalTarget, requestedCount, true);
    const mergedSteps = consolidateStepsTopological(orderedSteps);

    const warehouseWithdrawals = [];
    for (const [itemId, count] of stockConsumed.entries()) {
      const sourcePlan = this.warehouse.locateItemSources(
        itemId,
        count,
        options.originPos || null
      );
      warehouseWithdrawals.push(sourcePlan);
    }

    const totalEuRequired = mergedSteps.reduce((acc, s) => acc + s.totalEu, 0);
    const totalDurationTicks = mergedSteps.reduce((acc, s) => acc + s.durationTicks, 0);

    return {
      targetItemId: canonicalTarget,
      requestedCount,
      unlockedVoltageTier: options.maxVoltageTier || this.unlockedVoltageTier,
      currentDimension: options.currentDimension || this.currentDimension,
      dependencyTree,
      rawMaterials: Object.fromEntries(rawMaterials),
      warehouseWithdrawals,
      steps: mergedSteps,
      totalEuRequired,
      totalDurationTicks
    };
  }

  requestCraft(itemId, quantity = 1, requesterMeta = {}) {
    const plan = this.resolveCraftingPlan(itemId, quantity, requesterMeta.planOptions || {});
    const job = {
      jobId: `craft_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      itemId: plan.targetItemId,
      quantity: plan.requestedCount,
      requestedBy: requesterMeta.requestedBy || 'system',
      status: 'queued',
      createdAt: Date.now(),
      plan
    };
    this.craftQueue.push(job);
    this.emit('craftQueued', job);
    return job;
  }
}

function consolidateStepsTopological(steps) {
  const result = [];
  const indexByRecipe = new Map();

  for (const step of steps) {
    if (!indexByRecipe.has(step.recipeId)) {
      const cloned = {
        ...step,
        stepIndex: result.length,
        inputs: step.inputs.map((i) => ({ ...i })),
        fluidInputs: step.fluidInputs.map((f) => ({ ...f })),
        outputs: step.outputs.map((o) => ({ ...o }))
      };
      indexByRecipe.set(step.recipeId, result.length);
      result.push(cloned);
      continue;
    }

    const existingIdx = indexByRecipe.get(step.recipeId);
    const requiredIds = new Set(step.inputs.map((i) => i.itemId));
    let canMergeAtExisting = true;
    for (let k = existingIdx + 1; k < result.length; k++) {
      const intermediateOutputs = result[k].outputs.map((o) => o.itemId);
      if (intermediateOutputs.some((outId) => requiredIds.has(outId))) {
        canMergeAtExisting = false;
        break;
      }
    }

    if (canMergeAtExisting) {
      const target = result[existingIdx];
      target.batches += step.batches;
      target.durationTicks += step.durationTicks;
      target.totalEu += step.totalEu;
      target.surplusGenerated += step.surplusGenerated;
      for (const inp of step.inputs) {
        const match = target.inputs.find((x) => x.itemId === inp.itemId);
        if (match) match.count += inp.count;
        else target.inputs.push({ ...inp });
      }
      for (const fl of step.fluidInputs) {
        const match = target.fluidInputs.find((x) => x.fluidId === fl.fluidId);
        if (match) match.amountMb += fl.amountMb;
        else target.fluidInputs.push({ ...fl });
      }
      for (const out of step.outputs) {
        const match = target.outputs.find((x) => x.itemId === out.itemId);
        if (match) match.count += out.count;
        else target.outputs.push({ ...out });
      }
    } else {
      const cloned = {
        ...step,
        stepIndex: result.length,
        inputs: step.inputs.map((i) => ({ ...i })),
        fluidInputs: step.fluidInputs.map((f) => ({ ...f })),
        outputs: step.outputs.map((o) => ({ ...o }))
      };
      indexByRecipe.set(step.recipeId, result.length);
      result.push(cloned);
    }
  }

  result.forEach((s, i) => {
    s.stepIndex = i;
  });
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  VOLTAGE_TIER_ORDER,
  EMPTY_SLOT_120,
  WarehouseTracker,
  ContainerPacketController,
  CraftingEngine
};
