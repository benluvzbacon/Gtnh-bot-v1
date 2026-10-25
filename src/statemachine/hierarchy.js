'use strict';

const {
  BotStateMachine,
  NestedStateMachine,
  StateTransition,
  BehaviorIdle
} = require('mineflayer-statemachine');

/**
 * Maps raw item IDs (`minecraft:raw_iron`, `gtceu:raw_tin`, `gtceu:sticky_resin`, etc.)
 * to harvestable world block IDs in `bot.registry.blocksByName`.
 */
function resolveWorldBlockIdsForRawItem(bot, itemId) {
  if (!bot?.registry?.blocksByName) return [];
  const clean = String(itemId || '').toLowerCase();
  const shortName = clean.split(':')[1] || clean;
  const candidateNames = new Set([shortName]);

  if (shortName === 'raw_iron') {
    candidateNames.add('iron_ore');
    candidateNames.add('deepslate_iron_ore');
  } else if (shortName === 'raw_copper') {
    candidateNames.add('copper_ore');
    candidateNames.add('deepslate_copper_ore');
  } else if (shortName === 'raw_gold') {
    candidateNames.add('gold_ore');
    candidateNames.add('deepslate_gold_ore');
  } else if (shortName === 'coal' || shortName === 'raw_coal') {
    candidateNames.add('coal_ore');
    candidateNames.add('deepslate_coal_ore');
  } else if (shortName === 'redstone' || shortName === 'raw_redstone') {
    candidateNames.add('redstone_ore');
    candidateNames.add('deepslate_redstone_ore');
  } else if (shortName === 'clay_ball') {
    candidateNames.add('clay');
  } else if (shortName === 'cobblestone') {
    candidateNames.add('stone');
    candidateNames.add('cobblestone');
  } else if (shortName === 'sticky_resin') {
    candidateNames.add('gtceu:rubber_log');
    candidateNames.add('rubber_log');
  }

  const ids = [];
  for (const name of candidateNames) {
    const blk = bot.registry.blocksByName[name];
    if (blk && typeof blk.id === 'number') {
      ids.push(blk.id);
    }
  }
  return ids;
}

/**
 * Remaps `mineflayer-statemachine`'s legacy `'physicTick'` event subscription to
 * modern `'physicsTick'` BEFORE `new BotStateMachine(bot, root)` runs, completely
 * preventing Mineflayer `physics.js`'s `newListener` deprecation warning!
 */
function installPhysicTickDeprecationShim(bot) {
  if (!bot || bot._gtlPhysicTickShimmed) return;
  const remapEvent = (event) => (event === 'physicTick' ? 'physicsTick' : event);

  for (const method of ['on', 'addListener', 'once', 'removeListener', 'off']) {
    if (typeof bot[method] === 'function') {
      const orig = bot[method].bind(bot);
      bot[method] = (event, ...rest) => orig(remapEvent(event), ...rest);
    }
  }
  bot._gtlPhysicTickShimmed = true;
}

/**
 * Guards a `prismarine-windows` `Window` instance (`bot.inventory` or `bot.currentWindow`)
 * so ANY `once(window, 'updateSlot:0')` listener — including inside Mineflayer `inventory.js`'s
 * private lexical `clickWindow`, `putAway(0)`, `transfer`, and `craft.js` — resolves cleanly
 * within `slot0TimeoutMs` whenever a Minecraft `1.20.1` server omits `set_slot(0)` on `null -> null`
 * transitions, completely eliminating `Event updateSlot:0 did not fire within timeout of 20000ms`!
 */
function guardWindowSlot0Listeners(window, slot0TimeoutMs = 140) {
  if (!window || window._gtlSlot0Guarded || typeof window.emit !== 'function') return;
  const origOnce = typeof window.once === 'function' ? window.once.bind(window) : null;
  let inInternal = false;

  const armSlot0Fallback = (event) => {
    if (inInternal || event !== 'updateSlot:0') return;
    let settled = false;
    let timer = null;

    const onSettled = () => {
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    if (origOnce) {
      inInternal = true;
      try {
        origOnce('updateSlot:0', onSettled);
      } finally {
        inInternal = false;
      }
    }

    // If `slot 0` already held an item before the click (e.g. button -> plate -> slab -> pickaxe,
    // or taking the crafted result!), the 1.20.1 server WILL send `set_slot(0)` with the updated
    // `stateId` — allow up to 3x `slot0TimeoutMs` on low-end PCs so we never race ahead with a stale `stateId`!
    const effectiveWaitMs = window.slots?.[0] ? slot0TimeoutMs * 3 : slot0TimeoutMs;

    timer = setTimeout(() => {
      timer = null;
      if (settled) return;
      settled = true;
      if (typeof window.removeListener === 'function') {
        window.removeListener('updateSlot:0', onSettled);
      }
      const remaining =
        typeof window.listenerCount === 'function' ? window.listenerCount('updateSlot:0') : 1;
      if (remaining > 0) {
        const cur0 = window.slots?.[0] ?? null;
        window.emit('updateSlot:0', cur0, cur0);
      }
    }, effectiveWaitMs);
  };

  for (const method of ['addListener', 'on']) {
    if (typeof window[method] === 'function') {
      const orig = window[method].bind(window);
      window[method] = function wrappedSlot0Add(event, listener, ...rest) {
        const ret = orig(event, listener, ...rest);
        armSlot0Fallback(event);
        return ret;
      };
    }
  }

  window._gtlSlot0Guarded = true;
}

/**
 * Prevents two severe Mineflayer `1.20.1` `inventory.js` window-click stalls across BOTH public
 * `bot.clickWindow` AND internal `inventory.js` closures (`putAway`, `transfer`, `moveSlotItem`):
 *  1. Installs `guardWindowSlot0Listeners` on `bot.inventory` and every `bot.currentWindow`
 *     (including deferred `inject_allowed` / `open_window` / `windowOpen` hooks) so `promise_utils.once`
 *     never stalls for 20,000ms throwing `Event updateSlot:0 did not fire within timeout of 20000ms`.
 *  2. Clears `bot.lastDigTime` prior to window operations so hotbar slot clicks right after chopping
 *     or mining do not block for 500ms (`DIG_CLICK_TIMEOUT`).
 */
function installFastWindowClickShim(bot, options = {}) {
  if (!bot) return;
  const slot0TimeoutMs = options.slot0TimeoutMs ?? 140;

  const applyWindowAndMethodHooks = () => {
    if (bot.inventory) {
      guardWindowSlot0Listeners(bot.inventory, slot0TimeoutMs);
    }
    if (bot.currentWindow) {
      guardWindowSlot0Listeners(bot.currentWindow, slot0TimeoutMs);
    }

    for (const fnName of ['clickWindow', 'putAway', 'moveSlotItem', 'transfer', 'equip']) {
      if (typeof bot[fnName] === 'function' && !bot[fnName]._gtlWrapped) {
        const origFn = bot[fnName].bind(bot);
        const wrapped = async (...args) => {
          if (bot.lastDigTime != null) {
            bot.lastDigTime = null;
          }
          if (bot.inventory) guardWindowSlot0Listeners(bot.inventory, slot0TimeoutMs);
          if (bot.currentWindow) guardWindowSlot0Listeners(bot.currentWindow, slot0TimeoutMs);
          return origFn(...args);
        };
        wrapped._gtlWrapped = true;
        bot[fnName] = wrapped;
      }
    }
  };

  applyWindowAndMethodHooks();

  if (!bot._gtlWindowLifecycleHooked && typeof bot.on === 'function') {
    bot._gtlWindowLifecycleHooked = true;
    bot.on('inject_allowed', applyWindowAndMethodHooks);
    bot.on('spawn', applyWindowAndMethodHooks);
    bot.on('windowOpen', (win) => {
      guardWindowSlot0Listeners(win, slot0TimeoutMs);
      applyWindowAndMethodHooks();
    });
    if (bot._client && typeof bot._client.on === 'function') {
      bot._client.on('open_window', () => {
        if (bot.currentWindow) {
          guardWindowSlot0Listeners(bot.currentWindow, slot0TimeoutMs);
        }
        setImmediate(() => {
          if (bot.currentWindow) {
            guardWindowSlot0Listeners(bot.currentWindow, slot0TimeoutMs);
          }
        });
      });
    }
  }
}

/**
 * Helper base class implementing `mineflayer-statemachine`'s `StateBehavior` contract
 * with async-safe tick execution guards so async Mineflayer tasks never overlap across ticks.
 */
class GTNHBehaviorState {
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
 * separating GregTech Leisure (GTL) Macro FTB Quests progression from Micro execution loops
 * and Hazard/Power Survival preemption.
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
    currentEra: 'STEAM_ULV',
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
        const blkIds = resolveWorldBlockIdsForRawItem(bot, raw.itemId);
        if (blkIds.length > 0) {
          const found = bot.findBlock({
            matching: blkIds.length === 1 ? blkIds[0] : blkIds,
            maxDistance: 48
          });
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
  // DEPTH 2 — MICRO EXECUTION MACHINE 2: DAG Crafting & GTCEu Machine GUI Loop
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
  // DEPTH 1 — MACRO GTL ERA & FTB QUESTS PROGRESSION MACHINE
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
      if (!blackboard.activeQuest || blackboard.activeQuest.questId !== nextQuest.questId) {
        blackboard.activeQuest = nextQuest;
        blackboard.activeTaskIndex = 0;
      }
      blackboard.currentEra = nextQuest.era || blackboard.currentEra;

      const tasks = nextQuest.tasks || [];
      const task = tasks[blackboard.activeTaskIndex] || tasks[0];
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
        const totalTasks = (blackboard.activeQuest.tasks || []).length;
        if (blackboard.activeTaskIndex + 1 < totalTasks) {
          blackboard.activeTaskIndex += 1;
        } else {
          craftingEngine.markQuestCompleted(blackboard.activeQuest.questId);
          blackboard.activeQuest = null;
          blackboard.activeTaskIndex = 0;
        }
      }
      self.done = true;
    }
  });

  const victoryState = new BehaviorIdle();
  victoryState.stateName = 'macro_gtl_max_tier_victory';

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
  // DEPTH 1 — EMERGENCY HAZARD MITIGATION MACHINE (Rain / Toxic / Combat)
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
  rootMachine.stateName = 'RootGTLStateMachine';

  // Install 'physicTick' -> 'physicsTick' shim BEFORE BotStateMachine subscribes so
  // Mineflayer's physics.js `newListener` hook never logs a deprecation warning!
  installPhysicTickDeprecationShim(bot);
  const botStateMachine = new BotStateMachine(bot, rootMachine);

  // Deduplicate ticks within a single event-loop turn
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
  GTLBehaviorState: GTNHBehaviorState,
  installPhysicTickDeprecationShim,
  installFastWindowClickShim,
  guardWindowSlot0Listeners,
  resolveWorldBlockIdsForRawItem,
  buildGTNHStateMachine,
  buildGTLStateMachine: buildGTNHStateMachine
};
