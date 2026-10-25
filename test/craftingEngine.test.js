'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const Vec3 = require('vec3');

const {
  WarehouseTracker,
  ContainerPacketController,
  CraftingEngine
} = require('../src/craftingEngine');

const TEMPLATE_DB_PATH = path.resolve(__dirname, '../data/quest_tree_template.json');

test('CraftingEngine ingests Quest Book & JEI database as strict acyclic DAGs', () => {
  const engine = new CraftingEngine({ unlockedVoltageTier: 'LV' });
  const summary = engine.loadDatabaseFromFile(TEMPLATE_DB_PATH);

  assert.equal(summary.isQuestDagAcyclic, true, 'Quest graph must be a valid DAG');
  assert.equal(summary.isRecipeDagAcyclic, true, 'Recipe graph must be a valid DAG');
  assert.ok(summary.questsLoaded >= 10);
  assert.ok(summary.recipesLoaded >= 35);
  assert.ok(
    engine.prunedCyclicRecipeIds.has('rcp_steel_ingot_from_nuggets_cycle'),
    'Reverse storage-recompression cycle must be pruned from canonical DAG'
  );

  const questOrder = engine.getTopologicalQuestOrder().map((q) => q.questId);
  assert.ok(
    questOrder.indexOf('quest_stone_001') < questOrder.indexOf('quest_steam_002'),
    'Stone Age root quest must precede Steam PBF quest'
  );
  assert.ok(
    questOrder.indexOf('quest_steam_003') < questOrder.indexOf('quest_lv_001'),
    'First Steel gate quest must precede LV Electronic Circuit quest'
  );
});

test('CraftingEngine resolves full LV Electronic Circuit (gregtech:gt.metaitem.01:32700) dependency chain with exact material balance', () => {
  const engine = new CraftingEngine({ unlockedVoltageTier: 'LV' });
  engine.loadDatabaseFromFile(TEMPLATE_DB_PATH);

  const plan = engine.resolveCraftingPlan('gregtech:gt.metaitem.01:32700', 1);

  assert.equal(plan.targetItemId, 'gregtech:gt.metaitem.01:32700');
  assert.equal(plan.requestedCount, 1);

  const producedItems = new Set(plan.steps.map((s) => s.outputItemId));
  // Verify mandatory GTNH LV Electronic Circuit sub-components are resolved
  assert.ok(producedItems.has('gregtech:gt.metaitem.01:32705'), 'Must craft Vacuum Tubes');
  assert.ok(producedItems.has('gregtech:gt.metaitem.01:32706'), 'Must craft Resistors');
  assert.ok(producedItems.has('gregtech:gt.blockmachines:1360'), 'Must craft Red Alloy Wire');
  assert.ok(producedItems.has('gregtech:gt.metaitem.01:32711'), 'Must craft Basic Circuit Board');
  assert.ok(producedItems.has('gregtech:gt.metaitem.01:17305'), 'Must craft Steel Plate');

  // Simulate executing every step in order starting ONLY from `plan.rawMaterials`
  const ledger = new Map(Object.entries(plan.rawMaterials));
  for (const step of plan.steps) {
    for (const inp of step.inputs) {
      const current = ledger.get(inp.itemId) || 0;
      assert.ok(
        current >= inp.count,
        `Step #${step.stepIndex} (${step.recipeId}) needed ${inp.count} of ${inp.itemId}, only had ${current}`
      );
      ledger.set(inp.itemId, current - inp.count);
    }
    for (const out of step.outputs) {
      ledger.set(out.itemId, (ledger.get(out.itemId) || 0) + out.count);
    }
  }

  assert.ok(
    (ledger.get('gregtech:gt.metaitem.01:32700') || 0) >= 1,
    'Simulated topological execution must yield >= 1 LV Electronic Circuit'
  );
});

test('CraftingEngine deducts WarehouseTracker chest stock and routes withdrawal coordinates', () => {
  const engine = new CraftingEngine({ unlockedVoltageTier: 'LV' });
  engine.loadDatabaseFromFile(TEMPLATE_DB_PATH);

  // Stock chest A at (102, 64, 100) with 2 Vacuum Tubes & 2 Resistors; chest B at (120, 64, 100) with 1 Basic Circuit Board
  engine.warehouse.upsertContainer(new Vec3(102, 64, 100), {
    'gregtech:gt.metaitem.01:32705': 2,
    'gregtech:gt.metaitem.01:32706': 2
  });
  engine.warehouse.upsertContainer(new Vec3(120, 64, 100), {
    'gregtech:gt.metaitem.01:32711': 1,
    'gregtech:gt.metaitem.01:17305': 1
  });

  const plan = engine.resolveCraftingPlan('gregtech:gt.metaitem.01:32700', 1, {
    originPos: new Vec3(100, 64, 100)
  });

  const stepRecipeIds = plan.steps.map((s) => s.recipeId);
  assert.ok(!stepRecipeIds.includes('rcp_vacuum_tube'), 'Should not craft Vacuum Tubes already in chest');
  assert.ok(!stepRecipeIds.includes('rcp_resistor_hand'), 'Should not craft Resistors already in chest');
  assert.ok(!stepRecipeIds.includes('rcp_basic_circuit_board'), 'Should not craft Circuit Board already in chest');
  assert.equal(plan.warehouseWithdrawals.length, 4);
});

test('CraftingEngine switches to LV Circuit Assembler when molten Soldering Alloy fluid is stocked', () => {
  const engine = new CraftingEngine({ unlockedVoltageTier: 'LV' });
  engine.loadDatabaseFromFile(TEMPLATE_DB_PATH);

  engine.warehouse.upsertContainer(
    new Vec3(95, 64, 95),
    { 'fluid:molten.solderingalloy': 1440 },
    { containerType: 'gt_fluid_tank' }
  );

  const plan = engine.resolveCraftingPlan('gregtech:gt.metaitem.01:32700', 2);
  const finalStep = plan.steps[plan.steps.length - 1];
  assert.equal(finalStep.recipeId, 'rcp_lv_electronic_circuit_assembler');
  assert.equal(finalStep.programmedCircuit, 1);
  assert.equal(finalStep.batches, 1); // Outputs 2 LV circuits per craft in Circuit Assembler!
});

test('ContainerPacketController configures Programmed Circuit #14 in Bender GUI (both physical & ghost modes) and echoes rejected transactions', async () => {
  const sentPackets = [];
  const mockClient = new EventEmitter();
  mockClient.write = (name, payload) => {
    sentPackets.push({ name, payload });
  };
  const mockBot = { _client: mockClient };

  const engine = new CraftingEngine({
    bot: mockBot,
    unlockedVoltageTier: 'LV'
  });
  engine.containerController.clickDelayMs = 0;
  engine.loadDatabaseFromFile(TEMPLATE_DB_PATH);

  // Simulate server opening LV Bending Machine windowId = 4
  mockClient.emit('open_window', {
    windowId: 4,
    inventoryType: 'gregtech:bender',
    windowTitle: 'Basic Bending Machine',
    slotCount: 8
  });

  // 1. Test physical Programmed Circuit #14 insertion into Bender circuitSlot (slot 3)
  const benderPlan = engine.resolveCraftingPlan('IC2:itemCellEmpty:0', 1, {
    inventoryOverride: { 'gregtech:gt.metaitem.01:17057': 2 }
  });
  assert.equal(benderPlan.steps.length, 1);
  assert.equal(benderPlan.steps[0].programmedCircuit, 14);

  const execRes = await engine.containerController.executeMachineStep(benderPlan.steps[0], {
    windowId: 4,
    circuitStrategy: 'physical',
    playerCircuitSlot: 5, // Player inv index 5 -> container slot 8 + 5 = 13
    inputSourceSlots: { 'gregtech:gt.metaitem.01:17057': 10 }
  });

  assert.equal(execRes.machine, 'gt_lv_bender');
  const circuitAction = execRes.actions.find((a) => a.type === 'configure_circuit');
  assert.ok(circuitAction);
  assert.equal(circuitAction.detail.mode, 'physical');
  assert.equal(circuitAction.detail.configNumber, 14);
  assert.equal(circuitAction.detail.targetSlot, 3);
  assert.equal(circuitAction.detail.packetsSent[0].slot, 13);
  assert.equal(circuitAction.detail.packetsSent[1].slot, 3);

  // 2. Test GTNH Ghost Circuit Selector mode for configuration #14 (2x +5 shift-right-clicks + 4x +1 right-clicks)
  const ghostRes = await engine.containerController.configureProgrammedCircuit(
    'gt_lv_bender',
    14,
    { windowId: 4, strategy: 'ghost' }
  );
  assert.equal(ghostRes.mode, 'ghost');
  assert.equal(ghostRes.targetSlot, 4);
  // 1 reset middle-click + 2 big steps (+5) + 4 single steps (+1) = 7 window_click packets
  assert.equal(ghostRes.packetsSent.length, 7);

  // 3. Test transaction rejection resync echo
  mockClient.emit('transaction', { windowId: 4, action: 99, accepted: false });
  const txEcho = sentPackets.find((p) => p.name === 'transaction');
  assert.ok(txEcho, 'Must echo rejected transaction packet back to Forge server');
  assert.equal(txEcho.payload.action, 99);
});
