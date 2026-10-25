'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Vec3 = require('vec3');

const {
  FMLHandshakeClientState,
  createFmlProto,
  attachForgeHandshake
} = require('../src/protocol/forgeHandshake');
const { GTNHNavigator } = require('../src/navigation/gtnhNavigator');
const { GTNHAutomationAgent } = require('../src/bot');

function encodeVarInt(value) {
  const bytes = [];
  let v = value >>> 0;
  while ((v & ~0x7f) !== 0) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v & 0x7f);
  return Buffer.from(bytes);
}

function encodeVarIntString(str) {
  const strBuf = Buffer.from(str, 'utf8');
  return Buffer.concat([encodeVarInt(strBuf.length), strBuf]);
}

test('Forge 1.7.10 FML|HS handshake completes all 5 phases and maps dynamic ModIdData numeric IDs', () => {
  const proto = createFmlProto();
  const outbound = [];
  const client = new EventEmitter();
  client.version = '1.7.10';
  client.write = (name, payload) => {
    outbound.push({ name, payload });
  };

  const session = attachForgeHandshake(client);
  let completedPayload = null;
  client.once('fmlHandshakeComplete', (info) => {
    completedPayload = info;
  });

  // 1. Server sends ServerHello (fmlProtocolVersion = 1 for Forge 1.7.10)
  client.emit('custom_payload', {
    channel: 'FML|HS',
    data: proto.createPacketBuffer('FML|HS', {
      discriminator: 'ServerHello',
      fmlProtocolVersion: 1
    })
  });
  assert.equal(session.getState(), FMLHandshakeClientState.WAITINGSERVERDATA);
  assert.equal(outbound[0].payload.channel, 'REGISTER');

  // 2. Server sends ModList
  client.emit('custom_payload', {
    channel: 'FML|HS',
    data: proto.createPacketBuffer('FML|HS', {
      discriminator: 'ModList',
      mods: [
        { modid: 'Forge', version: '10.13.4.1614' },
        { modid: 'gregtech', version: '5.09.45.210' }
      ]
    })
  });
  assert.equal(session.getState(), FMLHandshakeClientState.WAITINGSERVERCOMPLETE);

  // 3. Server sends 1.7.10 ModIdData (discriminator = 3) with dynamic Forge block/item IDs
  const modIdPacket = Buffer.concat([
    Buffer.from([0x03]), // discriminator 3
    encodeVarInt(2), // 2 entries
    encodeVarIntString('\u0001gregtech:gt.blockmachines'),
    encodeVarInt(1509),
    encodeVarIntString('\u0002gregtech:gt.metaitem.01'),
    encodeVarInt(7156)
  ]);
  client.emit('custom_payload', { channel: 'FML|HS', data: modIdPacket });
  assert.equal(session.getState(), FMLHandshakeClientState.PENDINGCOMPLETE);

  // Verify bidirectional dynamic numeric ID <-> GTNH canonical ID translation!
  assert.equal(
    session.registryBridge.toCanonicalItemId({ type: 7156, metadata: 32700 }),
    'gregtech:gt.metaitem.01:32700'
  );
  assert.equal(
    session.registryBridge.fromCanonicalItemId('gregtech:gt.blockmachines:1400').blockId,
    1509
  );

  // 4. Server sends HandshakeAck phase 2 (WAITINGACK) -> client enters COMPLETE
  client.emit('custom_payload', {
    channel: 'FML|HS',
    data: proto.createPacketBuffer('FML|HS', { discriminator: 'HandshakeAck', phase: 2 })
  });
  assert.equal(session.getState(), FMLHandshakeClientState.COMPLETE);

  // 5. Server sends HandshakeAck phase 3 (COMPLETE) -> handshake finalized!
  client.emit('custom_payload', {
    channel: 'FML|HS',
    data: proto.createPacketBuffer('FML|HS', { discriminator: 'HandshakeAck', phase: 3 })
  });
  assert.ok(completedPayload);
  assert.equal(completedPayload.modsCount, 2);
  assert.equal(completedPayload.mappedItems, 1);
  assert.equal(completedPayload.mappedBlocks, 1);
});

test('GTNHNavigator enforces lava-vein proximity exclusion, vertical shaft drop protection, and DDA voxel raycasting', () => {
  const worldMap = new Map();
  // Ground everywhere except a 6-block deep shaft at (5, y, 5) and a lava vein at (10, 64, 10)
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
  worldMap.set('3,65,0', { type: 45, name: 'brick_block', boundingBox: 'block', position: new Vec3(3, 65, 0) });

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

  // Safe flat stone step has 0 penalty
  assert.equal(nav.evaluateStepPenalty({ position: new Vec3(2, 64, 2) }), 0);

  // Stepping directly next to lava vein at (9, 64, 10) incurs >= 200 penalty
  assert.ok(nav.evaluateStepPenalty({ position: new Vec3(9, 64, 10) }) >= 200);

  // Stepping over 6-block vertical shaft at (5, 64, 5) is blocked (>= 1000 penalty)
  assert.ok(nav.evaluateStepPenalty({ position: new Vec3(5, 64, 5) }) >= 1000);

  // DDA Raycast along +X from (0.5, 65.5, 0.5) hits brick_block at (3, 65, 0) on West (-X) face
  const hit = nav.raycastVoxel(new Vec3(0.5, 65.5, 0.5), new Vec3(1, 0, 0), 6.0);
  assert.ok(hit);
  assert.deepEqual([hit.position.x, hit.position.y, hit.position.z], [3, 65, 0]);
  assert.deepEqual([hit.face.x, hit.face.y, hit.face.z], [-1, 0, 0]);
});

test('GTNHAutomationAgent drives 3-tier Hierarchical State Machine and preempts on low-EU / hazard emergencies', async () => {
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

  const agent = new GTNHAutomationAgent({ autoReconnect: false });
  // Stock initial Stone Age quest requirements so macro machine transitions cleanly into micro loop
  agent.warehouse.upsertContainer(new Vec3(101, 64, 100), {
    'minecraft:log:0': 16,
    'minecraft:flint:0': 6
  });

  agent.attachBot(bot, {
    startStateMachineImmediately: true,
    stateMachineOptions: { autoMarkSimulatedQuests: true }
  });

  const sm = agent.stateMachineBundle;
  assert.ok(sm);
  assert.equal(
    sm.botStateMachine.nestedStateMachines.length,
    8,
    '1 Root (Depth 0) + 3 Depth-1 + 4 Depth-2 = 8 nested state machines'
  );
  const depths = new Set(sm.botStateMachine.nestedStateMachines.map((m) => m.depth));
  assert.deepEqual(Array.from(depths).sort(), [0, 1, 2], 'Must span 3 hierarchical FSM depths');

  const tickMany = async (count) => {
    for (let i = 0; i < count; i++) {
      bot.emit('physicsTick');
      await new Promise((r) => setImmediate(r));
    }
  };

  await tickMany(8);
  assert.ok(
    agent.craftingEngine.completedQuests.has('quest_stone_001'),
    'First Stone Age quest should complete via Macro -> CraftingMicroMachine transition'
  );

  // Trigger Critical Low-Power EU emergency and verify Root FSM preempts into LowPowerStandbyMachine!
  agent.hazardMonitor.registerPowerBuffer({
    id: 'test_buf',
    position: new Vec3(102, 64, 100),
    maxEu: 100000,
    storedEu: 5000 // 5% < 20% critical!
  });
  await tickMany(3);
  assert.equal(sm.rootMachine.activeState, sm.lowPowerStandbyMachine);

  // Restore EU above 50% hysteresis and verify Root FSM resumes MacroProgressionMachine!
  agent.hazardMonitor.updatePowerBufferTelemetry('test_buf', { storedEu: 75000 });
  await tickMany(3);
  assert.equal(sm.rootMachine.activeState, sm.macroProgressionMachine);
});

test('BetterQuesting DefaultQuests.json + NEI CSV ingestion pipeline transforms dumps into valid DAGs', () => {
  const { transformBetterQuestingDump, parseNeiIdCsv } = require('../src/cli/ingestData');

  const sampleBq = {
    'questDatabase:9': {
      '0:10': {
        'questID:3': 9001,
        'preRequisites:11': [],
        'properties:10': {
          'betterquesting:10': {
            'name:8': 'Mine Chalcopyrite Vein',
            'questLogic:8': 'AND'
          }
        },
        'tasks:9': {
          '0:10': {
            'taskID:8': 'bq_standard:retrieval',
            'consume:1': 0,
            'requiredItems:9': {
              '0:10': {
                'id:8': 'gregtech:gt.blockores',
                'Damage:2': 855,
                'Count:3': 64
              }
            }
          }
        }
      }
    }
  };

  const transformed = transformBetterQuestingDump(sampleBq);
  assert.equal(transformed.length, 1);
  assert.equal(transformed[0].questId, 'bq_quest_9001');
  assert.equal(transformed[0].tasks[0].requiredItems[0].itemId, 'gregtech:gt.blockores:855');

  const csv = [
    'Name,ID,Has BlockItem,Mod',
    'gregtech:gt.blockmachines,1509,true,gregtech',
    'gregtech:gt.metaitem.01,7156,false,gregtech'
  ].join('\n');
  const parsedCsv = parseNeiIdCsv(csv);
  assert.equal(parsedCsv.length, 2);
  assert.equal(parsedCsv[0].kind, 'block');
  assert.equal(parsedCsv[1].kind, 'item');
});

