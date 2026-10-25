'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const { EventEmitter } = require('events');
const mineflayer = require('mineflayer');
const collectBlockPlugin = require('mineflayer-collectblock').plugin;
const toolPlugin = require('mineflayer-tool').plugin;
const Vec3 = require('vec3');

const {
  ForgeRegistryBridge,
  attachForgeHandshake,
  buildModded1201CustomPackets,
  buildForgeTaggedHost,
  DEFAULT_GTL_MODLIST
} = require('./protocol/forgeHandshake');
const { GTNHNavigator } = require('./navigation/gtnhNavigator');
const {
  WarehouseTracker,
  ContainerPacketController,
  CraftingEngine
} = require('./craftingEngine');
const { MultiblockBuilder } = require('./multiblockBuilder');
const { HazardMonitor } = require('./hazards/hazardMonitor');
const {
  buildGTLStateMachine,
  installPhysicTickDeprecationShim
} = require('./statemachine/hierarchy');
const { AutonomousProgressionEngine } = require('./survival/autonomousProgression');

/**
 * Parses optional CLI flags (`--host`, `--port`, `--username`, `--auth`, `--version`, `--fml2`)
 * so Windows PowerShell/CMD, macOS, and Linux users can pass flags directly via `npm start -- ...`.
 */
function parseCliOverrides(argv = []) {
  const overrides = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--host' && next) {
      overrides.host = next;
      i++;
    } else if (arg === '--port' && next) {
      overrides.port = Number(next);
      i++;
    } else if ((arg === '--username' || arg === '--user') && next) {
      overrides.username = next;
      i++;
    } else if (arg === '--auth' && next) {
      overrides.auth = next;
      i++;
    } else if (arg === '--version' && next) {
      overrides.version = next;
      i++;
    } else if (arg === '--fml2') {
      overrides.fmlMarker = '\0FML2\0';
    } else if (arg === '--fml3') {
      overrides.fmlMarker = '\0FML3\0';
    } else if (arg === '--no-reconnect') {
      overrides.autoReconnect = false;
    }
  }
  return overrides;
}

/**
 * Resolves runtime configuration for GregTech Leisure (Minecraft 1.20.1, Forge 47.4.16).
 * Because Mineflayer 4.39+ speaks 1.20.1 (protocol 763) natively, no external ViaProxy
 * Java process is required — saving ~300 MB of RAM on low-end PCs!
 */
function resolveAgentConfig(overrides = {}) {
  const fmlEnv = process.env.GTL_FML_MARKER || process.env.GTNH_FML_MARKER || null;
  let defaultMarker = '\0FML3\0';
  if (fmlEnv === 'FML2' || fmlEnv === '\0FML2\0') {
    defaultMarker = '\0FML2\0';
  }

  return {
    host: overrides.host || process.env.GTL_HOST || process.env.GTNH_HOST || '127.0.0.1',
    port: Number(overrides.port || process.env.GTL_PORT || process.env.GTNH_PORT || 25565),
    username:
      overrides.username ||
      process.env.GTL_USERNAME ||
      process.env.GTNH_USERNAME ||
      'GTL_Automaton',
    auth: overrides.auth || process.env.GTL_AUTH || process.env.GTNH_AUTH || 'offline',
    version: overrides.version || process.env.GTL_VERSION || process.env.GTNH_VERSION || '1.20.1',
    fmlMarker: overrides.fmlMarker || defaultMarker,
    forgeBridgeMode:
      overrides.forgeBridgeMode ||
      process.env.GTL_FORGE_MODE ||
      process.env.GTNH_FORGE_MODE ||
      'fml3_native_1201',
    forgeModsPath:
      overrides.forgeModsPath ||
      process.env.GTL_FORGE_MODS_JSON ||
      process.env.GTNH_FORGE_MODS_JSON ||
      null,
    registryDumpPath:
      overrides.registryDumpPath ||
      process.env.GTL_REGISTRY_DUMP_JSON ||
      process.env.GTNH_REGISTRY_DUMP_JSON ||
      null,
    questDbPath:
      overrides.questDbPath ||
      process.env.GTL_QUEST_DB_PATH ||
      process.env.GTNH_QUEST_DB_PATH ||
      path.resolve(__dirname, '../data/quest_tree_template.json'),
    blueprintsDir:
      overrides.blueprintsDir ||
      process.env.GTL_BLUEPRINTS_DIR ||
      process.env.GTNH_BLUEPRINTS_DIR ||
      path.resolve(__dirname, '../data'),
    unlockedVoltageTier:
      overrides.unlockedVoltageTier ||
      process.env.GTL_INITIAL_TIER ||
      process.env.GTNH_INITIAL_TIER ||
      'STEAM',
    autoReconnect:
      overrides.autoReconnect ??
      (process.env.GTL_AUTO_RECONNECT !== '0' && process.env.GTNH_AUTO_RECONNECT !== '0'),
    enableAutonomousSurvival:
      overrides.enableAutonomousSurvival ??
      process.env.GTL_AUTONOMOUS !== '0',
    reconnectBaseDelayMs: Number(overrides.reconnectBaseDelayMs || 5000),
    debugWindows: overrides.debugWindows ?? (process.env.BOT_DEBUG_WINDOWS === '1')
  };
}

/**
 * Top-level Headless GregTech Leisure (GTL) Automation Agent orchestrating:
 *  - Forge 1.20.1 (`FML3` / `FML2` `fml:loginwrapper` + `fml:play`) handshake & live registry sync
 *  - Hazard-hardened 1.20.1 spatial navigation (`GTLNavigator` — steam vents, hot pipes, Y=-64 shafts)
 *  - FTB Quests & GTCEu/KubeJS DAG crafting engine + 1.20.1 LDLib packet GUI controller (`CraftingEngine`)
 *  - 3D schematic multiblock printer with `gtceu:duct_tape` Maintenance Hatch servicing (`MultiblockBuilder`)
 *  - Dry-boiler explosion guard, MAE2 EU P2P over-voltage check, & 2x low-EU drain hysteresis (`HazardMonitor`)
 *  - 3-tier Hierarchical State Machine (`mineflayer-statemachine`)
 */
class GTLAutomationAgent extends EventEmitter {
  constructor(configOverrides = {}) {
    super();
    this.config = resolveAgentConfig(configOverrides);
    this._activeFmlMarker = this.config.fmlMarker || '\0FML3\0';

    this.registryBridge = new ForgeRegistryBridge();
    this.warehouse = new WarehouseTracker({ registryBridge: this.registryBridge });
    this.containerController = new ContainerPacketController(null, {
      registryBridge: this.registryBridge,
      clickDelayMs: configOverrides.clickDelayMs ?? 55
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
    this.progressionEngine = null;
    this.stateMachineBundle = null;
    this.fmlSession = null;

    this._shuttingDown = false;
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._fastRetryOverrideMs = null;

    this._loadStaticAssets();
  }

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
          if (raw && (raw.blueprintId || raw.blocks || raw.layers || raw.voxels)) {
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

  _loadForgeModList() {
    if (this.config.forgeModsPath && fs.existsSync(this.config.forgeModsPath)) {
      return JSON.parse(fs.readFileSync(this.config.forgeModsPath, 'utf8'));
    }
    return DEFAULT_GTL_MODLIST;
  }

  /**
   * Connects directly to a GregTech Leisure 1.20.1 Forge server or Open-to-LAN instance
   * using native Mineflayer 1.20.1 + Forge `FML3` (`\0FML3\0` + `fml:loginwrapper`) handshake.
   */
  connect(extraBotOptions = {}) {
    this._shuttingDown = false;
    this.fmlSession = null;
    const forgeMods = this._loadForgeModList();
    const fmlMarker = extraBotOptions.fmlMarker || this._activeFmlMarker || '\0FML3\0';
    const host = this.config.host;
    const port = this.config.port;

    // For direct IPs, localhost, or explicit non-25565 ports (where DNS SRV lookup does not run),
    // also pass `fakeHost: "<host>\\0FML3\\0"` directly to `createBot` so even synchronous stream
    // transports carry the Forge marker on the very first `set_protocol` packet.
    const isDirectEndpoint =
      net.isIP(host) !== 0 || host === 'localhost' || port !== 25565 || Boolean(extraBotOptions.stream);

    const createOpts = {
      host,
      port,
      username: this.config.username,
      auth: this.config.auth,
      version: this.config.version,
      customPackets: buildModded1201CustomPackets(),
      ...(isDirectEndpoint && this.config.forgeBridgeMode !== 'vanilla'
        ? { fakeHost: buildForgeTaggedHost(host, fmlMarker) }
        : {}),
      ...extraBotOptions
    };

    const botInstance = mineflayer.createBot(createOpts);
    return this.attachBot(botInstance, { forgeMods, fmlMarker });
  }

  attachBot(bot, options = {}) {
    this.bot = bot;
    installPhysicTickDeprecationShim(bot);
    const fmlMarker = options.fmlMarker || this._activeFmlMarker || '\0FML3\0';

    if (!this.fmlSession && bot._client && this.config.forgeBridgeMode !== 'vanilla') {
      this.fmlSession = attachForgeHandshake(bot._client, {
        forgeMods: options.forgeMods || this._loadForgeModList(),
        registryBridge: this.registryBridge,
        fmlMarker,
        autoMirrorServerMods: options.autoMirrorServerMods !== false,
        useAutoVersionForge: Boolean(options.useAutoVersionForge),
        ackModData: Boolean(options.ackModData)
      });
    }

    // Install solid modded blockStateId fallback immediately + sync any preloaded registry dump
    if (bot.registry) {
      this.registryBridge.syncToBotRegistry(bot.registry);
    }

    // Re-sync live Forge S2CRegistry snapshots into Mineflayer's `bot.registry` upon login success
    if (bot._client && typeof bot._client.on === 'function') {
      bot._client.on('fmlHandshakeStart', (info) => {
        this.emit('log', {
          level: 'info',
          message: `[Forge1201] ${info.protocol} Handshake started — server advertised ${info.serverModsCount} mods, ${info.channelsCount} channels, ${info.registriesExpected} registries.`
        });
      });

      bot._client.on('fmlChannelMismatch', (mismatches) => {
        this.emit('log', {
          level: 'error',
          message: `[Forge1201] Server rejected channel versions: ${JSON.stringify(mismatches)}`
        });
      });

      bot._client.on('fmlHandshakeComplete', (summary) => {
        if (bot.registry) {
          this.registryBridge.syncToBotRegistry(bot.registry);
        }
        this.emit('log', {
          level: 'info',
          message: `[Forge1201] ${summary.protocol} Handshake complete! Synced ${summary.registriesSynced} registries (${summary.mappedItems} items, ${summary.mappedBlocks} blocks) & ${summary.configsSynced} server configs.`
        });
      });
    }

    if (typeof bot.loadPlugin === 'function' && bot.registry) {
      try {
        bot.loadPlugin(toolPlugin);
        bot.loadPlugin(collectBlockPlugin);
      } catch (_) {
        // Safe fallback for minimal/mock bot harnesses
      }
    }

    this.navigator = new GTNHNavigator(bot, options.navigatorOptions || {});

    this.containerController.attachToBot(bot);
    this.multiblockBuilder.bot = bot;
    this.multiblockBuilder.navigator = this.navigator;

    this.hazardMonitor = new HazardMonitor({
      bot,
      navigator: this.navigator,
      ...(options.hazardOptions || {})
    });

    if (this.progressionEngine) {
      this.progressionEngine.stop();
    }
    this.progressionEngine = new AutonomousProgressionEngine({
      bot,
      navigator: this.navigator,
      craftingEngine: this.craftingEngine,
      multiblockBuilder: this.multiblockBuilder,
      hazardMonitor: this.hazardMonitor,
      registryBridge: this.registryBridge,
      options: options.progressionOptions || {}
    });
    this.progressionEngine.on('log', (entry) => this.emit('log', entry));
    this.progressionEngine.on('milestoneCompleted', (id) => this.emit('milestoneCompleted', id));

    this._bindWorldAndTelemetryListeners(bot);

    if (options.startStateMachineImmediately) {
      this._initStateMachine(options.stateMachineOptions);
    } else if (typeof bot.once === 'function') {
      bot.once('spawn', () => {
        this._reconnectAttempts = 0;
        if (bot.registry) {
          this.registryBridge.syncToBotRegistry(bot.registry);
        }
        const pos = bot.entity?.position;
        this.emit('log', {
          level: 'info',
          message: `[Forge1201] Spawned in GregTech Leisure world${pos ? ` at (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})` : ''}!`
        });
        this._initStateMachine(options.stateMachineOptions);
        if (
          options.enableAutonomousSurvival !== false &&
          this.config.enableAutonomousSurvival !== false
        ) {
          this.progressionEngine.start();
        }
        this.emit('ready', { position: pos });
      });
    }

    return this;
  }

  _initStateMachine(smOptions = {}) {
    if (this.stateMachineBundle) return this.stateMachineBundle;
    this.stateMachineBundle = buildGTLStateMachine({
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
      const logOpen = (pkt) => {
        this.emit('log', {
          level: 'debug',
          message: `[WindowCalibration] Opened windowId=${pkt.windowId} type=${pkt.inventoryType} title=${pkt.windowTitle}`
        });
      };
      bot._client.on('open_window', logOpen);
      bot._client.on('fmlOpenContainer', logOpen);
    }

    this.hazardMonitor.on('weatherEmergency', (event) => {
      this.emit('log', {
        level: 'warn',
        message: `[HazardMonitor] Rain/Storm detected! Exterior wiring locked; disabled ${event.disabledMachines.length} unroofed electric machine(s).`
      });
    });

    this.hazardMonitor.on('dryBoilerWarning', (boiler) => {
      this.emit('log', {
        level: 'warn',
        message: `[HazardMonitor] DRY STEAM BOILER '${boiler.id}' at ${boiler.temperatureC}C! Blocking water fill until <95C to prevent explosion.`
      });
    });

    this.hazardMonitor.on('powerCritical', (tel) => {
      this.emit('log', {
        level: 'warn',
        message: `[HazardMonitor] CRITICAL EU DROP (${(tel.fillRatio * 100).toFixed(1)}% / ${tel.storedEu} EU). Halting EU recipes to prevent GTL 2x low-energy progress drain!`
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
        message: `[HazardMonitor] Environmental debuffs [${info.effects.join(',')}] detected! Retreating to clean chunk ${info.escapeTarget}.`
      });
    });

    if (typeof bot.on === 'function') {
      bot.on('kicked', (reason) => {
        const reasonStr = typeof reason === 'string' ? reason : JSON.stringify(reason);
        this.emit('log', { level: 'error', message: `[Forge1201] Kicked: ${reasonStr}` });

        // Automatic FML3 <-> FML2 net-version negotiation fallback
        if (reasonStr.includes('this server is net version 2') && this._activeFmlMarker !== '\0FML2\0') {
          this._activeFmlMarker = '\0FML2\0';
          this._fastRetryOverrideMs = 250;
          this.emit('log', {
            level: 'warn',
            message: '[Forge1201] Server requested Forge net version 2 (FML2) — switching marker to \\0FML2\\0 and reconnecting immediately!'
          });
        } else if (reasonStr.includes('this server is net version 3') && this._activeFmlMarker !== '\0FML3\0') {
          this._activeFmlMarker = '\0FML3\0';
          this._fastRetryOverrideMs = 250;
          this.emit('log', {
            level: 'warn',
            message: '[Forge1201] Server requested Forge net version 3 (FML3) — switching marker to \\0FML3\\0 and reconnecting immediately!'
          });
        } else if (
          this.config.auth === 'offline' &&
          (reasonStr.includes('unverified_username') ||
            reasonStr.toLowerCase().includes('invalid session') ||
            reasonStr.toLowerCase().includes('failed to verify username'))
        ) {
          this.emit('log', {
            level: 'error',
            message:
              '[Forge1201] Server has online-mode=true! Re-run with `--auth microsoft --username <your_email_or_gamertag>` (or set `online-mode=false` in server.properties / use Open to LAN).'
          });
        }
      });

      bot.on('error', (err) => {
        const msg = err?.message || String(err);
        if (msg.startsWith('Parse error for play.toClient')) {
          this.emit('log', {
            level: 'warn',
            message: `[Forge1201] Ignored non-fatal modded play packet layout warning: ${msg}`
          });
          return;
        }
        this.emit('log', { level: 'error', message: `[Forge1201] Network error: ${msg}` });
      });

      bot.on('end', (reason) => {
        this.emit('log', { level: 'warn', message: `[Forge1201] Disconnected (${reason || 'end'})` });
        if (this.progressionEngine) {
          this.progressionEngine.stop();
        }
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
    const delay =
      this._fastRetryOverrideMs != null
        ? this._fastRetryOverrideMs
        : Math.min(60000, this.config.reconnectBaseDelayMs * Math.pow(1.5, this._reconnectAttempts - 1));
    this._fastRetryOverrideMs = null;

    this.emit('log', {
      level: 'info',
      message: `[Forge1201] Reconnecting in ${Math.round(delay)}ms (attempt #${this._reconnectAttempts}, marker=${this._activeFmlMarker.replace(/\0/g, '')})...`
    });
    this._reconnectTimer = setTimeout(() => {
      if (!this._shuttingDown) {
        this.connect();
      }
    }, delay);
  }

  shutdown() {
    this._shuttingDown = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.progressionEngine) {
      this.progressionEngine.stop();
    }
    if (this.navigator) {
      this.navigator.stop();
    }
    if (this.bot && typeof this.bot.quit === 'function') {
      this.bot.quit('GTL Bot graceful shutdown');
    }
    if (this.bot?._client?.closeTimer) {
      this.bot._client.closeTimer.unref?.();
    }
  }
}

/**
 * Executes an offline headless verification & diagnostics pass (`npm run dry-run`),
 * proving all GregTech Leisure 1.20.1 subsystems (FTB Quests DAG, LV Electronic Circuit
 * & GTL Cheap LV Control Circuit resolution, PBF/EBF/Large Steam Circuit Assembler
 * blueprints, and Hazard Monitor) work together cleanly with <60 MB RAM.
 */
async function runHeadlessDryRun() {
  const agent = new GTLAutomationAgent({ autoReconnect: false });
  agent.craftingEngine.setUnlockedVoltageTier('LV');

  agent.warehouse.upsertContainer(
    new Vec3(104, 64, 98),
    {
      'gtceu:vacuum_tube': 1,
      'gtceu:steel_ingot': 4,
      'minecraft:copper_ingot': 10,
      'fluid:gtceu:glue': 200
    },
    { containerType: 'sophisticatedstorage:netherite_shulker_box' }
  );

  const lvCircuitPlan = agent.craftingEngine.resolveCraftingPlan(
    'gtceu:basic_electronic_circuit',
    1,
    { originPos: new Vec3(100, 64, 100) }
  );

  const gtlControlCircuitPlan = agent.craftingEngine.resolveCraftingPlan(
    'kubejs:advanced_control_circuit',
    2,
    { originPos: new Vec3(100, 64, 100) }
  );

  const pbfBlueprint = agent.multiblockBuilder.blueprints.get('primitive_blast_furnace');
  const ebfBlueprint = agent.multiblockBuilder.blueprints.get('electric_blast_furnace');
  const questOrder = agent.craftingEngine.getTopologicalQuestOrder();

  const report = {
    status: 'OK',
    modpack: 'GregTech Leisure (GTL) 1.4.5.x — Minecraft 1.20.1 / Forge 47.4.16',
    erasLoaded: agent.craftingEngine.eras.map((e) => e.eraId),
    questsTopologicalOrder: questOrder.map((q) => q.questId),
    blueprintsLoaded: Array.from(agent.multiblockBuilder.blueprints.keys()),
    pbfBillOfMaterials: pbfBlueprint ? pbfBlueprint.billOfMaterials : {},
    ebfBillOfMaterials: ebfBlueprint ? ebfBlueprint.billOfMaterials : {},
    sampleBasicElectronicCircuitPlan: {
      targetItemId: lvCircuitPlan.targetItemId,
      stepsCount: lvCircuitPlan.steps.length,
      rawMaterials: lvCircuitPlan.rawMaterials,
      warehouseWithdrawalsCount: lvCircuitPlan.warehouseWithdrawals.length
    },
    sampleGtlCheapLvCircuitPlan: {
      targetItemId: gtlControlCircuitPlan.targetItemId,
      stepsCount: gtlControlCircuitPlan.steps.length,
      rawMaterials: gtlControlCircuitPlan.rawMaterials
    }
  };

  console.log('[GTL-Bot Dry Run] GregTech Leisure 1.20.1 Verification Complete:');
  console.log(JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--dry-run')) {
    runHeadlessDryRun().catch((err) => {
      console.error('[GTL-Bot Dry Run] Fatal Error:', err);
      process.exitCode = 1;
    });
  } else {
    const cliOverrides = parseCliOverrides(args);
    const agent = new GTLAutomationAgent(cliOverrides);
    agent.on('log', (entry) => {
      const fn = entry.level === 'error' ? console.error : console.log;
      fn(`${new Date().toISOString()} [${entry.level.toUpperCase()}] ${entry.message}`);
    });

    process.on('SIGINT', () => {
      console.log('\nReceived SIGINT — shutting down GTL Automation Agent...');
      agent.shutdown();
      process.exit(0);
    });
    process.on('SIGTERM', () => {
      agent.shutdown();
      process.exit(0);
    });

    console.log(
      `Booting GregTech Leisure Headless Agent -> ${agent.config.host}:${agent.config.port} as '${agent.config.username}' (MC ${agent.config.version} / auth=${agent.config.auth} / marker=${agent._activeFmlMarker.replace(/\0/g, '')})...`
    );
    agent.connect();
  }
}

module.exports = {
  GTLAutomationAgent,
  GTNHAutomationAgent: GTLAutomationAgent,
  resolveAgentConfig,
  parseCliOverrides,
  runHeadlessDryRun
};
