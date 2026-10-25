'use strict';

const { EventEmitter } = require('events');
const { ProtoDef } = require('protodef');
const forgePlugin = require('@tcortega/minecraft-protocol-forge');

/**
 * Default baseline Forge 1.7.10 mod signature presented during FML|HS ModList
 * negotiation if dynamic server ping mod mirroring is not active.
 */
const DEFAULT_GTNH_MODLIST = [
  { modid: 'mcp', version: '9.05' },
  { modid: 'FML', version: '7.10.99.99' },
  { modid: 'Forge', version: '10.13.4.1614' },
  { modid: 'CodeChickenCore', version: '1.1.12' },
  { modid: 'NotEnoughItems', version: '2.5.42-GTNH' },
  { modid: 'IC2', version: '2.2.828-experimental' },
  { modid: 'gregtech', version: '5.09.45.210' },
  { modid: 'dreamcraft', version: '2.6.48' },
  { modid: 'betterquesting', version: '3.5.412-GTNH' },
  { modid: 'bartworks', version: '0.9.25' },
  { modid: 'gtplusplus', version: '1.11.42' }
];

const FMLHandshakeClientState = Object.freeze({
  START: 1,
  WAITINGSERVERDATA: 2,
  WAITINGSERVERCOMPLETE: 3,
  PENDINGCOMPLETE: 4,
  COMPLETE: 5,
  RESET: 6
});

const FML_CHANNELS = ['FML|HS', 'FML', 'FML|MP', 'FML', 'FORGE'];

/**
 * Builds the ProtoDef wire parser/serializer for the Forge Multipart / Handshake (`FML|HS`) channel.
 */
function createFmlProto() {
  const proto = new ProtoDef();

  proto.addType('string', ['pstring', { countType: 'varint' }]);

  proto.addType('fml|hsMapper', [
    'mapper',
    {
      type: 'i8',
      mappings: {
        0: 'ServerHello',
        1: 'ClientHello',
        2: 'ModList',
        3: 'RegistryOrModIdData',
        '-1': 'HandshakeAck',
        '-2': 'HandshakeReset'
      }
    }
  ]);

  proto.addType('FML|HS_Header', [
    'container',
    [
      { name: 'discriminator', type: 'fml|hsMapper' }
    ]
  ]);

  proto.addType('FML|HS', [
    'container',
    [
      { name: 'discriminator', type: 'fml|hsMapper' },
      {
        anon: true,
        type: [
          'switch',
          {
            compareTo: 'discriminator',
            fields: {
              ServerHello: [
                'container',
                [
                  { name: 'fmlProtocolVersion', type: 'i8' },
                  {
                    name: 'overrideDimension',
                    type: [
                      'switch',
                      {
                        compareTo: 'fmlProtocolVersion',
                        fields: { 0: 'void', 1: 'void' },
                        default: 'i32'
                      }
                    ]
                  }
                ]
              ],
              ClientHello: [
                'container',
                [{ name: 'fmlProtocolVersion', type: 'i8' }]
              ],
              ModList: [
                'container',
                [
                  {
                    name: 'mods',
                    type: [
                      'array',
                      {
                        countType: 'varint',
                        type: [
                          'container',
                          [
                            { name: 'modid', type: 'string' },
                            { name: 'version', type: 'string' }
                          ]
                        ]
                      }
                    ]
                  }
                ]
              ],
              HandshakeAck: [
                'container',
                [{ name: 'phase', type: 'i8' }]
              ],
              HandshakeReset: [
                'container',
                [{ name: 'phase', type: 'i8' }]
              ]
            },
            default: 'void'
          }
        ]
      }
    ]
  ]);

  return proto;
}

/**
 * Bidirectional Forge 1.7.10 numeric ID <-> canonical string (`modid:name[:meta]`) bridge.
 * In Forge 1.7.10, world saves dynamically allocate numeric block/item IDs (up to 32000)
 * and transmit them during login via `FML|HS` discriminator 3 (`ModIdData`).
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
   * Registers an explicit block or item mapping.
   * @param {'block'|'item'} kind
   * @param {string} registryName - e.g. 'gregtech:gt.metaitem.01'
   * @param {number} numericId - e.g. 7156
   */
  register(kind, registryName, numericId) {
    const cleanName = String(registryName).trim();
    const id = Number(numericId);
    if (!cleanName || !Number.isFinite(id)) return;

    if (kind === 'block') {
      this.numericToBlockName.set(id, cleanName);
      this.blockNameToNumeric.set(cleanName, id);
    } else {
      this.numericToItemName.set(id, cleanName);
      this.itemNameToNumeric.set(cleanName, id);
      if (!this.numericToBlockName.has(id) && id < 4096) {
        this.numericToBlockName.set(id, cleanName);
      }
    }
  }

  /**
   * Loads a static ID dump dictionary (e.g. exported from NEI Data Dump CSV/JSON).
   * @param {Array<{kind?: string, name: string, id: number}>|Object} entries
   */
  loadDump(entries) {
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        this.register(entry.kind || 'item', entry.name, entry.id);
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
   * Parses a Forge 1.7.10 `ModIdData` payload buffer (`\x01mod:block` / `\x02mod:item`)
   * or a Forge 1.8+ `RegistryData` payload buffer (`hasMore`, `registryName`, `ids`).
   * @param {Buffer} buffer - Full FML|HS packet starting at discriminator byte (3)
   * @param {number} fmlProtocolVersion - 1 for 1.7.10, 2+ for 1.8+
   * @returns {{ hasMore: boolean, entriesLoaded: number }}
   */
  ingestRegistryPacket(buffer, fmlProtocolVersion = 1) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 2) {
      return { hasMore: false, entriesLoaded: 0 };
    }

    let offset = 1; // Skip discriminator byte (0x03)
    let entriesLoaded = 0;

    if (fmlProtocolVersion >= 2) {
      // 1.8+ RegistryData begins with boolean `hasMore`
      const hasMore = buffer.readUInt8(offset) !== 0;
      offset += 1;
      try {
        const regStr = readVarIntString(buffer, offset);
        offset = regStr.nextOffset;
        const countRes = readVarInt(buffer, offset);
        offset = countRes.nextOffset;
        const kind = regStr.value.toLowerCase().includes('block') ? 'block' : 'item';
        for (let i = 0; i < countRes.value && offset < buffer.length; i++) {
          const entryName = readVarIntString(buffer, offset);
          offset = entryName.nextOffset;
          const entryId = readVarInt(buffer, offset);
          offset = entryId.nextOffset;
          this.register(kind, entryName.value, entryId.value);
          entriesLoaded++;
        }
      } catch (_) {
        // Partial or custom registry extension tail; safe to ignore after header parse
      }
      this.emit('updated', { entriesLoaded, hasMore });
      return { hasMore, entriesLoaded };
    }

    // 1.7.10 ModIdData: [count: varint] of [prefixedName: string, id: varint]
    try {
      const countRes = readVarInt(buffer, offset);
      offset = countRes.nextOffset;
      for (let i = 0; i < countRes.value && offset < buffer.length; i++) {
        const rawEntry = readVarIntString(buffer, offset);
        offset = rawEntry.nextOffset;
        const idRes = readVarInt(buffer, offset);
        offset = idRes.nextOffset;

        const rawName = rawEntry.value;
        if (rawName.startsWith('\u0001')) {
          this.register('block', rawName.slice(1), idRes.value);
        } else if (rawName.startsWith('\u0002')) {
          this.register('item', rawName.slice(1), idRes.value);
        } else {
          this.register('item', rawName, idRes.value);
        }
        entriesLoaded++;
      }
    } catch (_) {
      // Defensive guard against truncated custom FML frames
    }

    this.emit('updated', { entriesLoaded, hasMore: false });
    return { hasMore: false, entriesLoaded };
  }

  /**
   * Resolves a Prismarine Item / network slot object into a canonical GTNH item ID
   * (`modid:itemname:metadata`, e.g. `gregtech:gt.metaitem.01:32700`).
   * @param {Object} item
   * @returns {string|null}
   */
  toCanonicalItemId(item) {
    if (!item) return null;
    if (typeof item === 'string') return normalizeItemId(item);

    const meta = item.metadata ?? item.itemDamage ?? 0;
    if (item.canonicalId) return normalizeItemId(item.canonicalId);

    const numericId = item.type ?? item.blockId;
    if (Number.isFinite(numericId)) {
      const mapped =
        this.numericToItemName.get(numericId) ||
        this.numericToBlockName.get(numericId);
      if (mapped) {
        return `${mapped}:${meta}`;
      }
    }

    if (item.name) {
      const base = item.name.includes(':') ? item.name : `minecraft:${item.name}`;
      return `${base}:${meta}`;
    }

    return Number.isFinite(numericId) ? `id:${numericId}:${meta}` : null;
  }

  /**
   * Resolves a canonical GTNH item ID (`gregtech:gt.metaitem.01:32700`) into
   * `{ blockId, itemDamage, baseName, metadata }` for packet construction.
   * @param {string} canonicalId
   * @param {Object} [mcRegistry] - Optional Prismarine registry fallback
   */
  fromCanonicalItemId(canonicalId, mcRegistry = null) {
    const parsed = splitCanonicalItemId(canonicalId);
    let numericId =
      this.itemNameToNumeric.get(parsed.baseName) ??
      this.blockNameToNumeric.get(parsed.baseName) ??
      null;

    if (numericId === null && mcRegistry) {
      const shortName = parsed.baseName.replace(/^minecraft:/, '');
      if (mcRegistry.itemsByName && mcRegistry.itemsByName[shortName]) {
        numericId = mcRegistry.itemsByName[shortName].id;
      } else if (mcRegistry.blocksByName && mcRegistry.blocksByName[shortName]) {
        numericId = mcRegistry.blocksByName[shortName].id;
      }
    }

    return {
      blockId: numericId ?? -1,
      itemDamage: parsed.metadata,
      baseName: parsed.baseName,
      metadata: parsed.metadata
    };
  }
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
    const value = read & 0x7f;
    result |= value << (7 * numRead);
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
    throw new RangeError('Buffer underflow while reading FML string');
  }
  const value = buffer.toString('utf8', lenRes.nextOffset, end);
  return { value, nextOffset: end };
}

function splitCanonicalItemId(itemId) {
  const raw = String(itemId || '').trim();
  const parts = raw.split(':');
  if (parts.length >= 3) {
    const metaCandidate = Number(parts[parts.length - 1]);
    if (Number.isFinite(metaCandidate)) {
      return {
        baseName: parts.slice(0, -1).join(':'),
        metadata: metaCandidate
      };
    }
  }
  if (parts.length === 2) {
    const secondNum = Number(parts[1]);
    if (Number.isFinite(secondNum)) {
      return { baseName: `minecraft:${parts[0]}`, metadata: secondNum };
    }
    return { baseName: raw, metadata: 0 };
  }
  return { baseName: `minecraft:${raw}`, metadata: 0 };
}

function normalizeItemId(itemId) {
  const { baseName, metadata } = splitCanonicalItemId(itemId);
  return `${baseName}:${metadata}`;
}

/**
 * Attaches the FML|HS Forge 1.7.10 / 1.8+ handshake state machine to a
 * `minecraft-protocol` client (or Mineflayer `bot._client`).
 *
 * @param {Object} client - Underlying minecraft-protocol Client
 * @param {Object} [options]
 * @param {Array<{modid: string, version: string}>} [options.forgeMods]
 * @param {ForgeRegistryBridge} [options.registryBridge]
 * @param {boolean} [options.useAutoVersionForge]
 * @returns {{ proto: ProtoDef, registryBridge: ForgeRegistryBridge, getState: () => number }}
 */
function attachForgeHandshake(client, options = {}) {
  const proto = createFmlProto();
  const registryBridge = options.registryBridge || new ForgeRegistryBridge();
  const forgeMods = Array.isArray(options.forgeMods) && options.forgeMods.length > 0
    ? options.forgeMods
    : DEFAULT_GTNH_MODLIST;

  if (options.useAutoVersionForge && forgePlugin && typeof forgePlugin.autoVersionForge === 'function') {
    forgePlugin.autoVersionForge(client);
  }

  // Tag host with \0FML\0 so the Forge server activates FML|HS negotiation during login/play transition
  client.tagHost = '\0FML\0';
  client.fmlHandshakeState = FMLHandshakeClientState.START;
  client.fmlProtocolVersion = 1;
  client.fmlHandshakeReset = false;

  const writeCustomPayload = (channel, data) => {
    if (typeof client.write === 'function') {
      client.write('custom_payload', { channel, data });
    }
  };

  const writeHandshakeAck = (phase) => {
    const ackBuffer = proto.createPacketBuffer('FML|HS', {
      discriminator: 'HandshakeAck',
      phase
    });
    writeCustomPayload('FML|HS', ackBuffer);
  };

  const handleFmlPayload = (rawData) => {
    const buffer = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData || []);
    if (buffer.length === 0) return;

    const header = proto.parsePacketBuffer('FML|HS_Header', buffer).data;
    const discriminator = header.discriminator;

    if (discriminator === 'HandshakeReset') {
      writeHandshakeAck(FMLHandshakeClientState.START);
      client.fmlHandshakeState = FMLHandshakeClientState.START;
      client.fmlHandshakeReset = true;
      client.emit('fmlHandshakeReset');
      return;
    }

    switch (client.fmlHandshakeState) {
      case FMLHandshakeClientState.START: {
        if (discriminator !== 'ServerHello') break;
        const parsed = proto.parsePacketBuffer('FML|HS', buffer).data;
        client.fmlProtocolVersion = parsed.fmlProtocolVersion ?? 1;
        client.emit('fmlHandshakeStart', {
          fmlProtocolVersion: client.fmlProtocolVersion,
          overrideDimension: parsed.overrideDimension ?? 0
        });

        // 1. Register Forge plugin channels
        writeCustomPayload('REGISTER', Buffer.from(FML_CHANNELS.join('\0'), 'utf8'));

        // 2. Echo ClientHello with matching FML protocol version
        writeCustomPayload(
          'FML|HS',
          proto.createPacketBuffer('FML|HS', {
            discriminator: 'ClientHello',
            fmlProtocolVersion: client.fmlProtocolVersion
          })
        );

        // 3. Present client ModList
        writeCustomPayload(
          'FML|HS',
          proto.createPacketBuffer('FML|HS', {
            discriminator: 'ModList',
            mods: forgeMods
          })
        );

        client.fmlHandshakeState = FMLHandshakeClientState.WAITINGSERVERDATA;
        break;
      }

      case FMLHandshakeClientState.WAITINGSERVERDATA: {
        if (discriminator !== 'ModList') break;
        const parsed = proto.parsePacketBuffer('FML|HS', buffer).data;
        client.serverForgeMods = parsed.mods || [];
        client.emit('forgeMods', client.serverForgeMods);

        // Acknowledge ModList receipt -> transition to WAITINGSERVERCOMPLETE (or PENDINGCOMPLETE after reset)
        writeHandshakeAck(FMLHandshakeClientState.WAITINGSERVERDATA);
        if (client.fmlHandshakeReset) {
          client.fmlHandshakeState = FMLHandshakeClientState.PENDINGCOMPLETE;
        } else {
          client.fmlHandshakeState = FMLHandshakeClientState.WAITINGSERVERCOMPLETE;
        }
        break;
      }

      case FMLHandshakeClientState.WAITINGSERVERCOMPLETE: {
        if (discriminator !== 'RegistryOrModIdData') break;
        const isLegacy1710 =
          client.fmlProtocolVersion <= 1 ||
          String(client.version || '').startsWith('1.7');

        const { hasMore, entriesLoaded } = registryBridge.ingestRegistryPacket(
          buffer,
          isLegacy1710 ? 1 : client.fmlProtocolVersion
        );
        client.emit('fmlRegistryMapped', { entriesLoaded, hasMore });

        if (isLegacy1710 || !hasMore) {
          writeHandshakeAck(FMLHandshakeClientState.WAITINGSERVERCOMPLETE);
          client.fmlHandshakeState = FMLHandshakeClientState.PENDINGCOMPLETE;
        }
        break;
      }

      case FMLHandshakeClientState.PENDINGCOMPLETE: {
        if (discriminator !== 'HandshakeAck') break;
        const parsed = proto.parsePacketBuffer('FML|HS', buffer).data;
        if (parsed.phase === 2) {
          writeHandshakeAck(FMLHandshakeClientState.PENDINGCOMPLETE);
          client.fmlHandshakeState = FMLHandshakeClientState.COMPLETE;
        }
        break;
      }

      case FMLHandshakeClientState.COMPLETE: {
        if (discriminator !== 'HandshakeAck') break;
        const parsed = proto.parsePacketBuffer('FML|HS', buffer).data;
        if (parsed.phase === 3) {
          writeHandshakeAck(FMLHandshakeClientState.COMPLETE);
          client.emit('fmlHandshakeComplete', {
            modsCount: (client.serverForgeMods || []).length,
            mappedItems: registryBridge.numericToItemName.size,
            mappedBlocks: registryBridge.numericToBlockName.size
          });
        }
        break;
      }

      default:
        break;
    }
  };

  if (typeof client.on === 'function') {
    client.on('custom_payload', (packet) => {
      if (packet && packet.channel === 'FML|HS') {
        handleFmlPayload(packet.data);
      }
    });
  }

  return {
    proto,
    registryBridge,
    handleFmlPayload,
    getState: () => client.fmlHandshakeState
  };
}

module.exports = {
  DEFAULT_GTNH_MODLIST,
  FMLHandshakeClientState,
  ForgeRegistryBridge,
  createFmlProto,
  attachForgeHandshake,
  normalizeItemId,
  splitCanonicalItemId
};
