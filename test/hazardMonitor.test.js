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
      return { type: 45, name: 'bricks', boundingBox: 'block', position: p };
    }
    if (p.y <= 63) {
      return { type: 1, name: 'stone', boundingBox: 'block', position: p };
    }
    return { type: 0, name: 'air', boundingBox: 'empty', position: p };
  };

  return { bot, client, roofBlocks, sentPackets };
}

test('HazardMonitor prevents GTL dry steam boiler explosions (4BFC342697BDE75A) and MAE2 EU P2P over-voltage (4B66FAB975B2C7D2)', () => {
  const { bot } = createHazardMockBot();
  const monitor = new HazardMonitor({ bot });

  monitor.registerSteamBoiler({
    id: 'lp_boiler_1',
    position: new Vec3(14, 64, 10),
    temperatureC: 420,
    waterMb: 0
  });

  const hotDryVerdict = monitor.verifySafeBoilerWaterFill('lp_boiler_1');
  assert.equal(hotDryVerdict.safe, false, 'Adding water to a dry 420C GTCEu boiler must be blocked!');

  monitor.updateBoilerTelemetry('lp_boiler_1', { temperatureC: 80, waterMb: 0 });
  assert.equal(monitor.verifySafeBoilerWaterFill('lp_boiler_1').safe, true, 'Cooled boiler (<95C) is safe to fill');

  // Verify MAE2 EU P2P over-voltage guard (GTL Quest 4B66FAB975B2C7D2)
  const euP2pOvervolt = monitor.verifySafeCableConnection('MV', 'LV', { viaEuP2P: true });
  assert.equal(euP2pOvervolt.safe, false);
  assert.match(euP2pOvervolt.reason, /mae2:eu_p2p_tunnel/);
});

test('HazardMonitor locks exterior wiring and Soft-Mallet disables ONLY unroofed GTCEu electric machines on 1.20.1 rain packets', () => {
  const { bot, client, roofBlocks, sentPackets } = createHazardMockBot();
  const monitor = new HazardMonitor({ bot });

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

  monitor.registerElectricMachine({
    id: 'outdoor_lv_bender',
    position: new Vec3(30, 64, 30),
    voltageTier: 'LV',
    active: true
  });

  let emergencyEvent = null;
  monitor.once('weatherEmergency', (ev) => {
    emergencyEvent = ev;
  });
  client.emit('game_state_change', { reason: 'start_raining', gameMode: 0 });

  assert.equal(monitor.isRaining, true);
  assert.equal(monitor.exteriorWiringLocked, true);
  assert.ok(emergencyEvent);
  assert.equal(emergencyEvent.disabledMachines.length, 1);
  assert.equal(emergencyEvent.disabledMachines[0].id, 'outdoor_lv_bender');
  assert.equal(sentPackets.length, 1);
  assert.equal(sentPackets[0].payload.hand, 0);
  assert.equal(sentPackets[0].payload.cursorX, 0.5);
});

test('HazardMonitor parses GTCEu Modern energyContainer NBT, halts below 20% EU to prevent 2x low-energy progress drain, and resumes above 50%', async () => {
  const { bot, client } = createHazardMockBot();
  const monitor = new HazardMonitor({
    bot,
    criticalEuThresholdRatio: 0.20,
    recoveryEuThresholdRatio: 0.50
  });
  const controller = new ContainerPacketController(bot, { clickDelayMs: 0 });

  monitor.registerPowerBuffer({
    id: 'gtceu_lv_4x_buffer',
    type: 'gtceu:lv_battery_buffer_4x',
    position: new Vec3(12, 64, 12),
    maxEu: 400000,
    storedEu: 320000
  });

  const sampleStep = {
    recipeId: 'rcp_steel_plate_bender',
    machine: 'gt_lv_bender',
    voltageTier: 'LV',
    euPerTick: 24,
    durationTicks: 10,
    totalEu: 240,
    inputs: [],
    outputs: []
  };

  assert.equal(monitor.canExecuteRecipeStep(sampleStep).allowed, true);

  // Emit GTCEu Modern 1.20.1 `energyContainer` TileEntity NBT update dropping to 50,000 / 400,000 EU (12.5%)
  client.emit('tile_entity_data', {
    location: { x: 12, y: 64, z: 12 },
    action: 0,
    nbtData: nbt.comp({
      energyContainer: nbt.comp({
        energyStored: nbt.int(50000),
        energyCapacity: nbt.int(400000)
      })
    })
  });

  assert.equal(monitor.lowPowerHalted, true);
  assert.equal(monitor.canExecuteRecipeStep(sampleStep).allowed, false);

  await assert.rejects(
    () => controller.executeMachineStep(sampleStep, { hazardMonitor: monitor }),
    { code: 'HAZARD_HALT' }
  );

  // Partial recharge to 35% stays halted due to 50% hysteresis
  monitor.updatePowerBufferTelemetry('gtceu_lv_4x_buffer', { storedEu: 140000 });
  assert.equal(monitor.lowPowerHalted, true);

  // Recharge to 55% clears halt!
  monitor.updatePowerBufferTelemetry('gtceu_lv_4x_buffer', { storedEu: 220000 });
  assert.equal(monitor.lowPowerHalted, false);
  assert.equal(monitor.canExecuteRecipeStep(sampleStep).allowed, true);
});

test('GTLNavigator & HazardMonitor avoid scalding steam exhaust vents, unframed hot pipes, toxic chunks, and elite mobs', () => {
  const { bot, client } = createHazardMockBot();
  const navigator = new GTNHNavigator(bot);
  const monitor = new HazardMonitor({ bot, navigator });

  // Register a Steam Compressor at (6, 64, 6) venting NORTH -> exhaust air tile at (6, 64, 5)
  const exhaustPos = navigator.registerSteamExhaustVent(new Vec3(6, 64, 6), 'NORTH');
  assert.deepEqual([exhaustPos.x, exhaustPos.y, exhaustPos.z], [6, 64, 5]);
  assert.ok(navigator.evaluateStepPenalty({ position: exhaustPos }) >= 1000, 'Must never walk into scalding steam exhaust');
  assert.ok(navigator.evaluatePlacePenalty({ position: exhaustPos }) >= 1000, 'Must never place a block obstructing steam exhaust');

  // Unframed hot fluid pipe scalds; framing removes penalty
  navigator.registerHotFluidPipe(new Vec3(7, 64, 6), false);
  assert.ok(navigator.evaluateStepPenalty({ position: new Vec3(7, 64, 6) }) >= 1000);
  navigator.registerHotFluidPipe(new Vec3(7, 64, 6), true);
  assert.equal(navigator.evaluateStepPenalty({ position: new Vec3(7, 64, 6) }), 0);

  // Environmental Poison (19) debuff triggers retreat vector
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
  assert.ok(alertInfo);
  assert.equal(monitor.inPollutedZone, true);

  // Champion / Apotheotic Zombie triggers CRITICAL_EVADE
  bot.entities[99] = {
    id: 99,
    name: 'zombie',
    displayName: 'Apotheotic Champion Fiery Zombie',
    position: new Vec3(14, 64, 8)
  };
  const threats = monitor.scanNearbyThreats();
  assert.equal(threats.length, 1);
  assert.equal(threats[0].recommendedAction, 'CRITICAL_EVADE');
});
