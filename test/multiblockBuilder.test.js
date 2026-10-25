'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const Vec3 = require('vec3');

const { CraftingEngine } = require('../src/craftingEngine');
const { MultiblockBuilder } = require('../src/multiblockBuilder');

const PBF_PATH = path.resolve(__dirname, '../data/primitive_blast_furnace.json');
const EBF_PATH = path.resolve(__dirname, '../data/electric_blast_furnace.json');
const LSCA_PATH = path.resolve(__dirname, '../data/large_steam_circuit_assembler.json');
const DB_PATH = path.resolve(__dirname, '../data/quest_tree_template.json');

function createVirtualVoxelBot() {
  const voxels = new Map();
  const key = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

  for (let x = 90; x <= 115; x++) {
    for (let z = 90; z <= 115; z++) {
      voxels.set(`${x},62,${z}`, {
        type: 1,
        name: 'stone',
        boundingBox: 'block',
        position: new Vec3(x, 62, z)
      });
    }
  }

  const packets = [];
  const sneakHistory = [];
  const client = new EventEmitter();
  client.write = (name, payload) => {
    packets.push({ name, payload });
  };

  const bot = new EventEmitter();
  bot._client = client;
  bot.entity = { id: 1, position: new Vec3(100, 63, 102) };
  bot.inventoryItems = [];
  bot.inventory = {
    items: () => bot.inventoryItems
  };
  bot.blockAt = (pos) => {
    const p = pos.floored();
    return (
      voxels.get(key(p)) || {
        type: 0,
        name: 'air',
        boundingBox: 'empty',
        position: p
      }
    );
  };
  bot.dig = async (block) => {
    voxels.delete(key(block.position));
  };
  bot.lookAt = async () => {};
  bot.equip = async () => {};
  bot.setControlState = (ctrl, val) => {
    if (ctrl === 'sneak') sneakHistory.push(val);
  };
  bot._ApplyVirtualPlacement = (targetPos, cell) => {
    const p = targetPos.floored();
    voxels.set(key(p), {
      type: 500,
      name: cell.itemId,
      boundingBox: 'block',
      position: p
    });
  };

  return { bot, voxels, packets, sneakHistory, key };
}

test('MultiblockBuilder parses GTL 1.20.1 PBF, Dual-LV EBF, and Large Steam Circuit Assembler blueprints and rotates across facings', () => {
  const builder = new MultiblockBuilder();
  const pbf = builder.loadBlueprintFromFile(PBF_PATH);
  const ebf = builder.loadBlueprintFromFile(EBF_PATH);
  const lsca = builder.loadBlueprintFromFile(LSCA_PATH);

  assert.equal(pbf.voxels.length, 36, '3x4x3 PBF grid has 36 total voxel cells');
  assert.equal(pbf.roleCounts.firebrick, 32, 'Standard PBF uses 32 gtceu:firebricks');
  assert.equal(pbf.roleCounts.controller, 1);
  assert.equal(pbf.roleCounts.air, 3, 'PBF has 3 vertical interior air blocks');

  assert.equal(ebf.roleCounts.energy_hatch, 2, 'GTL Dual-LV Energy Hatch EBF setup for MV overclock');
  assert.equal(ebf.roleCounts.maintenance_hatch, 1);
  assert.equal(ebf.roleCounts.muffler_hatch, 1);
  assert.equal(ebf.roleCounts.coil, 16);

  assert.equal(lsca.voxels.length, 27, 'GTL Large Steam Circuit Assembler is 3x3x3');
  assert.equal(lsca.roleCounts.steam_input_hatch, 1);
  assert.equal(lsca.roleCounts.ulv_fluid_hatch, 1);

  const projEast = builder.projectToWorld(ebf, new Vec3(100, 64, 100), 'EAST');
  const controllerCell = projEast.cells.find((c) => c.role === 'controller');
  assert.deepEqual(
    [controllerCell.worldPos.x, controllerCell.worldPos.y, controllerCell.worldPos.z],
    [100, 64, 100],
    'Controller always remains pinned at master anchor [100, 64, 100]'
  );
  assert.equal(controllerCell.worldFacing, 'EAST');
});

test('MultiblockBuilder pauses when GTL hatches/casings are missing, delegates to CraftingEngine, emits 1.20.1 block_place packets, and services EBF Maintenance Hatch with gtceu:duct_tape', async () => {
  const { bot, voxels, packets, sneakHistory, key } = createVirtualVoxelBot();

  const engine = new CraftingEngine({ unlockedVoltageTier: 'LV' });
  engine.loadDatabaseFromFile(DB_PATH);

  const protectedBoxes = [];
  const mockNavigator = {
    hasLineOfSight: () => true,
    gotoPlacementPose: async () => {},
    gotoBlockAdjacent: async () => {},
    registerProtectedStructure: (id, min, max) => {
      protectedBoxes.push({ id, min, max });
    }
  };

  const builder = new MultiblockBuilder({
    bot,
    navigator: mockNavigator,
    craftingEngine: engine
  });
  builder.loadBlueprintFromFile(EBF_PATH);

  // Obstruct both an interior coil air cavity (100, 65, 99) AND the block above the Muffler Hatch (100, 68, 99)!
  voxels.set(key(new Vec3(100, 65, 99)), {
    type: 3,
    name: 'dirt',
    boundingBox: 'block',
    position: new Vec3(100, 65, 99)
  });
  voxels.set(key(new Vec3(100, 68, 99)), {
    type: 4,
    name: 'cobblestone',
    boundingBox: 'block',
    position: new Vec3(100, 68, 99)
  });

  // Initially omit 2x LV Energy Hatches and 1x Maintenance Hatch to trigger missing-hatch craft delegation!
  engine.warehouse.upsertContainer(new Vec3(96, 63, 96), {
    'gtceu:electric_blast_furnace': 1,
    'gtceu:heatproof_machine_casing': 10,
    'gtceu:cupronickel_coil_block': 16,
    'gtceu:lv_input_bus': 1,
    'gtceu:lv_output_bus': 1,
    'gtceu:lv_input_hatch': 1,
    'gtceu:lv_muffler_hatch': 1
  });

  const firstAttempt = await builder.executeBuild(
    'electric_blast_furnace',
    new Vec3(100, 64, 100),
    { facing: 'NORTH' }
  );

  assert.equal(firstAttempt.status, 'PAUSED_MISSING_MATERIALS');
  assert.equal(firstAttempt.missingMaterials.length, 2);
  assert.equal(engine.craftQueue.length, 2, 'Missing Energy Hatches & Maintenance Hatch must be queued');

  const queuedIds = engine.craftQueue.map((j) => j.itemId).sort();
  assert.deepEqual(queuedIds, [
    'gtceu:lv_energy_input_hatch',
    'gtceu:maintenance_hatch'
  ]);

  // Supply missing hatches + GTL quest reward `gtceu:duct_tape` and resume!
  engine.warehouse.upsertContainer(new Vec3(96, 63, 96), {
    'gtceu:electric_blast_furnace': 1,
    'gtceu:heatproof_machine_casing': 10,
    'gtceu:cupronickel_coil_block': 16,
    'gtceu:lv_input_bus': 1,
    'gtceu:lv_output_bus': 1,
    'gtceu:lv_input_hatch': 1,
    'gtceu:lv_muffler_hatch': 1,
    'gtceu:lv_energy_input_hatch': 2,
    'gtceu:maintenance_hatch': 1,
    'gtceu:duct_tape': 256
  });

  const resumed = await builder.resumePausedBuild();
  assert.equal(resumed.status, 'COMPLETED');
  assert.equal(resumed.dugCount, 2, 'Must excavate obstructed interior air AND block above Muffler Hatch');
  assert.equal(resumed.placedCount, 34, 'Must place all 34 solid EBF blocks');
  assert.equal(resumed.maintenanceServiced, true, 'Must service Maintenance Hatch automatically with gtceu:duct_tape');

  const blockPlacePackets = packets.filter((p) => p.name === 'block_place');
  assert.equal(blockPlacePackets.length, 35, '34 voxel placements + 1 gtceu:duct_tape service interaction');
  assert.equal(blockPlacePackets[0].payload.hand, 0);
  assert.equal(blockPlacePackets[0].payload.cursorX, 0.5);
  assert.equal(typeof blockPlacePackets[0].payload.sequence, 'number');
  assert.ok(sneakHistory.includes(true) && sneakHistory.includes(false));
  assert.equal(protectedBoxes.length, 1);
});
