'use strict';

const { EventEmitter } = require('events');
const { ProtoDef } = require('protodef');
const forgePlugin = require('@tcortega/minecraft-protocol-forge');

/**
 * Default Forge 1.20.1 mod signature for GregTech Leisure (GTL 1.4.5.x, Forge 47.4.16).
 * Note: During live `fml:loginwrapper` (`S2CModList`) negotiation, `autoMirrorServerMods`
 * automatically echoes the server's advertised mod list so minor pack updates (e.g. 1.4.5.2 -> 1.4.5.3)
 * connect seamlessly without manual modlist edits.
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
  'avaritia'
];

/**
 * Forge 1.20.1 (`FML2` / `FML3`) `fml:handshake` packet discriminators inside `fml:loginwrapper`.
 */
const FML3HandshakePacketId = Object.freeze({
  S2C_MOD_LIST: 1,
  C2S_MOD_LIST_REPLY: 2,
  S2C_SERVER_REGISTRY: 3,
  S2C_CONFIG_DATA: 4,
  C2S_ACK: 99
});

/**
 * Legacy Forge `FML|HS` state constants retained for backwards compatibility.
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
 * Normalizes a Minecraft 1.20.1 / GTCEu Modern item or block identifier.
 * Examples:
 *  - `'gtceu:basic_electronic_circuit'` -> `'gtceu:basic_electronic_circuit'`
 *  - `'oak_log'` -> `'minecraft:oak_log'`
 *  - `'gtceu:firebricks:0'` -> `'gtceu:firebricks'` (strips legacy `:0` suffix)
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
  // 3+ segments: strip trailing `:0` metadata from legacy callers, keep non-zero tag/variant if any
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
 * In Minecraft 1.20.1 + Forge 47.4.x, `S2CServerRegistry` snapshots synchronize integer network
 * `itemId` / `blockStateId` indices with flattened strings such as `gtceu:basic_electronic_circuit`
 * and `gtceu:primitive_blast_furnace`.
 */
class ForgeRegistryBridge extends EventEmitter {
  constructor() {
    super();
    this.numericToBlockName = new Map();
    this.blockNameToNumeric = new Map();
    this.numericToItemName = new Map();
    this.itemNameToNumeric = new Map();
  }

  /**
   * Registers a block or item mapping (`gtceu:lv_bender` <-> numeric network ID).
   */
  register(kind, registryName, numericId) {
    const cleanName = normalizeItemId(registryName);
    const id = Number(numericId);
    if (!cleanName || !Number.isFinite(id)) return;

    if (kind === 'block') {
      this.numericToBlockName.set(id, cleanName);
      this.blockNameToNumeric.set(cleanName, id);
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
   * Parses a Forge 1.20.1 `S2CServerRegistry` inner payload (`[pktId=3][registryKey][hasSnapshot]...`)
   * or a legacy `ModIdData` payload, populating `numericToItemName` / `numericToBlockName`.
   */
  ingestForge120RegistrySnapshot(innerBuffer) {
    if (!Buffer.isBuffer(innerBuffer) || innerBuffer.length < 2) {
      return { registryName: null, entriesLoaded: 0 };
    }

    let offset = 0;
    const pktId = readVarInt(innerBuffer, offset);
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

    let entriesLoaded = 0;
    const kind = registryName.includes('block') ? 'block' : 'item';

    // Support JSON snapshot encoding as well as Forge 1.20.1 binary VarInt map encoding
    if (innerBuffer[offset] === 0x7b) {
      try {
        const parsedJson = JSON.parse(innerBuffer.subarray(offset).toString('utf8'));
        const mapObj = parsedJson.entries || parsedJson.ids || parsedJson;
        for (const [entryName, entryId] of Object.entries(mapObj)) {
          if (Number.isFinite(Number(entryId))) {
            this.register(kind, entryName, Number(entryId));
            entriesLoaded++;
          }
        }
        this.emit('updated', { registryName, entriesLoaded });
        return { registryName, entriesLoaded };
      } catch (_) {
        // Fall through to binary VarInt decoder
      }
    }

    try {
      const idsCount = readVarInt(innerBuffer, offset);
      offset = idsCount.nextOffset;
      for (let i = 0; i < idsCount.value && offset < innerBuffer.length; i++) {
        const entryLoc = readVarIntString(innerBuffer, offset);
        offset = entryLoc.nextOffset;
        const entryNum = readVarInt(innerBuffer, offset);
        offset = entryNum.nextOffset;
        this.register(kind, entryLoc.value, entryNum.value);
        entriesLoaded++;
      }
    } catch (_) {
      // Snapshot tail extensions (aliases/overrides/dummied) are safely ignored once ID map is read
    }

    this.emit('updated', { registryName, entriesLoaded });
    return { registryName, entriesLoaded };
  }

  /**
   * Converts a Prismarine Item / 1.20.1 slot object into a canonical ResourceLocation
   * (`gtceu:basic_electronic_circuit`, `kubejs:advanced_control_circuit`, etc.).
   */
  toCanonicalItemId(item) {
    if (!item || item.present === false) return null;
    if (typeof item === 'string') return normalizeItemId(item);
    if (item.canonicalId) return normalizeItemId(item.canonicalId);

    if (item.name) {
      return normalizeItemId(item.name.includes(':') ? item.name : `minecraft:${item.name}`);
    }

    const numericId = item.itemId ?? item.type ?? item.blockId;
    if (Number.isFinite(numericId) && numericId >= 0) {
      const mapped =
        this.numericToItemName.get(numericId) ||
        this.numericToBlockName.get(numericId);
      if (mapped) return mapped;
      return `id:${numericId}`;
    }

    return null;
  }

  /**
   * Converts a canonical ResourceLocation (`gtceu:lv_bender`) into a 1.20.1 wire slot descriptor
   * (`{ present: true, itemId, itemCount, nbtData }`).
   */
  fromCanonicalItemId(canonicalId, mcRegistry = null) {
    const clean = normalizeItemId(canonicalId);
    let numericId =
      this.itemNameToNumeric.get(clean) ??
      this.blockNameToNumeric.get(clean) ??
      null;

    if (numericId === null && mcRegistry) {
      const shortName = clean.replace(/^minecraft:/, '');
      if (mcRegistry.itemsByName?.[shortName]) {
        numericId = mcRegistry.itemsByName[shortName].id;
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
 * Wraps an `fml:handshake` inner payload inside a Forge 1.20.1 `fml:loginwrapper` frame:
 * `[channel: string][length: varint][innerPayload]`.
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
 * Parses a Forge 1.20.1 `S2CModList` (`packetId = 1`) inner buffer:
 * `[1: varint][mods: array<string>][channels: map<string,string>][registries: array<string>]`.
 */
function parseFml3ModList(innerBuffer) {
  let offset = 0;
  const pktId = readVarInt(innerBuffer, offset);
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

  return { packetId: pktId.value, mods, channels, registries };
}

/**
 * Serializes a Forge 1.20.1 `C2SModListReply` (`packetId = 2`) inner buffer:
 * `[2: varint][mods: array<string>][channels: map<string,string>][registries: map<string,string>]`.
 */
function buildFml3ModListReply({ mods = [], channels = [], registries = [] }) {
  const chunks = [encodeVarInt(FML3HandshakePacketId.C2S_MOD_LIST_REPLY)];

  chunks.push(encodeVarInt(mods.length));
  for (const modId of mods) {
    chunks.push(encodeVarIntString(modId));
  }

  chunks.push(encodeVarInt(channels.length));
  for (const ch of channels) {
    chunks.push(encodeVarIntString(ch.channel));
    chunks.push(encodeVarIntString(ch.version));
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
 * Serializes a Forge 1.20.1 `C2SAck` (`packetId = 99`) inner buffer.
 */
function buildFml3Ack() {
  return encodeVarInt(FML3HandshakePacketId.C2S_ACK);
}

/**
 * Serializes a server-side `S2CModList` (`packetId = 1`) inner buffer (used for protocol testing).
 */
function buildFml3ServerModList({ mods = [], channels = [], registries = [] }) {
  const chunks = [encodeVarInt(FML3HandshakePacketId.S2C_MOD_LIST)];
  chunks.push(encodeVarInt(mods.length));
  for (const m of mods) chunks.push(encodeVarIntString(m));
  chunks.push(encodeVarInt(channels.length));
  for (const ch of channels) {
    chunks.push(encodeVarIntString(ch.channel));
    chunks.push(encodeVarIntString(ch.version));
  }
  chunks.push(encodeVarInt(registries.length));
  for (const r of registries) chunks.push(encodeVarIntString(r));
  return Buffer.concat(chunks);
}

/**
 * Attaches the Forge 1.20.1 (`FML3` / `FML2` `fml:loginwrapper`) handshake state machine
 * onto a `minecraft-protocol` / Mineflayer client (`bot._client`).
 *
 * @param {Object} client - Underlying minecraft-protocol Client
 * @param {Object} [options]
 * @param {string[]} [options.forgeMods] - Mod IDs to advertise if `autoMirrorServerMods` is false
 * @param {boolean} [options.autoMirrorServerMods=true] - Echo server's S2CModList & channels for seamless GTL compatibility
 * @param {ForgeRegistryBridge} [options.registryBridge]
 * @param {string} [options.fmlMarker='\0FML3\0'] - Hostname marker (`\0FML3\0` for Forge 47.x 1.20.1, `\0FML2\0` for older)
 */
function attachForgeHandshake(client, options = {}) {
  const registryBridge = options.registryBridge || new ForgeRegistryBridge();
  const autoMirrorServerMods = options.autoMirrorServerMods ?? true;
  const fallbackMods = Array.isArray(options.forgeMods) && options.forgeMods.length > 0
    ? options.forgeMods.map((m) => (typeof m === 'string' ? m : m.modid))
    : DEFAULT_GTL_MODLIST;

  if (options.useAutoVersionForge && forgePlugin && typeof forgePlugin.autoVersionForge === 'function') {
    forgePlugin.autoVersionForge(client);
  }

  // Forge 1.20.1 (47.4.x) inspects serverAddress suffix for \0FML3\0 (or \0FML2\0)
  const fmlMarker = options.fmlMarker || '\0FML3\0';
  client.tagHost = fmlMarker;
  client.fmlHandshakeState = FMLHandshakeClientState.START;
  client.registriesSynced = 0;
  client.configsSynced = 0;

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
        params.serverHost = `${params.serverHost}${fmlMarker}`;
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
      // Acknowledge unknown optional login query with null payload per Vanilla 1.20.1 protocol
      sendLoginPluginResponse(messageId, null);
      return;
    }

    const rawBuf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const { subChannel, innerBuffer } = unwrapFmlLoginWrapper(rawBuf);

    if (subChannel !== 'fml:handshake' || innerBuffer.length === 0) {
      // Reply with standard FML Ack wrapped in loginwrapper
      sendLoginPluginResponse(messageId, wrapFmlLoginWrapper(subChannel, buildFml3Ack()));
      return;
    }

    const pktId = readVarInt(innerBuffer, 0).value;

    switch (pktId) {
      case FML3HandshakePacketId.S2C_MOD_LIST: {
        const parsed = parseFml3ModList(innerBuffer);
        client.serverForgeMods = parsed.mods;
        client.fmlHandshakeState = FMLHandshakeClientState.WAITINGSERVERDATA;
        client.emit('fmlHandshakeStart', {
          protocol: 'FML3',
          serverModsCount: parsed.mods.length,
          registriesExpected: parsed.registries.length
        });
        client.emit('forgeMods', parsed.mods);

        const replyMods = autoMirrorServerMods && parsed.mods.length > 0
          ? parsed.mods
          : fallbackMods;
        const replyInner = buildFml3ModListReply({
          mods: replyMods,
          channels: parsed.channels,
          registries: parsed.registries
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
        client.configsSynced += 1;
        sendLoginPluginResponse(messageId, wrapFmlLoginWrapper('fml:handshake', buildFml3Ack()));
        client.fmlHandshakeState = FMLHandshakeClientState.COMPLETE;
        client.emit('fmlHandshakeComplete', {
          protocol: 'FML3',
          fmlVersion: 'FML3',
          modsCount: (client.serverForgeMods || []).length,
          registriesSynced: client.registriesSynced,
          configsSynced: client.configsSynced,
          mappedItems: registryBridge.numericToItemName.size,
          mappedBlocks: registryBridge.numericToBlockName.size
        });
        break;
      }

      default: {
        sendLoginPluginResponse(messageId, wrapFmlLoginWrapper('fml:handshake', buildFml3Ack()));
        break;
      }
    }
  };

  if (typeof client.on === 'function') {
    client.on('login_plugin_request', handleLoginPluginRequest);
    client.once?.('success', () => {
      if (client.fmlHandshakeState !== FMLHandshakeClientState.COMPLETE) {
        client.fmlHandshakeState = FMLHandshakeClientState.COMPLETE;
        client.emit('fmlHandshakeComplete', {
          protocol: 'FML3',
          fmlVersion: 'FML3',
          modsCount: (client.serverForgeMods || []).length,
          registriesSynced: client.registriesSynced,
          configsSynced: client.configsSynced,
          mappedItems: registryBridge.numericToItemName.size,
          mappedBlocks: registryBridge.numericToBlockName.size
        });
      }
    });
  }

  return {
    proto: new ProtoDef(),
    registryBridge,
    handleLoginPluginRequest,
    getState: () => client.fmlHandshakeState
  };
}

const FML_LOGIN_WRAPPER_CHANNEL = 'fml:loginwrapper';
const FML_HANDSHAKE_CHANNEL = 'fml:handshake';

module.exports = {
  DEFAULT_GTL_MODLIST,
  DEFAULT_GTNH_MODLIST: DEFAULT_GTL_MODLIST,
  FML_LOGIN_WRAPPER_CHANNEL,
  FML_HANDSHAKE_CHANNEL,
  FML3HandshakePacketId,
  FMLHandshakeClientState,
  ForgeRegistryBridge,
  attachForgeHandshake,
  wrapFmlLoginWrapper,
  wrapLoginPluginPayload: wrapFmlLoginWrapper,
  unwrapFmlLoginWrapper,
  parseFml3ModList,
  buildFml3ModListReply,
  buildFml3ServerModList,
  buildFml3Ack,
  encodeVarInt,
  encodeVarIntString,
  normalizeItemId,
  splitCanonicalItemId
};
