'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Vec3 = require('vec3');
const nbt = require('prismarine-nbt');

const { HazardMonitor } = require('../src/hazards/hazardMonitor');
const { GTNHNavigator } = require('../src/navigation/gtnhNavigator');
const { ContainerPacketController } = require('../src/craftingEngine');

function createHazardMockBot() {
  const roofBlocks = new Set();
  const sentPackets = [];
  const client = new EventEmitter();
  client.write = (name, payload) => {
    sentPackets.push({ name, payload });
  };

  const bot = new EventEmitter();
  bot._client = client;
  bot.entity = { id: 42, position: new Vec3(8, 64, 8) };
  bot.health = 20;
  bot.entities = {};
  bot.blockAt = (pos) => {
    const p = pos.floored();
    if (roofBlocks.has(`${p.x},${p.y},${p.z}`)) {
      return { type: 45, name: 'brick_block', boundingBox: 'block', position: p };
    }
    if (p.y <= 63) {
      return { type: 1, name: 'stone', boundingBox: 'block', position: p };
    }
    return { type: 0, name: 'air', boundingBox: 'empty', position: p };
  };

  return { bot, client, roofBlocks, sentPackets };
}

test('HazardMonitor locks exterior wiring and Soft-Mallet disables ONLY unroofed electric machines on rain/storm packets', () => {
  const { bot, client, roofBlocks, sentPackets } = createHazardMockBot();
  const monitor = new HazardMonitor({ bot });

  // Machine 1 at (10, 64, 10) has a full 3x3 brick roof at y = 67
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      roofBlocks.add(`${10 + dx},67,${10 + dz}`);
    }
  }
  monitor.registerElectricMachine({
    id: 'roofed_lv_wiremill',
    position: new Vec3(10, 64, 10),
    voltageTier: 'LV',
    active: true
  });

  // Machine 2 at (30, 64, 30) is outdoors with no roof!
  monitor.registerElectricMachine({
    id: 'outdoor_lv_bender',
    position: new Vec3(30, 64, 30),
    voltageTier: 'LV',
    active: true
  });

  // Verify voltage check BEFORE rain
  assert.equal(monitor.verifySafeCableConnection('LV', 'LV').safe, true);
  assert.equal(
    monitor.verifySafeCableConnection('MV', 'LV').safe,
    false,
    'Connecting MV cable to LV machine must be blocked to prevent over-voltage explosion'
  );

  // Simulate server sending `game_state_change` start_raining packet (reason = 'start_raining' / 1)
  let emergencyEvent = null;
  monitor.once('weatherEmergency', (ev) => {
    emergencyEvent = ev;
  });
  client.emit('game_state_change', { reason: 'start_raining', gameMode: 0 });

  assert.equal(monitor.isRaining, true);
  assert.equal(monitor.exteriorWiringLocked, true);
  assert.equal(
    monitor.verifySafeCableConnection('LV', 'LV').safe,
    false,
    'Exterior wiring must lock during active rain'
  );
  assert.ok(emergencyEvent);
  assert.equal(emergencyEvent.disabledMachines.length, 1);
  assert.equal(emergencyEvent.disabledMachines[0].id, 'outdoor_lv_bender');

  assert.equal(monitor.electricMachines.get('roofed_lv_wiremill').active, true);
  assert.equal(monitor.electricMachines.get('outdoor_lv_bender').active, false);
  assert.equal(sentPackets.length, 1, 'Exactly 1 Soft Mallet shutdown packet sent to outdoor machine');
});

test('HazardMonitor polls GregTech Battery Buffer NBT packets, halts crafting below critical EU threshold, and resumes above hysteresis', async () => {
  const { bot, client } = createHazardMockBot();
  const monitor = new HazardMonitor({
    bot,
    criticalEuThresholdRatio: 0.20,
    recoveryEuThresholdRatio: 0.50
  });
  const controller = new ContainerPacketController(bot, { clickDelayMs: 0 });

  monitor.registerPowerBuffer({
    id: 'lv_4x_battery_buffer',
    type: 'battery_buffer',
    position: new Vec3(12, 64, 12),
    maxEu: 400000,
    storedEu: 320000 // 80% full
  });

  const sampleStep = {
    recipeId: 'rcp_steel_plate_bender',
    machine: 'gt_lv_bender',
    voltageTier: 'LV',
    euPerTick: 24,
    durationTicks: 56,
    totalEu: 1344,
    inputs: [],
    outputs: []
  };

  assert.equal(monitor.canExecuteRecipeStep(sampleStep).allowed, true);

  // Emit TileEntity NBT update dropping Battery Buffer to 50,000 / 400,000 EU (12.5% < 20% critical!)
  client.emit('tile_entity_data', {
    location: { x: 12, y: 64, z: 12 },
    action: 0,
    nbtData: nbt.comp({
      mStoredEnergy: nbt.int(50000),
      mMaxEnergy: nbt.int(400000)
    })
  });

  assert.equal(monitor.lowPowerHalted, true);
  assert.equal(monitor.canExecuteRecipeStep(sampleStep).allowed, false);

  await assert.rejects(
    () => controller.executeMachineStep(sampleStep, { hazardMonitor: monitor }),
    { code: 'HAZARD_HALT' }
  );

  // Partial recharge to 35% (140,000 EU) stays halted due to 50% hysteresis guard
  monitor.updatePowerBufferTelemetry('lv_4x_battery_buffer', { storedEu: 140000 });
  assert.equal(monitor.lowPowerHalted, true);

  // Recharge to 55% (220,000 EU) clears halt and allows crafting again!
  monitor.updatePowerBufferTelemetry('lv_4x_battery_buffer', { storedEu: 220000 });
  assert.equal(monitor.lowPowerHalted, false);
  assert.equal(monitor.canExecuteRecipeStep(sampleStep).allowed, true);
});

test('HazardMonitor detects GTNH pollution debuffs + Infernal Mobs and updates Navigator chunk exclusion penalties', () => {
  const { bot, client } = createHazardMockBot();
  const navigator = new GTNHNavigator(bot);
  const monitor = new HazardMonitor({ bot, navigator });

  // Emit Poison (19) packet on bot entityId 42 -> triggers pollution alert on chunk (0, 0)
  let alertInfo = null;
  monitor.once('pollutionHazard', (info) => {
    alertInfo = info;
  });
  client.emit('entity_effect', {
    entityId: 42,
    effectId: 19,
    amplifier: 1,
    duration: 200
  });

  assert.ok(alertInfo, 'Pollution hazard event must fire');
  assert.equal(monitor.inPollutedZone, true);
  assert.ok(
    navigator.evaluateStepPenalty({ position: new Vec3(8, 64, 8) }) >= 500,
    'Polluted chunk must receive impassable/high step penalty in GTNHNavigator'
  );
  assert.notEqual(
    Math.floor(alertInfo.escapeTarget.x / 16) === 0 &&
      Math.floor(alertInfo.escapeTarget.z / 16) === 0,
    true,
    'Escape vector must route out of polluted chunk (0, 0)'
  );

  // Add an Infernal Mob (`1UP Fiery Zombie`) 6 blocks away
  bot.entities[99] = {
    id: 99,
    name: 'zombie',
    displayName: '1UP Fiery Vengeance Zombie',
    position: new Vec3(14, 64, 8)
  };
  const threats = monitor.scanNearbyThreats();
  assert.equal(threats.length, 1);
  assert.equal(threats[0].isInfernal, true);
  assert.equal(threats[0].recommendedAction, 'CRITICAL_EVADE');
});
