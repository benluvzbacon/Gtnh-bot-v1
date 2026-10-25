'use strict';

const path = require('path');
const Vec3 = require('vec3');
const { MultiblockBuilder } = require('../multiblockBuilder');

if (require.main === module) {
  const args = process.argv.slice(2);
  const blueprintFile =
    args[0] || path.resolve(__dirname, '../../data/primitive_blast_furnace.json');
  const facing = (args[1] || 'NORTH').toUpperCase();

  const builder = new MultiblockBuilder();
  const parsed = builder.loadBlueprintFromFile(blueprintFile);
  const projection = builder.projectToWorld(parsed, new Vec3(100, 64, 100), facing);

  console.log(
    JSON.stringify(
      {
        blueprintId: parsed.blueprintId,
        displayName: parsed.displayName,
        era: parsed.era,
        facing: projection.facing,
        anchor: projection.anchor,
        boundingBox: projection.boundingBox,
        roleCounts: parsed.roleCounts,
        billOfMaterials: parsed.billOfMaterials
      },
      null,
      2
    )
  );
}
