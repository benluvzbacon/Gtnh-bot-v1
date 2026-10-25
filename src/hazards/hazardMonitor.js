'use strict';

const { EventEmitter } = require('events');
const Vec3 = require('vec3');
const nbt = require('prismarine-nbt');
const { VOLTAGE_TIER_ORDER } = require('../craftingEngine');

/**
 * Vanilla 1.7.10 potion effect IDs inflicted by GregTech chunk pollution (>500k gibbl).
 */
const GTNH_POLLUTION_EFFECT_IDS = new Set([
  2,  // Slowness
  4,  // Mining Fatigue
  9,  // Nausea
  15, // Blindness
  17, // Hunger
  18, // Weakness
  19, // Poison
  20  // Wither
]);

const HOSTILE_MOB_NAMES = new Set([
  'creeper',
  'skeleton',
  'zombie',
  'spider',
  'cave_spider',
  'witch',
  'enderman',
  'blaze',
  'ghast',
  'slime',
  'magma_cube',
  'wisp',
  'taintacle',
  'thaumic_slime',
  'hellhound'
]);

const INFERNAL_MODIFIER_KEYWORDS = [
  '1up',
  'fiery',
  'vengeance',
  'berserk',
  'ender',
  'ghastly',
  'webber',
  'storm',
  'choke',
  'wither',
  'alchemist',
  'sapper',
  'ninja',
  'sticky'
];

/**
 * GTNH-Specific Volatility, Weather, Power Telemetry, Pollution, and Combat Sensor Suite.
 */
class HazardMonitor extends EventEmitter {
  /**
   * @param {Object} [options]
   * @param {import('mineflayer').Bot|null} [options.bot]
   * @param {import('../navigation/gtnhNavigator').GTNHNavigator|null} [options.navigator]
   * @param {number} [options.criticalEuThresholdRatio=0.20]
   * @param {number} [options.recoveryEuThresholdRatio=0.50]
   * @param {number} [options.hostileAlertRadius=12]
   * @param {number} [options.creeperBlastEvadeRadius=8]
   * @param {Vec3} [options.safeShelterPos]
   */
  constructor(options = {}) {
    super();
    this.bot = options.bot || null;
    this.navigator = options.navigator || null;

    this.criticalEuThresholdRatio = options.criticalEuThresholdRatio ?? 0.20;
    this.recoveryEuThresholdRatio = options.recoveryEuThresholdRatio ?? 0.50;
    this.hostileAlertRadius = options.hostileAlertRadius ?? 12;
    this.creeperBlastEvadeRadius = options.creeperBlastEvadeRadius ?? 8;
    this.safeShelterPos = options.safeShelterPos
      ? new Vec3(options.safeShelterPos.x, options.safeShelterPos.y, options.safeShelterPos.z)
      : null;

    // Weather state
    this.isRaining = false;
    this.isThundering = false;
    this.rainLevel = 0;
    this.thunderLevel = 0;
    this.exteriorWiringLocked = false;

    // Registered GregTech electric machines: machineId -> descriptor
    this.electricMachines = new Map();

    // Registered GregTech Battery Buffers / Steam Turbines: bufferId -> descriptor
    this.powerBuffers = new Map();
    this.lowPowerHalted = false;
    this.lastNetEuPerTick = 0;

    // Pollution & entity status
    this.activePlayerEffects = new Map();
    this.inPollutedZone = false;
    this.currentThreats = [];
    this.emergencyPacketLog = [];

    if (this.bot) {
      this.attachToBot(this.bot);
    }
  }

  attachToBot(bot) {
    this.bot = bot;

    if (typeof bot.on === 'function') {
      bot.on('rain', () => {
        this._updateWeatherState({
          isRaining: Boolean(bot.isRaining),
          thunderLevel: bot.thunderState ?? this.thunderLevel
        });
      });

      bot.on('physicsTick', () => {
        this.scanNearbyThreats();
      });
    }

    const client = bot._client;
    if (client && typeof client.on === 'function') {
      // Packet-level weather sensor (1.7.10 / 1.8 packet_game_state_change)
      client.on('game_state_change', (packet) => {
        this.handleGameStatePacket(packet);
      });

      // Packet-level TileEntity telemetry for GregTech Battery Buffers / Machines
      client.on('tile_entity_data', (packet) => {
        this.handleTileEntityPacket(packet);
      });

      // Packet-level potion debuff sensor for GTNH pollution clouds
      client.on('entity_effect', (packet) => {
        this.handleEntityEffectPacket(packet);
      });
    }
  }

  /**
   * Registers an electric GregTech machine so the monitor can disable it immediately
   * if rain/storms hit while the machine is unroofed.
   */
  registerElectricMachine({
    id,
    position,
    voltageTier = 'LV',
    hasRainCover = false,
    active = true
  }) {
    const pos = position instanceof Vec3
      ? position.floored()
      : new Vec3(position.x, position.y, position.z).floored();
    const record = {
      id,
      position: pos,
      voltageTier,
      hasRainCover: Boolean(hasRainCover),
      active: Boolean(active),
      disabledByRainGuard: false
    };
    this.electricMachines.set(id, record);
    return record;
  }

  /**
   * Validates GTNH cable-to-machine voltage safety BEFORE placing a wire/cable.
   * Connecting higher voltage (e.g. MV 128 EU/t) into a lower-tier machine (e.g. LV 32 EU/t)
   * without a Transformer causes an instant machine explosion in GregTech!
   */
  verifySafeCableConnection(cableVoltageTier, machineVoltageTier) {
    const srcRank = VOLTAGE_TIER_ORDER[cableVoltageTier] ?? 99;
    const dstRank = VOLTAGE_TIER_ORDER[machineVoltageTier] ?? 0;

    if (this.exteriorWiringLocked) {
      return {
        safe: false,
        reason: 'Exterior wiring locked due to active rain/storm over-voltage explosion risk'
      };
    }

    if (srcRank > dstRank) {
      return {
        safe: false,
        reason: `Catastrophic GTNH over-voltage: ${cableVoltageTier} source exceeds ${machineVoltageTier} machine rating`
      };
    }

    return { safe: true, reason: null };
  }

  /**
   * Checks whether `position` (or its 4 horizontal neighbors, per GT5u splash-ignition rules!)
   * lacks a solid roof overhead up to `maxScanHeight`.
   */
  isExposedToSky(position, maxScanHeight = 128) {
    if (!this.bot || typeof this.bot.blockAt !== 'function') {
      return true;
    }
    const base = position instanceof Vec3
      ? position.floored()
      : new Vec3(position.x, position.y, position.z).floored();

    const checkColumns = [
      base,
      base.offset(1, 0, 0),
      base.offset(-1, 0, 0),
      base.offset(0, 0, 1),
      base.offset(0, 0, -1)
    ];

    for (const col of checkColumns) {
      let hasRoof = false;
      const topY = Math.min(255, col.y + maxScanHeight);
      for (let y = col.y + 1; y <= topY; y++) {
        const blk = this.bot.blockAt(new Vec3(col.x, y, col.z));
        if (!blk) break;
        const name = (blk.name || '').toLowerCase();
        if (blk.type !== 0 && name !== 'air' && name !== 'cave_air' && name !== 'void_air') {
          hasRoof = true;
          break;
        }
      }
      if (!hasRoof) {
        return true;
      }
    }

    return false;
  }

  /**
   * Processes raw `game_state_change` weather packets (`start_raining`, `stop_raining`,
   * `rain_level_change`, `thunder_level_change`).
   */
  handleGameStatePacket(packet) {
    if (!packet) return;
    const reason = packet.reason;
    const value = Number(packet.gameMode ?? packet.value ?? 0);

    if (reason === 1 || reason === 'start_raining') {
      this._updateWeatherState({ isRaining: true, rainLevel: Math.max(this.rainLevel, 1.0) });
    } else if (reason === 2 || reason === 'stop_raining') {
      this._updateWeatherState({ isRaining: false, isThundering: false, rainLevel: 0, thunderLevel: 0 });
    } else if (reason === 7 || reason === 'rain_level_change') {
      this._updateWeatherState({
        rainLevel: value,
        isRaining: value > 0.15
      });
    } else if (reason === 8 || reason === 'thunder_level_change') {
      this._updateWeatherState({
        thunderLevel: value,
        isThundering: value > 0.15,
        isRaining: this.isRaining || value > 0.15
      });
    }
  }

  _updateWeatherState(next) {
    if (next.rainLevel !== undefined) this.rainLevel = next.rainLevel;
    if (next.thunderLevel !== undefined) this.thunderLevel = next.thunderLevel;
    if (next.isRaining !== undefined) this.isRaining = next.isRaining;
    if (next.isThundering !== undefined) this.isThundering = next.isThundering;

    const stormActive = this.isRaining || this.isThundering;
    this.exteriorWiringLocked = stormActive;

    if (stormActive) {
      const disabledMachines = this.disableUnroofedMachines();
      this.emit('weatherEmergency', {
        isRaining: this.isRaining,
        isThundering: this.isThundering,
        exteriorWiringLocked: true,
        disabledMachines
      });
    } else {
      this.emit('weatherCleared', { exteriorWiringLocked: false });
    }
  }

  /**
   * Immediately disables any active registered GregTech electric machine that is exposed
   * to the sky without a rain cover, transmitting a Soft Mallet shutdown packet.
   */
  disableUnroofedMachines() {
    const disabled = [];

    for (const machine of this.electricMachines.values()) {
      if (!machine.active || machine.hasRainCover) continue;
      if (!this.isExposedToSky(machine.position)) continue;

      machine.active = false;
      machine.disabledByRainGuard = true;
      this._sendSoftMalletTogglePacket(machine.position);
      disabled.push(machine);
    }

    return disabled;
  }

  _sendSoftMalletTogglePacket(pos) {
    const packet = {
      location: { x: pos.x, y: pos.y, z: pos.z },
      direction: 1,
      heldItem: {
        blockId: 7150, // GregTech MetaTool (Soft Mallet meta 14)
        itemCount: 1,
        itemDamage: 14
      },
      cursorX: 8,
      cursorY: 8,
      cursorZ: 8
    };
    this.emergencyPacketLog.push({
      timestamp: Date.now(),
      action: 'soft_mallet_shutdown',
      position: pos.clone(),
      packet
    });
    if (this.bot?._client && typeof this.bot._client.write === 'function') {
      this.bot._client.write('block_place', packet);
    }
  }

  /**
   * Registers a GregTech Battery Buffer, LESU, or Steam Turbine buffer for EU/Steam monitoring.
   */
  registerPowerBuffer({
    id,
    type = 'battery_buffer',
    position,
    maxEu = 100000,
    storedEu = 100000
  }) {
    const pos = position instanceof Vec3
      ? position.floored()
      : new Vec3(position.x, position.y, position.z).floored();
    const record = {
      id,
      type,
      position: pos,
      maxEu: Math.max(1, Number(maxEu)),
      storedEu: Math.max(0, Number(storedEu)),
      updatedAt: Date.now()
    };
    this.powerBuffers.set(id, record);
    this._evaluatePowerHealth();
    return record;
  }

  /**
   * Updates stored EU / Steam-equivalent EU for a specific buffer and re-evaluates thresholds.
   */
  updatePowerBufferTelemetry(idOrPos, { storedEu, maxEu }) {
    let target = null;
    if (typeof idOrPos === 'string') {
      target = this.powerBuffers.get(idOrPos);
    } else if (idOrPos) {
      const p = idOrPos instanceof Vec3
        ? idOrPos.floored()
        : new Vec3(idOrPos.x, idOrPos.y, idOrPos.z).floored();
      for (const buf of this.powerBuffers.values()) {
        if (buf.position.x === p.x && buf.position.y === p.y && buf.position.z === p.z) {
          target = buf;
          break;
        }
      }
    }
    if (!target) return null;

    const now = Date.now();
    const dtTicks = Math.max(1, (now - target.updatedAt) / 50);
    if (Number.isFinite(maxEu) && maxEu > 0) {
      target.maxEu = maxEu;
    }
    if (Number.isFinite(storedEu)) {
      const deltaEu = storedEu - target.storedEu;
      this.lastNetEuPerTick = deltaEu / dtTicks;
      target.storedEu = Math.max(0, Math.min(target.maxEu, storedEu));
    }
    target.updatedAt = now;

    this._evaluatePowerHealth();
    return target;
  }

  /**
   * Parses incoming `tile_entity_data` NBT packets from GregTech machines / Battery Buffers
   * (`mStoredEnergy`, `mStoredSteam`, and internal battery `Inventory` charge tags).
   */
  handleTileEntityPacket(packet) {
    if (!packet || !packet.location || !packet.nbtData) return;

    let simplified;
    try {
      simplified = packet.nbtData.type ? nbt.simplify(packet.nbtData) : packet.nbtData;
    } catch (_) {
      return;
    }
    if (!simplified || typeof simplified !== 'object') return;

    let stored = null;
    let maxCap = null;

    if (Number.isFinite(simplified.mStoredEnergy)) {
      stored = Number(simplified.mStoredEnergy);
    } else if (Number.isFinite(simplified.mStoredSteam)) {
      // 2 mB Steam = 1 EU in GTNH LV Steam Turbines
      stored = Math.floor(Number(simplified.mStoredSteam) * 0.5);
    }

    if (Array.isArray(simplified.Inventory)) {
      let batteryChargeSum = 0;
      for (const slotEntry of simplified.Inventory) {
        const charge =
          slotEntry?.tag?.['GT.ItemCharge'] ??
          slotEntry?.tag?.charge ??
          0;
        if (Number.isFinite(charge)) {
          batteryChargeSum += Number(charge);
        }
      }
      if (batteryChargeSum > 0) {
        stored = (stored || 0) + batteryChargeSum;
      }
    }

    if (Number.isFinite(simplified.mMaxEnergy) && simplified.mMaxEnergy > 0) {
      maxCap = Number(simplified.mMaxEnergy);
    }

    if (stored !== null) {
      this.updatePowerBufferTelemetry(packet.location, {
        storedEu: stored,
        maxEu: maxCap ?? undefined
      });
    }
  }

  /**
   * Computes aggregate EU capacity, stored EU, and fill ratio across all registered buffers.
   */
  getPowerTelemetry() {
    if (this.powerBuffers.size === 0) {
      return {
        bufferCount: 0,
        storedEu: 0,
        maxEu: 0,
        fillRatio: 1.0,
        lowPowerHalted: this.lowPowerHalted,
        netEuPerTick: this.lastNetEuPerTick
      };
    }

    let storedEu = 0;
    let maxEu = 0;
    for (const buf of this.powerBuffers.values()) {
      storedEu += buf.storedEu;
      maxEu += buf.maxEu;
    }
    const fillRatio = maxEu > 0 ? storedEu / maxEu : 0;

    return {
      bufferCount: this.powerBuffers.size,
      storedEu,
      maxEu,
      fillRatio,
      lowPowerHalted: this.lowPowerHalted,
      netEuPerTick: this.lastNetEuPerTick
    };
  }

  _evaluatePowerHealth() {
    const telemetry = this.getPowerTelemetry();
    if (telemetry.bufferCount === 0) return telemetry;

    if (!this.lowPowerHalted && telemetry.fillRatio < this.criticalEuThresholdRatio) {
      this.lowPowerHalted = true;
      this.emit('powerCritical', telemetry);
    } else if (this.lowPowerHalted && telemetry.fillRatio >= this.recoveryEuThresholdRatio) {
      this.lowPowerHalted = false;
      this.emit('powerRestored', telemetry);
    }

    return telemetry;
  }

  /**
   * Gatekeeper consulted by `CraftingEngine` & `ContainerPacketController` before starting
   * or continuing a GregTech machine recipe cycle. Prevents mid-recipe power stalls that
   * destroy expensive GTNH wafers/ingots!
   */
  canExecuteRecipeStep(step) {
    const requiresElectric = (step.euPerTick ?? 0) > 0 && step.voltageTier !== 'STONE';

    if (requiresElectric && this.lowPowerHalted) {
      const tel = this.getPowerTelemetry();
      return {
        allowed: false,
        reason: `Battery Buffer EU critically low (${(tel.fillRatio * 100).toFixed(1)}% < ${(this.criticalEuThresholdRatio * 100).toFixed(0)}% threshold)`
      };
    }

    if (requiresElectric && this.powerBuffers.size > 0) {
      const tel = this.getPowerTelemetry();
      const neededWithMargin = (step.totalEu || step.euPerTick * step.durationTicks || 0) * 1.15;
      if (neededWithMargin > 0 && tel.storedEu < neededWithMargin) {
        return {
          allowed: false,
          reason: `Insufficient buffered EU (${tel.storedEu} EU stored < ${Math.ceil(neededWithMargin)} EU required incl. 15% safety margin)`
        };
      }
    }

    if (requiresElectric && (this.isRaining || this.isThundering)) {
      // Block running unroofed machines during active rain/storms
      for (const machine of this.electricMachines.values()) {
        if (machine.disabledByRainGuard) {
          return {
            allowed: false,
            reason: `Machine '${machine.id}' disabled due to active rain/storm explosion hazard`
          };
        }
      }
    }

    return { allowed: true, reason: null };
  }

  /**
   * Monitors `entity_effect` packets for GTNH high-pollution debuffs (Weakness, Poison,
   * Slowness, Nausea, Mining Fatigue), marks the chunk in `GTNHNavigator`, and emits
   * a `'pollutionHazard'` alert for immediate evacuation.
   */
  handleEntityEffectPacket(packet) {
    if (!packet) return;
    const botEntityId = this.bot?.entity?.id;
    if (botEntityId !== undefined && packet.entityId !== botEntityId) return;

    const effectId = Number(packet.effectId);
    if (!GTNH_POLLUTION_EFFECT_IDS.has(effectId)) return;

    this.activePlayerEffects.set(effectId, {
      effectId,
      amplifier: packet.amplifier ?? 0,
      duration: packet.duration ?? 100,
      recordedAt: Date.now()
    });

    // Prune expired effects
    const now = Date.now();
    for (const [id, entry] of this.activePlayerEffects.entries()) {
      if (now - entry.recordedAt > entry.duration * 50 + 1000) {
        this.activePlayerEffects.delete(id);
      }
    }

    // Two or more simultaneous pollution symptoms (or Poison/Nausea) indicate heavy GTNH smog (>600k gibbl)
    if (this.activePlayerEffects.size >= 2 || effectId === 9 || effectId === 19) {
      this.inPollutedZone = true;
      const botPos = this.bot?.entity?.position;
      if (botPos && this.navigator) {
        const chunkX = Math.floor(botPos.x / 16);
        const chunkZ = Math.floor(botPos.z / 16);
        const estimatedGibbl = 650000 + this.activePlayerEffects.size * 100000;
        this.navigator.recordChunkPollution(chunkX, chunkZ, estimatedGibbl);
      }

      const escapeTarget = this.computeCleanChunkEscapeTarget();
      this.emit('pollutionHazard', {
        effects: Array.from(this.activePlayerEffects.keys()),
        escapeTarget
      });
    }
  }

  /**
   * Computes a clean chunk coordinate outside any polluted chunks recorded in `GTNHNavigator`.
   */
  computeCleanChunkEscapeTarget() {
    const pos = this.bot?.entity?.position || new Vec3(0, 64, 0);
    if (this.safeShelterPos) {
      const sChunk = `${Math.floor(this.safeShelterPos.x / 16)},${Math.floor(this.safeShelterPos.z / 16)}`;
      if (!this.navigator?.pollutedChunks.has(sChunk)) {
        return this.safeShelterPos.clone();
      }
    }

    const baseChunkX = Math.floor(pos.x / 16);
    const baseChunkZ = Math.floor(pos.z / 16);
    const candidateDirs = [
      [2, 0],
      [-2, 0],
      [0, 2],
      [0, -2],
      [2, 2],
      [-2, -2]
    ];

    for (const [dcx, dcz] of candidateDirs) {
      const cx = baseChunkX + dcx;
      const cz = baseChunkZ + dcz;
      const polluted = this.navigator?.pollutedChunks.get(`${cx},${cz}`);
      if (!polluted || polluted.gibbl < 300000) {
        return new Vec3(cx * 16 + 8, Math.floor(pos.y), cz * 16 + 8);
      }
    }

    return pos.offset(32, 0, 0);
  }

  /**
   * Scans `bot.entities` for nearby hostile entities and GTNH Infernal Mobs, returning
   * prioritized tactical responses (`CRITICAL_EVADE` vs `ENGAGE_DEFENSE`).
   */
  scanNearbyThreats() {
    if (!this.bot?.entities || !this.bot?.entity?.position) {
      this.currentThreats = [];
      return [];
    }

    const botPos = this.bot.entity.position;
    const botHealth = this.bot.health ?? 20;
    const threats = [];

    for (const entity of Object.values(this.bot.entities)) {
      if (!entity || entity === this.bot.entity || !entity.position) continue;
      const rawName = String(entity.name || entity.mobType || '').toLowerCase();
      const customTag = String(entity.username || entity.displayName || '').toLowerCase();

      const isHostile =
        HOSTILE_MOB_NAMES.has(rawName) ||
        String(entity.type || '').toLowerCase() === 'hostile' ||
        String(entity.kind || '').toLowerCase() === 'hostile mobs';

      if (!isHostile) continue;

      const distance = botPos.distanceTo(entity.position);
      if (distance > this.hostileAlertRadius) continue;

      const isInfernal = INFERNAL_MODIFIER_KEYWORDS.some((kw) => customTag.includes(kw));
      const isCreeper = rawName.includes('creeper');

      const action =
        isInfernal ||
        (isCreeper && distance <= this.creeperBlastEvadeRadius) ||
        botHealth <= 8
          ? 'CRITICAL_EVADE'
          : 'ENGAGE_DEFENSE';

      threats.push({
        entityId: entity.id,
        name: rawName || 'hostile',
        position: entity.position.clone(),
        distance,
        isInfernal,
        isCreeper,
        recommendedAction: action
      });
    }

    threats.sort((a, b) => a.distance - b.distance);
    this.currentThreats = threats;

    if (threats.length > 0) {
      this.emit('hostileDetected', threats);
    }

    return threats;
  }

  /**
   * Executes defensive combat or hazard retreat for the highest-priority active threat.
   */
  async mitigateImmediateHazard() {
    if (this.inPollutedZone) {
      const target = this.computeCleanChunkEscapeTarget();
      if (this.navigator) {
        await this.navigator.gotoPosition(target, 2, 12000);
      }
      this.inPollutedZone = false;
      this.activePlayerEffects.clear();
      return { mitigated: 'pollution_retreat', destination: target };
    }

    const topThreat = this.currentThreats[0];
    if (!topThreat) {
      return { mitigated: 'none' };
    }

    if (topThreat.recommendedAction === 'CRITICAL_EVADE') {
      if (this.navigator) {
        await this.navigator.retreatFromPoint(topThreat.position, 18, 10000);
      }
      return { mitigated: 'evaded_threat', threat: topThreat };
    }

    // Engage lone standard mob defensively while backing up
    const entity = this.bot?.entities?.[topThreat.entityId];
    if (entity && typeof this.bot?.attack === 'function') {
      if (typeof this.bot.lookAt === 'function') {
        await this.bot.lookAt(entity.position.offset(0, 1.2, 0), true);
      }
      this.bot.attack(entity);
      return { mitigated: 'attacked_threat', threat: topThreat };
    }

    return { mitigated: 'none' };
  }

  /**
   * Summary predicate used by the Hierarchical State Machine's top-level preemption transitions.
   */
  hasActiveEmergency() {
    return (
      this.inPollutedZone ||
      this.currentThreats.some((t) => t.recommendedAction === 'CRITICAL_EVADE')
    );
  }
}

module.exports = {
  GTNH_POLLUTION_EFFECT_IDS,
  HOSTILE_MOB_NAMES,
  INFERNAL_MODIFIER_KEYWORDS,
  HazardMonitor
};
