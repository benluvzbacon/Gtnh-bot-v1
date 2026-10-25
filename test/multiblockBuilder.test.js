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
const DB_PATH = path.resolve(__dirname, '../data/quest_tree_template.json');

/**
 * Creates an in-memory 3D voxel world + mock Mineflayer bot for live-testing
 * `MultiblockBuilder` block scanning, excavation, and `block_place` packet emission.
 */
function createVirtualVoxelBot() {
  const voxels = new Map();
  const key = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

  // Lay solid stone ground at y <= 62
  for (let x = 90; x <= 115; x++) {
    for (let z = 90; z <= 115; z++) {
      voxels.set(`${x},62,${z}`, {
        type: 1,
        name: 'stone',
        metadata: 0,
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
  bot.entity = { id: 1, position: new Vec3(100, 63, 97) };
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
        metadata: 0,
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
      name: cell.blockName,
      metadata: cell.metadata,
      canonicalId: cell.itemId,
      boundingBox: 'block',
      position: p
    });
  };

  return { bot, voxels, packets, sneakHistory, key };
}

test('MultiblockBuilder parses 3x3x4 Primitive Blast Furnace & Electric Blast Furnace blueprints and rotates across all 4 facings', () => {
  const builder = new MultiblockBuilder();
  const pbf = builder.loadBlueprintFromFile(PBF_PATH);
  const ebf = builder.loadBlueprintFromFile(EBF_PATH);

  assert.equal(pbf.voxels.length, 36, '3x3x4 grid has 36 total voxel cells');
  assert.equal(pbf.roleCounts.casing, 30, 'PBF requires 30 Firebricks');
  assert.equal(pbf.roleCounts.controller, 1);
  assert.equal(pbf.roleCounts.input_hatch, 1);
  assert.equal(pbf.roleCounts.output_hatch, 1);
  assert.equal(pbf.roleCounts.air, 3, 'PBF has 3 vertical interior air blocks');

  assert.equal(ebf.roleCounts.energy_hatch, 2, 'Dual-LV Energy Hatch EBF setup');
  assert.equal(ebf.roleCounts.maintenance_hatch, 1);
  assert.equal(ebf.roleCounts.muffler_hatch, 1);
  assert.equal(ebf.roleCounts.coil, 16);

  // Verify 90-degree EAST rotation transforms West Input Hatch (-1, 0, 1) -> (-1, 0, -1) facing NORTH
  const projEast = builder.projectToWorld(pbf, new Vec3(100, 64, 100), 'EAST');
  const controllerCell = projEast.cells.find((c) => c.role === 'controller');
  assert.deepEqual(
    [controllerCell.worldPos.x, controllerCell.worldPos.y, controllerCell.worldPos.z],
    [100, 64, 100],
    'Controller always remains pinned at master anchor [100, 64, 100]'
  );
  assert.equal(controllerCell.worldFacing, 'EAST');

  const inputHatchCell = projEast.cells.find((c) => c.role === 'input_hatch');
  assert.equal(inputHatchCell.worldFacing, 'NORTH');
});

test('MultiblockBuilder pauses when specialized GTNH hatches/casings are missing, passes missing IDs to CraftingEngine, and completes 3x3x4 PBF on resume', async () => {
  const { bot, voxels, packets, sneakHistory, key } = createVirtualVoxelBot();

  const engine = new CraftingEngine({ unlockedVoltageTier: 'STEAM' });
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
  builder.loadBlueprintFromFile(PBF_PATH);

  // Place a stray dirt block inside the hollow interior cavity at (100, 64, 101) to test air excavation!
  voxels.set(key(new Vec3(100, 64, 101)), {
    type: 3,
    name: 'dirt',
    metadata: 0,
    boundingBox: 'block',
    position: new Vec3(100, 64, 101)
  });

  // Initially stock ONLY 28 Firebricks and 1 Controller (missing 2 Firebricks, 1 Input Hatch, 1 Output Hatch!)
  engine.warehouse.upsertContainer(new Vec3(96, 63, 96), {
    'gregtech:gt.blockcasings4:15': 28,
    'gregtech:gt.blockmachines:1400': 1
  });

  const firstAttempt = await builder.executeBuild(
    'primitive_blast_furnace',
    new Vec3(100, 64, 100),
    { facing: 'NORTH' }
  );

  assert.equal(firstAttempt.status, 'PAUSED_MISSING_MATERIALS');
  assert.equal(firstAttempt.missingMaterials.length, 3);
  assert.equal(engine.craftQueue.length, 3, 'All 3 missing items must be queued in CraftingEngine');

  const queuedIds = engine.craftQueue.map((j) => j.itemId).sort();
  assert.deepEqual(queuedIds, [
    'gregtech:gt.blockcasings4:15',
    'gregtech:gt.blockmachines:151',
    'gregtech:gt.blockmachines:161'
  ]);

  // Supply the missing Firebricks + Input Hatch + Output Hatch to the warehouse and resume checkpoint!
  engine.warehouse.upsertContainer(new Vec3(96, 63, 96), {
    'gregtech:gt.blockcasings4:15': 30,
    'gregtech:gt.blockmachines:1400': 1,
    'gregtech:gt.blockmachines:151': 1,
    'gregtech:gt.blockmachines:161': 1
  });

  const resumed = await builder.resumePausedBuild();
  assert.equal(resumed.status, 'COMPLETED');
  assert.equal(resumed.dugCount, 1, 'Must excavate the stray dirt block inside the PBF air chimney');
  assert.equal(resumed.placedCount, 33, 'Must place 30 Firebricks + Input Hatch + Output Hatch + Controller');

  const blockPlacePackets = packets.filter((p) => p.name === 'block_place');
  assert.equal(blockPlacePackets.length, 33);
  assert.ok(sneakHistory.includes(true) && sneakHistory.includes(false), 'Must toggle sneak during hatch/controller placement');
  assert.equal(protectedBoxes.length, 1, 'Completed multiblock must register break-protection AABB');
});
