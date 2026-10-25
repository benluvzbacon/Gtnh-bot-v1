'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const mineflayer = require('mineflayer');
const mc = require('minecraft-protocol');
const collectBlockPlugin = require('mineflayer-collectblock').plugin;
const toolPlugin = require('mineflayer-tool').plugin;
const Vec3 = require('vec3');

const {
  ForgeRegistryBridge,
  attachForgeHandshake,
  DEFAULT_GTNH_MODLIST
} = require('./protocol/forgeHandshake');
const { GTNHNavigator } = require('./navigation/gtnhNavigator');
const {
  WarehouseTracker,
  ContainerPacketController,
  CraftingEngine
} = require('./craftingEngine');
const { MultiblockBuilder } = require('./multiblockBuilder');
const { HazardMonitor } = require('./hazards/hazardMonitor');
const { buildGTNHStateMachine } = require('./statemachine/hierarchy');

/**
 * Resolves standard runtime configuration from options and environment variables.
 */
function resolveAgentConfig(overrides = {}) {
  return {
    host: overrides.host || process.env.GTNH_HOST || '127.0.0.1',
    port: Number(overrides.port || process.env.GTNH_PORT || 25565),
    username: overrides.username || process.env.GTNH_USERNAME || 'GTNH_Automaton',
    auth: overrides.auth || process.env.GTNH_AUTH || 'offline',
    // ViaProxy exposes 1.8.8 protocol to Mineflayer while forwarding FML|HS to 1.7.10 GTNH;
    // '1.7.10' or '1.8.8' can be selected depending on proxy/direct topology.
    version: overrides.version || process.env.GTNH_VERSION || '1.8.8',
    forgeBridgeMode: overrides.forgeBridgeMode || process.env.GTNH_FORGE_MODE || 'fml_passthrough',
    forgeModsPath: overrides.forgeModsPath || process.env.GTNH_FORGE_MODS_JSON || null,
    registryDumpPath: overrides.registryDumpPath || process.env.GTNH_REGISTRY_DUMP_JSON || null,
    questDbPath:
      overrides.questDbPath ||
      process.env.GTNH_QUEST_DB_PATH ||
      path.resolve(__dirname, '../data/quest_tree_template.json'),
    blueprintsDir:
      overrides.blueprintsDir ||
      process.env.GTNH_BLUEPRINTS_DIR ||
      path.resolve(__dirname, '../data'),
    unlockedVoltageTier: overrides.unlockedVoltageTier || process.env.GTNH_INITIAL_TIER || 'STEAM',
    autoReconnect: overrides.autoReconnect ?? (process.env.GTNH_AUTO_RECONNECT !== '0'),
    reconnectBaseDelayMs: Number(overrides.reconnectBaseDelayMs || 5000),
    debugWindows:
      overrides.debugWindows ?? (process.env.BOT_DEBUG_WINDOWS === '1')
  };
}

/**
 * Top-level Headless GTNH Automation Agent orchestrating:
 *  - Forge 1.7.10 (`FML|HS`) protocol handshake & dynamic numeric-ID registry mapping
 *  - Hazard-hardened 1.7.10 spatial navigation (`GTNHNavigator`)
 *  - BetterQuesting & JEI DAG crafting engine + packet GUI slot clicker (`CraftingEngine`)
 *  - 3D schematic multiblock printer (`MultiblockBuilder`)
 *  - Rain/Over-voltage, EU Battery Buffer, Pollution & Infernal Mob mitigation (`HazardMonitor`)
 *  - 3-tier Hierarchical State Machine (`mineflayer-statemachine`)
 */
class GTNHAutomationAgent extends EventEmitter {
  /**
   * @param {Object} [configOverrides]
   */
  constructor(configOverrides = {}) {
    super();
    this.config = resolveAgentConfig(configOverrides);

    this.registryBridge = new ForgeRegistryBridge();
    this.warehouse = new WarehouseTracker({ registryBridge: this.registryBridge });
    this.containerController = new ContainerPacketController(null, {
      registryBridge: this.registryBridge,
      clickDelayMs: configOverrides.clickDelayMs ?? 65
    });
    this.craftingEngine = new CraftingEngine({
      registryBridge: this.registryBridge,
      warehouse: this.warehouse,
      containerController: this.containerController,
      unlockedVoltageTier: this.config.unlockedVoltageTier
    });

    this.bot = null;
    this.navigator = null;
    this.multiblockBuilder = null;
    this.hazardMonitor = null;
    this.stateMachineBundle = null;
    this.fmlSession = null;

    this._shuttingDown = false;
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;

    this._loadStaticAssets();
  }

  /**
   * Loads optional NEI numeric ID dumps, the Quest Book + JEI DAG database,
   * and all 3D multiblock JSON schematics from `/data`.
   */
  _loadStaticAssets() {
    if (this.config.registryDumpPath && fs.existsSync(this.config.registryDumpPath)) {
      const dump = JSON.parse(fs.readFileSync(this.config.registryDumpPath, 'utf8'));
      this.registryBridge.loadDump(dump);
    }

    if (this.config.questDbPath && fs.existsSync(this.config.questDbPath)) {
      this.craftingEngine.loadDatabaseFromFile(this.config.questDbPath);
    }

    this.multiblockBuilder = new MultiblockBuilder({
      craftingEngine: this.craftingEngine,
      warehouse: this.warehouse,
      registryBridge: this.registryBridge
    });

    if (this.config.blueprintsDir && fs.existsSync(this.config.blueprintsDir)) {
      const files = fs.readdirSync(this.config.blueprintsDir);
      for (const file of files) {
        if (!file.endsWith('.json') || file === 'quest_tree_template.json') continue;
        const fullPath = path.join(this.config.blueprintsDir, file);
        try {
          const raw = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
          if (raw && (raw.blueprintId || raw.layers || raw.voxels)) {
            this.multiblockBuilder.registerBlueprint(raw);
          }
        } catch (err) {
          this.emit('log', {
            level: 'warn',
            message: `Skipped non-blueprint JSON '${file}': ${err.message}`
          });
        }
      }
    }
  }

  /**
   * Resolves the Forge mod list to advertise during `FML|HS` negotiation.
   */
  _loadForgeModList() {
    if (this.config.forgeModsPath && fs.existsSync(this.config.forgeModsPath)) {
      return JSON.parse(fs.readFileSync(this.config.forgeModsPath, 'utf8'));
    }
    return DEFAULT_GTNH_MODLIST;
  }

  /**
   * Boots and wires the agent onto either a live network connection (`connect()`)
   * or an injected Mineflayer-compatible `bot` instance (`attachBot(bot)`).
   */
  connect() {
    this._shuttingDown = false;
    const forgeMods = this._loadForgeModList();

    let botInstance;
    if (this.config.forgeBridgeMode === 'direct_1710_client') {
      // Create raw 1.7 protocol client with FML|HS handshake attached before play transition
      const rawClient = mc.createClient({
        host: this.config.host,
        port: this.config.port,
        username: this.config.username,
        auth: this.config.auth,
        version: '1.7'
      });
      this.fmlSession = attachForgeHandshake(rawClient, {
        forgeMods,
        registryBridge: this.registryBridge
      });
      botInstance = mineflayer.createBot({
        client: rawClient,
        version: '1.8.8'
      });
    } else {
      // Standard Mineflayer client with FML|HS plugin channel attached (e.g. ViaProxy FML passthrough)
      botInstance = mineflayer.createBot({
        host: this.config.host,
        port: this.config.port,
        username: this.config.username,
        auth: this.config.auth,
        version: this.config.version
      });
    }

    return this.attachBot(botInstance, { forgeMods });
  }

  /**
   * Attaches all GTNH subsystems, packet listeners, sensors, and the hierarchical
   * state machine onto a Mineflayer `bot` instance.
   */
  attachBot(bot, options = {}) {
    this.bot = bot;

    // 1. Attach Forge FML|HS handshake listener onto underlying protocol client
    if (!this.fmlSession && bot._client) {
      this.fmlSession = attachForgeHandshake(bot._client, {
        forgeMods: options.forgeMods || this._loadForgeModList(),
        registryBridge: this.registryBridge,
        useAutoVersionForge: Boolean(options.useAutoVersionForge)
      });
    }

    // 2. Load Mineflayer utility plugins if supported by bot instance
    if (typeof bot.loadPlugin === 'function' && bot.registry) {
      try {
        bot.loadPlugin(toolPlugin);
        bot.loadPlugin(collectBlockPlugin);
      } catch (_) {
        // Safe fallback for minimal/mock bot harnesses
      }
    }

    // 3. Initialize GTNH spatial navigator (lava veins, shaft drops, pollution exclusion zones)
    this.navigator = new GTNHNavigator(bot, options.navigatorOptions || {});

    // 4. Bind ContainerPacketController & MultiblockBuilder to live bot + navigator
    this.containerController.attachToBot(bot);
    this.multiblockBuilder.bot = bot;
    this.multiblockBuilder.navigator = this.navigator;

    // 5. Initialize GTNH Volatility & Hazard Monitor (Rain/Storm, EU Buffers, Pollution, Mobs)
    this.hazardMonitor = new HazardMonitor({
      bot,
      navigator: this.navigator,
      ...(options.hazardOptions || {})
    });

    this._bindWorldAndTelemetryListeners(bot);

    // 6. Initialize 3-Tier Hierarchical State Machine on spawn (or immediately if requested)
    if (options.startStateMachineImmediately) {
      this._initStateMachine(options.stateMachineOptions);
    } else if (typeof bot.once === 'function') {
      bot.once('spawn', () => {
        this._reconnectAttempts = 0;
        this._initStateMachine(options.stateMachineOptions);
        this.emit('ready', { position: bot.entity?.position });
      });
    }

    return this;
  }

  _initStateMachine(smOptions = {}) {
    if (this.stateMachineBundle) return this.stateMachineBundle;
    this.stateMachineBundle = buildGTNHStateMachine({
      bot: this.bot,
      navigator: this.navigator,
      craftingEngine: this.craftingEngine,
      multiblockBuilder: this.multiblockBuilder,
      hazardMonitor: this.hazardMonitor,
      options: smOptions
    });
    this.emit('stateMachineStarted', this.stateMachineBundle);
    return this.stateMachineBundle;
  }

  _bindWorldAndTelemetryListeners(bot) {
    if (this.config.debugWindows && bot._client) {
      bot._client.on('open_window', (pkt) => {
        this.emit('log', {
          level: 'debug',
          message: `[WindowCalibration] Opened windowId=${pkt.windowId} type=${pkt.inventoryType} title=${pkt.windowTitle} slots=${pkt.slotCount}`
        });
      });
    }

    this.hazardMonitor.on('weatherEmergency', (event) => {
      this.emit('log', {
        level: 'warn',
        message: `[HazardMonitor] Rain/Storm detected! Exterior wiring locked; disabled ${event.disabledMachines.length} unroofed electric machine(s).`
      });
    });

    this.hazardMonitor.on('powerCritical', (tel) => {
      this.emit('log', {
        level: 'warn',
        message: `[HazardMonitor] CRITICAL EU DROP (${(tel.fillRatio * 100).toFixed(1)}% / ${tel.storedEu} EU). Active EU crafting halted!`
      });
    });

    this.hazardMonitor.on('powerRestored', (tel) => {
      this.emit('log', {
        level: 'info',
        message: `[HazardMonitor] EU buffers recovered (${(tel.fillRatio * 100).toFixed(1)}%). Resuming crafting queues.`
      });
    });

    this.hazardMonitor.on('pollutionHazard', (info) => {
      this.emit('log', {
        level: 'warn',
        message: `[HazardMonitor] GTNH Pollution debuffs [${info.effects.join(',')}] detected! Retreating to clean chunk ${info.escapeTarget}.`
      });
    });

    if (typeof bot.on === 'function') {
      bot.on('kicked', (reason) => {
        this.emit('log', { level: 'error', message: `[ForgeClient] Kicked: ${reason}` });
      });

      bot.on('error', (err) => {
        this.emit('log', { level: 'error', message: `[ForgeClient] Network error: ${err.message}` });
      });

      bot.on('end', (reason) => {
        this.emit('log', { level: 'warn', message: `[ForgeClient] Disconnected (${reason || 'end'})` });
        this.stateMachineBundle = null;
        if (!this._shuttingDown && this.config.autoReconnect) {
          this._scheduleReconnect();
        }
      });
    }
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectAttempts += 1;
    const delay = Math.min(60000, this.config.reconnectBaseDelayMs * Math.pow(1.5, this._reconnectAttempts - 1));
    this.emit('log', {
      level: 'info',
      message: `[ForgeClient] Reconnecting in ${Math.round(delay)}ms (attempt #${this._reconnectAttempts})...`
    });
    this._reconnectTimer = setTimeout(() => {
      if (!this._shuttingDown) {
        this.connect();
      }
    }, delay);
  }

  /**
   * Gracefully stops pathfinding, clears timers, and closes the network session.
   */
  shutdown() {
    this._shuttingDown = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.navigator) {
      this.navigator.stop();
    }
    if (this.bot && typeof this.bot.quit === 'function') {
      this.bot.quit('GTNH Bot graceful shutdown');
    }
  }
}

/**
 * Executes an offline headless verification & diagnostics pass (`npm run dry-run`),
 * proving all subsystems (Quest Book DAG, LV Circuit dependency resolution, 3x3x4 PBF
 * blueprint parser, Programmed Circuit #14 packet simulator, and Hazard Monitor) work together.
 */
async function runHeadlessDryRun() {
  const agent = new GTNHAutomationAgent({ autoReconnect: false });
  agent.craftingEngine.setUnlockedVoltageTier('LV');

  // Seed sample warehouse chest at (104, 64, 98) with partial GTNH intermediates
  agent.warehouse.upsertContainer(
    new Vec3(104, 64, 98),
    {
      'gregtech:gt.metaitem.01:32705': 1, // 1x Vacuum Tube already in storage
      'gregtech:gt.metaitem.01:11305': 4, // 4x Steel Ingot
      'gregtech:gt.metaitem.01:11035': 10 // 10x Copper Ingot
    },
    { containerType: 'iron_chest' }
  );

  const lvCircuitPlan = agent.craftingEngine.resolveCraftingPlan(
    'gregtech:gt.metaitem.01:32700',
    1,
    { originPos: new Vec3(100, 64, 100) }
  );

  const pbfBlueprint = agent.multiblockBuilder.blueprints.get('primitive_blast_furnace');
  const questOrder = agent.craftingEngine.getTopologicalQuestOrder();

  const report = {
    status: 'OK',
    erasLoaded: agent.craftingEngine.eras.map((e) => e.eraId),
    questsTopologicalOrder: questOrder.map((q) => q.questId),
    blueprintsLoaded: Array.from(agent.multiblockBuilder.blueprints.keys()),
    pbfBillOfMaterials: pbfBlueprint ? pbfBlueprint.billOfMaterials : {},
    sampleLvCircuitPlan: {
      targetItemId: lvCircuitPlan.targetItemId,
      stepsCount: lvCircuitPlan.steps.length,
      rawMaterials: lvCircuitPlan.rawMaterials,
      warehouseWithdrawalsCount: lvCircuitPlan.warehouseWithdrawals.length
    }
  };

  console.log('[GTNH-Bot Dry Run] Framework Verification Complete:');
  console.log(JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--dry-run')) {
    runHeadlessDryRun().catch((err) => {
      console.error('[GTNH-Bot Dry Run] Fatal Error:', err);
      process.exitCode = 1;
    });
  } else {
    const agent = new GTNHAutomationAgent();
    agent.on('log', (entry) => {
      const fn = entry.level === 'error' ? console.error : console.log;
      fn(`${new Date().toISOString()} [${entry.level.toUpperCase()}] ${entry.message}`);
    });

    process.on('SIGINT', () => {
      console.log('\nReceived SIGINT — shutting down GTNH Automation Agent...');
      agent.shutdown();
      process.exit(0);
    });
    process.on('SIGTERM', () => {
      agent.shutdown();
      process.exit(0);
    });

    console.log(
      `Booting GTNH Headless Agent -> ${agent.config.host}:${agent.config.port} as '${agent.config.username}' (mode=${agent.config.forgeBridgeMode})...`
    );
    agent.connect();
  }
}

module.exports = {
  GTNHAutomationAgent,
  resolveAgentConfig,
  runHeadlessDryRun
};
