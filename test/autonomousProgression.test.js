'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const Vec3 = require('vec3');
const prismarineRegistry = require('prismarine-registry');
const mcData = require('minecraft-data')('1.20.1');

const { GTLAutomationAgent } = require('../src/bot');
const { installPhysicTickDeprecationShim } = require('../src/statemachine/hierarchy');
const {
  AutonomousProgressionEngine,
  matchesItemSpec
} = require('../src/survival/autonomousProgression');

/**
 * Builds an interactive stateful 3D survival world + live Crafting Table / Furnace / Blast Furnace
 * harness so `AutonomousProgressionEngine` executes genuine survival milestones from an empty inventory!
 */
function createInteractiveSurvivalWorldHarness() {
  const bot = new EventEmitter();
  bot.version = '1.20.1';
  bot.registry = prismarineRegistry('1.20.1');

  bot.entity = {
    position: new Vec3(0.5, 64, 0.5),
    velocity: new Vec3(0, 0, 0),
    height: 1.8,
    effects: {}
  };
  bot.entities = {};
  bot.health = 20;
  bot.food = 20;
  bot.heldItem = null;

  // Track any deprecation warnings if `physicTick` is ever registered raw
  const deprecationWarnings = [];
  bot.on('newListener', (event) => {
    if (event === 'physicTick') {
      deprecationWarnings.push("Deprecated: 'physicTick' event is deprecated");
    }
  });

  // World voxel map: "x,y,z" -> { id, name, stateId, boundingBox, position }
  const voxels = new Map();
  const keyOf = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;

  const setBlock = (x, y, z, name, customStateId = null) => {
    const pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
    if (name === 'air') {
      voxels.delete(keyOf(pos.x, pos.y, pos.z));
      return;
    }
    const blkEntry = bot.registry.blocksByName[name] || {
      id: 900,
      name,
      defaultState: customStateId || 48000,
      boundingBox: 'block'
    };
    const bbox = blkEntry.boundingBox || 'block';
    voxels.set(keyOf(pos.x, pos.y, pos.z), {
      id: blkEntry.id,
      type: blkEntry.id,
      name,
      stateId: customStateId ?? blkEntry.defaultState ?? 1,
      boundingBox: bbox,
      shapes: bbox === 'block' ? [[0, 0, 0, 1, 1, 1]] : [],
      position: pos
    });
  };

  // Flat bedrock/stone/grass terrain around (-24..24, y=20..63, -24..24)
  for (let x = -20; x <= 20; x++) {
    for (let z = -20; z <= 20; z++) {
      setBlock(x, 63, z, 'grass_block');
      for (let y = 58; y <= 62; y++) {
        setBlock(x, y, z, 'stone');
      }
    }
  }

  // Five Oak Trees around spawn -> 20 oak_log (80 planks) for crafting + starter fuel
  for (const [tx, tz] of [
    [6, 6],
    [8, 6],
    [10, 6],
    [6, 9],
    [8, 9]
  ]) {
    for (let dy = 0; dy < 4; dy++) {
      setBlock(tx, 64 + dy, tz, 'oak_log');
    }
  }

  // Surface Clay patch at (-8, 63, 6..-6) -> 20 clay blocks
  for (let i = 0; i < 8; i++) {
    setBlock(-8, 63, i, 'clay');
  }

  // Underground Iron vein (`iron_ore` at y=60 -> 20 blocks = 40 raw_iron)
  for (let i = 0; i < 20; i++) {
    setBlock(-12 + (i % 5), 60, -10 - Math.floor(i / 5), 'iron_ore');
  }

  // Underground MODDED GTCEu 3x3-chunk veins (`stateId > vanillaMaxStateId` embedded in `stone`!):
  // - stateId 48120 = gtceu:chalcopyrite_ore (drops `gtceu:raw_chalcopyrite` -> Copper!)
  // - stateId 49310 = gtceu:cassiterite_ore (drops `gtceu:raw_cassiterite` -> Tin!)
  for (let x = 12; x <= 16; x++) {
    for (let z = -14; z <= -10; z++) {
      setBlock(x, 59, z, 'stone');
      setBlock(x, 61, z, 'stone');
    }
  }
  for (let i = 0; i < 10; i++) {
    setBlock(13 + (i % 3), 60, -13 + Math.floor(i / 4), 'gtceu:chalcopyrite_ore', 48120);
  }
  for (let i = 0; i < 6; i++) {
    setBlock(15, 60, -13 + i, 'gtceu:cassiterite_ore', 49310);
  }

  bot.blockAt = (pos) => {
    const k = keyOf(pos.x, pos.y, pos.z);
    if (voxels.has(k)) return voxels.get(k);
    return {
      id: 0,
      type: 0,
      name: 'air',
      stateId: 0,
      boundingBox: 'empty',
      shapes: [],
      position: new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z))
    };
  };

  bot.findBlocks = ({ matching, maxDistance = 64, count = 16 }) => {
    const matchSet = new Set(Array.isArray(matching) ? matching : [matching]);
    const center = bot.entity.position;
    const out = [];
    for (const blk of voxels.values()) {
      if (matchSet.has(blk.id) && blk.position.distanceTo(center) <= maxDistance) {
        out.push(blk.position.clone());
      }
    }
    out.sort((a, b) => a.distanceTo(center) - b.distanceTo(center));
    return out.slice(0, count);
  };

  bot.findBlock = (opts) => {
    const list = bot.findBlocks({ ...opts, count: 1 });
    return list.length > 0 ? bot.blockAt(list[0]) : null;
  };

  // Stateful Player Inventory (`slots 9..44`)
  const invStacks = []; // [{ type, name, count }]
  let registryBridgeRef = null;

  const resolveItemEntry = (canonicalName) => {
    const full = canonicalName.includes(':') ? canonicalName : `minecraft:${canonicalName}`;
    const short = full.replace(/^minecraft:/, '');
    if (bot.registry.itemsByName[short]) {
      return { id: bot.registry.itemsByName[short].id, name: short };
    }
    if (bot.registry.itemsByName[full]) {
      return { id: bot.registry.itemsByName[full].id, name: full };
    }
    const bridged = registryBridgeRef?.itemNameToNumeric?.get(full);
    if (bridged !== null && bridged !== undefined) {
      return { id: bridged, name: full };
    }
    return { id: 25000, name: full };
  };

  const addItem = (canonicalName, count = 1) => {
    const entry = resolveItemEntry(canonicalName);
    const existing = invStacks.find((s) => s.type === entry.id && s.name === entry.name);
    if (existing) {
      existing.count += count;
    } else {
      invStacks.push({ type: entry.id, name: entry.name, count });
    }
  };

  const removeItemByType = (typeId, count = 1) => {
    const idx = invStacks.findIndex((s) => s.type === typeId);
    if (idx === -1) return false;
    if (invStacks[idx].count < count) return false;
    invStacks[idx].count -= count;
    if (invStacks[idx].count <= 0) invStacks.splice(idx, 1);
    return true;
  };

  const removeMatchingSpec = (spec, count = 1) => {
    let rem = count;
    for (let i = invStacks.length - 1; i >= 0 && rem > 0; i--) {
      const canonical = invStacks[i].name.includes(':')
        ? invStacks[i].name
        : `minecraft:${invStacks[i].name}`;
      if (matchesItemSpec(canonical, spec)) {
        const take = Math.min(rem, invStacks[i].count);
        invStacks[i].count -= take;
        rem -= take;
        if (invStacks[i].count <= 0) invStacks.splice(i, 1);
      }
    }
    return rem === 0;
  };

  const craftGrid2x2 = [null, null, null, null, null];
  bot.inventory = {
    type: 'minecraft:inventory',
    inventoryStart: 9,
    inventoryEnd: 45,
    selectedItem: null,
    craftGrid2x2,
    get slots() {
      const arr = new Array(46).fill(null);
      for (let g = 0; g <= 4; g++) {
        arr[g] = craftGrid2x2[g];
      }
      invStacks.forEach((s, i) => {
        arr[9 + i] = { slot: 9 + i, type: s.type, name: s.name, count: s.count };
      });
      return arr;
    },
    items: () =>
      invStacks.map((s, i) => ({
        slot: 9 + i,
        type: s.type,
        name: s.name,
        count: s.count
      }))
  };

  bot.equip = async (item) => {
    bot.heldItem = item;
  };

  bot.consume = async () => {
    if (bot.heldItem) {
      removeItemByType(bot.heldItem.type, 1);
      bot.food = Math.min(20, bot.food + 8);
    }
  };

  bot.pathfinder = {
    setMovements: () => {},
    setGoal: () => {},
    goto: async (goal) => {
      if (typeof goal.x === 'number' && typeof goal.z === 'number') {
        bot.entity.position = new Vec3(goal.x + 0.5, goal.y ?? 64, goal.z + 0.5);
      }
    }
  };

  const metrics = {
    totalDigs: 0,
    forceLookTrueDigs: 0,
    bareHandLogDigs: 0,
    woodenPickCobbleDigs: 0,
    openBlockCalls: 0
  };

  bot.dig = async (block, forceLook) => {
    const blk = bot.blockAt(block.position);
    if (!blk || blk.type === 0) return;
    metrics.totalDigs += 1;
    if (forceLook === true) metrics.forceLookTrueDigs += 1;
    const heldName = String(bot.heldItem?.name || '');
    if (blk.name === 'oak_log' && !heldName.includes('axe')) {
      metrics.bareHandLogDigs += 1;
    }
    if ((blk.name === 'stone' || blk.name === 'cobblestone') && heldName === 'wooden_pickaxe') {
      metrics.woodenPickCobbleDigs += 1;
    }
    setBlock(blk.position.x, blk.position.y, blk.position.z, 'air');
    if (blk.name === 'oak_log') addItem('minecraft:oak_log', 1);
    else if (blk.name === 'stone' || blk.name === 'cobblestone') addItem('minecraft:cobblestone', 1);
    else if (blk.name === 'clay') addItem('minecraft:clay_ball', 4);
    else if (blk.name === 'iron_ore') addItem('minecraft:raw_iron', 2);
    else if (blk.stateId === 48120) addItem('gtceu:raw_chalcopyrite', 3);
    else if (blk.stateId === 49310) addItem('gtceu:raw_cassiterite', 3);
  };

  bot.placeBlock = async (refBlock, faceVec) => {
    if (!bot.heldItem) throw new Error('Nothing equipped to place');
    const target = refBlock.position.plus(faceVec);
    const placeName = bot.heldItem.name;
    removeItemByType(bot.heldItem.type, 1);
    setBlock(target.x, target.y, target.z, placeName);
  };

  // Vanilla `recipesFor` + `craft`
  const VANILLA_RECIPES = {
    oak_planks: { in: [['#logs', 1]], out: ['minecraft:oak_planks', 4], table: false },
    stick: { in: [['#planks', 2]], out: ['minecraft:stick', 4], table: false },
    crafting_table: { in: [['#planks', 4]], out: ['minecraft:crafting_table', 1], table: false },
    wooden_pickaxe: {
      in: [['#planks', 3], ['minecraft:stick', 2]],
      out: ['minecraft:wooden_pickaxe', 1],
      table: true
    },
    stone_pickaxe: {
      in: [['#cobblestone', 3], ['minecraft:stick', 2]],
      out: ['minecraft:stone_pickaxe', 1],
      table: true
    },
    stone_axe: {
      in: [['#cobblestone', 3], ['minecraft:stick', 2]],
      out: ['minecraft:stone_axe', 1],
      table: true
    },
    stone_sword: {
      in: [['#cobblestone', 2], ['minecraft:stick', 1]],
      out: ['minecraft:stone_sword', 1],
      table: true
    },
    furnace: { in: [['#cobblestone', 8]], out: ['minecraft:furnace', 1], table: true },
    chest: { in: [['#planks', 8]], out: ['minecraft:chest', 1], table: true },
    iron_pickaxe: {
      in: [['minecraft:iron_ingot', 3], ['minecraft:stick', 2]],
      out: ['minecraft:iron_pickaxe', 1],
      table: true
    },
    bucket: { in: [['minecraft:iron_ingot', 3]], out: ['minecraft:bucket', 1], table: true },
    blast_furnace: {
      in: [
        ['minecraft:iron_ingot', 5],
        ['minecraft:furnace', 1],
        ['minecraft:smooth_stone', 3]
      ],
      out: ['minecraft:blast_furnace', 1],
      table: true
    },
    bricks: { in: [['minecraft:brick', 4]], out: ['minecraft:bricks', 1], table: false }
  };

  bot.recipesFor = (itemId, _meta, _minResult, craftingTable) => {
    const itemObj = mcData.items[itemId];
    if (!itemObj) return [];
    const rule = VANILLA_RECIPES[itemObj.name];
    if (!rule) return [];
    if (rule.table && !craftingTable) return [];
    for (const [spec, qty] of rule.in) {
      let have = 0;
      for (const s of invStacks) {
        const cid = s.name.includes(':') ? s.name : `minecraft:${s.name}`;
        if (matchesItemSpec(cid, spec)) have += s.count;
      }
      if (have < qty) return [];
    }
    return [{ id: itemObj.name, rule }];
  };

  bot.craft = async (recipe, count = 1) => {
    for (let i = 0; i < count; i++) {
      for (const [spec, qty] of recipe.rule.in) {
        if (!removeMatchingSpec(spec, qty)) throw new Error(`Missing ${spec}`);
      }
      addItem(recipe.rule.out[0], recipe.rule.out[1]);
    }
  };

  // Server-authoritative 3x3 Crafting Table window (`openBlock` + `clickWindow`)
  let activeCraftWindow = null;

  const evaluateModded3x3Result = (gridSlots) => {
    const names = gridSlots.map((s) => (s ? (s.name.includes(':') ? s.name : `minecraft:${s.name}`) : null));
    const nonNull = names.filter(Boolean);

    // Iron Hammer: 6 iron_ingot + 1 stick
    if (
      nonNull.length === 7 &&
      nonNull.filter((n) => n === 'minecraft:iron_ingot').length === 6 &&
      nonNull.includes('minecraft:stick')
    ) {
      return { item: 'gtceu:iron_hammer', count: 1, keepToolSlots: [] };
    }
    // Iron Mortar: 2 iron_ingot + 5 stone
    if (
      nonNull.length === 7 &&
      nonNull.filter((n) => n === 'minecraft:iron_ingot').length === 2 &&
      nonNull.filter((n) => n === 'minecraft:stone').length === 5
    ) {
      return { item: 'gtceu:iron_mortar', count: 1, keepToolSlots: [] };
    }
    // Hammer + 2 Iron Ingot -> Iron Plate (Hammer stays in grid!)
    if (
      nonNull.length === 3 &&
      nonNull.some((n) => n.endsWith('_hammer')) &&
      nonNull.filter((n) => n === 'minecraft:iron_ingot').length === 2
    ) {
      return {
        item: 'gtceu:iron_plate',
        count: 1,
        keepToolSlots: names.map((n, idx) => (n && n.endsWith('_hammer') ? idx + 1 : -1)).filter((v) => v > 0)
      };
    }
    // Hammer + 2 Bronze Ingot -> Bronze Plate (Hammer stays in grid!)
    if (
      nonNull.length === 3 &&
      nonNull.some((n) => n.endsWith('_hammer')) &&
      nonNull.filter((n) => n === 'gtceu:bronze_ingot').length === 2
    ) {
      return {
        item: 'gtceu:bronze_plate',
        count: 1,
        keepToolSlots: names.map((n, idx) => (n && n.endsWith('_hammer') ? idx + 1 : -1)).filter((v) => v > 0)
      };
    }
    // Iron Wrench: 6 iron_plate + Hammer
    if (
      nonNull.length === 7 &&
      nonNull.some((n) => n.endsWith('_hammer')) &&
      nonNull.filter((n) => n === 'gtceu:iron_plate').length === 6
    ) {
      return {
        item: 'gtceu:iron_wrench',
        count: 1,
        keepToolSlots: names.map((n, idx) => (n && n.endsWith('_hammer') ? idx + 1 : -1)).filter((v) => v > 0)
      };
    }
    // Iron File: 2 iron_plate + 1 stick
    if (
      nonNull.length === 3 &&
      nonNull.filter((n) => n === 'gtceu:iron_plate').length === 2 &&
      nonNull.includes('minecraft:stick')
    ) {
      return { item: 'gtceu:iron_file', count: 1, keepToolSlots: [] };
    }
    // Mortar + Copper Ingot -> Copper Dust
    if (nonNull.length === 2 && nonNull.some((n) => n.endsWith('_mortar')) && nonNull.includes('minecraft:copper_ingot')) {
      return {
        item: 'gtceu:copper_dust',
        count: 1,
        keepToolSlots: names.map((n, idx) => (n && n.endsWith('_mortar') ? idx + 1 : -1)).filter((v) => v > 0)
      };
    }
    // Mortar + Tin Ingot -> Tin Dust
    if (nonNull.length === 2 && nonNull.some((n) => n.endsWith('_mortar')) && nonNull.includes('gtceu:tin_ingot')) {
      return {
        item: 'gtceu:tin_dust',
        count: 1,
        keepToolSlots: names.map((n, idx) => (n && n.endsWith('_mortar') ? idx + 1 : -1)).filter((v) => v > 0)
      };
    }
    // 3 Copper Dust + 1 Tin Dust -> 4 Bronze Dust
    if (
      nonNull.length === 4 &&
      nonNull.filter((n) => n === 'gtceu:copper_dust').length === 3 &&
      nonNull.includes('gtceu:tin_dust')
    ) {
      return { item: 'gtceu:bronze_dust', count: 4, keepToolSlots: [] };
    }
    // LP Steam Solid Boiler: 5 bronze_plate + wrench + 2 bricks + 1 furnace
    if (
      nonNull.length === 9 &&
      nonNull.filter((n) => n === 'gtceu:bronze_plate').length === 5 &&
      nonNull.some((n) => n.endsWith('_wrench')) &&
      nonNull.filter((n) => n === 'minecraft:bricks').length === 2 &&
      nonNull.includes('minecraft:furnace')
    ) {
      return {
        item: 'gtceu:lp_steam_solid_boiler',
        count: 1,
        keepToolSlots: names.map((n, idx) => (n && n.endsWith('_wrench') ? idx + 1 : -1)).filter((v) => v > 0)
      };
    }
    return null;
  };

  const buildCraftWindow = (gridSize = 9) => {
    const win = {
      inventoryStart: 1 + gridSize,
      inventoryEnd: 1 + gridSize + 36,
      selectedItem: null,
      grid: new Array(gridSize).fill(null),
      resultMeta: null,
      get slots() {
        const s = new Array(1 + gridSize + 36).fill(null);
        const evalRes = evaluateModded3x3Result(this.grid);
        this.resultMeta = evalRes;
        if (evalRes) {
          const entry = resolveItemEntry(evalRes.item);
          s[0] = { slot: 0, type: entry.id, name: entry.name, count: evalRes.count };
        }
        for (let g = 0; g < gridSize; g++) {
          if (this.grid[g]) s[1 + g] = { slot: 1 + g, ...this.grid[g] };
        }
        invStacks.forEach((st, i) => {
          s[1 + gridSize + i] = {
            slot: 1 + gridSize + i,
            type: st.type,
            name: st.name,
            count: st.count
          };
        });
        return s;
      }
    };
    return win;
  };

  bot.openBlock = async () => {
    metrics.openBlockCalls += 1;
    activeCraftWindow = buildCraftWindow(9);
    return activeCraftWindow;
  };

  bot.closeWindow = async () => {
    activeCraftWindow = null;
  };

  bot.clickWindow = async (slot, mouseButton, mode) => {
    if (!activeCraftWindow) {
      activeCraftWindow = buildCraftWindow(4);
    }
    const win = activeCraftWindow;
    const gridEnd = win.inventoryStart - 1;

    if (slot === 0 && mode === 1) {
      const res = evaluateModded3x3Result(win.grid);
      if (res) {
        addItem(res.item, res.count);
        for (let g = 0; g < win.grid.length; g++) {
          if (win.grid[g] && !res.keepToolSlots.includes(g + 1)) {
            win.grid[g].count -= 1;
            if (win.grid[g].count <= 0) win.grid[g] = null;
          }
        }
      }
      return;
    }

    if (slot >= 1 && slot <= gridEnd && mode === 1) {
      const gItem = win.grid[slot - 1];
      if (gItem) {
        addItem(gItem.name, gItem.count);
        win.grid[slot - 1] = null;
      }
      return;
    }

    if (slot >= win.inventoryStart && mode === 0 && mouseButton === 0) {
      if (!win.selectedItem) {
        const idx = slot - win.inventoryStart;
        const st = invStacks[idx];
        if (st) {
          win.selectedItem = { ...st };
          invStacks.splice(idx, 1);
        }
      } else {
        addItem(win.selectedItem.name, win.selectedItem.count);
        win.selectedItem = null;
      }
      return;
    }

    if (slot >= 1 && slot <= gridEnd && mode === 0 && mouseButton === 1 && win.selectedItem) {
      if (!win.grid[slot - 1]) {
        win.grid[slot - 1] = { type: win.selectedItem.type, name: win.selectedItem.name, count: 1 };
      } else {
        win.grid[slot - 1].count += 1;
      }
      win.selectedItem.count -= 1;
      if (win.selectedItem.count <= 0) win.selectedItem = null;
    }
  };

  // Live Furnace & GTL 1-Tick Blast Furnace
  bot.openFurnace = async () => {
    let fuelSlot = null;
    let outSlot = null;
    return {
      fuelItem: () => fuelSlot,
      inputItem: () => null,
      outputItem: () => outSlot,
      putFuel: async (typeId, _meta, count) => {
        removeItemByType(typeId, count);
        fuelSlot = { type: typeId, count };
      },
      putInput: async (typeId, _meta, count) => {
        const src = invStacks.find((s) => s.type === typeId);
        const srcName = src ? src.name : '';
        removeItemByType(typeId, count);

        let outCanonical = null;
        if (srcName === 'raw_iron' || srcName.includes('magnetite')) outCanonical = 'minecraft:iron_ingot';
        else if (srcName === 'cobblestone') outCanonical = 'minecraft:stone';
        else if (srcName === 'stone') outCanonical = 'minecraft:smooth_stone';
        else if (srcName === 'raw_copper' || srcName.includes('chalcopyrite')) outCanonical = 'minecraft:copper_ingot';
        else if (srcName.includes('cassiterite') || srcName === 'gtceu:raw_tin') outCanonical = 'gtceu:tin_ingot';
        else if (srcName === 'gtceu:bronze_dust') outCanonical = 'gtceu:bronze_ingot';
        else if (srcName === 'clay_ball') outCanonical = 'minecraft:brick';

        if (outCanonical) {
          const entry = resolveItemEntry(outCanonical);
          outSlot = { type: entry.id, name: entry.name, count };
        }
      },
      takeOutput: async () => {
        if (outSlot) {
          addItem(outSlot.name, outSlot.count);
          outSlot = null;
        }
      },
      takeInput: async () => {},
      close: () => {}
    };
  };

  return {
    bot,
    voxels,
    invStacks,
    addItem,
    metrics,
    deprecationWarnings,
    bindRegistryBridge: (rb) => {
      registryBridgeRef = rb;
    }
  };
}

test('installPhysicTickDeprecationShim silences Mineflayer physics.js physicTick warning while preserving tick updates', () => {
  const { bot, deprecationWarnings } = createInteractiveSurvivalWorldHarness();
  installPhysicTickDeprecationShim(bot);

  const agent = new GTLAutomationAgent({
    autoReconnect: false,
    enableAutonomousSurvival: false
  });
  agent.attachBot(bot, { startStateMachineImmediately: true });

  assert.equal(
    deprecationWarnings.length,
    0,
    'Expected ZERO physicTick deprecation warnings when BotStateMachine subscribes'
  );
  agent.shutdown();
});

test('AutonomousProgressionEngine self-care eats food when hungry and evades nearby Creepers', async () => {
  const { bot, addItem, bindRegistryBridge } = createInteractiveSurvivalWorldHarness();
  const agent = new GTLAutomationAgent({
    autoReconnect: false,
    enableAutonomousSurvival: false
  });
  bindRegistryBridge(agent.registryBridge);
  agent.attachBot(bot, {
    progressionOptions: { persistState: false, actionDelayScale: 0 }
  });

  // 1. Hunger self-care
  bot.food = 10;
  addItem('minecraft:bread', 2);
  const resEat = await agent.progressionEngine.runSingleCycle();
  assert.equal(resEat.stage, 'SELF_CARE');
  assert.equal(bot.food, 18);

  // 2. Creeper blast evasion
  bot.entities[99] = {
    id: 99,
    name: 'creeper',
    position: new Vec3(2.5, 64, 0.5),
    height: 1.7
  };
  const startPos = bot.entity.position.clone();
  const resCreeper = await agent.progressionEngine.runSingleCycle();
  assert.equal(resCreeper.stage, 'SELF_CARE');
  assert.ok(
    bot.entity.position.distanceTo(startPos) > 4,
    'Bot should sprint away from nearby Creeper'
  );

  agent.shutdown();
});

test('AutonomousProgressionEngine plays from empty-handed spawn through Wood -> Base -> 1-Tick Blast Furnace -> GTCEu Tools -> Modded Vein Prospecting -> Bronze & Steam -> PBF -> MV/HV Quest Frontier', async () => {
  const { bot, addItem, metrics, bindRegistryBridge, deprecationWarnings } =
    createInteractiveSurvivalWorldHarness();

  const agent = new GTLAutomationAgent({
    autoReconnect: false,
    enableAutonomousSurvival: false
  });

  // Load synced GregTech Leisure 1.20.1 modded item/block IDs
  agent.registryBridge.loadDump([
    { kind: 'item', name: 'gtceu:iron_hammer', id: 14001 },
    { kind: 'item', name: 'gtceu:iron_mortar', id: 14002 },
    { kind: 'item', name: 'gtceu:iron_plate', id: 14003 },
    { kind: 'item', name: 'gtceu:iron_wrench', id: 14004 },
    { kind: 'item', name: 'gtceu:iron_file', id: 14005 },
    { kind: 'item', name: 'gtceu:raw_chalcopyrite', id: 14006 },
    { kind: 'item', name: 'gtceu:raw_cassiterite', id: 14007 },
    { kind: 'item', name: 'gtceu:tin_ingot', id: 14008 },
    { kind: 'item', name: 'gtceu:copper_dust', id: 14009 },
    { kind: 'item', name: 'gtceu:tin_dust', id: 14010 },
    { kind: 'item', name: 'gtceu:bronze_dust', id: 14011 },
    { kind: 'item', name: 'gtceu:bronze_ingot', id: 14012 },
    { kind: 'item', name: 'gtceu:bronze_plate', id: 14013 },
    { kind: 'item', name: 'gtceu:lp_steam_solid_boiler', id: 14014 },
    { kind: 'item', name: 'gtceu:firebricks', id: 14015 },
    { kind: 'item', name: 'gtceu:primitive_blast_furnace', id: 14016 },
    { kind: 'item', name: 'kubejs:advanced_control_circuit', id: 14017 },
    { kind: 'item', name: 'gtceu:aluminium_ingot', id: 14018 },
    { kind: 'item', name: 'gtceu:stainless_steel_ingot', id: 14019 },
    { kind: 'block', name: 'gtceu:lp_steam_solid_boiler', id: 3201 },
    { kind: 'block', name: 'gtceu:firebricks', id: 3202 },
    { kind: 'block', name: 'gtceu:primitive_blast_furnace', id: 3203 }
  ]);
  bindRegistryBridge(agent.registryBridge);

  const completedMilestones = [];
  agent.on('milestoneCompleted', (id) => completedMilestones.push(id));

  agent.attachBot(bot, {
    progressionOptions: { persistState: false, stepIntervalMs: 10, actionDelayScale: 0 }
  });
  assert.equal(deprecationWarnings.length, 0);

  const engine = agent.progressionEngine;
  assert.ok(engine instanceof AutonomousProgressionEngine);
  assert.equal(engine.getInventoryItems().length, 0, 'Starts completely empty-handed');

  // Run autonomous cycles continuously — no commands issued!
  let cyclesUsed = 0;
  for (let cycle = 0; cycle < 65; cycle++) {
    cyclesUsed += 1;
    await engine.runSingleCycle();
    if (completedMilestones.includes('M09_PRIMITIVE_BLAST_FURNACE')) break;
  }

  // Verify real survival speedrunner guarantees:
  assert.equal(
    metrics.forceLookTrueDigs,
    metrics.totalDigs,
    'Every single dig must pass forceLook=true (0ms instant camera snap)'
  );
  assert.ok(
    metrics.bareHandLogDigs <= 4,
    `Expected <= 4 bare-handed log punches before crafting Stone Axe, got ${metrics.bareHandLogDigs}`
  );
  assert.ok(
    metrics.woodenPickCobbleDigs <= 7,
    `Expected <= 7 wooden-pickaxe stone digs before immediate Stone Pickaxe upgrade, got ${metrics.woodenPickCobbleDigs}`
  );
  assert.ok(
    engine.getValidStationBlock('furnaceAux', 'furnace'),
    'Expected Dual Parallel Furnace bank placed at Base Camp'
  );
  assert.ok(
    cyclesUsed <= 25,
    `Expected all 9 milestones to finish in <= 25 high-speed chained cycles, took ${cyclesUsed}`
  );

  // Verify real survival progression milestones completed autonomously:
  assert.ok(completedMilestones.includes('M01_WOOD_BOOTSTRAP'), 'Completed wood bootstrap');
  assert.ok(completedMilestones.includes('M02_BASE_AND_CRAFTING_TABLE'), 'Placed Crafting Table & pickaxe');
  assert.ok(completedMilestones.includes('M03_STONE_TOOLS_AND_FURNACE'), 'Placed Furnace & Warehouse Chest');
  assert.ok(completedMilestones.includes('M04_PROSPECT_COAL_AND_IRON'), 'Mined & smelted Iron');
  assert.ok(completedMilestones.includes('M05_FAST_BLAST_FURNACE_AND_IRON_KIT'), 'Placed GTL 1-Tick Blast Furnace');
  assert.ok(completedMilestones.includes('M06_GTCEU_HAND_TOOLS'), 'Crafted modded GTCEu Iron Hammer & Mortar');
  assert.ok(completedMilestones.includes('M07_COPPER_TIN_AND_BRONZE'), 'Prospected modded Copper/Tin veins & smelted Bronze');
  assert.ok(completedMilestones.includes('M08_STEAM_BOILER_AND_MACHINES'), 'Built LP Steam Solid Boiler');
  assert.ok(completedMilestones.includes('M09_PRIMITIVE_BLAST_FURNACE'), 'Advanced through PBF multiblock stage');

  // Verify dynamic GTCEu modded `stateId > vanillaMaxStateId` learning discovered both modded ore veins!
  assert.equal(engine.worldState.learnedOreStates['48120'], 'gtceu:raw_chalcopyrite');
  assert.equal(engine.worldState.learnedOreStates['49310'], 'gtceu:raw_cassiterite');

  // Verify continuous FTB Quests frontier auto-unlocks LV -> MV -> HV voltage tiers as milestone items are produced!
  addItem('kubejs:advanced_control_circuit', 2);
  addItem('gtceu:aluminium_ingot', 1);
  addItem('gtceu:stainless_steel_ingot', 1);
  await engine.runSingleCycle();

  assert.equal(agent.craftingEngine.unlockedVoltageTier, 'HV');

  agent.shutdown();
});

test('installFastWindowClickShim prevents Mineflayer 1.20.1 updateSlot:0 infinite hang on null->null crafting clicks & clears lastDigTime', async () => {
  const { once } = require('events');
  const { bot, addItem, bindRegistryBridge } = createInteractiveSurvivalWorldHarness();
  bot._client = new EventEmitter(); // Enable live 1.20.1 crafting paths!
  bot.lastDigTime = Date.now();

  // Replace `openBlock` and `clickWindow` with Mineflayer `inventory.js`'s EXACT `waitForWindowUpdate`
  // behavior: clicking slots 0..9 in `minecraft:crafting` awaits `once(window, 'updateSlot:0')`,
  // while a real 1.20.1 server ONLY emits `updateSlot:0` when slot 0 ACTUALLY changes (`null -> item` or `item -> null`)!
  const craftWindow = new EventEmitter();
  craftWindow.id = 1;
  craftWindow.type = 'minecraft:crafting';
  craftWindow.inventoryStart = 10;
  craftWindow.inventoryEnd = 46;
  craftWindow.selectedItem = null;
  craftWindow.slots = new Array(46).fill(null);

  bot.openBlock = async () => {
    // Sync player inventory into window slots 10..45
    const items = bot.inventory.items();
    for (let i = 0; i < 46; i++) craftWindow.slots[i] = null;
    items.forEach((it, idx) => {
      craftWindow.slots[10 + idx] = { ...it, slot: 10 + idx };
    });
    bot.currentWindow = craftWindow;
    return craftWindow;
  };
  bot.closeWindow = async () => {
    bot.currentWindow = null;
  };

  // Raw unshimmed `clickWindow` reproducing Mineflayer `inventory.js` lines 481-489 & 576
  bot.clickWindow = async (slot, mouseButton, mode) => {
    if (bot.lastDigTime != null && Date.now() - bot.lastDigTime < 500) {
      throw new Error('lastDigTime was not cleared before clickWindow!');
    }
    const win = bot.currentWindow || bot.inventory;
    const prevSlot0 = win.slots[0];

    if (mode === 0 && mouseButton === 0) {
      const tmp = win.slots[slot];
      win.slots[slot] = win.selectedItem ? { ...win.selectedItem, slot } : null;
      win.selectedItem = tmp ? { ...tmp } : null;
    } else if (mode === 0 && mouseButton === 1 && win.selectedItem) {
      if (!win.slots[slot]) {
        win.slots[slot] = { ...win.selectedItem, count: 1, slot };
      } else {
        win.slots[slot].count += 1;
      }
      win.selectedItem.count -= 1;
      if (win.selectedItem.count <= 0) win.selectedItem = null;
    } else if (mode === 1 && slot === 0 && win.slots[0]) {
      addItem(`minecraft:${win.slots[0].name}`, win.slots[0].count);
      for (let g = 1; g <= 9; g++) win.slots[g] = null;
      win.slots[0] = null;
    } else if (mode === 1 && slot >= 1 && slot <= 9 && win.slots[slot]) {
      win.slots[slot] = null;
    }

    // Real 1.20.1 server furnace check: ONLY sets slot 0 when ALL 8 cobblestones are placed!
    // Clicks 1..7 leave slot 0 `null -> null` and emit ZERO `updateSlot:0` packet!
    const cobbleCells = [1, 2, 3, 4, 6, 7, 8, 9].every(
      (idx) => win.slots[idx]?.name === 'cobblestone' && !win.slots[5]
    );
    const nextSlot0 = cobbleCells ? { type: 200, name: 'furnace', count: 1, slot: 0 } : null;
    win.slots[0] = nextSlot0;
    if (Boolean(prevSlot0) !== Boolean(nextSlot0)) {
      setImmediate(() => win.emit('updateSlot:0', prevSlot0, nextSlot0));
    }

    if (win.type === 'minecraft:crafting' && slot >= 0 && slot <= 9) {
      await once(win, 'updateSlot:0');
    }
  };

  const agent = new GTLAutomationAgent({
    autoReconnect: false,
    enableAutonomousSurvival: false
  });
  bindRegistryBridge(agent.registryBridge);
  agent.attachBot(bot, {
    progressionOptions: { persistState: false, actionDelayScale: 0, slot0TimeoutMs: 12 }
  });

  // Place crafting_table in world and give 8 cobblestone
  agent.progressionEngine.worldState.stations.craftingTable = { x: 2, y: 64, z: 0 };
  const tableId = bot.registry.blocksByName.crafting_table.id;
  bot.blockAt(new Vec3(2, 64, 0));
  // Ensure getValidStationBlock sees a crafting_table at (2, 64, 0)
  const origBlockAt = bot.blockAt;
  bot.blockAt = (pos) => {
    if (Math.floor(pos.x) === 2 && Math.floor(pos.y) === 64 && Math.floor(pos.z) === 0) {
      return { id: tableId, type: tableId, name: 'crafting_table', boundingBox: 'block', position: new Vec3(2, 64, 0) };
    }
    return origBlockAt(pos);
  };

  addItem('minecraft:cobblestone', 8);

  const startedAt = Date.now();
  const crafted = await agent.progressionEngine.craftVanillaItem('furnace', 1, true);
  const elapsed = Date.now() - startedAt;

  assert.equal(crafted, true, 'Furnace craft must complete without hanging on null->null clicks 1..7');
  assert.ok(elapsed < 1500, `Expected fast non-hanging craft (<1500ms), took ${elapsed}ms`);
  assert.equal(agent.progressionEngine.countInventory('minecraft:furnace'), 1);

  agent.shutdown();
});

test('Same-body reconnect cleans leftover 2x2 grid items, discovers placed stations, fast-forwards existing tools, and rolls back stale milestones', async () => {
  const { bot, voxels, addItem, bindRegistryBridge } = createInteractiveSurvivalWorldHarness();

  // Place pre-existing Crafting Table & Furnace near the reconnecting player body (as if placed in prior session)
  const ctEntry = bot.registry.blocksByName.crafting_table;
  const furEntry = bot.registry.blocksByName.furnace;
  voxels.set('3,64,0', {
    id: ctEntry.id,
    type: ctEntry.id,
    name: 'crafting_table',
    stateId: ctEntry.defaultState,
    boundingBox: 'block',
    position: new Vec3(3, 64, 0)
  });
  voxels.set('3,64,1', {
    id: furEntry.id,
    type: furEntry.id,
    name: 'furnace',
    stateId: furEntry.defaultState,
    boundingBox: 'block',
    position: new Vec3(3, 64, 1)
  });

  // Previous body already holds Stone Pickaxe + Stone Axe + leftover planks stuck in 2x2 slot 2 from Ctrl+C!
  addItem('minecraft:stone_pickaxe', 1);
  addItem('minecraft:stone_axe', 1);
  bot.inventory.craftGrid2x2[2] = {
    type: bot.registry.itemsByName.oak_planks.id,
    name: 'oak_planks',
    count: 3,
    slot: 2
  };
  let cleanedSlot2 = false;
  const origClick = bot.clickWindow;
  bot.clickWindow = async (slot, mouseButton, mode) => {
    if (slot === 2 && mode === 1 && bot.inventory.craftGrid2x2[2]) {
      addItem('minecraft:oak_planks', bot.inventory.craftGrid2x2[2].count);
      bot.inventory.craftGrid2x2[2] = null;
      cleanedSlot2 = true;
      return;
    }
    return origClick ? origClick(slot, mouseButton, mode) : undefined;
  };

  const agent = new GTLAutomationAgent({
    autoReconnect: false,
    enableAutonomousSurvival: true
  });
  bindRegistryBridge(agent.registryBridge);
  agent.attachBot(bot, {
    progressionOptions: { persistState: false, actionDelayScale: 0 }
  });

  // Simulate stale `.gtl-runtime-state.json` falsely claiming M05 Blast Furnace was built in an old world
  agent.progressionEngine.worldState.completedMilestones = ['M05_FAST_BLAST_FURNACE_AND_IRON_KIT'];
  agent.progressionEngine.worldState.baseAnchor = { x: 999, y: 64, z: 999 }; // stale far-away anchor!

  // Also verify single-controller guarantee on `spawn`: `AutonomousProgressionEngine` runs, `BotStateMachine` stays off!
  bot.emit('spawn');
  agent.progressionEngine.stop(); // pause background timer so we inspect deterministic reconcile step
  assert.equal(
    agent.stateMachineBundle,
    null,
    'BotStateMachine must NOT run concurrently with AutonomousProgressionEngine on spawn'
  );

  await agent.progressionEngine.reconcileStateWithCurrentBody();

  assert.equal(cleanedSlot2, true, 'Must sweep leftover item out of 2x2 crafting grid slot 2 on reconnect');
  assert.ok(
    agent.progressionEngine.getValidStationBlock('craftingTable', 'crafting_table'),
    'Must auto-discover existing Crafting Table near previous body'
  );
  assert.ok(
    agent.progressionEngine.getValidStationBlock('furnace', 'furnace'),
    'Must auto-discover existing Furnace near previous body'
  );
  assert.ok(
    agent.progressionEngine.hasMilestone('M01_WOOD_BOOTSTRAP') &&
      agent.progressionEngine.hasMilestone('M02_BASE_AND_CRAFTING_TABLE') &&
      agent.progressionEngine.hasMilestone('M03_STONE_TOOLS_AND_FURNACE'),
    'Must fast-forward M01..M03 when previous body already holds stone tools & furnace'
  );
  assert.equal(
    agent.progressionEngine.hasMilestone('M05_FAST_BLAST_FURNACE_AND_IRON_KIT'),
    false,
    'Must roll back stale M05 milestone when no Blast Furnace exists in world or inventory'
  );

  agent.shutdown();
});

test('GTNHNavigator & AutonomousProgressionEngine swim upward from 4-block-deep water, hop 2-block-deep shorelines, hold buoyancy jump, and anchor Base Camp on dry land', async () => {
  const { bot, voxels, bindRegistryBridge } = createInteractiveSurvivalWorldHarness();

  // Carve a 4-block-deep lake (`x = -4..4, z = -4..4`, water at `y = 60..63`, solid lakebed at `y = 59`,
  // surrounded by steep grass banks at `x = ±5` where `y = 63` is `grass_block` next to `y = 60..63` deep water!)
  const waterEntry = bot.registry.blocksByName.water;
  for (let x = -4; x <= 4; x++) {
    for (let z = -4; z <= 4; z++) {
      for (let y = 60; y <= 63; y++) {
        voxels.set(`${x},${y},${z}`, {
          id: waterEntry.id,
          type: waterEntry.id,
          name: 'water',
          stateId: waterEntry.defaultState,
          boundingBox: 'empty',
          shapes: [],
          position: new Vec3(x, y, z)
        });
      }
    }
  }

  // Place bot submerged at the bottom of the lake (`y = 60`, 4 blocks underwater!)
  bot.entity.position = new Vec3(0.5, 60, 0.5);
  bot.entity.isInWater = true;
  bot.oxygenLevel = 11;

  const controlStates = { jump: false, forward: false, sprint: false };
  bot.setControlState = (state, val) => {
    controlStates[state] = Boolean(val);
  };

  // Wire pathfinder `goto` to verify real A* path generation using `navigator.movements`!
  const { goals } = require('mineflayer-pathfinder');
  bot.pathfinder = {
    thinkTimeout: 5000,
    movements: null,
    setMovements(m) {
      this.movements = m;
    },
    setGoal() {},
    stop() {},
    isMoving: () => false,
    goto: async (goal) => {
      // Move bot to goal and clear water flag once ashore
      bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5);
      bot.entity.isInWater = false;
      bot.oxygenLevel = 20;
    }
  };

  const agent = new GTLAutomationAgent({
    autoReconnect: false,
    enableAutonomousSurvival: false
  });
  bindRegistryBridge(agent.registryBridge);
  agent.attachBot(bot, {
    progressionOptions: { persistState: false, actionDelayScale: 0 }
  });

  const nav = agent.navigator;
  const moves = nav.configureMovements();

  // 1. Verify `getMoveUp` from lakebed `(0, 60, 0)` emits upward swim neighbor `(0, 61, 0)`!
  const upNeighbors = [];
  moves.getMoveUp(new Vec3(0, 60, 0), upNeighbors);
  assert.ok(
    upNeighbors.some((m) => m.x === 0 && m.y === 61 && m.z === 0),
    'Submerged bot at y=60 must generate upward swim Move to y=61'
  );

  // 2. Verify `getMoveJumpUp` from deep shoreline surface `(4, 63, 0)` (with water at `y=62` below!)
  // emits shore-exit hop onto grass bank `(5, 64, 0)`!
  const shoreNeighbors = [];
  moves.getMoveJumpUp(new Vec3(4, 63, 0), { x: 1, z: 0 }, shoreNeighbors);
  assert.ok(
    shoreNeighbors.some((m) => m.x === 5 && m.y === 64 && m.z === 0),
    'Floating bot at deep water edge (4,63,0) must generate shore-exit Move onto (5,64,0)'
  );

  // 3. Verify `physicsTick` buoyancy reflex holds `jump = true` in water and releases it on dry land
  bot.emit('physicsTick');
  assert.equal(controlStates.jump, true, 'Swim reflex must hold jump=true while in water');

  // 4. Verify `AutonomousProgressionEngine` escapes underwater spawn onto dry shore and anchors Base Camp on DRY land!
  const cycleRes = await agent.progressionEngine.runSingleCycle();
  assert.equal( nav.isBotInWater(), false, 'Bot must swim out onto dry shore');
  const anchor = agent.progressionEngine.ensureBaseAnchor();
  assert.equal(
    agent.progressionEngine._isDryStandableSpot(anchor),
    true,
    `Base Camp anchor (${anchor.x}, ${anchor.y}, ${anchor.z}) must be on dry standable land, never in water`
  );

  // Tick once on dry land -> `jump` cleanly released!
  bot.emit('physicsTick');
  assert.equal(controlStates.jump, false, 'Swim reflex must release jump=false once on dry land');
  assert.ok(cycleRes);

  agent.shutdown();
});

test('guardWindowSlot0Listeners unblocks real Mineflayer promise_utils.once(window, "updateSlot:0") inside private closures & deferred inject_allowed', async () => {
  const { once: mfOnce } = require('mineflayer/lib/promise_utils');
  const windowsLoader = require('prismarine-windows')('1.20.1');

  // Simulate real `mineflayer.createBot`: `bot.inventory` and `bot.putAway` do NOT exist yet when `attachBot` runs!
  const bot = new EventEmitter();
  bot.version = '1.20.1';
  bot.registry = prismarineRegistry('1.20.1');
  bot._client = new EventEmitter();
  bot.entity = { position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0), height: 1.8, effects: {} };
  bot.entities = {};

  const agent = new GTLAutomationAgent({
    autoReconnect: false,
    enableAutonomousSurvival: false
  });
  agent.attachBot(bot, {
    progressionOptions: { persistState: false, slot0TimeoutMs: 20 }
  });

  // Now simulate `setTimeout(() => bot.emit('inject_allowed'), 0)` creating `bot.inventory` & a private lexical closure!
  bot.inventory = windowsLoader.createWindow(0, 'minecraft:inventory', 'Inventory');
  const privateInternalClick = async () => {
    // Reproduces `inventory.js` private `clickWindow` + `putAway(0)` calling `promise_utils.once` directly on `window`
    // WITHOUT calling `bot.clickWindow` (which previously threw `Event updateSlot:0 did not fire within timeout of 20000ms`!)
    await mfOnce(bot.inventory, 'updateSlot:0', 300);
  };
  bot.putAway = async () => {
    await privateInternalClick();
  };
  bot.emit('inject_allowed');

  const t0 = Date.now();
  await bot.putAway(0);
  const dt = Date.now() - t0;
  assert.ok(dt < 200, `Expected private updateSlot:0 wait to resolve via guard (<200ms), took ${dt}ms`);

  // Also verify opened Crafting Table windows emitted via `open_window` are guarded automatically!
  bot.currentWindow = windowsLoader.createWindow(1, 'minecraft:crafting', 'Crafting', 46);
  bot._client.emit('open_window', { windowId: 1 });
  const t1 = Date.now();
  await mfOnce(bot.currentWindow, 'updateSlot:0', 300);
  assert.ok(Date.now() - t1 < 200, 'Opened crafting window must also auto-unblock updateSlot:0');

  agent.shutdown();
});

test('Bot never mines stone without a pickaxe in hand (M02 gate, hill station placement, hotbar slot 44, pathfinder dirt-swap recovery, and navigator stone penalty)', async () => {
  const { GTNHNavigator } = require('../src/navigation/gtnhNavigator');

  const bot = new EventEmitter();
  bot.version = '1.20.1';
  bot.QUICK_BAR_START = 36;
  bot.quickBarSlot = null; // Reproduces fresh spawn before any setQuickBarSlot!
  bot.heldItem = null;
  bot.health = 20;
  bot.food = 20;
  bot.oxygenLevel = 20;
  bot.entities = {};
  bot.entity = {
    position: new Vec3(0.5, 64, 0.5),
    velocity: new Vec3(0, 0, 0),
    isInWater: false,
    onGround: true
  };

  const slots = new Array(46).fill(null);
  const syncHeld = () => {
    bot.heldItem = typeof bot.quickBarSlot === 'number' ? slots[36 + bot.quickBarSlot] || null : null;
  };
  bot.setQuickBarSlot = (slotIdx) => {
    bot.quickBarSlot = slotIdx;
    syncHeld();
  };
  bot.inventory = {
    inventoryStart: 9,
    inventoryEnd: 45,
    slots,
    items: () => slots.slice(9, 45).filter(Boolean)
  };
  bot.equip = async (item, dest) => {
    if (dest === 'hand') {
      if (item.slot >= 36 && item.slot <= 44) {
        bot.setQuickBarSlot(item.slot - 36);
      } else {
        const prev = slots[36];
        slots[36] = { ...item, slot: 36 };
        slots[item.slot] = prev ? { ...prev, slot: item.slot } : null;
        bot.setQuickBarSlot(0);
      }
    }
  };

  // Simulate `mineflayer-tool` unequipping hand on digTime ties (the exact bug in mineflayer-tool!)
  bot.tool = {
    equipForBlock: async () => {
      slots[36 + (bot.quickBarSlot ?? 0)] = slots[36 + (bot.quickBarSlot ?? 0)];
      bot.heldItem = null;
    }
  };

  // World map with a 1-block dirt hill at (2, 64, 0) where Crafting Table prefers to go,
  // and exposed `stone` blocks at (8..10, 64, 0)
  const worldBlocks = new Map();
  const keyOf = (x, y, z) => `${x},${y},${z}`;
  for (let x = -12; x <= 14; x++) {
    for (let z = -12; z <= 14; z++) {
      worldBlocks.set(keyOf(x, 63, z), {
        name: 'grass_block',
        type: 2,
        stateId: 9,
        boundingBox: 'block',
        position: new Vec3(x, 63, z)
      });
    }
  }
  // 1-block dirt bump right at (2, 64, 0)
  worldBlocks.set(keyOf(2, 64, 0), {
    name: 'dirt',
    type: 3,
    stateId: 10,
    boundingBox: 'block',
    position: new Vec3(2, 64, 0)
  });
  for (let sx = 8; sx <= 10; sx++) {
    worldBlocks.set(keyOf(sx, 64, 0), {
      name: 'stone',
      type: 1,
      stateId: 1,
      boundingBox: 'block',
      position: new Vec3(sx, 64, 0)
    });
  }

  bot.registry = require('prismarine-registry')('1.20.1');
  const stoneId = bot.registry.blocksByName.stone.id;
  const grassId = bot.registry.blocksByName.grass_block.id;
  const dirtId = bot.registry.blocksByName.dirt.id;
  const tableId = bot.registry.blocksByName.crafting_table.id;
  const woodPickId = bot.registry.itemsByName.wooden_pickaxe.id;
  const cobbleId = bot.registry.itemsByName.cobblestone.id;
  for (const blk of worldBlocks.values()) {
    if (blk.name === 'stone') blk.type = stoneId;
    if (blk.name === 'grass_block') blk.type = grassId;
    if (blk.name === 'dirt') blk.type = dirtId;
  }

  bot.blockAt = (pos) => {
    const p = pos.floored();
    return (
      worldBlocks.get(keyOf(p.x, p.y, p.z)) || {
        name: 'air',
        type: 0,
        stateId: 0,
        boundingBox: 'empty',
        position: p
      }
    );
  };
  bot.findBlocks = ({ matching }) => {
    const ids = Array.isArray(matching) ? matching : [matching];
    const out = [];
    for (const blk of worldBlocks.values()) {
      if (ids.includes(blk.type)) out.push(blk.position.clone());
    }
    return out;
  };

  let allowWorldPlace = false;
  bot.placeBlock = async (refBlock, faceVec) => {
    if (!allowWorldPlace || !bot.heldItem) return;
    const dest = refBlock.position.plus(faceVec).floored();
    worldBlocks.set(keyOf(dest.x, dest.y, dest.z), {
      name: bot.heldItem.name,
      type: bot.heldItem.type,
      stateId: 58,
      boundingBox: 'block',
      position: dest
    });
    const s = bot.heldItem.slot;
    slots[s] = null;
    syncHeld();
  };

  const stoneDigTools = [];
  bot.dig = async (blk) => {
    if (blk.name === 'stone') {
      stoneDigTools.push(bot.heldItem ? bot.heldItem.name : 'EMPTY_HAND');
      worldBlocks.delete(keyOf(blk.position.x, blk.position.y, blk.position.z));
      // Deposit cobblestone into slot 12
      slots[12] = {
        type: cobbleId,
        name: 'cobblestone',
        count: (slots[12]?.count || 0) + 1,
        slot: 12
      };
    }
  };

  // Simulate `mineflayer-pathfinder` equipping `dirt` (slot 37) during `goto`!
  bot.pathfinder = {
    thinkTimeout: 5000,
    setMovements() {},
    setGoal() {},
    stop() {},
    isMoving: () => false,
    goto: async (goal) => {
      if (typeof goal?.x === 'number' && typeof goal?.z === 'number') {
        bot.entity.position = new Vec3(goal.x - 1, goal.y ?? 64, goal.z);
      }
      if (slots[37]?.name === 'dirt') {
        bot.setQuickBarSlot(1); // pathfinder leaves dirt in hand!
      }
    }
  };
  const nav = new GTNHNavigator(bot);

  const engine = new AutonomousProgressionEngine({
    bot,
    navigator: nav,
    options: {
      persistState: false,
      actionDelayScale: 0
    }
  });
  engine.markMilestoneComplete('M01_WOOD_BOOTSTRAP');

  // 1. Without a pickaxe, GTNHNavigator forbids pathfinder from tunneling through stone (`penalty = 1000`),
  //    AND `digAndCollectBlock(stone)` refuses to swing bare-handed!
  const stoneAt8 = bot.blockAt(new Vec3(8, 64, 0));
  assert.equal(nav.evaluateBreakPenalty(stoneAt8), 1000, 'Navigator must forbid breaking stone without a pickaxe');
  const bareDig = await engine.digAndCollectBlock(stoneAt8);
  assert.equal(bareDig, false, 'digAndCollectBlock must refuse to punch stone bare-handed');
  assert.equal(stoneDigTools.length, 0, 'Zero bare-handed stone dig attempts allowed');
  bot.entity.position = new Vec3(0.5, 64, 0.5);

  // 2. When Crafting Table placement fails on server (`allowWorldPlace = false`), `placeStationAtBase`
  //    must NOT save fake station coords AND `runSingleCycle()` must stay in `M02_BASE_AND_CRAFTING_TABLE`!
  slots[36] = { type: tableId, name: 'crafting_table', count: 1, slot: 36 };
  slots[37] = { type: dirtId, name: 'dirt', count: 16, slot: 37 };
  const cycleFailPlace = await engine.runSingleCycle();
  assert.equal(cycleFailPlace.stage, 'M02_BASE_AND_CRAFTING_TABLE');
  assert.equal(engine.worldState.stations.craftingTable, null, 'Unverified placement must not save station coords');
  assert.equal(stoneDigTools.length, 0, 'M02 must never fall through to M03 stone mining without a pickaxe');

  // 3. Now allow world placement: `placeStationAtBase` adapts to the 1-block dirt hill `(2, 65, 0)`!
  allowWorldPlace = true;
  const placedTable = await engine.placeStationAtBase('minecraft:crafting_table', 'craftingTable', {
    x: 2,
    y: 0,
    z: 0
  });
  assert.ok(placedTable, 'placeStationAtBase should adapt to 1-block slope at (2, 65, 0)');
  assert.deepEqual(engine.worldState.stations.craftingTable, { x: 2, y: 65, z: 0 });

  // 4. Deposit crafted `wooden_pickaxe` into hotbar `slot 44` (where shift-clicking slot 0 places it!)
  //    while `quickBarSlot` is currently holding `dirt` (`slot 37`), then mine stone!
  slots[44] = { type: woodPickId, name: 'wooden_pickaxe', count: 1, slot: 44 };
  assert.equal(nav.evaluateBreakPenalty(stoneAt8), 0, 'Navigator allows stone break once pickaxe is in inventory');

  await engine.gatherSurfaceBlocks(['stone'], '#cobblestone', 3);
  assert.equal(stoneDigTools.length, 3, 'Should mine all 3 stone blocks');
  for (const usedTool of stoneDigTools) {
    assert.equal(
      usedTool,
      'wooden_pickaxe',
      'Every single stone block MUST be mined with wooden_pickaxe in hand even after pathfinder swapped to dirt!'
    );
  }
  assert.equal(bot.quickBarSlot, 8, 'Hotbar slot 8 (window slot 44) should be selected');
  assert.equal(bot.heldItem?.name, 'wooden_pickaxe');
});

test('UniversalRecipeRegistry & AutonomousProgressionEngine: raw_coal->coal smelting, furnace-only smooth_stone routing, declare_recipes sync, heartbeat watchdog, and pit self-unstick', async () => {
  const { UniversalRecipeRegistry } = require('../src/recipes/universalRecipeRegistry');
  const { ForgeRegistryBridge } = require('../src/protocol/forgeHandshake');

  const bridge = new ForgeRegistryBridge();
  bridge.numericIdToName = new Map([
    [9101, 'gtceu:raw_coal'],
    [9102, 'minecraft:coal'],
    [9103, 'minecraft:oak_planks'],
    [9104, 'minecraft:cobblestone'],
    [9105, 'minecraft:stone'],
    [9106, 'minecraft:smooth_stone'],
    [9107, 'minecraft:dirt'],
    [9108, 'kubejs:custom_ingot']
  ]);

  const reg = new UniversalRecipeRegistry({ registryBridge: bridge });

  // 1. Verify UniversalRecipeRegistry coverage (750+ Vanilla + GTCEu + GTL recipes + fuel rules)
  assert.ok(reg.craftingByOutput.size >= 700, 'Must index 700+ vanilla & modded crafting outputs');
  assert.equal(reg.isValidFurnaceFuel('gtceu:raw_coal'), false, 'raw_coal must NEVER be treated as furnace fuel');
  assert.equal(reg.isValidFurnaceFuel('gtceu:raw_lignite_coal'), false, 'raw_lignite_coal is not direct fuel');
  assert.equal(reg.getFuelSmeltCapacity('minecraft:coal'), 8);
  assert.equal(reg.getFuelSmeltCapacity('minecraft:oak_planks'), 1.5);
  assert.equal(reg.getFuelSmeltCapacity('gtceu:coke_gem'), 16);

  const rawCoalSmelt = reg.getSmeltingRecipeForInput('gtceu:raw_coal', 'blast_furnace');
  assert.ok(rawCoalSmelt && rawCoalSmelt.outputId === 'minecraft:coal' && rawCoalSmelt.outputCount === 2);

  // Cobblestone & stone MUST NOT route to Blast Furnace (`canBlast === false`)!
  assert.equal(reg.getSmeltingRecipeForInput('minecraft:cobblestone', 'blast_furnace'), null);
  assert.equal(reg.getSmeltingRecipeForInput('minecraft:stone', 'blast_furnace'), null);
  assert.equal(reg.getSmeltingRecipeForInput('minecraft:stone', 'furnace')?.outputId, 'minecraft:smooth_stone');

  // EBF-only materials must NOT pretend to smelt in a normal furnace
  assert.equal(reg.getSmeltingRecipeForInput('gtceu:raw_aluminium', 'furnace'), null);
  // Dynamic GTCEu non-blast metals DO smelt
  assert.equal(reg.getSmeltingRecipeForInput('gtceu:raw_cobalt', 'blast_furnace')?.outputId, 'gtceu:cobalt_ingot');

  // Test live `declare_recipes` wire-buffer ingestion (`minecraft:smelting` followed by modded custom serializer)
  const writeVarInt = (val) => {
    const bytes = [];
    let v = val >>> 0;
    do {
      let b = v & 0x7f;
      v >>>= 7;
      if (v !== 0) b |= 0x80;
      bytes.push(b);
    } while (v !== 0);
    return Buffer.from(bytes);
  };
  const writeStr = (s) => {
    const b = Buffer.from(s, 'utf8');
    return Buffer.concat([writeVarInt(b.length), b]);
  };
  const writeSlot = (id, count) => Buffer.concat([Buffer.from([1]), writeVarInt(id), Buffer.from([count, 0])]);
  const floatBuf = Buffer.alloc(4);
  floatBuf.writeFloatBE(0.7, 0);

  const liveDeclareBuf = Buffer.concat([
    writeVarInt(2), // 2 recipes: 1 standard smelting + 1 custom modded serializer
    writeStr('minecraft:smelting'),
    writeStr('kubejs:smelt_custom_ingot'),
    writeStr(''), // group
    writeVarInt(0), // category
    writeVarInt(1), // 1 ingredient option
    writeSlot(9104, 1), // input: cobblestone (9104)
    writeSlot(9108, 2), // output: 2x kubejs:custom_ingot (9108)
    floatBuf,
    writeVarInt(120),
    // Trailing custom modded serializer that has arbitrary custom bytes (must stop cleanly without throwing!)
    writeStr('gtceu:custom_machine_recipe'),
    writeStr('gtceu:test_unframed'),
    Buffer.from([0xde, 0xad, 0xbe, 0xef])
  ]);
  const added = reg.ingestDeclareRecipesBuffer(liveDeclareBuf);
  assert.equal(added, 1, 'Should safely ingest standard recipes and stop cleanly at custom modded serializer');
  assert.equal(reg.getSmeltingRecipesForOutput('kubejs:custom_ingot')[0]?.outputCount, 2);

  // 2. Verify live `ensureFurnaceFuel` smelts `gtceu:raw_coal -> 2x minecraft:coal` in Blast Furnace,
  //    NEVER puts `gtceu:raw_coal` into Fuel Slot 1, and `smeltToProduceLive('minecraft:smooth_stone', 3)`
  //    routes `cobblestone -> stone -> smooth_stone` strictly to `furnace` (NOT `blast_furnace`)!
  const bot = new EventEmitter();
  bot.version = '1.20.1';
  bot.QUICK_BAR_START = 36;
  bot.quickBarSlot = 0;
  bot.heldItem = null;
  bot.health = 20;
  bot.food = 20;
  bot.oxygenLevel = 20;
  bot.entities = {};
  bot.entity = {
    position: new Vec3(0.5, 64, 0.5),
    velocity: new Vec3(0, 0, 0),
    isInWater: false,
    onGround: true
  };

  const invItems = [
    { type: 9101, name: 'gtceu:raw_coal', count: 3, slot: 10 },
    { type: 9103, name: 'minecraft:oak_planks', count: 2, slot: 11 },
    { type: 9104, name: 'minecraft:cobblestone', count: 3, slot: 12 },
    { type: 9107, name: 'minecraft:dirt', count: 8, slot: 36 }
  ];
  bot.setQuickBarSlot = (idx) => {
    bot.quickBarSlot = idx;
    bot.heldItem = invItems.find((i) => i.slot === 36 + idx) || null;
  };
  bot.setQuickBarSlot(0);
  bot.inventory = {
    inventoryStart: 9,
    inventoryEnd: 45,
    slots: new Array(46).fill(null),
    items: () => invItems.filter((i) => i.count > 0)
  };

  const stationBlocks = new Map([
    ['3,64,0', { name: 'furnace', type: 61, boundingBox: 'block', position: new Vec3(3, 64, 0) }],
    ['4,64,0', { name: 'blast_furnace', type: 62, boundingBox: 'block', position: new Vec3(4, 64, 0) }]
  ]);
  bot.blockAt = (pos) => {
    const p = pos.floored();
    const k = `${p.x},${p.y},${p.z}`;
    if (stationBlocks.has(k)) return stationBlocks.get(k);
    if (p.y === 63) return { name: 'grass_block', type: 2, boundingBox: 'block', position: p };
    return { name: 'air', type: 0, boundingBox: 'empty', position: p };
  };

  const usedFuels = [];
  const stationHistory = [];
  bot.openFurnace = async (stationBlock) => {
    const stType = stationBlock.name;
    let fIn = null;
    let fFuel = null;
    let fOut = null;
    const fWin = new EventEmitter();
    fWin.slots = [null, null, null];
    fWin.inputItem = () => fIn;
    fWin.fuelItem = () => fFuel;
    fWin.outputItem = () => fOut;
    fWin.putFuel = async (itemType, _meta, qty) => {
      const src = invItems.find((i) => i.type === itemType && i.count > 0);
      assert.ok(src, 'Fuel item must exist');
      assert.notEqual(src.name, 'gtceu:raw_coal', 'MUST NEVER put unsmelted gtceu:raw_coal into Fuel Slot 1!');
      usedFuels.push({ name: src.name, qty, station: stType });
      src.count -= qty;
      fFuel = { type: itemType, name: src.name, count: qty };
    };
    fWin.putInput = async (itemType, _meta, qty) => {
      const src = invItems.find((i) => i.type === itemType && i.count > 0);
      assert.ok(src, 'Input item must exist');
      const rcp = reg.getSmeltingRecipeForInput(src.name, stType);
      assert.ok(rcp, `Station ${stType} must actually support smelting ${src.name}!`);
      stationHistory.push({ input: src.name, station: stType, qty });
      src.count -= qty;
      const outNumId = [...bridge.numericIdToName.entries()].find(([, v]) => v === rcp.outputId)?.[0] || 9999;
      fIn = null;
      fOut = { type: outNumId, name: rcp.outputId, count: qty * (rcp.outputCount || 1) };
      setImmediate(() => fWin.emit('update'));
    };
    fWin.takeOutput = async () => {
      if (!fOut) return;
      const existing = invItems.find((i) => i.name === fOut.name);
      if (existing) existing.count += fOut.count;
      else invItems.push({ ...fOut, slot: 20 + invItems.length });
      fOut = null;
    };
    fWin.takeInput = async () => {
      fIn = null;
    };
    fWin.close = () => {};
    return fWin;
  };

  const engine = new AutonomousProgressionEngine({
    bot,
    registryBridge: {
      toCanonicalItemId: (item) => bridge.numericIdToName.get(item?.type) || item?.name || ''
    },
    recipeRegistry: reg,
    options: { persistState: false, actionDelayScale: 0, cycleTimeoutMs: 120 }
  });
  engine.worldState.baseAnchor = { x: 0, y: 64, z: 0 };
  engine.worldState.stations.furnace = { x: 3, y: 64, z: 0 };
  engine.worldState.stations.blastFurnace = { x: 4, y: 64, z: 0 };

  const fuelReady = await engine.ensureFurnaceFuel(10);
  assert.equal(fuelReady, true, 'Should smelt 3x gtceu:raw_coal into 6x minecraft:coal (48 smelts)');
  assert.equal(engine.countInventory('minecraft:coal'), 6, '3x gtceu:raw_coal -> 6x minecraft:coal');
  assert.equal(stationHistory[0].station, 'blast_furnace', 'raw_coal blasts in 1-tick blast_furnace');

  const madeSmooth = await engine.smeltToProduceLive('minecraft:smooth_stone', 3);
  assert.equal(madeSmooth, true, '2-stage cobblestone -> stone -> smooth_stone must complete');
  assert.equal(engine.countInventory('minecraft:smooth_stone'), 3);
  const stoneStages = stationHistory.filter((s) => s.input !== 'gtceu:raw_coal');
  assert.equal(stoneStages.length, 2);
  assert.equal(stoneStages[0].station, 'furnace', 'cobblestone -> stone must use regular furnace, NEVER blast_furnace');
  assert.equal(stoneStages[1].station, 'furnace', 'stone -> smooth_stone must use regular furnace, NEVER blast_furnace');

  // 3. Verify 2-block-deep pit physical self-unstick pillars out automatically!
  const pitPlaced = [];
  bot.setControlState = () => {};
  bot.placeBlock = async (refBlock, face) => {
    pitPlaced.push(refBlock.position.plus(face));
  };
  const origBlockAt = bot.blockAt;
  bot.blockAt = (pos) => {
    const p = pos.floored();
    if (p.x === 0 && p.z === 0 && p.y === 61) {
      return { name: 'stone', type: 1, boundingBox: 'block', position: p };
    }
    if (Math.abs(p.x) + Math.abs(p.z) === 1 && (p.y === 62 || p.y === 63)) {
      return { name: 'dirt', type: 3, boundingBox: 'block', position: p };
    }
    return { name: 'air', type: 0, boundingBox: 'empty', position: p };
  };
  bot.entity.position = new Vec3(0.5, 62, 0.5);
  await engine._performPhysicalUnstick(new Vec3(5, 64, 0));
  assert.equal(pitPlaced.length, 1, 'Trapped bot in 2-block pit should pillar up 1 block automatically');
  bot.blockAt = origBlockAt;
});




