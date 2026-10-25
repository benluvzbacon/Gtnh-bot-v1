#!/usr/bin/env node
'use strict';

/**
 * GregTech Leisure (1.20.1) Low-End PC Modpack Optimizer
 *
 * Patches an installed GregTech Leisure CurseForge / Prism / Modrinth instance
 * to run smoothly on low-RAM (8 GB) and weak-GPU / iGPU machines while keeping
 * 100% server compatibility and GTL progression intact.
 *
 * Usage:
 *   npm run optimize-pack -- --instance-dir "/path/to/GregTech Leisure" [--ram-gb 8] [--aggressive] [--dry-run]
 *   npm run optimize-pack -- --instance-dir "/path/to/GregTech Leisure" --restore
 */

const fs = require('node:fs');
const path = require('node:path');

const KIT_DIR = path.resolve(__dirname, '../../modpack-optimizations');

const SAFE_CLIENT_ONLY_PATTERNS = [
  /^oculus[-_]/i,
  /^iris[-_]/i,
  /^openysm[-_]/i,
  /^yesstevemodel[-_]/i,
  /^cosmeticarmorreworked[-_]/i,
  /^presencefootsteps[-_]/i,
  /^fallingleaves[-_]/i,
  /^visuality[-_]/i,
  /^eatinganimation[-_]/i,
  /^3dskinlayers[-_]/i,
  /^shouldersurfing[-_]/i
];

const AGGRESSIVE_CLIENT_ONLY_PATTERNS = [
  /^modern[-_]?ui[-_]/i,
  /^simple[-_]?voice[-_]?chat[-_]/i,
  /^voicechat[-_]/i,
  /^legendarytooltips[-_]/i,
  /^sound[-_]?physics[-_]/i,
  /^ambientsounds[-_]/i,
  /^blur[-_]/i,
  /^toastcontrol[-_]/i,
  /^advancementplaques[-_]/i
];

// Never disable core gameplay, performance, or server-synced registry mods
const PROTECTED_MOD_PATTERNS = [
  /^gtceu/i,
  /^gtl/i,
  /^gregtech/i,
  /^ldlib/i,
  /^kubejs/i,
  /^rhino/i,
  /^architectury/i,
  /^ftb/i,
  /^ae2/i,
  /^appliedenergistics/i,
  /^mae2/i,
  /^expatternprovider/i,
  /^ad_astra/i,
  /^embeddium/i,
  /^rubidium/i,
  /^sodium/i,
  /^modernfix/i,
  /^ferritecore/i,
  /^radium/i,
  /^lithium/i,
  /^starlight/i,
  /^entityculling/i,
  /^immediatelyfast/i,
  /^noisium/i,
  /^canary/i,
  /^sophisticated/i
];

function parseCliArgs(argv) {
  const args = {
    instanceDir: null,
    ramGb: 8,
    aggressive: false,
    dryRun: false,
    restore: false
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--instance-dir' && argv[i + 1]) {
      args.instanceDir = path.resolve(argv[i + 1]);
      i += 1;
    } else if (token === '--ram-gb' && argv[i + 1]) {
      args.ramGb = Number(argv[i + 1]) || 8;
      i += 1;
    } else if (token === '--aggressive') {
      args.aggressive = true;
    } else if (token === '--dry-run') {
      args.dryRun = true;
    } else if (token === '--restore') {
      args.restore = true;
    }
  }
  return args;
}

/**
 * Patches YAML scalar keys in-place using line-level regex matching so comments
 * and nested structure in `gtceu.yaml` / `gtlcore.yaml` remain intact.
 */
function patchYamlScalars(rawYaml, scalarUpdates) {
  let updated = rawYaml;
  const appliedKeys = [];

  for (const [key, value] of Object.entries(scalarUpdates)) {
    const formattedValue = typeof value === 'boolean' ? String(value) : String(value);
    const lineRegex = new RegExp(`^(\\s*${key}\\s*:\\s*)([^#\\r\\n]+)(.*)$`, 'm');
    if (lineRegex.test(updated)) {
      updated = updated.replace(lineRegex, `$1${formattedValue}$3`);
      appliedKeys.push(key);
    } else {
      updated = `${updated.trimEnd()}\n${key}: ${formattedValue}\n`;
      appliedKeys.push(key);
    }
  }

  return { content: updated, appliedKeys };
}

/**
 * Merges key=value or key:value properties files (ModernFix `.properties` and Vanilla `options.txt`).
 */
function mergeKeyValueFile(existingContent, updates, separator = ':') {
  const lines = existingContent ? existingContent.split(/\r?\n/) : [];
  const seen = new Set();

  const nextLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return line;
    }
    const idx = line.indexOf(separator);
    if (idx === -1) {
      return line;
    }
    const key = line.slice(0, idx).trim();
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      seen.add(key);
      return `${key}${separator}${updates[key]}`;
    }
    return line;
  });

  for (const [key, val] of Object.entries(updates)) {
    if (!seen.has(key)) {
      nextLines.push(`${key}${separator}${val}`);
    }
  }

  return `${nextLines.filter((l, i, arr) => !(i === arr.length - 1 && l === '')).join('\n')}\n`;
}

function deepMergeJson(baseObj, overrideObj) {
  const out = { ...(baseObj || {}) };
  for (const [key, value] of Object.entries(overrideObj || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = deepMergeJson(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function buildRecommendedJvmArgs(ramGb = 8) {
  if (ramGb <= 8) {
    return '-Xms4096M -Xmx4608M -XX:+UnlockExperimentalVMOptions -XX:+UseG1GC -XX:G1NewSizePercent=20 -XX:G1ReservePercent=20 -XX:MaxGCPauseMillis=35 -XX:G1HeapRegionSize=16M -XX:+UseStringDeduplication -XX:+DisableExplicitGC -XX:+AlwaysPreTouch -Dfml.readTimeout=180 -Dforge.logging.mojang.level=warn';
  }
  if (ramGb <= 12) {
    return '-Xms4608M -Xmx5632M -XX:+UnlockExperimentalVMOptions -XX:+UseG1GC -XX:G1NewSizePercent=20 -XX:G1ReservePercent=20 -XX:MaxGCPauseMillis=35 -XX:G1HeapRegionSize=16M -XX:+UseStringDeduplication -XX:+DisableExplicitGC -XX:+AlwaysPreTouch -Dfml.readTimeout=180 -Dforge.logging.mojang.level=warn';
  }
  return '-Xms5120M -Xmx6144M -XX:+UnlockExperimentalVMOptions -XX:+UseG1GC -XX:G1NewSizePercent=20 -XX:G1ReservePercent=20 -XX:MaxGCPauseMillis=35 -XX:G1HeapRegionSize=32M -XX:+UseStringDeduplication -XX:+DisableExplicitGC -XX:+AlwaysPreTouch -Dfml.readTimeout=180 -Dforge.logging.mojang.level=warn';
}

function backupFileOnce(instanceDir, backupDir, manifest, relPath, dryRun) {
  const absTarget = path.join(instanceDir, relPath);
  const exists = fs.existsSync(absTarget);

  if (manifest.files[relPath]) {
    return;
  }

  manifest.files[relPath] = {
    existedBefore: exists,
    backupRelPath: exists ? `files/${relPath}` : null
  };

  if (exists && !dryRun) {
    const backupTarget = path.join(backupDir, 'files', relPath);
    fs.mkdirSync(path.dirname(backupTarget), { recursive: true });
    fs.copyFileSync(absTarget, backupTarget);
  }
}

function restoreModpackInstance(instanceDir, options = {}) {
  const dryRun = Boolean(options.dryRun);
  const backupDir = path.join(instanceDir, '.gtl-backup');
  const manifestPath = path.join(backupDir, 'manifest.json');

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`No .gtl-backup/manifest.json found in ${instanceDir}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const restoredFiles = [];
  const reenabledMods = [];

  for (const [relPath, entry] of Object.entries(manifest.files || {})) {
    const absTarget = path.join(instanceDir, relPath);
    if (entry.existedBefore && entry.backupRelPath) {
      const backupSource = path.join(backupDir, entry.backupRelPath);
      if (fs.existsSync(backupSource) && !dryRun) {
        fs.mkdirSync(path.dirname(absTarget), { recursive: true });
        fs.copyFileSync(backupSource, absTarget);
      }
      restoredFiles.push(relPath);
    } else if (!entry.existedBefore && fs.existsSync(absTarget)) {
      if (!dryRun) {
        fs.unlinkSync(absTarget);
      }
      restoredFiles.push(`${relPath} (removed created file)`);
    }
  }

  for (const modName of manifest.disabledMods || []) {
    const disabledPath = path.join(instanceDir, 'mods', `${modName}.disabled`);
    const activePath = path.join(instanceDir, 'mods', modName);
    if (fs.existsSync(disabledPath)) {
      if (!dryRun) {
        fs.renameSync(disabledPath, activePath);
      }
      reenabledMods.push(modName);
    }
  }

  return {
    restored: true,
    dryRun,
    restoredFiles,
    reenabledMods
  };
}

function optimizeModpackInstance(options) {
  const instanceDir = path.resolve(options.instanceDir);
  const ramGb = Number(options.ramGb) || 8;
  const aggressive = Boolean(options.aggressive);
  const dryRun = Boolean(options.dryRun);

  if (!fs.existsSync(instanceDir)) {
    throw new Error(`Modpack instance directory does not exist: ${instanceDir}`);
  }

  if (options.restore) {
    return restoreModpackInstance(instanceDir, { dryRun });
  }

  const backupDir = path.join(instanceDir, '.gtl-backup');
  const manifestPath = path.join(backupDir, 'manifest.json');
  const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    : {
        createdAt: new Date().toISOString(),
        modpack: 'GregTech Leisure (1.20.1)',
        files: {},
        disabledMods: []
      };

  const configDir = path.join(instanceDir, 'config');
  if (!dryRun) {
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const patchedFiles = [];

  // 1. Patch config/gtceu.yaml
  const gtceuRel = 'config/gtceu.yaml';
  const gtceuPath = path.join(instanceDir, gtceuRel);
  backupFileOnce(instanceDir, backupDir, manifest, gtceuRel, dryRun);
  const existingGtceu = fs.existsSync(gtceuPath)
    ? fs.readFileSync(gtceuPath, 'utf8')
    : fs.readFileSync(path.join(KIT_DIR, 'config/gtceu-lowspec-overrides.yaml'), 'utf8');
  const patchedGtceu = patchYamlScalars(existingGtceu, {
    oreGenerationChunkCacheSize: 128,
    oreIndicatorChunkCacheSize: 512,
    machineSounds: false,
    machinesEmissiveTextures: false,
    ambientOcclusion: false,
    renderFluids: false
  });
  if (!dryRun) {
    fs.writeFileSync(gtceuPath, patchedGtceu.content, 'utf8');
  }
  patchedFiles.push(gtceuRel);

  // 2. Patch config/gtlcore.yaml
  const gtlcoreRel = 'config/gtlcore.yaml';
  const gtlcorePath = path.join(instanceDir, gtlcoreRel);
  backupFileOnce(instanceDir, backupDir, manifest, gtlcoreRel, dryRun);
  const existingGtlcore = fs.existsSync(gtlcorePath)
    ? fs.readFileSync(gtlcorePath, 'utf8')
    : fs.readFileSync(path.join(KIT_DIR, 'config/gtlcore-lowspec-overrides.yaml'), 'utf8');
  const patchedGtlcore = patchYamlScalars(existingGtlcore, {
    enableSmoothAnimations: false,
    mobSpawnInterval: aggressive ? 100 : 80,
    ae2CraftingServiceUpdateInterval: aggressive ? 10 : 8,
    ae2StorageServiceUpdateInterval: aggressive ? 40 : 32,
    ae2CalculationMode: 'ULTRA_FAST'
  });
  if (!dryRun) {
    fs.writeFileSync(gtlcorePath, patchedGtlcore.content, 'utf8');
  }
  patchedFiles.push(gtlcoreRel);

  // 3. Merge config/embeddium-options.json
  const embeddiumRel = 'config/embeddium-options.json';
  const embeddiumPath = path.join(instanceDir, embeddiumRel);
  backupFileOnce(instanceDir, backupDir, manifest, embeddiumRel, dryRun);
  const kitEmbeddium = JSON.parse(
    fs.readFileSync(path.join(KIT_DIR, 'config/embeddium-options.json'), 'utf8')
  );
  let currentEmbeddium = {};
  if (fs.existsSync(embeddiumPath)) {
    try {
      currentEmbeddium = JSON.parse(fs.readFileSync(embeddiumPath, 'utf8'));
    } catch {
      currentEmbeddium = {};
    }
  }
  const mergedEmbeddium = deepMergeJson(currentEmbeddium, kitEmbeddium);
  if (aggressive) {
    mergedEmbeddium.performance.chunk_builder_threads = 1;
    mergedEmbeddium.extra.max_entity_distance = 16;
    mergedEmbeddium.extra.tile_entity_distance = 16;
  }
  if (!dryRun) {
    fs.writeFileSync(embeddiumPath, `${JSON.stringify(mergedEmbeddium, null, 2)}\n`, 'utf8');
  }
  patchedFiles.push(embeddiumRel);

  // 4. Merge config/modernfix-mixins.properties
  const modernfixRel = 'config/modernfix-mixins.properties';
  const modernfixPath = path.join(instanceDir, modernfixRel);
  backupFileOnce(instanceDir, backupDir, manifest, modernfixRel, dryRun);
  const existingModernfix = fs.existsSync(modernfixPath)
    ? fs.readFileSync(modernfixPath, 'utf8')
    : '';
  const nextModernfix = mergeKeyValueFile(
    existingModernfix,
    {
      'mixin.perf.dynamic_resources': 'true',
      'mixin.perf.faster_item_rendering': 'true',
      'mixin.perf.compact_bit_storage': 'true',
      'mixin.perf.deduplicate_location': 'true',
      'mixin.perf.faster_texture_stitching': 'true',
      'mixin.perf.mojang_registry_size': 'true',
      'mixin.perf.blast_search_trees': 'true',
      'mixin.bugfix.chunk_deadlock': 'true',
      'mixin.bugfix.packet_leak': 'true'
    },
    '='
  );
  if (!dryRun) {
    fs.writeFileSync(modernfixPath, nextModernfix, 'utf8');
  }
  patchedFiles.push(modernfixRel);

  // 5. Install config/ferritecore-mixin.toml if absent
  const ferriteRel = 'config/ferritecore-mixin.toml';
  const ferritePath = path.join(instanceDir, ferriteRel);
  if (!fs.existsSync(ferritePath)) {
    backupFileOnce(instanceDir, backupDir, manifest, ferriteRel, dryRun);
    const kitFerrite = fs.readFileSync(
      path.join(KIT_DIR, 'config/ferritecore-mixin.toml'),
      'utf8'
    );
    if (!dryRun) {
      fs.writeFileSync(ferritePath, kitFerrite, 'utf8');
    }
    patchedFiles.push(ferriteRel);
  }

  // 6. Patch options.txt (mipmapLevels:0 saves huge VRAM/RAM on GTCEu atlases!)
  const optionsRel = 'options.txt';
  const optionsPath = path.join(instanceDir, optionsRel);
  backupFileOnce(instanceDir, backupDir, manifest, optionsRel, dryRun);
  const existingOptions = fs.existsSync(optionsPath)
    ? fs.readFileSync(optionsPath, 'utf8')
    : '';
  const nextOptions = mergeKeyValueFile(
    existingOptions,
    {
      graphicsMode: '0',
      ao: '0',
      biomeBlendRadius: '0',
      renderDistance: aggressive ? '4' : '6',
      simulationDistance: aggressive ? '5' : '6',
      entityDistanceScaling: '0.5',
      maxFps: '60',
      enableVsync: 'false',
      particles: '2',
      renderClouds: '"false"',
      entityShadows: 'false',
      mipmapLevels: '0',
      prioritizedChunkUpdates: '0',
      syncChunkWrites: 'false'
    },
    ':'
  );
  if (!dryRun) {
    fs.writeFileSync(optionsPath, nextOptions, 'utf8');
  }
  patchedFiles.push(optionsRel);

  // 7. Scan mods/ and disable heavy client-only cosmetic/shader mods
  const modsDir = path.join(instanceDir, 'mods');
  const disabledMods = [];
  const activePatterns = aggressive
    ? [...SAFE_CLIENT_ONLY_PATTERNS, ...AGGRESSIVE_CLIENT_ONLY_PATTERNS]
    : SAFE_CLIENT_ONLY_PATTERNS;

  if (fs.existsSync(modsDir)) {
    const entries = fs.readdirSync(modsDir);
    for (const fileName of entries) {
      if (!fileName.endsWith('.jar')) {
        continue;
      }
      const isProtected = PROTECTED_MOD_PATTERNS.some((re) => re.test(fileName));
      if (isProtected) {
        continue;
      }
      const shouldDisable = activePatterns.some((re) => re.test(fileName));
      if (shouldDisable) {
        const srcJar = path.join(modsDir, fileName);
        const dstJar = path.join(modsDir, `${fileName}.disabled`);
        if (!dryRun) {
          fs.renameSync(srcJar, dstJar);
        }
        disabledMods.push(fileName);
        if (!manifest.disabledMods.includes(fileName)) {
          manifest.disabledMods.push(fileName);
        }
      }
    }
  }

  // 8. Write tailored JVM_ARGS_RECOMMENDED.txt
  const jvmArgs = buildRecommendedJvmArgs(ramGb);
  const jvmRel = 'JVM_ARGS_RECOMMENDED.txt';
  backupFileOnce(instanceDir, backupDir, manifest, jvmRel, dryRun);
  if (!dryRun) {
    fs.writeFileSync(
      path.join(instanceDir, jvmRel),
      `# Recommended Java 17 JVM Arguments for ${ramGb} GB System RAM (GregTech Leisure 1.20.1)\n${jvmArgs}\n`,
      'utf8'
    );
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
  patchedFiles.push(jvmRel);

  return {
    instanceDir,
    ramGb,
    aggressive,
    dryRun,
    patchedFiles,
    disabledMods,
    recommendedJvmArgs: jvmArgs,
    backupManifest: manifestPath
  };
}

if (require.main === module) {
  const args = parseCliArgs(process.argv);
  if (!args.instanceDir) {
    console.error(
      'Usage: npm run optimize-pack -- --instance-dir "/path/to/GregTech Leisure" [--ram-gb 8] [--aggressive] [--dry-run] [--restore]'
    );
    process.exit(1);
  }
  try {
    const report = optimizeModpackInstance(args);
    console.log(JSON.stringify(report, null, 2));
  } catch (err) {
    console.error(`[optimize-pack] Error: ${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  optimizeModpackInstance,
  restoreModpackInstance,
  patchYamlScalars,
  mergeKeyValueFile,
  buildRecommendedJvmArgs
};
