'use strict';

const { EventEmitter } = require('events');
const mc = require('minecraft-protocol');
const { ProtoDef } = require('protodef');
const forgePlugin = require('@tcortega/minecraft-protocol-forge');

/**
 * Default Forge 1.20.1 mod signature for GregTech Leisure (GTL 1.4.5.x, Forge 47.4.16).
 * During live `fml:loginwrapper` (`S2CModList`) negotiation, `autoMirrorServerMods`
 * automatically echoes the server's full advertised mod list & channels (200+ mods in GTL)
 * so any minor pack update or server-added utility mod connects seamlessly.
 */
const DEFAULT_GTL_MODLIST = [
  'minecraft',
  'forge',
  'fmlcore',
  'javafmllanguage',
  'lowcodefml',
  'mclanguage',
  'ldlib',
  'gtceu',
  'gtlcore',
  'gtladditions',
  'gtl_extend',
  'gtmthings',
  'gtmadvancedhatch',
  'kubejs',
  'rhino',
  'architectury',
  'ae2',
  'expatternprovider',
  'extendedae_plus',
  'mae2',
  'ftblibrary',
  'ftbteams',
  'ftbquests',
  'ad_astra',
  'sophisticatedcore',
  'sophisticatedstorage',
  'sophisticatedbackpacks',
  'functionalstorage',
  'avaritia',
  'modernfix',
  'embeddium',
  'ferritecore',
  'curios',
  'placebo'
];

/**
 * Official MinecraftForge 1.20.1 (`47.4.x`, `NetworkConstants.NETVERSION = "FML3"`)
 * `fml:handshake` SimpleChannel discriminators inside `fml:loginwrapper`:
 *  - 1: S2CModList (mods, channels, registries, dataPackRegistries)
 *  - 2: C2SModListReply (mods, channels, registries)
 *  - 3: S2CRegistry (registryName, hasSnapshot, optional ForgeRegistry.Snapshot)
 *  - 4: S2CConfigData (fileName, byte[] fileData)
 *  - 5: S2CModData (Map<modId, Pair<displayName, version>> — registered `.noResponse()`)
 *  - 6: S2CChannelMismatchData (Map<ResourceLocation, version>)
 *  - 99: C2SAcknowledge (void)
 */
const FML3HandshakePacketId = Object.freeze({
  S2C_MOD_LIST: 1,
  C2S_MOD_LIST_REPLY: 2,
  S2C_SERVER_REGISTRY: 3,
  S2C_CONFIG_DATA: 4,
  S2C_MOD_DATA: 5,
  S2C_CHANNEL_MISMATCH_DATA: 6,
  C2S_ACK: 99
});

/**
 * Forge 1.20.1 `fml:play` SimpleChannel discriminators (`NetworkInitialization.getPlayChannel()`):
 *  - 0: PlayMessages.SpawnEntity
 *  - 1: PlayMessages.OpenContainer (`NetworkHooks.openScreen` for GTCEu/LDLib/AE2 modded GUIs)
 */
const FML3PlayPacketId = Object.freeze({
  SPAWN_ENTITY: 0,
  OPEN_CONTAINER: 1
});

/**
 * Handshake lifecycle states exposed for telemetry and backwards compatibility.
 */
const FMLHandshakeClientState = Object.freeze({
  START: 1,
  WAITINGSERVERDATA: 2,
  WAITINGSERVERCOMPLETE: 3,
  PENDINGCOMPLETE: 4,
  COMPLETE: 5,
  RESET: 6
});

/**
 * Optional mod channels that accept `ABSENT` (`NetworkRegistry.acceptMissingOr(...)`)
 * and alter vanilla packet wire layouts when advertised by the client.
 * Omitting `modernfix:ingredient_sync` instructs ModernFix on the server to keep standard
 * vanilla recipe/tag sync semantics rather than custom client-mixin ingredient encoding.
 */
const DEFAULT_OMITTED_OPTIONAL_CHANNELS = new Set([
  'modernfix:ingredient_sync'
]);

/**
 * Patches `minecraft-data('1.20.1')`'s in-memory `play.toClient` protocol definitions and returns
 * a matching `customPackets` object so modded `declare_recipes` (GTCEu/AE2/KubeJS/Ad Astra recipe
 * serializers) and `declare_commands` (Forge `forge:enum` / `forge:modid` command argument nodes)
 * deserialize in O(1) as zero-copy `restBuffer` slices — even when `minecraft-protocol`'s global
 * protocol cache (`protocols['play;toClient;1.20.1;c']`) is populated earlier in the same process.
 */
function buildModded1201CustomPackets() {
  const overrideTypes = {
    packet_declare_recipes: [
      'container',
      [{ name: 'rawRecipes', type: 'restBuffer' }]
    ],
    packet_declare_commands: [
      'container',
      [
        { name: 'rawCommands', type: 'restBuffer' },
        { name: '_unusedRootIndex', type: 'void' }
      ]
    ]
  };

  try {
    const mcData1201 = require('minecraft-data')('1.20.1');
    if (mcData1201?.protocol?.play?.toClient?.types) {
      mcData1201.protocol.play.toClient.types.packet_declare_recipes =
        overrideTypes.packet_declare_recipes;
      mcData1201.protocol.play.toClient.types.packet_declare_commands =
        overrideTypes.packet_declare_commands;
    }
  } catch (_) {
    // Safe fallback if 1.20.1 data is unavailable
  }

  return {
    '1.20': {
      play: {
        toClient: {
          types: overrideTypes
        }
      }
    }
  };
}

// Pre-apply the 1.20.1 modded play-packet patch before any Client/Server compiles play.toClient
buildModded1201CustomPackets();

/**
 * Formats a clean hostname + Forge network version marker (`\0FML3\0` or `\0FML2\0`)
 * for `ClientIntentionPacket` (`set_protocol.serverHost`).
 */
function buildForgeTaggedHost(host, fmlMarker = '\0FML3\0') {
  const cleanHost = String(host || '127.0.0.1').split('\0')[0];
  const marker = fmlMarker.startsWith('\0') ? fmlMarker : `\0${fmlMarker}\0`;
  return `${cleanHost}${marker}`;
}

/**
 * Normalizes a Minecraft 1.20.1 / GTCEu Modern item or block identifier.
 */
function normalizeItemId(itemId) {
  const raw = String(itemId || '').trim();
  if (!raw) return 'minecraft:air';
  if (raw.startsWith('fluid:')) return raw;

  const parts = raw.split(':');
  if (parts.length === 1) {
    return `minecraft:${parts[0]}`;
  }
  if (parts.length === 2) {
    if (/^\d+$/.test(parts[1])) {
      return `minecraft:${parts[0]}`;
    }
    return `${parts[0]}:${parts[1]}`;
  }
  const tail = parts[parts.length - 1];
  if (tail === '0') {
    return parts.slice(0, -1).join(':');
  }
  return raw;
}

function splitCanonicalItemId(itemId) {
  const normalized = normalizeItemId(itemId);
  const parts = normalized.split(':');
  if (parts.length >= 3 && /^\d+$/.test(parts[parts.length - 1])) {
    return {
      baseName: parts.slice(0, -1).join(':'),
      metadata: Number(parts[parts.length - 1])
    };
  }
  return {
    baseName: normalized,
    metadata: 0
  };
}

/**
 * Bidirectional Forge 1.20.1 Registry ID <-> Canonical ResourceLocation (`namespace:path`) Bridge.
 * Synchronizes Forge `S2CRegistry` snapshots (`minecraft:item`, `minecraft:block`,
 * `minecraft:entity_type`, `minecraft:menu`, `minecraft:fluid`) with Mineflayer's `bot.registry`.
 */
class ForgeRegistryBridge extends EventEmitter {
  constructor() {
    super();
    this.numericToBlockName = new Map();
    this.blockNameToNumeric = new Map();
    this.numericToItemName = new Map();
    this.itemNameToNumeric = new Map();
    this.numericToEntityName = new Map();
    this.entityNameToNumeric = new Map();
    this.numericToMenuName = new Map();
    this.menuNameToNumeric = new Map();
  }

  /**
   * Registers a block, item, entity, or menu mapping (`gtceu:lv_bender` <-> numeric network ID).
   */
  register(kind, registryName, numericId) {
    const cleanName = normalizeItemId(registryName);
    const id = Number(numericId);
    if (!cleanName || !Number.isFinite(id)) return;

    if (kind === 'block') {
      this.numericToBlockName.set(id, cleanName);
      this.blockNameToNumeric.set(cleanName, id);
    } else if (kind === 'entity') {
      this.numericToEntityName.set(id, cleanName);
      this.entityNameToNumeric.set(cleanName, id);
    } else if (kind === 'menu') {
      this.numericToMenuName.set(id, cleanName);
      this.menuNameToNumeric.set(cleanName, id);
    } else {
      this.numericToItemName.set(id, cleanName);
      this.itemNameToNumeric.set(cleanName, id);
    }
  }

  /**
   * Bulk-loads a registry dump array or `{ "gtceu:steel_ingot": 1420 }` map.
   */
  loadDump(entries) {
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        this.register(entry.kind || 'item', entry.name || entry.id, entry.numericId ?? entry.id);
      }
      return;
    }
    if (entries && typeof entries === 'object') {
      for (const [name, id] of Object.entries(entries)) {
        this.register('item', name, id);
      }
    }
  }

  /**
   * Parses a Forge 1.20.1 `S2CRegistry` inner payload (`[discriminator=3][registryName][hasSnapshot]...`),
   * populating `numericToItemName` / `numericToBlockName` / `numericToEntityName` / `numericToMenuName`.
   */
  ingestForge120RegistrySnapshot(innerBuffer) {
    if (!Buffer.isBuffer(innerBuffer) || innerBuffer.length < 2) {
      return { registryName: null, entriesLoaded: 0 };
    }

    let offset = 0;
    const pktId = readU8DiscriminatorOrVarInt(innerBuffer, offset);
    offset = pktId.nextOffset;

    const regNameRes = readVarIntString(innerBuffer, offset);
    offset = regNameRes.nextOffset;
    const registryName = regNameRes.value;

    if (offset >= innerBuffer.length) {
      return { registryName, entriesLoaded: 0 };
    }

    const hasSnapshot = innerBuffer.readUInt8(offset++) !== 0;
    if (!hasSnapshot || offset >= innerBuffer.length) {
      return { registryName, entriesLoaded: 0 };
    }

    let kind = null;
    if (registryName === 'minecraft:block' || registryName.endsWith(':block')) {
      kind = 'block';
    } else if (registryName === 'minecraft:item' || registryName.endsWith(':item')) {
      kind = 'item';
    } else if (registryName === 'minecraft:entity_type' || registryName.includes('entity_type')) {
      kind = 'entity';
    } else if (registryName === 'minecraft:menu' || registryName.endsWith(':menu')) {
      kind = 'menu';
    }

    let entriesLoaded = 0;

    // Support JSON snapshot encoding (used in lightweight unit fixtures) as well as Forge 1.20.1 binary Snapshot
    if (innerBuffer[offset] === 0x7b) {
      try {
        const parsedJson = JSON.parse(innerBuffer.subarray(offset).toString('utf8'));
        const mapObj = parsedJson.entries || parsedJson.ids || parsedJson;
        const targetKind = kind || (registryName.includes('block') ? 'block' : 'item');
        for (const [entryName, entryId] of Object.entries(mapObj)) {
          if (Number.isFinite(Number(entryId))) {
            this.register(targetKind, entryName, Number(entryId));
            entriesLoaded++;
          }
        }
        this.emit('updated', { registryName, entriesLoaded });
        return { registryName, entriesLoaded };
      } catch (_) {
        // Fall through to binary ForgeRegistry.Snapshot decoder
      }
    }

    try {
      const idsCount = readVarInt(innerBuffer, offset);
      offset = idsCount.nextOffset;
      const targetKind = kind;
      for (let i = 0; i < idsCount.value && offset < innerBuffer.length; i++) {
        const entryLoc = readVarIntString(innerBuffer, offset);
        offset = entryLoc.nextOffset;
        const entryNum = readVarInt(innerBuffer, offset);
        offset = entryNum.nextOffset;
        if (targetKind) {
          this.register(targetKind, entryLoc.value, entryNum.value);
        }
        entriesLoaded++;
      }
    } catch (_) {
      // Snapshot tail fields (aliases, overrides, blocked, dummied) are safely ignored after IDs
    }

    this.emit('updated', { registryName, entriesLoaded });
    return { registryName, entriesLoaded };
  }

  /**
   * Injects synced Forge 1.20.1 registries (`items`, `blocks`, `entities`) into a live Mineflayer
   * `bot.registry` (`prismarine-registry`) instance AND installs a solid-cube fallback proxy on
   * `bot.registry.blocksByStateId` for modded block state IDs (`stateId > maxVanillaStateId`)
   * so Mineflayer physics & pathfinder walk solidly on modded GTCEu/GTL floors without falling!
   */
  syncToBotRegistry(botRegistry) {
    if (!botRegistry || typeof botRegistry !== 'object') {
      return { itemsInjected: 0, blocksInjected: 0, entitiesInjected: 0 };
    }

    let itemsInjected = 0;
    let blocksInjected = 0;
    let entitiesInjected = 0;

    if (botRegistry.items && botRegistry.itemsByName) {
      for (const [id, fullName] of this.numericToItemName.entries()) {
        if (!botRegistry.items[id]) {
          const shortName = fullName.startsWith('minecraft:')
            ? fullName.slice('minecraft:'.length)
            : fullName;
          const entry = {
            id,
            name: fullName,
            displayName: fullName,
            stackSize: 64
          };
          botRegistry.items[id] = entry;
          botRegistry.itemsByName[fullName] = entry;
          if (!botRegistry.itemsByName[shortName]) {
            botRegistry.itemsByName[shortName] = entry;
          }
          if (Array.isArray(botRegistry.itemsArray)) {
            botRegistry.itemsArray.push(entry);
          }
          itemsInjected++;
        }
      }
    }

    if (botRegistry.blocks && botRegistry.blocksByName) {
      for (const [id, fullName] of this.numericToBlockName.entries()) {
        if (!botRegistry.blocks[id]) {
          const shortName = fullName.startsWith('minecraft:')
            ? fullName.slice('minecraft:'.length)
            : fullName;
          const isNonSolid =
            fullName.includes('air') ||
            fullName.includes('fluid') ||
            fullName.includes('torch') ||
            fullName.includes('wire') ||
            fullName.includes('cable');
          const entry = {
            id,
            name: fullName,
            displayName: fullName,
            hardness: 2.0,
            resistance: 6.0,
            stackSize: 64,
            diggable: true,
            material: 'mineable/pickaxe',
            transparent: false,
            emitLight: 0,
            filterLight: 15,
            defaultState: 0,
            minStateId: 0,
            maxStateId: 0,
            states: [],
            drops: [],
            boundingBox: isNonSolid ? 'empty' : 'block',
            shapes: isNonSolid ? [] : [[0, 0, 0, 1, 1, 1]]
          };
          botRegistry.blocks[id] = entry;
          botRegistry.blocksByName[fullName] = entry;
          if (!botRegistry.blocksByName[shortName]) {
            botRegistry.blocksByName[shortName] = entry;
          }
          if (Array.isArray(botRegistry.blocksArray)) {
            botRegistry.blocksArray.push(entry);
          }
          blocksInjected++;
        }
      }
    }

    if (botRegistry.entities && botRegistry.entitiesByName) {
      for (const [id, fullName] of this.numericToEntityName.entries()) {
        if (!botRegistry.entities[id]) {
          const entry = {
            id,
            internalId: id,
            name: fullName,
            displayName: fullName,
            width: 0.6,
            height: 1.8,
            type: 'mob',
            category: 'Modded'
          };
          botRegistry.entities[id] = entry;
          botRegistry.entitiesByName[fullName] = entry;
          entitiesInjected++;
        }
      }
    }

    installModdedBlockStateFallback(botRegistry);

    return { itemsInjected, blocksInjected, entitiesInjected };
  }

  /**
   * Converts a Prismarine Item / 1.20.1 slot object into a canonical ResourceLocation
   * (`gtceu:basic_electronic_circuit`, `kubejs:advanced_control_circuit`, etc.).
   */
  toCanonicalItemId(item) {
    if (!item || item.present === false) return null;
    if (typeof item === 'string') return normalizeItemId(item);
    if (item.canonicalId) return normalizeItemId(item.canonicalId);

    const numericId = item.itemId ?? item.type ?? item.blockId;
    if (Number.isFinite(numericId) && numericId >= 0) {
      const mapped =
        this.numericToItemName.get(numericId) ||
        this.numericToBlockName.get(numericId);
      if (mapped) return mapped;
    }

    if (item.name && item.name !== 'unknown') {
      return normalizeItemId(item.name.includes(':') ? item.name : `minecraft:${item.name}`);
    }

    if (Number.isFinite(numericId) && numericId >= 0) {
      return `id:${numericId}`;
    }

    return null;
  }

  /**
   * Converts a canonical ResourceLocation (`gtceu:lv_bender`) into a 1.20.1 wire slot descriptor.
   */
  fromCanonicalItemId(canonicalId, mcRegistry = null) {
    const clean = normalizeItemId(canonicalId);
    let numericId =
      this.itemNameToNumeric.get(clean) ??
      this.blockNameToNumeric.get(clean) ??
      null;

    if (numericId === null && mcRegistry) {
      const shortName = clean.replace(/^minecraft:/, '');
      if (mcRegistry.itemsByName?.[clean]) {
        numericId = mcRegistry.itemsByName[clean].id;
      } else if (mcRegistry.itemsByName?.[shortName]) {
        numericId = mcRegistry.itemsByName[shortName].id;
      } else if (mcRegistry.blocksByName?.[clean]) {
        numericId = mcRegistry.blocksByName[clean].id;
      } else if (mcRegistry.blocksByName?.[shortName]) {
        numericId = mcRegistry.blocksByName[shortName].id;
      }
    }

    return {
      itemId: numericId ?? 1,
      blockId: numericId ?? 1,
      baseName: clean,
      metadata: 0
    };
  }
}

/**
 * Wraps `botRegistry.blocksByStateId` once in a lightweight Proxy so any modded blockStateId
 * beyond vanilla's static table resolves to a solid 1x1x1 block instead of `boundingBox: 'empty'`
 * (preventing Mineflayer physics from falling through modded factory/skyblock floors).
 */
function installModdedBlockStateFallback(botRegistry) {
  if (!botRegistry || !botRegistry.blocksByStateId || botRegistry._gtlModdedStateProxyInstalled) {
    return;
  }

  const rawByState = botRegistry.blocksByStateId;
  const syntheticCache = new Map();
  botRegistry._gtlModdedStateProxyInstalled = true;

  botRegistry.blocksByStateId = new Proxy(rawByState, {
    get(target, prop, receiver) {
      const existing = Reflect.get(target, prop, receiver);
      if (existing !== undefined) return existing;

      if (typeof prop === 'string') {
        const stateId = Number(prop);
        if (Number.isInteger(stateId) && stateId > 0) {
          let cached = syntheticCache.get(stateId);
          if (!cached) {
            cached = {
              id: 1,
              name: `forge:modded_state_${stateId}`,
              displayName: `Modded Block (#${stateId})`,
              minStateId: stateId,
              maxStateId: stateId,
              defaultState: stateId,
              states: [],
              hardness: 2.0,
              resistance: 6.0,
              stackSize: 64,
              diggable: true,
              material: 'mineable/pickaxe',
              transparent: false,
              boundingBox: 'block',
              shapes: [[0, 0, 0, 1, 1, 1]],
              drops: []
            };
            // Bound cache size on low-RAM systems
            if (syntheticCache.size > 4096) {
              syntheticCache.clear();
            }
            syntheticCache.set(stateId, cached);
          }
          return cached;
        }
      }
      return undefined;
    }
  });
}

function encodeVarInt(value) {
  const bytes = [];
  let v = value >>> 0;
  while ((v & ~0x7f) !== 0) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v & 0x7f);
  return Buffer.from(bytes);
}

function encodeVarIntString(str) {
  const strBuf = Buffer.from(String(str), 'utf8');
  return Buffer.concat([encodeVarInt(strBuf.length), strBuf]);
}

function readVarInt(buffer, startOffset) {
  let numRead = 0;
  let result = 0;
  let read;
  let offset = startOffset;
  do {
    if (offset >= buffer.length) {
      throw new RangeError('Buffer underflow while reading VarInt');
    }
    read = buffer.readUInt8(offset++);
    result |= (read & 0x7f) << (7 * numRead);
    numRead++;
    if (numRead > 5) {
      throw new Error('VarInt exceeds 5 bytes');
    }
  } while ((read & 0x80) !== 0);

  return { value: result, nextOffset: offset };
}

/**
 * Forge `IndexedMessageCodec` writes SimpleChannel discriminators as `writeByte(index & 0xff)`.
 * For indices `0..127` (`1, 2, 3, 4, 5, 6, 99`), `u8` and `varint` are byte-identical (`1 byte`);
 * reading `u8` directly also supports any mod SimpleChannel discriminator `128..255`.
 */
function readU8DiscriminatorOrVarInt(buffer, startOffset) {
  if (startOffset >= buffer.length) {
    throw new RangeError('Buffer underflow while reading SimpleChannel discriminator');
  }
  return {
    value: buffer.readUInt8(startOffset),
    nextOffset: startOffset + 1
  };
}

function readVarIntString(buffer, startOffset) {
  const lenRes = readVarInt(buffer, startOffset);
  const end = lenRes.nextOffset + lenRes.value;
  if (end > buffer.length) {
    throw new RangeError('Buffer underflow while reading string');
  }
  return {
    value: buffer.toString('utf8', lenRes.nextOffset, end),
    nextOffset: end
  };
}

/**
 * Wraps an inner payload inside a Forge 1.20.1 `fml:loginwrapper` frame:
 * `[ResourceLocation channel][VarInt length][byte[] innerPayload]`.
 */
function wrapFmlLoginWrapper(subChannel, innerBuffer) {
  return Buffer.concat([
    encodeVarIntString(subChannel),
    encodeVarInt(innerBuffer.length),
    innerBuffer
  ]);
}

/**
 * Unwraps a Forge 1.20.1 `fml:loginwrapper` frame into `{ subChannel, innerBuffer }`.
 */
function unwrapFmlLoginWrapper(wrapperBuffer) {
  const chRes = readVarIntString(wrapperBuffer, 0);
  const lenRes = readVarInt(wrapperBuffer, chRes.nextOffset);
  const start = lenRes.nextOffset;
  const end = Math.min(wrapperBuffer.length, start + lenRes.value);
  return {
    subChannel: chRes.value,
    innerBuffer: wrapperBuffer.subarray(start, end)
  };
}

/**
 * Parses a Forge 1.20.1 `S2CModData` (`discriminator = 5`) inner buffer:
 * `[5: u8][count: varint][modId: utf, displayName: utf, version: utf]...`
 */
function parseFml3ModData(innerBuffer) {
  let offset = 0;
  const pktId = readU8DiscriminatorOrVarInt(innerBuffer, offset);
  offset = pktId.nextOffset;

  const mods = {};
  if (offset < innerBuffer.length) {
    const count = readVarInt(innerBuffer, offset);
    offset = count.nextOffset;
    for (let i = 0; i < count.value && offset < innerBuffer.length; i++) {
      const modId = readVarIntString(innerBuffer, offset);
      offset = modId.nextOffset;
      const displayName = readVarIntString(innerBuffer, offset);
      offset = displayName.nextOffset;
      const version = readVarIntString(innerBuffer, offset);
      offset = version.nextOffset;
      mods[modId.value] = {
        displayName: displayName.value,
        version: version.value
      };
    }
  }
  return { packetId: pktId.value, mods };
}

/**
 * Parses a Forge 1.20.1 `S2CModList` (`discriminator = 1`) inner buffer:
 * `[1: u8][mods: string[]][channels: Map<RL,string>][registries: RL[]][dataPackRegistries?: RL[]]`.
 */
function parseFml3ModList(innerBuffer) {
  let offset = 0;
  const pktId = readU8DiscriminatorOrVarInt(innerBuffer, offset);
  offset = pktId.nextOffset;

  const modsCount = readVarInt(innerBuffer, offset);
  offset = modsCount.nextOffset;
  const mods = [];
  for (let i = 0; i < modsCount.value && offset < innerBuffer.length; i++) {
    const m = readVarIntString(innerBuffer, offset);
    offset = m.nextOffset;
    mods.push(m.value);
  }

  const channels = [];
  if (offset < innerBuffer.length) {
    const chCount = readVarInt(innerBuffer, offset);
    offset = chCount.nextOffset;
    for (let i = 0; i < chCount.value && offset < innerBuffer.length; i++) {
      const chName = readVarIntString(innerBuffer, offset);
      offset = chName.nextOffset;
      const chVer = readVarIntString(innerBuffer, offset);
      offset = chVer.nextOffset;
      channels.push({ channel: chName.value, version: chVer.value });
    }
  }

  const registries = [];
  if (offset < innerBuffer.length) {
    const regCount = readVarInt(innerBuffer, offset);
    offset = regCount.nextOffset;
    for (let i = 0; i < regCount.value && offset < innerBuffer.length; i++) {
      const rName = readVarIntString(innerBuffer, offset);
      offset = rName.nextOffset;
      registries.push(rName.value);
    }
  }

  const dataPackRegistries = [];
  if (offset < innerBuffer.length) {
    try {
      const dpCount = readVarInt(innerBuffer, offset);
      offset = dpCount.nextOffset;
      for (let i = 0; i < dpCount.value && offset < innerBuffer.length; i++) {
        const dpName = readVarIntString(innerBuffer, offset);
        offset = dpName.nextOffset;
        dataPackRegistries.push(dpName.value);
      }
    } catch (_) {
      // FML2 servers omit the 4th dataPackRegistries array
    }
  }

  return { packetId: pktId.value, mods, channels, registries, dataPackRegistries };
}

/**
 * Parses a Forge 1.20.1 `S2CConfigData` (`discriminator = 4`) inner buffer:
 * `[4: u8][fileName: utf][fileData: varint-prefixed byte[]]`
 */
function parseFml3ConfigData(innerBuffer) {
  let offset = 0;
  const pktId = readU8DiscriminatorOrVarInt(innerBuffer, offset);
  offset = pktId.nextOffset;
  if (offset >= innerBuffer.length) {
    return { packetId: pktId.value, fileName: '', byteLength: 0 };
  }
  const nameRes = readVarIntString(innerBuffer, offset);
  offset = nameRes.nextOffset;
  let byteLength = innerBuffer.length - offset;
  if (offset < innerBuffer.length) {
    try {
      const lenRes = readVarInt(innerBuffer, offset);
      byteLength = lenRes.value;
    } catch (_) {
      // Keep remaining buffer length fallback
    }
  }
  return { packetId: pktId.value, fileName: nameRes.value, byteLength };
}

/**
 * Parses a Forge 1.20.1 `S2CChannelMismatchData` (`discriminator = 6`) inner buffer.
 */
function parseFml3ChannelMismatch(innerBuffer) {
  let offset = 0;
  const pktId = readU8DiscriminatorOrVarInt(innerBuffer, offset);
  offset = pktId.nextOffset;
  const mismatches = {};
  if (offset < innerBuffer.length) {
    const count = readVarInt(innerBuffer, offset);
    offset = count.nextOffset;
    for (let i = 0; i < count.value && offset < innerBuffer.length; i++) {
      const ch = readVarIntString(innerBuffer, offset);
      offset = ch.nextOffset;
      const ver = readVarIntString(innerBuffer, offset);
      offset = ver.nextOffset;
      mismatches[ch.value] = ver.value;
    }
  }
  return { packetId: pktId.value, mismatches };
}

/**
 * Parses a Forge 1.20.1 `fml:play` `PlayMessages.OpenContainer` (`discriminator = 1`) buffer:
 * `[1: u8][menuTypeId: varint][windowId: varint][windowTitleJson: utf][extraData: varint + bytes]`
 */
function parseFmlPlayOpenContainer(payloadBuffer) {
  if (!Buffer.isBuffer(payloadBuffer) || payloadBuffer.length < 3) return null;
  let offset = 0;
  const disc = payloadBuffer.readUInt8(offset++);
  if (disc !== FML3PlayPacketId.OPEN_CONTAINER) return null;

  const menuTypeRes = readVarInt(payloadBuffer, offset);
  offset = menuTypeRes.nextOffset;
  const windowIdRes = readVarInt(payloadBuffer, offset);
  offset = windowIdRes.nextOffset;
  const titleRes = readVarIntString(payloadBuffer, offset);
  offset = titleRes.nextOffset;

  let extraData = Buffer.alloc(0);
  if (offset < payloadBuffer.length) {
    try {
      const extraLen = readVarInt(payloadBuffer, offset);
      offset = extraLen.nextOffset;
      extraData = payloadBuffer.subarray(offset, Math.min(payloadBuffer.length, offset + extraLen.value));
    } catch (_) {
      extraData = payloadBuffer.subarray(offset);
    }
  }

  return {
    menuTypeId: menuTypeRes.value,
    windowId: windowIdRes.value,
    windowTitle: titleRes.value,
    extraData
  };
}

/**
 * Serializes a Forge 1.20.1 `C2SModListReply` (`discriminator = 2`) inner buffer:
 * `[2: u8][mods: array<string>][channels: map<string,string>][registries: map<string,string>]`.
 */
function buildFml3ModListReply({ mods = [], channels = [], registries = [], omitChannels = DEFAULT_OMITTED_OPTIONAL_CHANNELS }) {
  const chunks = [Buffer.from([FML3HandshakePacketId.C2S_MOD_LIST_REPLY])];

  chunks.push(encodeVarInt(mods.length));
  for (const modId of mods) {
    chunks.push(encodeVarIntString(modId));
  }

  const filteredChannels = channels.filter((ch) => {
    const name = ch.channel || ch.name;
    if (!name) return false;
    if (omitChannels && omitChannels.has(name)) return false;
    return true;
  });

  chunks.push(encodeVarInt(filteredChannels.length));
  for (const ch of filteredChannels) {
    chunks.push(encodeVarIntString(ch.channel || ch.name));
    chunks.push(encodeVarIntString(ch.version ?? ch.marker ?? ''));
  }

  chunks.push(encodeVarInt(registries.length));
  for (const reg of registries) {
    const name = typeof reg === 'string' ? reg : reg.name;
    const marker = typeof reg === 'string' ? '' : reg.marker || '';
    chunks.push(encodeVarIntString(name));
    chunks.push(encodeVarIntString(marker));
  }

  return Buffer.concat(chunks);
}

/**
 * Serializes a Forge 1.20.1 `C2SAcknowledge` (`discriminator = 99`) inner buffer (`0x63`).
 */
function buildFml3Ack() {
  return Buffer.from([FML3HandshakePacketId.C2S_ACK]);
}

/**
 * Serializes a server-side `S2CModData` (`discriminator = 5`) inner buffer (used in integration tests).
 */
function buildFml3ServerModData(modEntries = []) {
  const chunks = [Buffer.from([FML3HandshakePacketId.S2C_MOD_DATA])];
  chunks.push(encodeVarInt(modEntries.length));
  for (const entry of modEntries) {
    const modId = typeof entry === 'string' ? entry : entry.modId;
    const displayName = typeof entry === 'string' ? entry : entry.displayName || entry.modId;
    const version = typeof entry === 'string' ? '1.0.0' : entry.version || '1.0.0';
    chunks.push(encodeVarIntString(modId));
    chunks.push(encodeVarIntString(displayName));
    chunks.push(encodeVarIntString(version));
  }
  return Buffer.concat(chunks);
}

/**
 * Serializes a server-side `S2CModList` (`discriminator = 1`) inner buffer (used in integration tests).
 */
function buildFml3ServerModList({ mods = [], channels = [], registries = [], dataPackRegistries = [] }) {
  const chunks = [Buffer.from([FML3HandshakePacketId.S2C_MOD_LIST])];
  chunks.push(encodeVarInt(mods.length));
  for (const m of mods) chunks.push(encodeVarIntString(m));
  chunks.push(encodeVarInt(channels.length));
  for (const ch of channels) {
    chunks.push(encodeVarIntString(ch.channel || ch.name));
    chunks.push(encodeVarIntString(ch.version ?? ch.marker ?? '1'));
  }
  chunks.push(encodeVarInt(registries.length));
  for (const r of registries) chunks.push(encodeVarIntString(r));
  chunks.push(encodeVarInt(dataPackRegistries.length));
  for (const dp of dataPackRegistries) chunks.push(encodeVarIntString(dp));
  return Buffer.concat(chunks);
}

/**
 * Serializes a binary Forge 1.20.1 `S2CRegistry` (`discriminator = 3`) inner buffer
 * matching `ForgeRegistry.Snapshot#write(FriendlyByteBuf)` (`ids`, `aliases`, `overrides`, `blocked`, `dummied`).
 */
function buildFml3ServerRegistry(registryName, idsMap = null) {
  const chunks = [
    Buffer.from([FML3HandshakePacketId.S2C_SERVER_REGISTRY]),
    encodeVarIntString(registryName)
  ];
  if (!idsMap) {
    chunks.push(Buffer.from([0x00]));
    return Buffer.concat(chunks);
  }
  chunks.push(Buffer.from([0x01]));
  const entries = idsMap instanceof Map ? Array.from(idsMap.entries()) : Object.entries(idsMap);
  chunks.push(encodeVarInt(entries.length));
  for (const [key, numId] of entries) {
    chunks.push(encodeVarIntString(key));
    chunks.push(encodeVarInt(Number(numId)));
  }
  // Empty aliases (0), overrides (0), blocked (0), dummied (0)
  chunks.push(Buffer.from([0x00, 0x00, 0x00, 0x00]));
  return Buffer.concat(chunks);
}

/**
 * Serializes a server-side `S2CConfigData` (`discriminator = 4`) inner buffer.
 */
function buildFml3ServerConfigData(fileName, contentBufferOrStr) {
  const fileBuf = Buffer.isBuffer(contentBufferOrStr)
    ? contentBufferOrStr
    : Buffer.from(String(contentBufferOrStr || ''), 'utf8');
  return Buffer.concat([
    Buffer.from([FML3HandshakePacketId.S2C_CONFIG_DATA]),
    encodeVarIntString(fileName),
    encodeVarInt(fileBuf.length),
    fileBuf
  ]);
}

/**
 * Decodes Forge 1.20.1's `ServerStatusPing` UTF-16 `forgeData.d` packed binary payload
 * (`ServerStatusPing.decodeOptimized` + `deserializeOptimized` in `MinecraftForge 47.4.16`).
 */
function decodeForgeOptimizedPing(encodedStr, fmlNetworkVersion = 3) {
  if (typeof encodedStr !== 'string' || encodedStr.length < 2) {
    return { fmlNetworkVersion, truncated: false, mods: {}, channels: {} };
  }

  const size0 = encodedStr.charCodeAt(0);
  const size1 = encodedStr.charCodeAt(1);
  const totalBytes = size0 | (size1 << 15);
  const out = Buffer.alloc(totalBytes);

  let writePos = 0;
  let strIdx = 2;
  let bitBuf = 0;
  let bitsInBuf = 0;

  while (strIdx < encodedStr.length && writePos < totalBytes) {
    while (bitsInBuf >= 8 && writePos < totalBytes) {
      out[writePos++] = bitBuf & 0xff;
      bitBuf >>>= 8;
      bitsInBuf -= 8;
    }
    const c = encodedStr.charCodeAt(strIdx++);
    bitBuf |= (c & 0x7fff) << bitsInBuf;
    bitsInBuf += 15;
  }

  while (writePos < totalBytes) {
    out[writePos++] = bitBuf & 0xff;
    bitBuf >>>= 8;
    bitsInBuf -= 8;
  }

  let offset = 0;
  const truncated = out.readUInt8(offset++) !== 0;
  const modsSize = out.readUInt16BE(offset);
  offset += 2;

  const mods = {};
  const channels = {};

  for (let i = 0; i < modsSize && offset < out.length; i++) {
    const flagRes = readVarInt(out, offset);
    offset = flagRes.nextOffset;
    const channelCount = flagRes.value >>> 1;
    const isIgnoreServerOnly = (flagRes.value & 0b1) !== 0;

    const modIdRes = readVarIntString(out, offset);
    offset = modIdRes.nextOffset;

    let modVersion = 'IGNORESERVERONLY';
    if (!isIgnoreServerOnly) {
      const modVerRes = readVarIntString(out, offset);
      offset = modVerRes.nextOffset;
      modVersion = modVerRes.value;
    }
    mods[modIdRes.value] = modVersion;

    for (let j = 0; j < channelCount && offset < out.length; j++) {
      const pathRes = readVarIntString(out, offset);
      offset = pathRes.nextOffset;
      const verRes = readVarIntString(out, offset);
      offset = verRes.nextOffset;
      const requiredOnClient = out.readUInt8(offset++) !== 0;
      const fullChannel = `${modIdRes.value}:${pathRes.value}`;
      channels[fullChannel] = {
        version: verRes.value,
        required: requiredOnClient
      };
    }
  }

  if (offset < out.length) {
    try {
      const nonModRes = readVarInt(out, offset);
      offset = nonModRes.nextOffset;
      for (let i = 0; i < nonModRes.value && offset < out.length; i++) {
        const chRes = readVarIntString(out, offset);
        offset = chRes.nextOffset;
        const verRes = readVarIntString(out, offset);
        offset = verRes.nextOffset;
        const requiredOnClient = out.readUInt8(offset++) !== 0;
        channels[chRes.value] = {
          version: verRes.value,
          required: requiredOnClient
        };
      }
    } catch (_) {
      // Truncated tail safe ignore
    }
  }

  return { fmlNetworkVersion, truncated, mods, channels };
}

/**
 * Queries a live Forge server status ping (`mc.ping`) and extracts its exact Minecraft version,
 * Forge network protocol (`FML3` vs `FML2` vs `FML`), mod count, and sample mod IDs.
 */
async function probeForgeServer({ host = '127.0.0.1', port = 25565, version = '1.20.1', timeoutMs = 6000 } = {}) {
  const response = await Promise.race([
    mc.ping({ host, port: Number(port), version }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Server ping timed out after ${timeoutMs}ms`)), timeoutMs)
    )
  ]);

  let fmlNetworkVersion = null;
  let fmlMarker = '\0FML3\0';
  let mods = {};
  let channels = {};

  if (response.forgeData) {
    fmlNetworkVersion = response.forgeData.fmlNetworkVersion ?? (response.forgeData.d ? 3 : 2);
    fmlMarker = fmlNetworkVersion === 2 ? '\0FML2\0' : '\0FML3\0';

    if (typeof response.forgeData.d === 'string' && response.forgeData.d.length >= 2) {
      const decoded = decodeForgeOptimizedPing(response.forgeData.d, fmlNetworkVersion);
      mods = decoded.mods;
      channels = decoded.channels;
    } else if (Array.isArray(response.forgeData.mods)) {
      for (const m of response.forgeData.mods) {
        mods[m.modId || m.modid] = m.modmarker || '';
      }
      if (Array.isArray(response.forgeData.channels)) {
        for (const c of response.forgeData.channels) {
          channels[c.res] = { version: c.version, required: Boolean(c.required) };
        }
      }
    }
  } else if (response.modinfo && response.modinfo.type === 'FML') {
    fmlNetworkVersion = 1;
    fmlMarker = '\0FML\0';
    for (const m of response.modinfo.modList || []) {
      mods[m.modid] = m.version || '';
    }
  }

  return {
    host,
    port: Number(port),
    minecraftVersion: response.version?.name || version,
    protocolVersion: response.version?.protocol ?? null,
    playersOnline: response.players?.online ?? 0,
    playersMax: response.players?.max ?? 0,
    isForge: fmlNetworkVersion !== null,
    fmlNetworkVersion,
    fmlMarker,
    modsCount: Object.keys(mods).length,
    modIds: Object.keys(mods),
    channelsCount: Object.keys(channels).length,
    channels,
    rawForgeDataPresent: Boolean(response.forgeData)
  };
}

/**
 * Attaches the complete Forge 1.20.1 (`FML3` / `FML2` `fml:loginwrapper` + `fml:play`)
 * handshake and play-channel handler onto a `minecraft-protocol` / Mineflayer client (`bot._client`).
 *
 * Key guarantees verified against `MinecraftForge 47.4.16` (`1.20.1`):
 *  1. Removes `minecraft-protocol`'s default `onLoginPluginRequest` listener so it NEVER sends
 *     an empty `{ messageId }` response that triggers `"Unexpected custom data from client"`.
 *  2. Tags `set_protocol.serverHost` with `\0FML3\0` (`client.tagHost` + `write` guard) so
 *     `ServerLifecycleHooks.handleServerLogin` recognizes `ConnectionType.MODDED` (`FML3`).
 *  3. Handles `S2CModData` (`5`, `.noResponse()`), `S2CModList` (`1`, reflecting server mods &
 *     required channels in `C2SModListReply`), `S2CRegistry` (`3`), `S2CConfigData` (`4`),
 *     `S2CChannelMismatchData` (`6`), and custom mod `fml:loginwrapper` login packets.
 *  4. Decodes `fml:play` `PlayMessages.OpenContainer` (`1`) so `NetworkHooks.openScreen` GUIs
 *     (GTCEu Modern / LDLib / AE2 / Sophisticated Storage) open seamlessly on `ContainerPacketController`.
 */
function attachForgeHandshake(client, options = {}) {
  const registryBridge = options.registryBridge || new ForgeRegistryBridge();
  const autoMirrorServerMods = options.autoMirrorServerMods ?? true;
  const ackModData = Boolean(options.ackModData ?? false);
  const omitChannels = options.omitChannels ?? DEFAULT_OMITTED_OPTIONAL_CHANNELS;
  const fallbackMods = Array.isArray(options.forgeMods) && options.forgeMods.length > 0
    ? options.forgeMods.map((m) => (typeof m === 'string' ? m : m.modid || m.modId))
    : DEFAULT_GTL_MODLIST;

  if (options.useAutoVersionForge && forgePlugin && typeof forgePlugin.autoVersionForge === 'function') {
    forgePlugin.autoVersionForge(client);
  }

  const fmlMarker = options.fmlMarker || '\0FML3\0';
  const fmlVersionLabel = fmlMarker.replace(/\0/g, '') || 'FML3';
  client.tagHost = fmlMarker;
  client.fmlHandshakeState = FMLHandshakeClientState.START;
  client.registriesSynced = 0;
  client.configsSynced = 0;
  client.syncedConfigFiles = [];

  // CRITICAL FIX #1: Remove node-minecraft-protocol's built-in `onLoginPluginRequest` listener
  // (`src/client/pluginChannels.js`), which otherwise immediately replies with `{ messageId }`
  // (`data: undefined`) and causes Forge 1.20.1 to disconnect with `unexpected_query_response`!
  if (typeof client.listeners === 'function' && typeof client.removeListener === 'function') {
    const existingListeners = client.listeners('login_plugin_request');
    for (const fn of existingListeners) {
      if (fn && fn.name === 'onLoginPluginRequest') {
        client.removeListener('login_plugin_request', fn);
      }
    }
  }

  // Belt-and-suspenders guard ensuring `set_protocol.serverHost` always carries `\0FML3\0` / `\0FML2\0`
  if (typeof client.write === 'function' && !client._fmlSetProtocolWrapped) {
    const rawWrite = client.write.bind(client);
    client._fmlSetProtocolWrapped = true;
    client.write = (packetName, params) => {
      if (
        packetName === 'set_protocol' &&
        params &&
        typeof params.serverHost === 'string' &&
        !params.serverHost.includes('\0FML')
      ) {
        params.serverHost = buildForgeTaggedHost(params.serverHost, client.tagHost || fmlMarker);
      }
      return rawWrite(packetName, params);
    };
  }

  const sendLoginPluginResponse = (messageId, dataBufferOrNull) => {
    if (typeof client.write === 'function') {
      client.write('login_plugin_response', {
        messageId,
        data: dataBufferOrNull
      });
    }
  };

  const handleLoginPluginRequest = (packet) => {
    if (!packet) return;
    const { messageId, channel, data } = packet;

    if (channel !== 'fml:loginwrapper' || !data || data.length === 0) {
      // Non-Forge optional login query (e.g. proxy/Velocity query): reply null per Vanilla 1.20.1
      sendLoginPluginResponse(messageId, null);
      return;
    }

    const rawBuf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const { subChannel, innerBuffer } = unwrapFmlLoginWrapper(rawBuf);

    if (subChannel !== 'fml:handshake' || innerBuffer.length === 0) {
      // CRITICAL FIX #2: Any mod login payload wrapped in `fml:loginwrapper` that expects an
      // indexed reply has its sequence number tracked in `HandshakeHandler.sentMessages` on the
      // server. Sending `C2SAcknowledge` (99) targeted to `fml:handshake` runs
      // `HandshakeHandler.indexFirst(handleClientAck)`, clearing `sentMessages` cleanly!
      sendLoginPluginResponse(messageId, wrapFmlLoginWrapper('fml:handshake', buildFml3Ack()));
      return;
    }

    const pktId = readU8DiscriminatorOrVarInt(innerBuffer, 0).value;

    switch (pktId) {
      case FML3HandshakePacketId.S2C_MOD_DATA: {
        // Forge 1.20.1 sends S2CModData (id = 5) FIRST, registered with `.noResponse()`.
        // Official Forge clients store `ConnectionData` and do NOT send a login_plugin_response
        // unless explicitly requested in synthetic test harnesses (`ackModData: true`).
        const parsedModData = parseFml3ModData(innerBuffer);
        client.serverForgeModData = parsedModData.mods;
        client.emit('fmlModData', parsedModData.mods);
        if (ackModData) {
          sendLoginPluginResponse(messageId, wrapFmlLoginWrapper('fml:handshake', buildFml3Ack()));
        }
        break;
      }

      case FML3HandshakePacketId.S2C_MOD_LIST: {
        const parsed = parseFml3ModList(innerBuffer);
        client.serverForgeMods = parsed.mods;
        client.serverForgeChannels = parsed.channels;
        client.serverDataPackRegistries = parsed.dataPackRegistries;
        client.fmlHandshakeState = FMLHandshakeClientState.WAITINGSERVERDATA;

        client.emit('fmlHandshakeStart', {
          protocol: fmlVersionLabel,
          serverModsCount: parsed.mods.length,
          channelsCount: parsed.channels.length,
          registriesExpected: parsed.registries.length,
          dataPackRegistriesCount: parsed.dataPackRegistries.length
        });
        client.emit('forgeMods', parsed.mods);

        const replyMods = autoMirrorServerMods && parsed.mods.length > 0
          ? parsed.mods
          : fallbackMods;
        const replyInner = buildFml3ModListReply({
          mods: replyMods,
          channels: parsed.channels,
          registries: [],
          omitChannels
        });
        sendLoginPluginResponse(messageId, wrapFmlLoginWrapper('fml:handshake', replyInner));
        client.fmlHandshakeState = FMLHandshakeClientState.WAITINGSERVERCOMPLETE;
        break;
      }

      case FML3HandshakePacketId.S2C_SERVER_REGISTRY: {
        const snap = registryBridge.ingestForge120RegistrySnapshot(innerBuffer);
        client.registriesSynced += 1;
        client.emit('fmlRegistryMapped', snap);
        sendLoginPluginResponse(messageId, wrapFmlLoginWrapper('fml:handshake', buildFml3Ack()));
        break;
      }

      case FML3HandshakePacketId.S2C_CONFIG_DATA: {
        const cfg = parseFml3ConfigData(innerBuffer);
        client.configsSynced += 1;
        if (cfg.fileName) {
          client.syncedConfigFiles.push(cfg.fileName);
        }
        client.emit('fmlConfigSynced', cfg);
        sendLoginPluginResponse(messageId, wrapFmlLoginWrapper('fml:handshake', buildFml3Ack()));
        client.fmlHandshakeState = FMLHandshakeClientState.PENDINGCOMPLETE;
        break;
      }

      case FML3HandshakePacketId.S2C_CHANNEL_MISMATCH_DATA: {
        const mismatch = parseFml3ChannelMismatch(innerBuffer);
        client.emit('fmlChannelMismatch', mismatch.mismatches);
        sendLoginPluginResponse(messageId, wrapFmlLoginWrapper('fml:handshake', buildFml3Ack()));
        break;
      }

      default: {
        sendLoginPluginResponse(messageId, wrapFmlLoginWrapper('fml:handshake', buildFml3Ack()));
        break;
      }
    }
  };

  // Decode Forge 1.20.1 `fml:play` custom_payload packets (`PlayMessages.OpenContainer`)
  const handleCustomPayload = (packet) => {
    if (!packet || packet.channel !== 'fml:play' || !packet.data) return;
    const buf = Buffer.isBuffer(packet.data) ? packet.data : Buffer.from(packet.data);
    if (buf.length === 0) return;

    const discriminator = buf.readUInt8(0);
    if (discriminator === FML3PlayPacketId.OPEN_CONTAINER) {
      const opened = parseFmlPlayOpenContainer(buf);
      if (opened) {
        const menuTypeName = registryBridge.numericToMenuName.get(opened.menuTypeId) || null;
        const containerEvent = {
          windowId: opened.windowId,
          inventoryType: menuTypeName || opened.menuTypeId,
          menuTypeId: opened.menuTypeId,
          menuTypeName,
          windowTitle: opened.windowTitle,
          extraData: opened.extraData
        };
        client.emit('fmlOpenContainer', containerEvent);
      }
    }
  };

  if (typeof client.on === 'function') {
    if (!client._fmlHandshakeAttached) {
      client._fmlHandshakeAttached = true;

      // Ensure `minecraft-protocol/src/client/chat.js` sees a valid empty command root
      // after `packet_declare_commands` consumes modded Forge command nodes as `restBuffer`
      // (otherwise `chat.js` calls `rejectCommandTree()` -> `client.end('impossibleCommandTree')`!).
      if (typeof client.prependListener === 'function') {
        client.prependListener('declare_commands', (pkt) => {
          if (pkt && !Array.isArray(pkt.nodes)) {
            pkt.nodes = [{ flags: { command_node_type: 0 }, children: [] }];
            pkt.rootIndex = 0;
          }
        });
      }

      client.on('login_plugin_request', handleLoginPluginRequest);
      client.on('custom_payload', handleCustomPayload);
      client.once?.('success', () => {
        client.fmlHandshakeState = FMLHandshakeClientState.COMPLETE;
        client.emit('fmlHandshakeComplete', {
          protocol: fmlVersionLabel,
          fmlVersion: fmlVersionLabel,
          modsCount: (client.serverForgeMods || []).length,
          registriesSynced: client.registriesSynced,
          configsSynced: client.configsSynced,
          mappedItems: registryBridge.numericToItemName.size,
          mappedBlocks: registryBridge.numericToBlockName.size,
          mappedEntities: registryBridge.numericToEntityName.size,
          mappedMenus: registryBridge.numericToMenuName.size
        });
      });
    }
  }

  return {
    proto: new ProtoDef(),
    registryBridge,
    handleLoginPluginRequest,
    handleCustomPayload,
    getState: () => client.fmlHandshakeState
  };
}

const FML_LOGIN_WRAPPER_CHANNEL = 'fml:loginwrapper';
const FML_HANDSHAKE_CHANNEL = 'fml:handshake';
const FML_PLAY_CHANNEL = 'fml:play';

module.exports = {
  DEFAULT_GTL_MODLIST,
  DEFAULT_GTNH_MODLIST: DEFAULT_GTL_MODLIST,
  DEFAULT_OMITTED_OPTIONAL_CHANNELS,
  FML_LOGIN_WRAPPER_CHANNEL,
  FML_HANDSHAKE_CHANNEL,
  FML_PLAY_CHANNEL,
  FML3HandshakePacketId,
  FML3PlayPacketId,
  FMLHandshakeClientState,
  ForgeRegistryBridge,
  attachForgeHandshake,
  buildModded1201CustomPackets,
  buildForgeTaggedHost,
  installModdedBlockStateFallback,
  wrapFmlLoginWrapper,
  wrapLoginPluginPayload: wrapFmlLoginWrapper,
  unwrapFmlLoginWrapper,
  parseFml3ModData,
  parseFml3ModList,
  parseFml3ConfigData,
  parseFml3ChannelMismatch,
  parseFmlPlayOpenContainer,
  buildFml3ModListReply,
  buildFml3ServerModData,
  buildFml3ServerModList,
  buildFml3ServerRegistry,
  buildFml3ServerConfigData,
  buildFml3Ack,
  decodeForgeOptimizedPing,
  probeForgeServer,
  encodeVarInt,
  encodeVarIntString,
  readVarInt,
  readVarIntString,
  normalizeItemId,
  splitCanonicalItemId
};
