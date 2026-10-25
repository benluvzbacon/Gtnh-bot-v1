'use strict';

const {
  BotStateMachine,
  NestedStateMachine,
  StateTransition,
  BehaviorIdle
} = require('mineflayer-statemachine');

/**
 * Helper base class implementing `mineflayer-statemachine`'s `StateBehavior` contract
 * with async-safe tick execution guards so async Mineflayer tasks never overlap across ticks.
 */
class GTNHBehaviorState {
  /**
   * @param {string} stateName
   * @param {Object} handlers
   * @param {Function} [handlers.onEnter]
   * @param {Function} [handlers.onTick]
   * @param {Function} [handlers.onExit]
   */
  constructor(stateName, handlers = {}) {
    this.stateName = stateName;
    this.active = false;
    this.done = false;
    this.error = null;
    this._runningAsync = false;
    this._handlers = handlers;
  }

  onStateEntered() {
    this.done = false;
    this.error = null;
    this._runningAsync = false;
    if (typeof this._handlers.onEnter === 'function') {
      const maybePromise = this._handlers.onEnter(this);
      if (maybePromise && typeof maybePromise.then === 'function') {
        this._runningAsync = true;
        maybePromise
          .then(() => {
            this._runningAsync = false;
          })
          .catch((err) => {
            this.error = err;
            this._runningAsync = false;
            this.done = true;
          });
      }
    }
  }

  update() {
    if (this._runningAsync || this.done) return;
    if (typeof this._handlers.onTick === 'function') {
      const maybePromise = this._handlers.onTick(this);
      if (maybePromise && typeof maybePromise.then === 'function') {
        this._runningAsync = true;
        maybePromise
          .then(() => {
            this._runningAsync = false;
          })
          .catch((err) => {
            this.error = err;
            this._runningAsync = false;
            this.done = true;
          });
      }
    }
  }

  onStateExited() {
    this._runningAsync = false;
    if (typeof this._handlers.onExit === 'function') {
      this._handlers.onExit(this);
    }
  }
}

/**
 * Builds the 3-tier Hierarchical State Machine (`BotStateMachine` + nested `NestedStateMachine`s)
 * separating GTNH Macro Era/Quest progression from Micro execution loops and Survival preemption.
 *
 * Hierarchy:
 *  - Depth 0 (`rootMachine`): Preempts between Macro Progression, Emergency Hazard Mitigation, and Low-EU Recovery
 *    - Depth 1 (`macroProgressionMachine`): Evaluates Quest Book DAG frontier & dispatches Micro Loops
 *      - Depth 2 (`miningMicroMachine`): Locate vein -> Pathfind -> Excavate -> Return
 *      - Depth 2 (`craftingMicroMachine`): Withdraw warehouse stock -> Route to GT Machine -> Packet Clicks + Circuit -> Extract
 *      - Depth 2 (`multiblockMicroMachine`): Scan 3D footprint -> Place casings/hatches/controller -> Verify formation
 *      - Depth 2 (`sortingMicroMachine`): Consolidate bot inventory -> Index warehouse chests
 *    - Depth 1 (`emergencyHazardMachine`): Rain shutdown -> Pollution/Hostile retreat -> Safe standby
 *    - Depth 1 (`lowPowerStandbyMachine`): Pause EU recipes -> Monitor Battery Buffers / Turbines -> Resume
 */
function buildGTNHStateMachine({
  bot,
  navigator,
  craftingEngine,
  multiblockBuilder,
  hazardMonitor,
  options = {}
}) {
  const blackboard = {
    currentEra: 'STONE_AGE',
    activeQuest: null,
    activeTaskIndex: 0,
    activeCraftingPlan: null,
    pendingRawMaterials: [],
    activeBlueprintId: null,
    multiblockAnchor: options.defaultMultiblockAnchor || { x: 100, y: 64, z: 100 },
    pausedForSubcraft: false,
    inventoryNeedsSorting: false,
    modpackCompleted: false,
    stateHistory: []
  };

  const recordTransition = (label) => {
    blackboard.stateHistory.push({ label, timestamp: Date.now() });
    if (blackboard.stateHistory.length > 250) {
      blackboard.stateHistory.shift();
    }
  };

  // =========================================================================
  // DEPTH 2 — MICRO EXECUTION MACHINE 1: Ore & Raw Material Mining Loop
  // =========================================================================
  const locateOreState = new GTNHBehaviorState('micro_mine_locate_vein', {
    onEnter: async (self) => {
      const nextRaw = blackboard.pendingRawMaterials[0];
      if (!nextRaw) {
        self.done = true;
        return;
      }
      self.targetRaw = nextRaw;
      self.done = true;
    }
  });

  const pathfindToOreState = new GTNHBehaviorState('micro_mine_pathfind', {
    onEnter: async (self) => {
      const raw = locateOreState.targetRaw;
      if (raw && bot?.findBlock && navigator) {
        const shortName = raw.itemId.split(':')[1] || '';
        const blkType = bot.registry?.blocksByName?.[shortName]?.id;
        if (blkType !== undefined) {
          const found = bot.findBlock({ matching: blkType, maxDistance: 48 });
          if (found) {
            self.targetBlock = found;
            await navigator.gotoBlockAdjacent(found.position, 15000);
          }
        }
      }
      self.done = true;
    }
  });

  const excavateOreState = new GTNHBehaviorState('micro_mine_excavate', {
    onEnter: async (self) => {
      const targetBlock = pathfindToOreState.targetBlock;
      if (targetBlock && typeof bot?.dig === 'function') {
        await bot.dig(targetBlock);
      }
      // Pop mined requirement from pending queue
      blackboard.pendingRawMaterials.shift();
      self.done = true;
    }
  });

  const mineExit = new BehaviorIdle();
  mineExit.stateName = 'micro_mine_exit';

  const miningMicroMachine = new NestedStateMachine(
    [
      new StateTransition({
        parent: locateOreState,
        child: pathfindToOreState,
        name: 'vein_located',
        shouldTransition: () => locateOreState.done
      }),
      new StateTransition({
        parent: pathfindToOreState,
        child: excavateOreState,
        name: 'arrived_at_vein',
        shouldTransition: () => pathfindToOreState.done
      }),
      new StateTransition({
        parent: excavateOreState,
        child: mineExit,
        name: 'excavation_finished',
        shouldTransition: () => excavateOreState.done
      })
    ],
    locateOreState,
    mineExit
  );
  miningMicroMachine.stateName = 'MiningMicroMachine';

  // =========================================================================
  // DEPTH 2 — MICRO EXECUTION MACHINE 2: DAG Crafting & GT Machine GUI Loop
  // =========================================================================
  const withdrawWarehouseState = new GTNHBehaviorState('micro_craft_withdraw_stock', {
    onEnter: async (self) => {
      const plan = blackboard.activeCraftingPlan;
      if (plan && Array.isArray(plan.warehouseWithdrawals)) {
        for (const w of plan.warehouseWithdrawals) {
          for (const loc of w.locations || []) {
            if (navigator && bot?.pathfinder?.goto) {
              await navigator.gotoBlockAdjacent(loc.position, 15000);
            }
          }
        }
      }
      self.done = true;
    }
  });

  const executeMachineStepsState = new GTNHBehaviorState('micro_craft_execute_steps', {
    onEnter: async (self) => {
      const plan = blackboard.activeCraftingPlan;
      if (plan && Array.isArray(plan.steps)) {
        for (const step of plan.steps) {
          const verdict = hazardMonitor
            ? hazardMonitor.canExecuteRecipeStep(step)
            : { allowed: true };
          if (!verdict.allowed) {
            self.done = true;
            return;
          }
          if (options.executeLiveContainerPackets) {
            await craftingEngine.containerController.executeMachineStep(step, {
              hazardMonitor
            });
          }
        }
      }
      blackboard.activeCraftingPlan = null;
      self.done = true;
    }
  });

  const craftExit = new BehaviorIdle();
  craftExit.stateName = 'micro_craft_exit';

  const craftingMicroMachine = new NestedStateMachine(
    [
      new StateTransition({
        parent: withdrawWarehouseState,
        child: executeMachineStepsState,
        name: 'inputs_staged',
        shouldTransition: () => withdrawWarehouseState.done
      }),
      new StateTransition({
        parent: executeMachineStepsState,
        child: craftExit,
        name: 'steps_executed',
        shouldTransition: () => executeMachineStepsState.done
      })
    ],
    withdrawWarehouseState,
    craftExit
  );
  craftingMicroMachine.stateName = 'CraftingMicroMachine';

  // =========================================================================
  // DEPTH 2 — MICRO EXECUTION MACHINE 3: 3D Blueprint Multiblock Construction
  // =========================================================================
  const scanMultiblockState = new GTNHBehaviorState('micro_multiblock_scan', {
    onEnter: async (self) => {
      self.projection = multiblockBuilder.projectToWorld(
        blackboard.activeBlueprintId,
        blackboard.multiblockAnchor,
        'NORTH'
      );
      self.done = true;
    }
  });

  const buildMultiblockState = new GTNHBehaviorState('micro_multiblock_place_blocks', {
    onEnter: async (self) => {
      const res = await multiblockBuilder.executeBuild(
        blackboard.activeBlueprintId,
        blackboard.multiblockAnchor,
        { facing: 'NORTH' }
      );
      if (res.status === 'PAUSED_MISSING_MATERIALS' && res.craftJobs?.length > 0) {
        blackboard.pausedForSubcraft = true;
        blackboard.activeCraftingPlan = res.craftJobs[0].plan;
      } else {
        blackboard.pausedForSubcraft = false;
        blackboard.activeBlueprintId = null;
      }
      self.done = true;
    }
  });

  const multiblockExit = new BehaviorIdle();
  multiblockExit.stateName = 'micro_multiblock_exit';

  const multiblockMicroMachine = new NestedStateMachine(
    [
      new StateTransition({
        parent: scanMultiblockState,
        child: buildMultiblockState,
        name: 'footprint_scanned',
        shouldTransition: () => scanMultiblockState.done
      }),
      new StateTransition({
        parent: buildMultiblockState,
        child: multiblockExit,
        name: 'build_pass_complete',
        shouldTransition: () => buildMultiblockState.done
      })
    ],
    scanMultiblockState,
    multiblockExit
  );
  multiblockMicroMachine.stateName = 'MultiblockMicroMachine';

  // =========================================================================
  // DEPTH 2 — MICRO EXECUTION MACHINE 4: Warehouse Chest Sorting Loop
  // =========================================================================
  const consolidateInventoryState = new GTNHBehaviorState('micro_sort_consolidate', {
    onEnter: async (self) => {
      if (bot?.inventory?.items && craftingEngine?.warehouse) {
        for (const container of craftingEngine.warehouse.containers.values()) {
          if (navigator && bot?.pathfinder?.goto) {
            await navigator.gotoBlockAdjacent(container.position, 10000);
          }
          break;
        }
      }
      blackboard.inventoryNeedsSorting = false;
      self.done = true;
    }
  });

  const sortExit = new BehaviorIdle();
  sortExit.stateName = 'micro_sort_exit';

  const sortingMicroMachine = new NestedStateMachine(
    [
      new StateTransition({
        parent: consolidateInventoryState,
        child: sortExit,
        name: 'sorted_chests',
        shouldTransition: () => consolidateInventoryState.done
      })
    ],
    consolidateInventoryState,
    sortExit
  );
  sortingMicroMachine.stateName = 'WarehouseSortingMicroMachine';

  // =========================================================================
  // DEPTH 1 — MACRO GTNH ERA & QUEST PROGRESSION MACHINE
  // =========================================================================
  const evaluateQuestState = new GTNHBehaviorState('macro_evaluate_quest_frontier', {
    onEnter: (self) => {
      const available = craftingEngine.getAvailableQuests();
      if (available.length === 0) {
        blackboard.activeQuest = null;
        blackboard.modpackCompleted = craftingEngine.questsById.size > 0;
        self.done = true;
        return;
      }

      const nextQuest = available[0];
      blackboard.activeQuest = nextQuest;
      blackboard.currentEra = nextQuest.era || blackboard.currentEra;

      const task = (nextQuest.tasks || [])[blackboard.activeTaskIndex] || nextQuest.tasks?.[0];
      if (!task) {
        self.done = true;
        return;
      }

      if (task.type === 'multiblock' && task.blueprintId) {
        if (!multiblockBuilder.blueprints.has(task.blueprintId) && task.blueprintPath) {
          multiblockBuilder.loadBlueprintFromFile(task.blueprintPath);
        }
        blackboard.activeBlueprintId = task.blueprintId;
      } else if (Array.isArray(task.requiredItems) && task.requiredItems.length > 0) {
        const targetReq = task.requiredItems[0];
        const plan = craftingEngine.resolveCraftingPlan(targetReq.itemId, targetReq.count, {
          bot
        });
        blackboard.activeCraftingPlan = plan;

        // Check if raw materials must be mined before crafting
        const combined = craftingEngine.warehouse.getCombinedStock(bot);
        const missingRaws = [];
        for (const [rawId, neededQty] of Object.entries(plan.rawMaterials || {})) {
          const have = combined.get(rawId) || 0;
          if (have < neededQty) {
            missingRaws.push({ itemId: rawId, count: neededQty - have });
          }
        }
        blackboard.pendingRawMaterials = missingRaws;
      }

      self.done = true;
    }
  });

  const advanceQuestState = new GTNHBehaviorState('macro_advance_quest_stage', {
    onEnter: (self) => {
      if (blackboard.activeQuest && options.autoMarkSimulatedQuests) {
        craftingEngine.markQuestCompleted(blackboard.activeQuest.questId);
        blackboard.activeQuest = null;
        blackboard.activeTaskIndex = 0;
      }
      self.done = true;
    }
  });

  const victoryState = new BehaviorIdle();
  victoryState.stateName = 'macro_gtnh_stargate_victory';

  const macroProgressionMachine = new NestedStateMachine(
    [
      new StateTransition({
        parent: evaluateQuestState,
        child: victoryState,
        name: 'all_quests_complete',
        shouldTransition: () => evaluateQuestState.done && blackboard.modpackCompleted,
        onTransition: () => recordTransition('macro -> victory')
      }),
      new StateTransition({
        parent: evaluateQuestState,
        child: sortingMicroMachine,
        name: 'dispatch_warehouse_sort',
        shouldTransition: () => evaluateQuestState.done && blackboard.inventoryNeedsSorting,
        onTransition: () => recordTransition('macro -> sortingMicroMachine')
      }),
      new StateTransition({
        parent: evaluateQuestState,
        child: miningMicroMachine,
        name: 'dispatch_ore_mining',
        shouldTransition: () =>
          evaluateQuestState.done && blackboard.pendingRawMaterials.length > 0,
        onTransition: () => recordTransition('macro -> miningMicroMachine')
      }),
      new StateTransition({
        parent: evaluateQuestState,
        child: multiblockMicroMachine,
        name: 'dispatch_multiblock_builder',
        shouldTransition: () =>
          evaluateQuestState.done && Boolean(blackboard.activeBlueprintId),
        onTransition: () => recordTransition('macro -> multiblockMicroMachine')
      }),
      new StateTransition({
        parent: evaluateQuestState,
        child: craftingMicroMachine,
        name: 'dispatch_dag_crafting',
        shouldTransition: () =>
          evaluateQuestState.done &&
          blackboard.pendingRawMaterials.length === 0 &&
          Boolean(blackboard.activeCraftingPlan),
        onTransition: () => recordTransition('macro -> craftingMicroMachine')
      }),
      new StateTransition({
        parent: miningMicroMachine,
        child: craftingMicroMachine,
        name: 'mining_to_crafting',
        shouldTransition: () =>
          miningMicroMachine.isFinished() && Boolean(blackboard.activeCraftingPlan),
        onTransition: () => recordTransition('miningMicroMachine -> craftingMicroMachine')
      }),
      new StateTransition({
        parent: miningMicroMachine,
        child: evaluateQuestState,
        name: 'mining_to_evaluate',
        shouldTransition: () =>
          miningMicroMachine.isFinished() && !blackboard.activeCraftingPlan,
        onTransition: () => recordTransition('miningMicroMachine -> evaluateQuestState')
      }),
      new StateTransition({
        parent: multiblockMicroMachine,
        child: craftingMicroMachine,
        name: 'multiblock_missing_hatch_to_craft',
        shouldTransition: () =>
          multiblockMicroMachine.isFinished() && blackboard.pausedForSubcraft,
        onTransition: () =>
          recordTransition('multiblockMicroMachine -> craftingMicroMachine (missing part)')
      }),
      new StateTransition({
        parent: multiblockMicroMachine,
        child: advanceQuestState,
        name: 'multiblock_completed',
        shouldTransition: () =>
          multiblockMicroMachine.isFinished() && !blackboard.pausedForSubcraft,
        onTransition: () => recordTransition('multiblockMicroMachine -> advanceQuestState')
      }),
      new StateTransition({
        parent: craftingMicroMachine,
        child: multiblockMicroMachine,
        name: 'subcraft_resume_multiblock',
        shouldTransition: () =>
          craftingMicroMachine.isFinished() &&
          blackboard.pausedForSubcraft &&
          Boolean(blackboard.activeBlueprintId),
        onTransition: () => {
          blackboard.pausedForSubcraft = false;
          recordTransition('craftingMicroMachine -> multiblockMicroMachine (resume)');
        }
      }),
      new StateTransition({
        parent: craftingMicroMachine,
        child: advanceQuestState,
        name: 'crafting_completed',
        shouldTransition: () =>
          craftingMicroMachine.isFinished() && !blackboard.pausedForSubcraft,
        onTransition: () => recordTransition('craftingMicroMachine -> advanceQuestState')
      }),
      new StateTransition({
        parent: sortingMicroMachine,
        child: evaluateQuestState,
        name: 'sorting_done',
        shouldTransition: () => sortingMicroMachine.isFinished(),
        onTransition: () => recordTransition('sortingMicroMachine -> evaluateQuestState')
      }),
      new StateTransition({
        parent: advanceQuestState,
        child: evaluateQuestState,
        name: 'next_quest_loop',
        shouldTransition: () => advanceQuestState.done && Boolean(options.autoMarkSimulatedQuests),
        onTransition: () => recordTransition('advanceQuestState -> evaluateQuestState')
      })
    ],
    evaluateQuestState,
    victoryState
  );
  macroProgressionMachine.stateName = 'MacroProgressionMachine';

  // =========================================================================
  // DEPTH 1 — EMERGENCY HAZARD MITIGATION MACHINE (Rain / Pollution / Combat)
  // =========================================================================
  const mitigateThreatState = new GTNHBehaviorState('emergency_mitigate_hazard', {
    onEnter: async (self) => {
      if (navigator) navigator.stop();
      if (hazardMonitor) {
        if (hazardMonitor.isRaining || hazardMonitor.isThundering) {
          hazardMonitor.disableUnroofedMachines();
        }
        await hazardMonitor.mitigateImmediateHazard();
      }
      self.done = true;
    }
  });

  const emergencyClearedExit = new BehaviorIdle();
  emergencyClearedExit.stateName = 'emergency_cleared_exit';

  const emergencyHazardMachine = new NestedStateMachine(
    [
      new StateTransition({
        parent: mitigateThreatState,
        child: emergencyClearedExit,
        name: 'threat_neutralized',
        shouldTransition: () =>
          mitigateThreatState.done && (!hazardMonitor || !hazardMonitor.hasActiveEmergency())
      })
    ],
    mitigateThreatState,
    emergencyClearedExit
  );
  emergencyHazardMachine.stateName = 'EmergencyHazardMachine';

  // =========================================================================
  // DEPTH 1 — LOW-POWER EU BUFFER RECOVERY MACHINE
  // =========================================================================
  const awaitEuRechargeState = new GTNHBehaviorState('power_await_buffer_recharge', {
    onEnter: () => {
      if (navigator) navigator.stop();
    },
    onTick: (self) => {
      if (!hazardMonitor || !hazardMonitor.lowPowerHalted) {
        self.done = true;
      }
    }
  });

  const powerRestoredExit = new BehaviorIdle();
  powerRestoredExit.stateName = 'power_restored_exit';

  const lowPowerStandbyMachine = new NestedStateMachine(
    [
      new StateTransition({
        parent: awaitEuRechargeState,
        child: powerRestoredExit,
        name: 'eu_above_hysteresis',
        shouldTransition: () => !hazardMonitor || !hazardMonitor.lowPowerHalted
      })
    ],
    awaitEuRechargeState,
    powerRestoredExit
  );
  lowPowerStandbyMachine.stateName = 'LowPowerStandbyMachine';

  // =========================================================================
  // DEPTH 0 — ROOT PREEMPTION STATE MACHINE
  // =========================================================================
  const rootMachine = new NestedStateMachine(
    [
      new StateTransition({
        parent: macroProgressionMachine,
        child: emergencyHazardMachine,
        name: 'preempt_hazard_emergency',
        shouldTransition: () => Boolean(hazardMonitor && hazardMonitor.hasActiveEmergency()),
        onTransition: () => recordTransition('PREEMPT -> EmergencyHazardMachine')
      }),
      new StateTransition({
        parent: emergencyHazardMachine,
        child: macroProgressionMachine,
        name: 'resume_from_hazard',
        shouldTransition: () =>
          emergencyHazardMachine.isFinished() &&
          (!hazardMonitor || !hazardMonitor.hasActiveEmergency()),
        onTransition: () => recordTransition('RESUME -> MacroProgressionMachine')
      }),
      new StateTransition({
        parent: macroProgressionMachine,
        child: lowPowerStandbyMachine,
        name: 'preempt_low_power_eu',
        shouldTransition: () =>
          Boolean(hazardMonitor && hazardMonitor.lowPowerHalted && !hazardMonitor.hasActiveEmergency()),
        onTransition: () => recordTransition('PREEMPT -> LowPowerStandbyMachine')
      }),
      new StateTransition({
        parent: lowPowerStandbyMachine,
        child: macroProgressionMachine,
        name: 'resume_from_low_power',
        shouldTransition: () =>
          lowPowerStandbyMachine.isFinished() && (!hazardMonitor || !hazardMonitor.lowPowerHalted),
        onTransition: () => recordTransition('RESUME -> MacroProgressionMachine')
      })
    ],
    macroProgressionMachine
  );
  rootMachine.stateName = 'RootGTNHStateMachine';

  const botStateMachine = new BotStateMachine(bot, rootMachine);

  // Compatibility bridge: mineflayer-statemachine@1.7.0 binds legacy 'physicTick',
  // whereas modern Mineflayer 4.x standardizes on 'physicsTick' (emitting both in 4.39).
  // Deduplicate per tick turn so rootMachine.update() executes cleanly on 'physicsTick' too.
  let updatedThisTurn = false;
  const origUpdate = botStateMachine.update.bind(botStateMachine);
  botStateMachine.update = () => {
    if (updatedThisTurn) return;
    updatedThisTurn = true;
    setImmediate(() => {
      updatedThisTurn = false;
    });
    origUpdate();
  };
  if (typeof bot?.on === 'function') {
    bot.on('physicsTick', () => botStateMachine.update());
  }

  return {
    botStateMachine,
    rootMachine,
    macroProgressionMachine,
    emergencyHazardMachine,
    lowPowerStandbyMachine,
    microMachines: {
      miningMicroMachine,
      craftingMicroMachine,
      multiblockMicroMachine,
      sortingMicroMachine
    },
    blackboard
  };
}

module.exports = {
  GTNHBehaviorState,
  buildGTNHStateMachine
};
