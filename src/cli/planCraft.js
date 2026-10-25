'use strict';

const path = require('path');
const { CraftingEngine } = require('../craftingEngine');

if (require.main === module) {
  const args = process.argv.slice(2);
  const targetItem = args[0] || 'gregtech:gt.metaitem.01:32700';
  const count = Number(args[1] || 1);
  const tier = args[2] || 'LV';

  const dbPath =
    process.env.GTNH_QUEST_DB_PATH ||
    path.resolve(__dirname, '../../data/quest_tree_template.json');

  const engine = new CraftingEngine({ unlockedVoltageTier: tier });
  engine.loadDatabaseFromFile(dbPath);

  const plan = engine.resolveCraftingPlan(targetItem, count);
  console.log(
    JSON.stringify(
      {
        targetItemId: plan.targetItemId,
        requestedCount: plan.requestedCount,
        unlockedVoltageTier: plan.unlockedVoltageTier,
        totalEuRequired: plan.totalEuRequired,
        totalDurationTicks: plan.totalDurationTicks,
        rawMaterials: plan.rawMaterials,
        steps: plan.steps.map((s) => ({
          step: s.stepIndex + 1,
          recipeId: s.recipeId,
          machine: s.machine,
          circuit: s.programmedCircuit,
          batches: s.batches,
          inputs: s.inputs,
          outputs: s.outputs
        }))
      },
      null,
      2
    )
  );
}
