'use strict';

const path = require('path');
const { CraftingEngine } = require('../craftingEngine');

if (require.main === module) {
  const args = process.argv.slice(2);
  const targetItem = args[0] || 'gtceu:basic_electronic_circuit';
  const count = Number(args[1] || 1);
  const tier = args[2] || 'LV';

  const dbPath =
    process.env.GTL_QUEST_DB_PATH ||
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
        currentDimension: plan.currentDimension,
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
          fluidInputs: s.fluidInputs,
          outputs: s.outputs
        }))
      },
      null,
      2
    )
  );
}
