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
  UHV: 9
});

/**
 * Spatial warehouse ledger indexing chests, JABBA barrels, Storage Drawers,
 * and GregTech Super/Quantum Chests + Fluid Tanks by 3D world coordinates.
 */
class WarehouseTracker extends EventEmitter {
  /**
   * @param {Object} [options]
   * @param {ForgeRegistryBridge} [options.registryBridge]
   */
  constructor(options = {}) {
    super();
    this.registryBridge = options.registryBridge || new ForgeRegistryBridge();
    /**
     * Map of containerKey (`dim:x,y,z`) -> {
     *   key: string,
     *   position: Vec3,
     *   dimension: number,
     *   containerType: string,
     *   contents: Map<string, number>,
     *   slots: Map<number, { itemId: string, count: number }>,
     *   lastScannedAt: number
     * }
     */
    this.containers = new Map();
  }

  static makeKey(pos, dimension = 0) {
    const p = pos instanceof Vec3 ? pos.floored() : new Vec3(pos.x, pos.y, pos.z).floored();
    return `${dimension}:${p.x},${p.y},${p.z}`;
  }

  /**
   * Indexes or updates a storage container's contents at `(x, y, z)`.
   * @param {Vec3|{x:number,y:number,z:number}} position
   * @param {Array<{itemId?: string, type?: number, metadata?: number, count: number, slot?: number}>|Object} items
   * @param {Object} [meta]
   */
  upsertContainer(position, items, meta = {}) {
    const pos = position instanceof Vec3
      ? position.floored()
      : new Vec3(position.x, position.y, position.z).floored();
    const dimension = meta.dimension ?? 0;
    const key = WarehouseTracker.makeKey(pos, dimension);

    const contents = new Map();
    const slots = new Map();

    if (Array.isArray(items)) {
      items.forEach((raw, idx) => {
        if (!raw || (raw.count ?? 0) <= 0) return;
        const canonical = raw.itemId
          ? normalizeItemId(raw.itemId)
          : this.registryBridge.toCanonicalItemId(raw);
        if (!canonical) return;
        const slotIndex = raw.slot ?? idx;
        contents.set(canonical, (contents.get(canonical) || 0) + raw.count);
        slots.set(slotIndex, { itemId: canonical, count: raw.count });
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
  adjustContainerStock(position, itemId, delta, dimension = 0) {
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
   * @param {import('mineflayer').Bot|null} [bot]
   * @param {Object<string, number>} [extraStock]
   * @returns {Map<string, number>}
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
 * Packet-level container window click & GregTech GUI slot simulator.
 * Handles non-standard GregTech 5 Unofficial (GTNH) machine containers, action transaction
 * counters, phantom/ghost slots, and Programmed Circuit (#1..#24) configuration.
 */
class ContainerPacketController extends EventEmitter {
  /**
   * @param {import('mineflayer').Bot|null} bot
   * @param {Object} [options]
   * @param {Object} [options.windowProfiles]
   * @param {ForgeRegistryBridge} [options.registryBridge]
   * @param {number} [options.clickDelayMs=65]
   */
  constructor(bot = null, options = {}) {
    super();
    this.bot = bot;
    this.registryBridge = options.registryBridge || new ForgeRegistryBridge();
    this.windowProfiles = new Map();
    this.calibratedVectors = new Map();
    this.clickDelayMs = options.clickDelayMs ?? 65;

    this._actionCounter = 0;
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
   * Registers or overrides custom click-vector slot calibration for a specific GregTech GUI.
   * @param {string} machineProfileId - e.g. 'gt_lv_bender'
   * @param {Object} vectorConfig - Slot overrides (inputSlots, circuitSlot, ghostCircuitSelectorSlot, etc.)
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

    client.on('open_window', (packet) => {
      this.activeWindow = {
        windowId: packet.windowId,
        inventoryType: packet.inventoryType,
        windowTitle: packet.windowTitle,
        slotCount: packet.slotCount,
        slots: new Array((packet.slotCount || 0) + 36).fill(null)
      };
      this.progressBars.clear();
      this.emit('windowOpened', this.activeWindow);
    });

    client.on('window_items', (packet) => {
      if (this.activeWindow && packet.windowId === this.activeWindow.windowId) {
        this.activeWindow.slots = (packet.items || []).slice();
        this.emit('windowItemsUpdated', this.activeWindow);
      }
    });

    client.on('set_slot', (packet) => {
      if (this.activeWindow && packet.windowId === this.activeWindow.windowId && packet.slot >= 0) {
        this.activeWindow.slots[packet.slot] = packet.item;
        this.emit('slotUpdated', { slot: packet.slot, item: packet.item });
      }
    });

    client.on('craft_progress_bar', (packet) => {
      if (!this.activeWindow || packet.windowId === this.activeWindow.windowId) {
        this.progressBars.set(packet.property, packet.value);
        this.emit('progressUpdated', { property: packet.property, value: packet.value });
      }
    });

    client.on('transaction', (packet) => {
      if (!packet.accepted && typeof client.write === 'function') {
        // Forge/Vanilla protocol requirement: echo unaccepted transaction to resync container state
        client.write('transaction', {
          windowId: packet.windowId,
          action: packet.action,
          accepted: packet.accepted
        });
      }
      this.emit('transactionAck', packet);
    });
  }

  nextActionId() {
    this._actionCounter = (this._actionCounter % 32766) + 1;
    return this._actionCounter;
  }

  /**
   * Emits a raw `window_click` packet targeting an exact container slot index.
   *
   * @param {Object} params
   * @param {number} [params.windowId] - Defaults to currently open windowId (or 0 for player inv)
   * @param {number} params.slot - Exact raw container slot index
   * @param {number} [params.mouseButton=0] - 0=left, 1=right, 2=middle
   * @param {number} [params.mode=0] - 0=click, 1=shift, 2=hotbar, 3=clone/phantom
   * @param {Object|null} [params.clickedItem=null] - Wire slot payload ({ blockId: -1 } for empty)
   */
  async sendWindowClick({
    windowId,
    slot,
    mouseButton = 0,
    mode = 0,
    clickedItem = null
  }) {
    const resolvedWindowId =
      windowId ?? this.activeWindow?.windowId ?? this.bot?.currentWindow?.id ?? 0;
    const action = this.nextActionId();

    const wireItem = clickedItem || this._readSlotAsWireItem(resolvedWindowId, slot);

    const payload = {
      windowId: resolvedWindowId,
      slot,
      mouseButton,
      action,
      mode,
      item: wireItem
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

  _readSlotAsWireItem(windowId, slot) {
    if (slot < 0) return { blockId: -1 };
    const winSlot =
      (this.activeWindow && this.activeWindow.windowId === windowId
        ? this.activeWindow.slots[slot]
        : null) ||
      this.bot?.currentWindow?.slots?.[slot] ||
      null;

    if (!winSlot || winSlot.blockId === -1) {
      return { blockId: -1 };
    }

    return {
      blockId: winSlot.blockId ?? winSlot.type ?? -1,
      itemCount: winSlot.itemCount ?? winSlot.count ?? 1,
      itemDamage: winSlot.itemDamage ?? winSlot.metadata ?? 0,
      nbtData: winSlot.nbtData ?? winSlot.nbt ?? undefined
    };
  }

  /**
   * Moves an item stack from `sourceSlot` to `destSlot` via packet-level cursor pickup & placement.
   * Supports partial stack deposits (`count`) via right-click (`mouseButton: 1`) placement loops.
   */
  async transferSlotToSlot(sourceSlot, destSlot, count = null, windowId = undefined) {
    const clicks = [];
    // 1. Left-click source slot to lift stack onto cursor
    clicks.push(
      await this.sendWindowClick({ windowId, slot: sourceSlot, mouseButton: 0, mode: 0 })
    );

    if (count !== null && count > 0) {
      // 2a. Deposit exact count using right-click single-item drops, then return remainder to sourceSlot
      for (let i = 0; i < count; i++) {
        clicks.push(
          await this.sendWindowClick({
            windowId,
            slot: destSlot,
            mouseButton: 1,
            mode: 0,
            clickedItem: { blockId: -1 }
          })
        );
      }
      clicks.push(
        await this.sendWindowClick({
          windowId,
          slot: sourceSlot,
          mouseButton: 0,
          mode: 0,
          clickedItem: { blockId: -1 }
        })
      );
    } else {
      // 2b. Full stack placement via left-click on destination slot
      clicks.push(
        await this.sendWindowClick({
          windowId,
          slot: destSlot,
          mouseButton: 0,
          mode: 0,
          clickedItem: { blockId: -1 }
        })
      );
    }

    return clicks;
  }

  /**
   * Configures a GregTech Programmed Circuit (`gregtech:gt.integrated_circuit`, config #1..#24)
   * inside a machine container GUI (e.g., setting Circuit #14 in an LV Bending Machine).
   *
   * Supports two GTNH modes:
   *  - `'physical'` (classic GT5u physical Integrated Circuit item with NBT `Configuration` / damage `configNumber`,
   *    placed into `profile.circuitSlot`).
   *  - `'ghost'` (GTNH built-in Ghost Circuit selector button at `profile.ghostCircuitSelectorSlot`).
   *
   * @param {string} machineProfileId - e.g. `'gt_lv_bender'`
   * @param {number} configNumber - Integer in [1..24], e.g. `14`
   * @param {Object} [options]
   * @param {'physical'|'ghost'|'auto'} [options.strategy='auto']
   * @param {number} [options.playerCircuitSlot] - Player inventory slot index (0..35) holding the Integrated Circuit
   * @param {number} [options.windowId]
   */
  async configureProgrammedCircuit(machineProfileId, configNumber, options = {}) {
    if (!Number.isInteger(configNumber) || configNumber < 1 || configNumber > 24) {
      throw new RangeError(
        `Invalid GregTech Programmed Circuit configuration #${configNumber}; expected integer in [1..24]`
      );
    }

    const profile = this.getProfile(machineProfileId);
    const windowId = options.windowId ?? this.activeWindow?.windowId ?? 1;
    const strategy = options.strategy || 'auto';
    const packetsSent = [];

    const circuitNbt = nbt.comp({
      Configuration: nbt.byte(configNumber)
    });

    // Locate physical integrated circuit in player section of container if available
    const resolvedPlayerSlot =
      options.playerCircuitSlot ?? this._findIntegratedCircuitInWindow(profile);

    if (strategy === 'physical' || (strategy === 'auto' && resolvedPlayerSlot !== null)) {
      const sourceContainerSlot =
        resolvedPlayerSlot >= (profile.playerInventoryOffset ?? 0)
          ? resolvedPlayerSlot
          : (profile.playerInventoryOffset ?? 8) + resolvedPlayerSlot;
      const targetCircuitSlot = profile.circuitSlot ?? 3;
      const circuitMapping = this.registryBridge.fromCanonicalItemId(
        `gregtech:gt.integrated_circuit:${configNumber}`,
        this.bot?.registry
      );
      const wireCircuitItem = {
        blockId: circuitMapping.blockId !== -1 ? circuitMapping.blockId : 7159,
        itemCount: 1,
        itemDamage: configNumber,
        nbtData: circuitNbt
      };

      // Pick up configured Integrated Circuit from player slot and insert into machine circuitSlot
      packetsSent.push(
        await this.sendWindowClick({
          windowId,
          slot: sourceContainerSlot,
          mouseButton: 0,
          mode: 0,
          clickedItem: wireCircuitItem
        })
      );
      packetsSent.push(
        await this.sendWindowClick({
          windowId,
          slot: targetCircuitSlot,
          mouseButton: 0,
          mode: 0,
          clickedItem: { blockId: -1 }
        })
      );

      return {
        mode: 'physical',
        machineProfileId,
        configNumber,
        targetSlot: targetCircuitSlot,
        nbt: circuitNbt,
        packetsSent
      };
    }

    // Ghost-circuit selector mode (GTNH built-in circuit slot):
    // Step 1: Middle-click / double-reset ghost selector slot to clear to 0
    const ghostSlot = profile.ghostCircuitSelectorSlot ?? profile.circuitSlot ?? 4;
    packetsSent.push(
      await this.sendWindowClick({
        windowId,
        slot: ghostSlot,
        mouseButton: 2,
        mode: 3,
        clickedItem: { blockId: -1 }
      })
    );

    // Step 2: Advance selector to exact configuration #configNumber:
    // In GTNH ghost circuit selector, Shift+Right-Click (+5) and Right-Click (+1) step up cleanly.
    const bigSteps = Math.floor(configNumber / 5);
    const singleSteps = configNumber % 5;

    for (let i = 0; i < bigSteps; i++) {
      packetsSent.push(
        await this.sendWindowClick({
          windowId,
          slot: ghostSlot,
          mouseButton: 1,
          mode: 1,
          clickedItem: { blockId: -1 }
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
          clickedItem: { blockId: -1 }
        })
      );
    }

    return {
      mode: 'ghost',
      machineProfileId,
      configNumber,
      targetSlot: ghostSlot,
      nbt: circuitNbt,
      packetsSent
    };
  }

  _findIntegratedCircuitInWindow(profile) {
    const slots = this.activeWindow?.slots || this.bot?.currentWindow?.slots;
    if (!Array.isArray(slots)) return null;

    const start = profile.playerInventoryOffset ?? 0;
    for (let idx = start; idx < slots.length; idx++) {
      const slotItem = slots[idx];
      if (!slotItem) continue;
      const canonical = this.registryBridge.toCanonicalItemId(slotItem) || '';
      if (canonical.startsWith('gregtech:gt.integrated_circuit:')) {
        return idx;
      }
    }
    return null;
  }

  /**
   * Executes a single machine crafting step at the packet level:
   *  1. Validates hazard/power safety if a `hazardMonitor` is attached.
   *  2. Sets Programmed Circuit configuration (e.g. #14 in Bender) if required by recipe.
   *  3. Transfers each recipe input stack from player inventory slots into machine `inputSlots`.
   *  4. Collects crafted items from `outputSlots` via shift-click (`mode: 1`).
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

    // Re-verify power/rain did not trip mid-cycle before collecting output
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
        mode: 1 // Shift-click output directly into player inventory
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
 * Graph-Based GTNH Quest & JEI Crafting Engine.
 * Structures the entire BetterQuesting Quest Book and JEI/NEI Recipe Registry as
 * Directed Acyclic Graphs (DAGs), resolves multi-tier GTNH dependency trees against
 * live inventory + warehouse chests, and queues missing component requests from
 * other subsystems (such as `MultiblockBuilder`).
 */
class CraftingEngine extends EventEmitter {
  /**
   * @param {Object} [options]
   * @param {WarehouseTracker} [options.warehouse]
   * @param {ContainerPacketController} [options.containerController]
   * @param {ForgeRegistryBridge} [options.registryBridge]
   * @param {string} [options.unlockedVoltageTier='LV']
   */
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
    this.availableMachines = new Set(
      options.availableMachines || ['crafting_table', 'furnace', 'gt_steam_machine']
    );

    /** @type {Graph} Directed Acyclic Graph of questId -> dependent questId */
    this.questGraph = new Graph({ directed: true });
    /** @type {Graph} Directed Acyclic Graph of ingredientItemId -> outputItemId */
    this.recipeDag = new Graph({ directed: true });

    this.eras = [];
    this.questsById = new Map();
    this.completedQuests = new Set();

    this.recipesById = new Map();
    /** @type {Map<string, Array<Object>>} */
    this.recipesByOutput = new Map();
    this.prunedCyclicRecipeIds = new Set();

    /** Queue of on-demand craft jobs requested by MultiblockBuilder or Quest FSM */
    this.craftQueue = [];
  }

  /**
   * Loads a GTNH Quest Book + JEI Recipe Registry JSON file from disk.
   * @param {string} jsonFilePath
   */
  loadDatabaseFromFile(jsonFilePath) {
    const resolved = path.resolve(jsonFilePath);
    const raw = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    return this.ingestDatabase(raw);
  }

  /**
   * Ingests a structured GTNH Quest Book & JEI Recipe database into validated DAGs.
   * Automatically detects and breaks storage compression/decompression loops so
   * `this.recipeDag` is guaranteed to be a strict Directed Acyclic Graph.
   */
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

    // Break any malformed quest cycle in third-party dumps while preserving forward progression
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
          // Only add edge if adding inp -> out keeps the item production graph acyclic!
          this.recipeDag.setEdge(inp.itemId, out.itemId, { recipeId: normalized.recipeId });
          if (!alg.isAcyclic(this.recipeDag)) {
            this.recipeDag.removeEdge(inp.itemId, out.itemId);
            this.prunedCyclicRecipeIds.add(normalized.recipeId);
          }
        }
      }
    }

    // Remove any recipe flagged as cycle-inducing from canonical primary output selection
    for (const [outputId, list] of this.recipesByOutput.entries()) {
      const clean = list.filter((r) => !this.prunedCyclicRecipeIds.has(r.recipeId));
      if (clean.length > 0) {
        this.recipesByOutput.set(outputId, clean);
      }
    }
  }

  /**
   * Returns quests in valid topological execution order.
   */
  getTopologicalQuestOrder() {
    const order = alg.topsort(this.questGraph);
    return order.map((id) => this.questsById.get(id)).filter(Boolean);
  }

  /**
   * Marks a quest complete and unlocks any Era gated behind `quest.unlocksEra`.
   */
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

  registerMachineAvailable(machineType) {
    this.availableMachines.add(machineType);
  }

  /**
   * Computes all currently unlocked & incomplete quests in the Quest Book DAG.
   */
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
   * Selects the best recipe for `itemId` given the bot's unlocked voltage tier,
   * available machines, and current fluid stock.
   */
  selectRecipeForItem(itemId, options = {}) {
    const canonical = normalizeItemId(itemId);
    const candidates = this.recipesByOutput.get(canonical);
    if (!candidates || candidates.length === 0) return null;

    const maxTier = options.maxVoltageTier || this.unlockedVoltageTier;
    const maxTierRank = VOLTAGE_TIER_ORDER[maxTier] ?? VOLTAGE_TIER_ORDER.LV;
    const enforceMachines = options.enforceAvailableMachines ?? false;
    const stock = options.stockMap || null;

    const eligible = candidates.filter((rcp) => {
      if (this.prunedCyclicRecipeIds.has(rcp.recipeId)) return false;
      const rcpRank = VOLTAGE_TIER_ORDER[rcp.voltageTier] ?? 0;
      if (rcpRank > maxTierRank) return false;
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
      // Fallback to lowest voltage candidate if strict filters excluded all
      const tierFiltered = candidates.filter(
        (rcp) => (VOLTAGE_TIER_ORDER[rcp.voltageTier] ?? 0) <= maxTierRank
      );
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
   * Recursively resolves the complete GTNH production chain for `(targetItemId, quantity)`
   * down to raw materials, cross-referencing live bot inventory + warehouse stock,
   * reusing intermediate batch surpluses across sibling branches, and outputting a
   * topologically ordered execution plan.
   *
   * @param {string} targetItemId - e.g. `'gregtech:gt.metaitem.01:32700'` (LV Electronic Circuit)
   * @param {number} [quantity=1]
   * @param {Object} [options]
   * @param {import('mineflayer').Bot} [options.bot]
   * @param {Object|Map<string,number>} [options.inventoryOverride]
   * @param {string} [options.maxVoltageTier]
   * @param {boolean} [options.enforceAvailableMachines=false]
   * @param {Vec3} [options.originPos]
   */
  resolveCraftingPlan(targetItemId, quantity = 1, options = {}) {
    const canonicalTarget = normalizeItemId(targetItemId);
    const requestedCount = Math.max(1, Math.ceil(Number(quantity) || 1));

    // Virtual stock ledger initialized from WarehouseTracker + bot inventory + optional overrides
    const virtualStock = this.warehouse.getCombinedStock(
      options.bot || null,
      options.inventoryOverride || null
    );
    const initialStockSnapshot = new Map(virtualStock);

    const rawMaterials = new Map();
    const stockConsumed = new Map();
    /** @type {Array<Object>} */
    const orderedSteps = [];
    const activeRecursionStack = new Set();

    const consumeFromVirtualStock = (id, needed) => {
      const avail = virtualStock.get(id) || 0;
      if (avail <= 0) return 0;
      const used = Math.min(avail, needed);
      virtualStock.set(id, avail - used);

      // Only attribute to `stockConsumed` up to what originally existed in inventory/warehouse
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

      // Root target can optionally force fresh crafting or use stock (default: deduct existing stock)
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
        // Cycle guard fallback: treat as raw external requirement
        rawMaterials.set(itemId, (rawMaterials.get(itemId) || 0) + remaining);
        node.isRawMaterial = true;
        return node;
      }

      const recipe = this.selectRecipeForItem(itemId, {
        maxVoltageTier: options.maxVoltageTier || this.unlockedVoltageTier,
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

      // Resolve all item inputs first (post-order DFS guarantees topological order!)
      const stepInputs = [];
      for (const inp of recipe.inputs) {
        const totalInputNeeded = inp.count * batches;
        stepInputs.push({ itemId: inp.itemId, count: totalInputNeeded });
        const childNode = resolveNode(inp.itemId, totalInputNeeded, false);
        node.children.push(childNode);
      }

      // Resolve fluid inputs
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

      // Credit surplus & secondary byproducts into virtualStock for downstream sibling branches!
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

    // Consolidate identical consecutive or parallelizable steps while preserving topological validity
    const mergedSteps = consolidateStepsTopological(orderedSteps);

    // Resolve concrete warehouse withdrawal coordinates for all stockConsumed items
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
      dependencyTree,
      rawMaterials: Object.fromEntries(rawMaterials),
      warehouseWithdrawals,
      steps: mergedSteps,
      totalEuRequired,
      totalDurationTicks
    };
  }

  /**
   * Queues an on-demand craft request (e.g. invoked by `MultiblockBuilder` when a casing,
   * controller, or specialized hatch is missing during layout execution).
   */
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

/**
 * Merges duplicate recipe invocations that share the same `recipeId` when doing so
 * preserves strict topological ordering (all inputs produced before consumer step).
 */
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
    // Check if any step AFTER existingIdx produces an input required by `step`
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
  WarehouseTracker,
  ContainerPacketController,
  CraftingEngine
};
