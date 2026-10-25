'use strict';

const { probeForgeServer } = require('../protocol/forgeHandshake');

async function main() {
  const args = process.argv.slice(2);
  let host = process.env.GTL_HOST || '127.0.0.1';
  let port = Number(process.env.GTL_PORT || 25565);

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--host' && args[i + 1]) {
      host = args[++i];
    } else if (a === '--port' && args[i + 1]) {
      port = Number(args[++i]);
    } else if (!a.startsWith('-')) {
      if (a.includes(':')) {
        const [h, p] = a.split(':');
        host = h;
        port = Number(p);
      } else if (/^\d+$/.test(a)) {
        port = Number(a);
      } else {
        host = a;
      }
    }
  }

  console.log(`[GTL Probe] Pinging Forge server at ${host}:${port}...`);
  const info = await probeForgeServer({ host, port });
  console.log(
    JSON.stringify(
      {
        host: info.host,
        port: info.port,
        minecraftVersion: info.minecraftVersion,
        protocolVersion: info.protocolVersion,
        players: `${info.playersOnline}/${info.playersMax}`,
        isForge: info.isForge,
        fmlNetworkVersion: info.fmlNetworkVersion,
        recommendedMarker: info.fmlMarker.replace(/\0/g, ''),
        modsCount: info.modsCount,
        sampleMods: info.modIds.slice(0, 25),
        channelsCount: info.channelsCount
      },
      null,
      2
    )
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[GTL Probe] Failed to reach server: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main };
