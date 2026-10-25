'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
// Load forgeHandshake first so 1.20.1 modded play-packet overrides apply before Server compiles protocol
const {
  FML3HandshakePacketId,
  FML3PlayPacketId,
  wrapFmlLoginWrapper,
  unwrapFmlLoginWrapper,
  buildFml3ServerModData,
  buildFml3ServerModList,
  buildFml3ServerRegistry,
  buildFml3ServerConfigData,
  encodeVarInt,
  encodeVarIntString,
  readVarInt,
  readVarIntString
} = require('../src/protocol/forgeHandshake');
const Server = require('minecraft-protocol/src/server');
const states = require('minecraft-protocol/src/states');
const uuid = require('minecraft-protocol/src/datatypes/uuid');
const mc = require('minecraft-protocol');
const mcData = require('minecraft-data')('1.20.1');
const registry1201 = require('prismarine-registry')('1.20.1');
const Chunk = require('prismarine-chunk')(registry1201);

const { GTLAutomationAgent } = require('../src/bot');

/**
 * Encodes a Forge 1.20.1 `ServerStatusPing` (`forgeData.d`) UTF-16 string using the exact
 * `encodeOptimized` bit-packing algorithm from `ServerStatusPing.java` (`MinecraftForge 47.4.16`).
 */
function encodeForgeOptimizedPing(mods = {}, nonModChannels = []) {
  const chunks = [Buffer.from([0x00])]; // truncated = false
  const modEntries = Object.entries(mods);
  const sizeHeader = Buffer.alloc(2);
  sizeHeader.writeUInt16BE(modEntries.length, 0);
  chunks.push(sizeHeader);

  for (const [modId, modVer] of modEntries) {
    const isIgnore = modVer === 'IGNORESERVERONLY';
    chunks.push(encodeVarInt(isIgnore ? 1 : 0));
    chunks.push(encodeVarIntString(modId));
    if (!isIgnore) {
      chunks.push(encodeVarIntString(modVer));
    }
  }

  chunks.push(encodeVarInt(nonModChannels.length));
  for (const ch of nonModChannels) {
    chunks.push(encodeVarIntString(ch.res));
    chunks.push(encodeVarIntString(ch.version));
    chunks.push(Buffer.from([ch.required ? 1 : 0]));
  }

  const buf = Buffer.concat(chunks);
  const byteLength = buf.length;
  let out = '';
  out += String.fromCharCode(byteLength & 0x7fff);
  out += String.fromCharCode((byteLength >>> 15) & 0x7fff);

  let bitBuf = 0;
  let bitsInBuf = 0;
  for (let i = 0; i < buf.length; i++) {
    if (bitsInBuf >= 15) {
      out += String.fromCharCode(bitBuf & 0x7fff);
      bitBuf >>>= 15;
      bitsInBuf -= 15;
    }
    bitBuf |= buf[i] << bitsInBuf;
    bitsInBuf += 8;
  }
  if (bitsInBuf > 0) {
    out += String.fromCharCode(bitBuf & 0x7fff);
  }
  return out;
}

/**
 * Parses a client's `C2SModListReply` (`discriminator = 2`) on the mock Forge 47.4.16 server.
 */
function parseServerSideClientModListReply(innerBuffer) {
  let offset = 0;
  const disc = innerBuffer.readUInt8(offset++);
  assert.equal(disc, FML3HandshakePacketId.C2S_MOD_LIST_REPLY);

  const modsLen = readVarInt(innerBuffer, offset);
  offset = modsLen.nextOffset;
  const mods = [];
  for (let i = 0; i < modsLen.value; i++) {
    const s = readVarIntString(innerBuffer, offset);
    offset = s.nextOffset;
    mods.push(s.value);
  }

  const chLen = readVarInt(innerBuffer, offset);
  offset = chLen.nextOffset;
  const channels = new Map();
  for (let i = 0; i < chLen.value; i++) {
    const k = readVarIntString(innerBuffer, offset);
    offset = k.nextOffset;
    const v = readVarIntString(innerBuffer, offset);
    offset = v.nextOffset;
    channels.set(k.value, v.value);
  }

  return { mods, channels };
}

/**
 * Spins up an authentic Forge 1.20.1 (`47.4.16`, `FMLNETVERSION = 3`) mock server over real TCP,
 * implementing `ServerLifecycleHooks.handleServerLogin`, `LoginWrapper`, `HandshakeHandler`,
 * `NetworkRegistry.validateServerChannels`, `S2CModData`, `S2CModList` (185 GTL mods),
 * `S2CRegistry`, `S2CConfigData`, and modded 1.20.1 `PLAY` world + `fml:play` packets.
 */
async function startMockForge1201Server(opts = {}) {
  const expectedNetVersion = opts.expectedNetVersion ?? 3;
  const gtlMods = [
    'minecraft',
    'forge',
    'gtceu',
    'gtlcore',
    'gtladditions',
    'gtl_extend',
    'gtmthings',
    'ldlib',
    'kubejs',
    'architectury',
    'ae2',
    'expatternprovider',
    'mae2',
    'ftblibrary',
    'ftbteams',
    'ftbquests',
    'ad_astra',
    'sophisticatedcore',
    'sophisticatedstorage',
    'modernfix',
    'embeddium',
    'ferritecore',
    'curios',
    'placebo',
    ...Array.from({ length: 165 }, (_, idx) => `gtl_extra_mod_${idx + 1}`)
  ];

  const requiredServerChannels = [
    { channel: 'fml:loginwrapper', version: 'FML3' },
    { channel: 'fml:handshake', version: 'FML3' },
    { channel: 'fml:play', version: 'FML3' },
    { channel: 'gtceu:network', version: '1.6.4' },
    { channel: 'gtlcore:network', version: '1.4.5' },
    { channel: 'ldlib:networking', version: '1.0.28' },
    { channel: 'ae2:main', version: '15.2' },
    { channel: 'ftbquests:main', version: '2001.4' },
    { channel: 'sophisticatedstorage:channel', version: '1.0.0' }
  ];

  const advertisedChannels = [
    ...requiredServerChannels,
    // Optional ModernFix smart ingredient channel (accepts ABSENT)
    { channel: 'modernfix:ingredient_sync', version: '1' }
  ];

  // Pick a guaranteed free ephemeral port first, then bind `Server`
  const freePort = await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.on('error', reject);
  });

  const server = new Server('1.20.1', undefined, true);
  const audit = {
    connections: 0,
    receivedFmlMarkers: [],
    rejectedReasons: [],
    modListReplies: [],
    ackedIndices: [],
    spawnedPlayers: []
  };

  server.on('connection', (client) => {
    audit.connections += 1;

    client.once('set_protocol', (pkt) => {
      const hostParts = String(pkt.serverHost || '').split('\0');
      const fmlTag = hostParts[1] || 'NONE';
      audit.receivedFmlMarkers.push(fmlTag);

      if (pkt.nextState === 1) {
        client.state = states.STATUS;
        client.once('ping_start', () => {
          const pingModMap = {};
          for (const m of gtlMods.slice(0, 30)) pingModMap[m] = '1.4.5.3';
          client.write('server_info', {
            response: JSON.stringify({
              version: { name: '1.20.1', protocol: 763 },
              players: { max: 20, online: 1 },
              description: { text: 'GregTech Leisure 1.4.5.3 Forge 47.4.16' },
              forgeData: {
                fmlNetworkVersion: expectedNetVersion,
                channels: [],
                mods: [],
                d: encodeForgeOptimizedPing(pingModMap, [
                  { res: 'fml:handshake', version: 'FML3', required: true }
                ])
              }
            })
          });
        });
        client.once('ping', (pingPkt) => {
          client.write('ping', { time: pingPkt.time });
          client.end();
        });
        return;
      }

      // Exact `ServerLifecycleHooks.handleServerLogin` validation from Forge 47.4.16!
      const isModded = fmlTag.startsWith('FML');
      const netVerNum = isModded ? Number(fmlTag.slice(3)) : 0;

      if (isModded && netVerNum !== expectedNetVersion) {
        client.state = states.LOGIN;
        const msg = `This modded server is not impl compatible with your modded client. Please verify your Forge version closely matches the server. Got net version ${netVerNum} this server is net version ${expectedNetVersion}`;
        audit.rejectedReasons.push(msg);
        client.write('disconnect', { reason: JSON.stringify({ text: msg }) });
        client.end(msg);
        return;
      }

      if (!isModded) {
        client.state = states.LOGIN;
        const msg =
          'This server has mods that require Forge to be installed on the client. Contact your server admin for more details.';
        audit.rejectedReasons.push(msg);
        client.write('disconnect', { reason: JSON.stringify({ text: msg }) });
        client.end(msg);
        return;
      }

      client.state = states.LOGIN;
      attachForgeNegotiation(client);
    });

    function attachForgeNegotiation(targetClient) {
      targetClient.once('login_start', (loginStart) => {
        targetClient.username = loginStart.username;
        targetClient.uuid = uuid.nameToMcOfflineUUID(targetClient.username);

        // Build exact Forge 47.4.16 `HandshakeHandler.messageList`
        // Index 0: S2CModData (needsResponse = false!)
        // Index 1: S2CModList (needsResponse = true)
        // Index 2..5: S2CRegistry (minecraft:item, minecraft:block, minecraft:entity_type, minecraft:menu)
        // Index 6..7: S2CConfigData (gtceu-server.toml, sophisticatedstorage-server.toml)
        // Index 8: Custom mod login wrapper packet (`gtlcore:login_sync`, needsResponse = true)
        const pendingSentMessages = new Set([1, 2, 3, 4, 5, 6, 7, 8]);

        const sendWrapped = (seqId, subChannel, innerBuf) => {
          targetClient.write('login_plugin_request', {
            messageId: seqId,
            channel: 'fml:loginwrapper',
            data: wrapFmlLoginWrapper(subChannel, innerBuf)
          });
        };

        targetClient.on('login_plugin_response', (resp) => {
          // Exact Forge `ServerLoginPacketListenerImpl.m_7223_` + `LoginWrapper`:
          // If `data == null`, Forge disconnects immediately with `unexpected_query_response`!
          if (!resp.data || resp.data.length === 0) {
            const msg = 'Unexpected custom data from client';
            audit.rejectedReasons.push(msg);
            targetClient.write('disconnect', {
              reason: JSON.stringify({ translate: 'multiplayer.disconnect.unexpected_query_response' })
            });
            targetClient.end(msg);
            return;
          }

          const { subChannel, innerBuffer } = unwrapFmlLoginWrapper(Buffer.from(resp.data));
          if (subChannel !== 'fml:handshake' || innerBuffer.length === 0) {
            const msg = `Unhandled loginwrapper subChannel ${subChannel}`;
            audit.rejectedReasons.push(msg);
            targetClient.write('disconnect', { reason: JSON.stringify({ text: msg }) });
            targetClient.end(msg);
            return;
          }

          const disc = innerBuffer.readUInt8(0);
          if (disc === FML3HandshakePacketId.C2S_MOD_LIST_REPLY) {
            const parsedReply = parseServerSideClientModListReply(innerBuffer);
            audit.modListReplies.push(parsedReply);

            // Exact `NetworkRegistry.validateServerChannels` check on all required channels (excluding internal fml:*)
            for (const req of requiredServerChannels) {
              if (req.channel.startsWith('fml:')) continue;
              const gotVer = parsedReply.channels.get(req.channel);
              if (gotVer !== req.version) {
                const msg = `Connection closed - mismatched mod channel list (${req.channel}: got ${gotVer}, expected ${req.version})`;
                audit.rejectedReasons.push(msg);
                targetClient.write('disconnect', { reason: JSON.stringify({ text: msg }) });
                targetClient.end(msg);
                return;
              }
            }
            pendingSentMessages.delete(resp.messageId);
          } else if (disc === FML3HandshakePacketId.C2S_ACK) {
            audit.ackedIndices.push(resp.messageId);
            pendingSentMessages.delete(resp.messageId);
          }

          if (pendingSentMessages.size === 0) {
            finishNegotiationAndSpawn(targetClient, audit);
          }
        });

        // Dispatch Forge 47.4.16 login payload sequence
        sendWrapped(0, 'fml:handshake', buildFml3ServerModData(gtlMods.slice(0, 20)));
        sendWrapped(
          1,
          'fml:handshake',
          buildFml3ServerModList({
            mods: gtlMods,
            channels: advertisedChannels,
            registries: ['minecraft:block', 'minecraft:item', 'minecraft:entity_type', 'minecraft:menu'],
            dataPackRegistries: ['ad_astra:planet_data', 'gtceu:ore_vein']
          })
        );
        sendWrapped(
          2,
          'fml:handshake',
          buildFml3ServerRegistry('minecraft:item', {
            'gtceu:basic_electronic_circuit': 8450,
            'gtceu:duct_tape': 9102,
            'kubejs:advanced_control_circuit': 12400
          })
        );
        sendWrapped(
          3,
          'fml:handshake',
          buildFml3ServerRegistry('minecraft:block', {
            'gtceu:primitive_blast_furnace': 3210,
            'gtceu:lv_bender': 3211,
            'gtceu:bronze_brick_casing': 3212
          })
        );
        sendWrapped(
          4,
          'fml:handshake',
          buildFml3ServerRegistry('minecraft:entity_type', {
            'touhou_little_maid:maid': 145
          })
        );
        sendWrapped(
          5,
          'fml:handshake',
          buildFml3ServerRegistry('minecraft:menu', {
            'ldlib:modular_ui': 42
          })
        );
        sendWrapped(6, 'fml:handshake', buildFml3ServerConfigData('gtceu-server.toml', '[machines]\nsteam = true\n'));
        sendWrapped(
          7,
          'fml:handshake',
          buildFml3ServerConfigData('sophisticatedstorage-server.toml', '[barrels]\nmaxUpgrades = 4\n')
        );
        sendWrapped(8, 'gtlcore:login_sync', Buffer.from([0x00, 0x01]));
      });
    }
  });

  function finishNegotiationAndSpawn(client, serverAudit) {
    client.write('compress', { threshold: 256 });
    client.compressionThreshold = 256;
    client.write('success', {
      uuid: client.uuid,
      username: client.username,
      properties: []
    });
    client.state = states.PLAY;

    const lp = mcData.loginPacket;
    client.write('login', {
      entityId: 77,
      isHardcore: false,
      gameMode: 0,
      previousGameMode: -1,
      worldNames: ['minecraft:overworld', 'ad_astra:moon'],
      dimensionCodec: lp.dimensionCodec,
      worldType: lp.worldType,
      worldName: 'minecraft:overworld',
      hashedSeed: [0, 0],
      maxPlayers: 20,
      viewDistance: 8,
      simulationDistance: 6,
      reducedDebugInfo: false,
      enableRespawnScreen: true,
      isDebug: false,
      isFlat: false,
      death: undefined,
      portalCooldown: 0
    });

    // Inject raw modded `declare_recipes` (0x6d) & `declare_commands` (0x10) buffers containing
    // custom GTCEu/AE2 serializers and Forge `forge:enum` command nodes that crash unpatched ProtoDef!
    const [ , writeVarIntProto, sizeOfVarIntProto ] = require('protodef').types.varint;
    const writeRawPlayPacket = (packetHexId, bodyBuf) => {
      const hdr = Buffer.alloc(sizeOfVarIntProto(packetHexId));
      writeVarIntProto(packetHexId, hdr, 0);
      client.writeRaw(Buffer.concat([hdr, bodyBuf]));
    };
    writeRawPlayPacket(0x6d, Buffer.from('\x03\x0cgtceu:bender\x14gtceu:plate_steel_01\xde\xad\xbe\xef', 'binary'));
    writeRawPlayPacket(0x10, Buffer.from('\x02\x12forge:enum_mod_arg\xca\xfe\xba\xbe', 'binary'));

    // Build a 1.20.1 chunk at (0, 0) whose floor at y=63 uses a high modded blockStateId (48210)!
    const chunk = new Chunk({ minY: -64, worldHeight: 384 });
    for (let x = 0; x < 16; x++) {
      for (let z = 0; z < 16; z++) {
        chunk.setBlockStateId({ x, y: 63, z }, 48210);
      }
    }

    client.write('map_chunk', {
      x: 0,
      z: 0,
      groundUp: true,
      biomes: chunk.dumpBiomes !== undefined ? chunk.dumpBiomes() : undefined,
      heightmaps: {
        type: 'compound',
        name: '',
        value: {}
      },
      bitMap: chunk.getMask(),
      chunkData: chunk.dump(),
      blockEntities: [],
      trustEdges: true,
      skyLightMask: [],
      blockLightMask: [],
      emptySkyLightMask: [],
      emptyBlockLightMask: [],
      skyLight: [],
      blockLight: []
    });

    // Spawn player standing at (8.5, 64, 8.5) directly on top of the modded y=63 floor!
    client.write('position', {
      x: 8.5,
      y: 64.0,
      z: 8.5,
      yaw: 0,
      pitch: 0,
      flags: 0x00,
      teleportId: 1
    });

    client.write('update_health', {
      health: 20,
      food: 20,
      foodSaturation: 5
    });

    // Place 4x `gtceu:basic_electronic_circuit` (synced modded itemId = 8450!) into hotbar slot 36
    client.write('set_slot', {
      windowId: 0,
      stateId: 1,
      slot: 36,
      item: {
        present: true,
        itemId: 8450,
        itemCount: 4,
        nbtData: undefined
      }
    });

    // Simulate `NetworkHooks.openScreen` opening an LDLib / GTCEu LV Bender GUI over `fml:play`!
    const extraGuiBytes = Buffer.from([0x10, 0x20]);
    const openContainerPayload = Buffer.concat([
      Buffer.from([FML3PlayPacketId.OPEN_CONTAINER]),
      encodeVarInt(42), // menuTypeId = 42 (`ldlib:modular_ui`)
      encodeVarInt(3), // windowId = 3
      encodeVarIntString(JSON.stringify({ text: 'LV Bending Machine' })),
      encodeVarInt(extraGuiBytes.length),
      extraGuiBytes
    ]);
    client.write('custom_payload', {
      channel: 'fml:play',
      data: openContainerPayload
    });

    serverAudit.spawnedPlayers.push(client.username);
  }

  await new Promise((resolve) => {
    server.once('listening', resolve);
    server.listen(freePort, '127.0.0.1');
  });

  return {
    port: freePort,
    server,
    audit,
    close: () =>
      new Promise((resolve) => {
        for (const c of Object.values(server.clients || {})) {
          c.socket?.destroy();
          c.closeTimer?.unref?.();
        }
        server.close();
        resolve();
      })
  };
}

test('Forge 1.20.1 (47.4.16) Live TCP Suite: Vanilla client without \\0FML3\\0 is rejected with exact Forge error, while GTLAutomationAgent completes full FML3 handshake and spawns cleanly', async () => {
  const mockServer = await startMockForge1201Server();

  try {
    // 1. Prove a vanilla (non-Forge) client gets kicked with the EXACT message reported by the user!
    const vanillaKickMsg = await new Promise((resolve, reject) => {
      const vanillaClient = mc.createClient({
        host: '127.0.0.1',
        port: mockServer.port,
        username: 'VanillaPlayer',
        auth: 'offline',
        version: '1.20.1'
      });
      vanillaClient.on('disconnect', (pkt) => {
        vanillaClient.end();
        vanillaClient.closeTimer?.unref?.();
        vanillaClient.socket?.destroy();
        resolve(pkt.reason);
      });
      vanillaClient.on('error', reject);
    });

    assert.ok(
      vanillaKickMsg.includes(
        'This server has mods that require Forge to be installed on the client. Contact your server admin for more details'
      )
    );

    // 2. Now connect the real `GTLAutomationAgent` over TCP to the exact same Forge 47.4.16 server!
    const agent = new GTLAutomationAgent({
      host: '127.0.0.1',
      port: mockServer.port,
      username: 'GTL_Automaton',
      auth: 'offline',
      version: '1.20.1',
      autoReconnect: false
    });

    const fmlWindowOpenedPromise = new Promise((resolve) => {
      agent.containerController.once('windowOpened', resolve);
    });

    const readyPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for GTL bot spawn')), 8000);
      agent.once('ready', (info) => {
        clearTimeout(timer);
        resolve(info);
      });
      agent.on('log', (entry) => {
        if (entry.level === 'error' && entry.message.includes('Kicked:')) {
          clearTimeout(timer);
          reject(new Error(entry.message));
        }
      });
    });

    agent.connect();
    const [spawnInfo, openedGui] = await Promise.all([readyPromise, fmlWindowOpenedPromise]);

    // Verify full Forge 1.20.1 FML3 handshake passed 100% of server checks:
    assert.equal(mockServer.audit.receivedFmlMarkers[1], 'FML3');
    assert.equal(mockServer.audit.modListReplies.length, 1);
    assert.equal(mockServer.audit.modListReplies[0].mods.length, 189); // All 189 server mods echoed!
    assert.equal(mockServer.audit.modListReplies[0].channels.get('gtceu:network'), '1.6.4');
    assert.equal(mockServer.audit.modListReplies[0].channels.has('modernfix:ingredient_sync'), false);
    // Verify S2CModData (index 0, `.noResponse()`) was NOT unexpectedly acked, while indices 2..8 were acked!
    assert.equal(mockServer.audit.ackedIndices.includes(0), false);
    assert.deepEqual(mockServer.audit.ackedIndices.sort((a, b) => a - b), [2, 3, 4, 5, 6, 7, 8]);

    // Verify bot spawned at (8.5, 64, 8.5) standing on modded blockStateId 48210 treated as solid block!
    assert.ok(spawnInfo.position);
    assert.equal(Math.round(spawnInfo.position.y), 64);
    const floorBlock = agent.bot.blockAt(spawnInfo.position.offset(0, -1, 0));
    assert.ok(floorBlock);
    assert.equal(floorBlock.stateId, 48210);
    assert.equal(floorBlock.boundingBox, 'block');
    assert.deepEqual(floorBlock.shapes, [[0, 0, 0, 1, 1, 1]]);

    // Verify synced Forge `minecraft:item` ID 8450 resolves natively in `bot.inventory` & `WarehouseTracker`!
    const stock = agent.warehouse.getCombinedStock(agent.bot);
    assert.equal(stock.get('gtceu:basic_electronic_circuit'), 4);

    // Verify `fml:play` `PlayMessages.OpenContainer` (`NetworkHooks.openScreen`) opened `ldlib:modular_ui`!
    assert.equal(openedGui.windowId, 3);
    assert.equal(openedGui.menuTypeName, 'ldlib:modular_ui');
    assert.ok(openedGui.windowTitle.includes('LV Bending Machine'));

    agent.shutdown();
  } finally {
    await mockServer.close();
  }
});

test('Forge 1.20.1 Live TCP Suite: probeForgeServer & decodeForgeOptimizedPing decode UTF-16 ServerStatusPing, and FML2 server triggers automatic \\0FML2\\0 fallback', async () => {
  const fml2Server = await startMockForge1201Server({ expectedNetVersion: 2 });

  try {
    const { probeForgeServer } = require('../src/protocol/forgeHandshake');
    const probe = await probeForgeServer({ host: '127.0.0.1', port: fml2Server.port });
    assert.equal(probe.isForge, true);
    assert.equal(probe.fmlNetworkVersion, 2);
    assert.equal(probe.fmlMarker, '\0FML2\0');
    assert.ok(probe.modIds.includes('gtceu'));
    assert.ok(probe.modIds.includes('gtlcore'));

    // Connect an agent defaulting to FML3 against the FML2 server with autoReconnect=true:
    // It should detect `"this server is net version 2"`, switch to `\0FML2\0`, and spawn cleanly!
    const agent = new GTLAutomationAgent({
      host: '127.0.0.1',
      port: fml2Server.port,
      username: 'GTL_AutoNegotiate',
      auth: 'offline',
      version: '1.20.1',
      autoReconnect: true
    });

    const readyPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for FML2 fallback spawn')), 8000);
      agent.once('ready', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    agent.connect();
    await readyPromise;

    assert.deepEqual(fml2Server.audit.receivedFmlMarkers.slice(-2), ['FML3', 'FML2']);
    agent.shutdown();
  } finally {
    await fml2Server.close();
  }
});
