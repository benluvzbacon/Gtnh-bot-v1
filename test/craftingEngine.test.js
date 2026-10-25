'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const Vec3 = require('vec3');

const { CraftingEngine } = require('../src/craftingEngine');

const TEMPLATE_DB_PATH = path.resolve(__dirname, '../data/quest_tree_template.json');

test('CraftingEngine ingests GregTech Leisure FTB Quests & GTCEu/KubeJS database as strict acyclic DAGs', () => {
  const engine = new CraftingEngine({ unlockedVoltageTier: 'LV' });
  const summary = engine.loadDatabaseFromFile(TEMPLATE_DB_PATH);

  assert.equal(summary.isQuestDagAcyclic, true, 'Quest graph must be a valid DAG');
  assert.equal(summary.isRecipeDagAcyclic, true, 'Recipe graph must be a valid DAG');
  assert.ok(summary.questsLoaded >= 14);
  assert.ok(summary.recipesLoaded >= 45);
  assert.ok(
    engine.prunedCyclicRecipeIds.has('rcp_steel_ingot_from_nuggets_cycle'),
    'Reverse storage-recompression cycle must be pruned from canonical DAG'
  );

  const questOrder = engine.getTopologicalQuestOrder().map((q) => q.questId);
  assert.ok(
    questOrder.indexOf('5F5F348E3A34827E') < questOrder.indexOf('5CE50DDC960340D8'),
    'Steam Age Bronze quest (5F5F348E3A34827E) must precede PBF quest (5CE50DDC960340D8)'
  );
  assert.ok(
    questOrder.indexOf('388BD32463FA905D') < questOrder.indexOf('5065BEDC95AE564E'),
    'First Steel Ingot quest (388BD32463FA905D) must precede First Circuit quest (5065BEDC95AE564E)'
  );
  assert.ok(
    questOrder.indexOf('553B2D61416792DC') < questOrder.indexOf('07D0D7005DA4F446'),
    'GTL Cheap LV Circuit quest (553B2D61416792DC) must precede EBF quest (07D0D7005DA4F446)'
  );
});

test('CraftingEngine resolves full GTL Basic Electronic Circuit (gtceu:basic_electronic_circuit) & Cheap LV Circuit (kubejs:advanced_control_circuit) chains', () => {
  const engine = new CraftingEngine({ unlockedVoltageTier: 'LV' });
  engine.loadDatabaseFromFile(TEMPLATE_DB_PATH);

  const plan = engine.resolveCraftingPlan('gtceu:basic_electronic_circuit', 1);

  assert.equal(plan.targetItemId, 'gtceu:basic_electronic_circuit');
  assert.equal(plan.requestedCount, 1);

  const producedItems = new Set(plan.steps.map((s) => s.outputItemId));
  assert.ok(producedItems.has('gtceu:vacuum_tube'), 'Must craft Vacuum Tubes');
  assert.ok(producedItems.has('gtceu:resistor'), 'Must craft Resistors');
  assert.ok(producedItems.has('gtceu:red_alloy_single_cable'), 'Must craft Red Alloy Single Cable');
  assert.ok(producedItems.has('gtceu:resin_printed_circuit_board'), 'Must craft Resin Printed Circuit Board');
  assert.ok(producedItems.has('gtceu:steel_plate'), 'Must craft Steel Plate');

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
    (ledger.get('gtceu:basic_electronic_circuit') || 0) >= 1,
    'Simulated topological execution must yield >= 1 Basic Electronic Circuit'
  );

  // Also verify GTL Steam Overhaul Cheap LV Circuit (`kubejs:advanced_control_circuit`) when glue is stocked
  engine.warehouse.upsertContainer(new Vec3(98, 64, 98), {
    'fluid:gtceu:glue': 500
  });
  const cheapCircuitPlan = engine.resolveCraftingPlan('kubejs:advanced_control_circuit', 2);
  const cheapOutputs = new Set(cheapCircuitPlan.steps.map((s) => s.outputItemId));
  assert.ok(cheapOutputs.has('kubejs:basic_control_circuit'));
  assert.ok(cheapOutputs.has('kubejs:advanced_control_circuit'));
});

test('CraftingEngine enforces GTL dimension-gated recipes (e.g. kubejs:ancient_world) and deducts WarehouseTracker stock', () => {
  const engine = new CraftingEngine({
    unlockedVoltageTier: 'LV',
    currentDimension: 'minecraft:overworld'
  });
  engine.loadDatabaseFromFile(TEMPLATE_DB_PATH);

  // Damascus Steel Dust requires `kubejs:ancient_world` in GTL -> should not select recipe in overworld!
  assert.equal(engine.selectRecipeForItem('gtceu:damascus_steel_dust'), null);

  // Switching dimension to `kubejs:ancient_world` unlocks the recipe!
  engine.setCurrentDimension('kubejs:ancient_world');
  const damascusRcp = engine.selectRecipeForItem('gtceu:damascus_steel_dust');
  assert.ok(damascusRcp);
  assert.equal(damascusRcp.recipeId, 'rcp_damascus_steel_ancient_world');

  // Stock containers and verify nearest-first warehouse withdrawals
  engine.warehouse.upsertContainer(new Vec3(102, 64, 100), {
    'gtceu:vacuum_tube': 2,
    'gtceu:resistor': 2
  });
  engine.warehouse.upsertContainer(new Vec3(120, 64, 100), {
    'gtceu:resin_printed_circuit_board': 1,
    'gtceu:steel_plate': 1
  });

  const plan = engine.resolveCraftingPlan('gtceu:basic_electronic_circuit', 1, {
    originPos: new Vec3(100, 64, 100)
  });

  const stepRecipeIds = plan.steps.map((s) => s.recipeId);
  assert.ok(!stepRecipeIds.includes('rcp_vacuum_tube'), 'Should not craft Vacuum Tubes already in storage');
  assert.ok(!stepRecipeIds.includes('rcp_resistor'), 'Should not craft Resistors already in storage');
  assert.ok(!stepRecipeIds.includes('rcp_resin_printed_circuit_board'), 'Should not craft PCB already in storage');
  assert.equal(plan.warehouseWithdrawals.length, 4);
});

test('CraftingEngine switches to LV Circuit Assembler when molten Soldering Alloy fluid is stocked', () => {
  const engine = new CraftingEngine({ unlockedVoltageTier: 'LV' });
  engine.loadDatabaseFromFile(TEMPLATE_DB_PATH);

  engine.warehouse.upsertContainer(
    new Vec3(95, 64, 95),
    { 'fluid:gtceu:soldering_alloy': 1440 },
    { containerType: 'gtceu:bronze_drum' }
  );

  const plan = engine.resolveCraftingPlan('gtceu:basic_electronic_circuit', 2);
  const finalStep = plan.steps[plan.steps.length - 1];
  assert.equal(finalStep.recipeId, 'rcp_basic_electronic_circuit_assembler');
  assert.equal(finalStep.programmedCircuit, 1);
  assert.equal(finalStep.batches, 1);
});

test('ContainerPacketController emits Minecraft 1.20.1 window_click packets (stateId, changedSlots, cursorItem) & configures GTCEu Programmed Circuit #14', async () => {
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

  // Simulate 1.20.1 server opening LDLib LV Bending Machine windowId = 4 and syncing stateId = 17
  mockClient.emit('open_window', {
    windowId: 4,
    inventoryType: 12,
    windowTitle: '{"text":"Basic Bending Machine"}'
  });
  mockClient.emit('window_items', {
    windowId: 4,
    stateId: 17,
    items: new Array(44).fill({ present: false }),
    carriedItem: { present: false }
  });

  const benderPlan = engine.resolveCraftingPlan('gtceu:fluid_cell', 1, {
    inventoryOverride: { 'gtceu:tin_plate': 2 }
  });
  assert.equal(benderPlan.steps.length, 1);
  assert.equal(benderPlan.steps[0].programmedCircuit, 14);

  // 1. Test physical gtceu:programmed_circuit #14 insertion
  const execRes = await engine.containerController.executeMachineStep(benderPlan.steps[0], {
    windowId: 4,
    circuitStrategy: 'physical',
    playerCircuitSlot: 5, // Player inv index 5 -> container slot 8 + 5 = 13
    inputSourceSlots: { 'gtceu:tin_plate': 10 }
  });

  assert.equal(execRes.machine, 'gt_lv_bender');
  const circuitAction = execRes.actions.find((a) => a.type === 'configure_circuit');
  assert.ok(circuitAction);
  assert.equal(circuitAction.detail.mode, 'physical');
  assert.equal(circuitAction.detail.itemId, 'gtceu:programmed_circuit');
  assert.equal(circuitAction.detail.configNumber, 14);
  assert.equal(circuitAction.detail.targetSlot, 3);

  // Verify 1.20.1 `window_click` packet schema (`stateId`, `changedSlots`, `cursorItem`)
  const firstClick = sentPackets.find((p) => p.name === 'window_click').payload;
  assert.equal(firstClick.stateId, 17);
  assert.ok(Array.isArray(firstClick.changedSlots));
  assert.equal(firstClick.cursorItem.present, true);

  // 2. Test GTCEu Ghost Circuit Selector mode for configuration #14
  const ghostRes = await engine.containerController.configureProgrammedCircuit(
    'gt_lv_bender',
    14,
    { windowId: 4, strategy: 'ghost' }
  );
  assert.equal(ghostRes.mode, 'ghost');
  assert.equal(ghostRes.targetSlot, 4);
  assert.equal(ghostRes.packetsSent.length, 7);
});
