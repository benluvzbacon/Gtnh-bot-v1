'use strict';

const { EventEmitter } = require('events');
const Vec3 = require('vec3');
const nbt = require('prismarine-nbt');
const { VOLTAGE_TIER_ORDER } = require('../craftingEngine');

/**
 * Minecraft 1.20.1 MobEffect IDs triggered by GregTech environmental hazards,
 * chemical leaks, or toxic planetary atmospheres.
 */
const GTL_HAZARD_EFFECT_IDS = new Set([
  2,  // Slowness
  4,  // Mining Fatigue
  9,  // Nausea
  15, // Blindness
  17, // Hunger
  18, // Weakness
  19, // Poison
  20, // Wither
  33  // Darkness (1.20.1)
]);

const HOSTILE_MOB_NAMES = new Set([
  'creeper',
  'skeleton',
  'stray',
  'wither_skeleton',
  'zombie',
  'husk',
  'drowned',
  'spider',
  'cave_spider',
  'witch',
  'enderman',
  'blaze',
  'ghast',
  'slime',
  'magma_cube',
  'phantom',
  'pillager',
  'vindicator',
  'ravager',
  'warden',
  'corrupted_lunarian',
  'star_crawler'
]);

const ELITE_OR_CHAMPION_KEYWORDS = [
  'champion',
  'apotheotic',
  'boss',
  'infernal',
  '1up',
  'fiery',
  'vengeance',
  'berserk',
  'ender',
  'storm',
  'wither',
  'alchemist',
  'sapper'
];

/**
 * GregTech Leisure (GTL 1.20.1) Volatility, Dry-Boiler Explosion Guard,
 * EU P2P / Cable Over-Voltage Guard, Power Hysteresis (`recipeProgressLowEnergy`),
 * Weather Protection, and Combat/Atmosphere Sensor Suite.
 */
class HazardMonitor extends EventEmitter {
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

    // Registered GTCEu electric machines: machineId -> descriptor
    this.electricMachines = new Map();

    // Registered GTCEu Steam Boilers (`gtceu:lp_steam_solid_boiler`, etc.) for dry-boil explosion guard
    this.steamBoilers = new Map();

    // Registered GTCEu Battery Buffers (`gtceu:lv_battery_buffer_4x`) / Large Boilers
    this.powerBuffers = new Map();
    this.lowPowerHalted = false;
    this.lastNetEuPerTick = 0;

    // Environmental debuffs & entity threats
    this.activePlayerEffects = new Map();
    this.inPollutedZone = false;
    this.currentThreats = [];
    this.emergencyPacketLog = [];
    this._packetSequence = 0;

    if (this.bot) {
      this.attachToBot(this.bot);
    }
  }

  _nextSequence() {
    this._packetSequence = (this._packetSequence + 1) % 1000000;
    return this._packetSequence;
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
    if (client && typeof client.on !== 'function') return;

    if (client) {
      client.on('game_state_change', (packet) => {
        this.handleGameStatePacket(packet);
      });

      client.on('tile_entity_data', (packet) => {
        this.handleTileEntityPacket(packet);
      });

      client.on('entity_effect', (packet) => {
        this.handleEntityEffectPacket(packet);
      });
    }
  }

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
   * Registers a GTCEu Steam Boiler (`gtceu:lp_steam_solid_boiler`, `gtceu:hp_steam_solid_boiler`,
   * `gtceu:bronze_large_boiler`) to guard against GTL's dry-boiler water explosion mechanic
   * (GTL Quest `4BFC342697BDE75A`).
   */
  registerSteamBoiler({
    id,
    position,
    temperatureC = 20,
    maxTemperatureC = 500,
    waterMb = 16000
  }) {
    const pos = position instanceof Vec3
      ? position.floored()
      : new Vec3(position.x, position.y, position.z).floored();
    const record = {
      id,
      position: pos,
      temperatureC: Number(temperatureC) || 20,
      maxTemperatureC: Number(maxTemperatureC) || 500,
      waterMb: Math.max(0, Number(waterMb) || 0),
      updatedAt: Date.now()
    };
    this.steamBoilers.set(id, record);
    return record;
  }

  updateBoilerTelemetry(id, { temperatureC, waterMb }) {
    const boiler = this.steamBoilers.get(id);
    if (!boiler) return null;
    if (Number.isFinite(temperatureC)) boiler.temperatureC = temperatureC;
    if (Number.isFinite(waterMb)) boiler.waterMb = Math.max(0, waterMb);
    boiler.updatedAt = Date.now();

    if (boiler.waterMb === 0 && boiler.temperatureC >= 100) {
      this.emit('dryBoilerWarning', {
        id: boiler.id,
        position: boiler.position,
        temperatureC: boiler.temperatureC,
        waterMb: boiler.waterMb
      });
    }
    return boiler;
  }

  /**
   * GTL Dry-Boiler Explosion Guard (Quest `4BFC342697BDE75A`):
   * Adding water to a dry GTCEu Steam Boiler whose temperature exceeds 100 C causes an
   * instant catastrophic steam explosion! Blocks water injection until cooled <= 95 C.
   */
  verifySafeBoilerWaterFill(boilerId) {
    const boiler = this.steamBoilers.get(boilerId);
    if (!boiler) {
      return { safe: true, reason: null };
    }
    if (boiler.waterMb <= 0 && boiler.temperatureC > 95) {
      return {
        safe: false,
        reason: `Dry GTCEu boiler '${boilerId}' is at ${boiler.temperatureC}C (>95C); injecting water now will cause a steam explosion! Cut fuel and cool below 95C first.`
      };
    }
    return { safe: true, reason: null };
  }

  /**
   * Validates GTCEu cable-to-machine AND MAE2 EU P2P (`mae2:eu_p2p_tunnel`) voltage safety
   * BEFORE connecting power (GTL Quest `4B66FAB975B2C7D2`: EU P2P tunnels do NOT step voltage!).
   */
  verifySafeCableConnection(sourceVoltageTier, machineVoltageTier, options = {}) {
    const srcRank = VOLTAGE_TIER_ORDER[sourceVoltageTier] ?? 99;
    const dstRank = VOLTAGE_TIER_ORDER[machineVoltageTier] ?? 0;

    if (this.exteriorWiringLocked && !options.indoorRoofed) {
      return {
        safe: false,
        reason: 'Exterior wiring locked due to active rain/storm machine fire/explosion risk'
      };
    }

    if (srcRank > dstRank) {
      const viaLabel = options.viaEuP2P ? ' (via mae2:eu_p2p_tunnel — does NOT step voltage!)' : '';
      return {
        safe: false,
        reason: `Catastrophic GTCEu over-voltage${viaLabel}: ${sourceVoltageTier} source exceeds ${machineVoltageTier} machine rating`
      };
    }

    return { safe: true, reason: null };
  }

  /**
   * Checks whether `position` (or its 4 horizontal neighbors) lacks a solid roof overhead
   * in Minecraft 1.20.1 world coordinates (up to `Y = 320`).
   */
  isExposedToSky(position, maxScanHeight = 160) {
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
      const topY = Math.min(320, col.y + maxScanHeight);
      for (let y = col.y + 1; y <= topY; y++) {
        const blk = this.bot.blockAt(new Vec3(col.x, y, col.z));
        if (!blk) break;
        const name = (blk.name || '').toLowerCase();
        if (
          blk.type !== 0 &&
          name !== 'air' &&
          name !== 'minecraft:air' &&
          name !== 'cave_air' &&
          name !== 'void_air'
        ) {
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
   * Immediately disables any active unroofed GTCEu electric machine via a 1.20.1
   * `gtceu:rubber_mallet` interaction packet.
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
      hand: 0,
      location: { x: pos.x, y: pos.y, z: pos.z },
      direction: 1,
      cursorX: 0.5,
      cursorY: 0.5,
      cursorZ: 0.5,
      insideBlock: false,
      sequence: this._nextSequence()
    };
    this.emergencyPacketLog.push({
      timestamp: Date.now(),
      action: 'soft_mallet_shutdown',
      toolItemId: 'gtceu:rubber_mallet',
      position: pos.clone(),
      packet
    });
    if (this.bot?._client && typeof this.bot._client.write === 'function') {
      this.bot._client.write('block_place', packet);
    }
  }

  registerPowerBuffer({
    id,
    type = 'gtceu:lv_battery_buffer_4x',
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
   * Parses incoming `tile_entity_data` NBT packets from GTCEu Modern 1.20.1 block entities
   * (`energyContainer.energyStored`, `energyStored`, `mStoredEnergy`, `steamTank`, and battery slots).
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

    const energyNode = simplified.energyContainer || simplified;
    if (Number.isFinite(energyNode.energyStored)) {
      stored = Number(energyNode.energyStored);
    } else if (Number.isFinite(simplified.mStoredEnergy)) {
      stored = Number(simplified.mStoredEnergy);
    } else if (Number.isFinite(simplified.mStoredSteam)) {
      stored = Math.floor(Number(simplified.mStoredSteam) * 0.5);
    }

    if (Number.isFinite(energyNode.energyCapacity) && energyNode.energyCapacity > 0) {
      maxCap = Number(energyNode.energyCapacity);
    } else if (Number.isFinite(simplified.mMaxEnergy) && simplified.mMaxEnergy > 0) {
      maxCap = Number(simplified.mMaxEnergy);
    }

    if (Array.isArray(simplified.Inventory)) {
      let batteryChargeSum = 0;
      for (const slotEntry of simplified.Inventory) {
        const charge =
          slotEntry?.tag?.Charge ??
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

    if (stored !== null) {
      this.updatePowerBufferTelemetry(packet.location, {
        storedEu: stored,
        maxEu: maxCap ?? undefined
      });
    }
  }

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
   * Gatekeeper consulted before starting or continuing a GTCEu machine recipe cycle.
   * In GregTech Leisure (`config/gtceu.yaml -> recipeProgressLowEnergy: true`), losing EU
   * mid-craft drains recipe progress at 2x speed! Hysteresis + 15% EU safety margin prevents stalls.
   */
  canExecuteRecipeStep(step) {
    const requiresElectric = (step.euPerTick ?? 0) > 0 && step.voltageTier !== 'STONE';

    if (requiresElectric && this.lowPowerHalted) {
      const tel = this.getPowerTelemetry();
      return {
        allowed: false,
        reason: `Battery Buffer EU critically low (${(tel.fillRatio * 100).toFixed(1)}% < ${(this.criticalEuThresholdRatio * 100).toFixed(0)}% threshold — GTL recipeProgressLowEnergy 2x drain guard active)`
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

  handleEntityEffectPacket(packet) {
    if (!packet) return;
    const botEntityId = this.bot?.entity?.id;
    if (botEntityId !== undefined && packet.entityId !== botEntityId) return;

    const effectId = Number(packet.effectId);
    if (!GTL_HAZARD_EFFECT_IDS.has(effectId)) return;

    this.activePlayerEffects.set(effectId, {
      effectId,
      amplifier: packet.amplifier ?? 0,
      duration: packet.duration ?? 100,
      recordedAt: Date.now()
    });

    const now = Date.now();
    for (const [id, entry] of this.activePlayerEffects.entries()) {
      if (now - entry.recordedAt > entry.duration * 50 + 1000) {
        this.activePlayerEffects.delete(id);
      }
    }

    if (this.activePlayerEffects.size >= 2 || effectId === 9 || effectId === 19 || effectId === 20) {
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

      const isInfernal = ELITE_OR_CHAMPION_KEYWORDS.some((kw) => customTag.includes(kw));
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

  hasActiveEmergency() {
    return (
      this.inPollutedZone ||
      this.currentThreats.some((t) => t.recommendedAction === 'CRITICAL_EVADE')
    );
  }
}

module.exports = {
  GTL_HAZARD_EFFECT_IDS,
  GTNH_POLLUTION_EFFECT_IDS: GTL_HAZARD_EFFECT_IDS,
  HOSTILE_MOB_NAMES,
  ELITE_OR_CHAMPION_KEYWORDS,
  INFERNAL_MODIFIER_KEYWORDS: ELITE_OR_CHAMPION_KEYWORDS,
  HazardMonitor
};
