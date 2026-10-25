'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const Vec3 = require('vec3');

const {
  FMLHandshakeClientState,
  FML_LOGIN_WRAPPER_CHANNEL,
  FML_HANDSHAKE_CHANNEL,
  encodeVarInt,
  encodeVarIntString,
  wrapLoginPluginPayload,
  attachForgeHandshake
} = require('../src/protocol/forgeHandshake');
const { GTNHNavigator } = require('../src/navigation/gtnhNavigator');
const { GTLAutomationAgent } = require('../src/bot');
const {
  parseSnbt,
  transformFtbQuestsChapter,
  runIngestPipeline
} = require('../src/cli/ingestData');

test('Forge 1.20.1 FML3 (fml:loginwrapper / fml:handshake) completes login-plugin handshake and syncs GTL 1.20.1 registries', () => {
  const outbound = [];
  const client = new EventEmitter();
  client.version = '1.20.1';
  client.write = (name, payload) => {
    outbound.push({ name, payload });
  };

  const session = attachForgeHandshake(client, { autoMirrorServerMods: true });
  let completedInfo = null;
  client.once('fmlHandshakeComplete', (info) => {
    completedInfo = info;
  });

  // Verify `\0FML3\0` host marker injection on set_protocol
  const handshakePkt = { serverHost: '127.0.0.1', serverPort: 25565, nextState: 2 };
  client.write('set_protocol', handshakePkt);
  assert.equal(handshakePkt.serverHost, '127.0.0.1\0FML3\0');

  // 1. Server sends S2C ModList (packetId = 1) inside `fml:loginwrapper`
  const s2cModListInner = Buffer.concat([
    encodeVarInt(1), // packetId = 1 (S2CModList)
    encodeVarInt(3), // 3 mods: forge, gtceu, gtlcore
    encodeVarIntString('forge'),
    encodeVarIntString('gtceu'),
    encodeVarIntString('gtlcore'),
    encodeVarInt(1), // 1 channel
    encodeVarIntString('gtceu:network'),
    encodeVarIntString('1.6.4'),
    encodeVarInt(2), // 2 registries
    encodeVarIntString('minecraft:item'),
    encodeVarIntString('minecraft:block')
  ]);
  client.emit('login_plugin_request', {
    messageId: 10,
    channel: FML_LOGIN_WRAPPER_CHANNEL,
    data: wrapLoginPluginPayload(FML_HANDSHAKE_CHANNEL, s2cModListInner)
  });

  assert.equal(session.getState(), FMLHandshakeClientState.WAITINGSERVERCOMPLETE);
  const modListReply = outbound.find((p) => p.name === 'login_plugin_response' && p.payload.messageId === 10);
  assert.ok(modListReply, 'Must reply to S2CModList with C2SModListReply (messageId 10)');
  assert.ok(Buffer.isBuffer(modListReply.payload.data));

  // 2. Server sends S2C Registry packet (packetId = 3) with snapshot entries
  const snapshotJson = JSON.stringify({
    entries: {
      'gtceu:basic_electronic_circuit': 14200,
      'kubejs:advanced_control_circuit': 18501,
      'gtceu:electric_blast_furnace': 4110
    }
  });
  const s2cRegistryInner = Buffer.concat([
    encodeVarInt(3), // packetId = 3 (S2CRegistry)
    encodeVarIntString('minecraft:item'),
    Buffer.from([0x01]), // hasSnapshot = true
    Buffer.from(snapshotJson, 'utf8')
  ]);
  client.emit('login_plugin_request', {
    messageId: 11,
    channel: FML_LOGIN_WRAPPER_CHANNEL,
    data: wrapLoginPluginPayload(FML_HANDSHAKE_CHANNEL, s2cRegistryInner)
  });

  // Verify flattened 1.20.1 ResourceLocation <-> numeric ID translation!
  assert.equal(
    session.registryBridge.toCanonicalItemId({ itemId: 14200 }),
    'gtceu:basic_electronic_circuit'
  );
  assert.equal(
    session.registryBridge.fromCanonicalItemId('kubejs:advanced_control_circuit').itemId,
    18501
  );

  // 3. Server sends S2C ConfigurationData (packetId = 4)
  const s2cConfigInner = Buffer.concat([
    encodeVarInt(4),
    encodeVarIntString('gtceu-server.toml'),
    Buffer.from('# server config', 'utf8')
  ]);
  client.emit('login_plugin_request', {
    messageId: 12,
    channel: FML_LOGIN_WRAPPER_CHANNEL,
    data: wrapLoginPluginPayload(FML_HANDSHAKE_CHANNEL, s2cConfigInner)
  });

  // 4. Server transitions to Play (`success`) -> finalizes FML3 handshake!
  client.emit('success', { uuid: '0000-0000', username: 'GTL_Automaton' });
  assert.equal(session.getState(), FMLHandshakeClientState.COMPLETE);
  assert.ok(completedInfo);
  assert.equal(completedInfo.fmlVersion, 'FML3');
  assert.equal(completedInfo.modsCount, 3);
  assert.equal(completedInfo.mappedItems, 3);
});

test('GTLNavigator enforces lava-vein proximity exclusion, vertical shaft drop protection, and DDA voxel raycasting', () => {
  const worldMap = new Map();
  for (let x = 0; x <= 15; x++) {
    for (let z = 0; z <= 15; z++) {
      if (x === 5 && z === 5) {
        worldMap.set('5,57,5', { type: 1, name: 'stone', boundingBox: 'block', position: new Vec3(5, 57, 5) });
      } else {
        worldMap.set(`${x},63,${z}`, { type: 1, name: 'stone', boundingBox: 'block', position: new Vec3(x, 63, z) });
      }
    }
  }
  worldMap.set('10,64,10', { type: 10, name: 'lava', boundingBox: 'empty', position: new Vec3(10, 64, 10) });
  worldMap.set('3,65,0', { type: 45, name: 'bricks', boundingBox: 'block', position: new Vec3(3, 65, 0) });

  const mockBot = new EventEmitter();
  mockBot.entity = { position: new Vec3(0, 64, 0) };
  mockBot.blockAt = (pos) => {
    const p = pos.floored();
    return worldMap.get(`${p.x},${p.y},${p.z}`) || {
      type: 0,
      name: 'air',
      boundingBox: 'empty',
      position: p
    };
  };

  const nav = new GTNHNavigator(mockBot, { maxDropDown: 3 });

  assert.equal(nav.evaluateStepPenalty({ position: new Vec3(2, 64, 2) }), 0);
  assert.ok(nav.evaluateStepPenalty({ position: new Vec3(9, 64, 10) }) >= 200);
  assert.ok(nav.evaluateStepPenalty({ position: new Vec3(5, 64, 5) }) >= 1000);

  const hit = nav.raycastVoxel(new Vec3(0.5, 65.5, 0.5), new Vec3(1, 0, 0), 6.0);
  assert.ok(hit);
  assert.deepEqual([hit.position.x, hit.position.y, hit.position.z], [3, 65, 0]);
  assert.deepEqual([hit.face.x, hit.face.y, hit.face.z], [-1, 0, 0]);
});

test('GTLAutomationAgent defaults to native 1.20.1, drives 3-tier FSM through Steam ULV quest 5F5F348E3A34827E, and preempts on low-EU', async () => {
  const client = new EventEmitter();
  client.write = () => {};

  const bot = new EventEmitter();
  bot._client = client;
  bot.entity = { id: 7, position: new Vec3(100, 64, 100) };
  bot.entities = {};
  bot.inventory = { items: () => [] };
  bot.blockAt = (pos) => ({
    type: pos.y <= 63 ? 1 : 0,
    name: pos.y <= 63 ? 'stone' : 'air',
    boundingBox: pos.y <= 63 ? 'block' : 'empty',
    position: pos.floored()
  });

  const agent = new GTLAutomationAgent({ autoReconnect: false });
  assert.equal(agent.config.version, '1.20.1');
  assert.equal(agent.config.forgeBridgeMode, 'fml3_native_1201');

  // Stock Copper + Tin ores/ingots so Steam Age Bronze quest (5F5F348E3A34827E) executes via CraftingMicroMachine!
  agent.warehouse.upsertContainer(new Vec3(101, 64, 100), {
    'minecraft:raw_copper': 12,
    'gtceu:raw_tin': 4
  });

  agent.attachBot(bot, {
    startStateMachineImmediately: true,
    stateMachineOptions: { autoMarkSimulatedQuests: true }
  });

  const sm = agent.stateMachineBundle;
  assert.ok(sm);
  assert.equal(sm.botStateMachine.nestedStateMachines.length, 8);
  const depths = new Set(sm.botStateMachine.nestedStateMachines.map((m) => m.depth));
  assert.deepEqual(Array.from(depths).sort(), [0, 1, 2]);

  const tickMany = async (count) => {
    for (let i = 0; i < count; i++) {
      bot.emit('physicsTick');
      await new Promise((r) => setImmediate(r));
    }
  };

  await tickMany(8);
  assert.ok(
    agent.craftingEngine.completedQuests.has('5F5F348E3A34827E'),
    'First GTL Steam ULV Bronze quest (5F5F348E3A34827E) should complete via Macro -> CraftingMicroMachine'
  );

  // Trigger Critical Low-Power EU emergency and verify Root FSM preempts into LowPowerStandbyMachine!
  agent.hazardMonitor.registerPowerBuffer({
    id: 'test_buf',
    position: new Vec3(102, 64, 100),
    maxEu: 100000,
    storedEu: 5000
  });
  await tickMany(3);
  assert.equal(sm.rootMachine.activeState, sm.lowPowerStandbyMachine);

  // Restore EU above 50% hysteresis and verify Root FSM resumes MacroProgressionMachine!
  agent.hazardMonitor.updatePowerBufferTelemetry('test_buf', { storedEu: 75000 });
  await tickMany(3);
  assert.equal(sm.rootMachine.activeState, sm.macroProgressionMachine);
});

test('FTB Quests .snbt parser & ingestion pipeline imports GregTech Leisure chapter quests into a valid DAG', () => {
  const sampleSnbtPath = path.resolve(__dirname, '../data/gtl_steam_sample.snbt');
  const fs = require('node:fs');
  const parsedSnbt = parseSnbt(fs.readFileSync(sampleSnbtPath, 'utf8'));

  assert.equal(parsedSnbt.id, '77F8039ACE718C6C');
  assert.equal(parsedSnbt.quests.length, 4);

  const quests = transformFtbQuestsChapter(parsedSnbt);
  assert.equal(quests.length, 4);
  assert.equal(quests[0].questId, '5F5F348E3A34827E');
  assert.equal(quests[0].tasks[0].requiredItems[0].itemId, 'gtceu:bronze_ingot');
  assert.equal(quests[0].tasks[0].requiredItems[0].count, 8);

  const circuitQuest = quests.find((q) => q.questId === '51A6B6CDC90D7E76');
  assert.ok(circuitQuest);
  assert.equal(circuitQuest.tasks[0].requiredItems[0].itemId, 'gtceu:programmed_circuit');
  assert.equal(circuitQuest.tasks[0].requiredItems[0].nbtTag.Configuration, 1);

  const report = runIngestPipeline(['--ftbquests', sampleSnbtPath, '--seed', '987654321']);
  assert.equal(report.summary.isQuestDagAcyclic, true);
  assert.equal(report.snbtQuestsImported, 4);
  assert.equal(report.worldSeed, '987654321');
});
