'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  optimizeModpackInstance,
  restoreModpackInstance
} = require('../src/cli/optimizeModpack');

test('optimizeModpackInstance tunes GTL configs, disables ONLY safe client-heavy JARs, writes 8GB JVM flags, and cleanly restores backups', () => {
  const tmpInstance = fs.mkdtempSync(path.join(os.tmpdir(), 'gtl-lowspec-test-'));

  try {
    fs.mkdirSync(path.join(tmpInstance, 'config'), { recursive: true });
    fs.mkdirSync(path.join(tmpInstance, 'mods'), { recursive: true });

    const originalGtceu = [
      'recipes:',
      '  nerfWoodCrafting: false',
      '  casingsPerCraft: 2',
      'worldgen:',
      '  oreGenerationChunkCacheSize: 512',
      '  oreIndicatorChunkCacheSize: 2048',
      'machines:',
      '  ghostCircuit: true',
      '  recipeProgressLowEnergy: true',
      '  machineSounds: true',
      'client:',
      '  machinesEmissiveTextures: true',
      ''
    ].join('\n');

    const originalGtlcore = [
      'durationMultiplier: 0.05',
      'oreMultiplier: 4',
      'enableSmoothAnimations: true',
      'mobSpawnInterval: 40',
      'ae2CraftingServiceUpdateInterval: 4',
      'ae2StorageServiceUpdateInterval: 16',
      'ae2CalculationMode: ULTRA_FAST',
      ''
    ].join('\n');

    fs.writeFileSync(path.join(tmpInstance, 'config/gtceu.yaml'), originalGtceu, 'utf8');
    fs.writeFileSync(path.join(tmpInstance, 'config/gtlcore.yaml'), originalGtlcore, 'utf8');
    fs.writeFileSync(
      path.join(tmpInstance, 'options.txt'),
      'mipmapLevels:4\nrenderDistance:12\ngraphicsMode:1\n',
      'utf8'
    );

    // Populate mock `mods/` directory with both heavy client-only JARs and protected core JARs
    const sampleJars = [
      'gtceu-1.20.1-1.6.4.jar',
      'gtlcore-1.20.1-1.4.5.jar',
      'embeddium-0.3.31+mc1.20.1.jar',
      'modernfix-forge-5.19.5+mc1.20.1.jar',
      'appliedenergistics2-forge-15.2.13.jar',
      'oculus-mc1.20.1-1.7.0.jar',
      'openysm-custom-1.20.1.jar',
      'cosmeticarmorreworked-1.20.1-v1a.jar',
      'ModernUI-Forge-1.20.1-3.11.0.jar'
    ];
    for (const jar of sampleJars) {
      fs.writeFileSync(path.join(tmpInstance, 'mods', jar), 'mock-jar', 'utf8');
    }

    // 1. Run Aggressive Low-Spec Optimization for an 8 GB RAM PC
    const report = optimizeModpackInstance({
      instanceDir: tmpInstance,
      ramGb: 8,
      aggressive: true
    });

    assert.equal(report.ramGb, 8);
    assert.match(report.recommendedJvmArgs, /-Xmx4608M/);

    // Verify protected gameplay mods remain active `.jar`
    assert.equal(fs.existsSync(path.join(tmpInstance, 'mods/gtceu-1.20.1-1.6.4.jar')), true);
    assert.equal(fs.existsSync(path.join(tmpInstance, 'mods/gtlcore-1.20.1-1.4.5.jar')), true);
    assert.equal(fs.existsSync(path.join(tmpInstance, 'mods/embeddium-0.3.31+mc1.20.1.jar')), true);
    assert.equal(fs.existsSync(path.join(tmpInstance, 'mods/modernfix-forge-5.19.5+mc1.20.1.jar')), true);

    // Verify client-heavy mods were renamed to `.jar.disabled`
    assert.equal(fs.existsSync(path.join(tmpInstance, 'mods/oculus-mc1.20.1-1.7.0.jar.disabled')), true);
    assert.equal(fs.existsSync(path.join(tmpInstance, 'mods/openysm-custom-1.20.1.jar.disabled')), true);
    assert.equal(fs.existsSync(path.join(tmpInstance, 'mods/cosmeticarmorreworked-1.20.1-v1a.jar.disabled')), true);
    assert.equal(fs.existsSync(path.join(tmpInstance, 'mods/ModernUI-Forge-1.20.1-3.11.0.jar.disabled')), true);

    // Verify `gtceu.yaml` keeps GTL gameplay settings intact while disabling emissive bloom & shrinking caches
    const patchedGtceu = fs.readFileSync(path.join(tmpInstance, 'config/gtceu.yaml'), 'utf8');
    assert.match(patchedGtceu, /ghostCircuit:\s*true/);
    assert.match(patchedGtceu, /casingsPerCraft:\s*2/);
    assert.match(patchedGtceu, /machinesEmissiveTextures:\s*false/);
    assert.match(patchedGtceu, /machineSounds:\s*false/);
    assert.match(patchedGtceu, /oreIndicatorChunkCacheSize:\s*512/);

    // Verify `gtlcore.yaml` keeps `durationMultiplier: 0.05` while tuning AE2 & animations
    const patchedGtlcore = fs.readFileSync(path.join(tmpInstance, 'config/gtlcore.yaml'), 'utf8');
    assert.match(patchedGtlcore, /durationMultiplier:\s*0\.05/);
    assert.match(patchedGtlcore, /enableSmoothAnimations:\s*false/);
    assert.match(patchedGtlcore, /ae2CraftingServiceUpdateInterval:\s*10/);

    // Verify `modernfix-mixins.properties` enables `dynamic_resources` and `options.txt` drops mipmaps to 0
    const modernfix = fs.readFileSync(path.join(tmpInstance, 'config/modernfix-mixins.properties'), 'utf8');
    assert.match(modernfix, /mixin\.perf\.dynamic_resources=true/);
    const optionsTxt = fs.readFileSync(path.join(tmpInstance, 'options.txt'), 'utf8');
    assert.match(optionsTxt, /mipmapLevels:0/);

    // 2. Test `--restore` reverts every modified config and re-enables every `.jar` cleanly!
    const restored = restoreModpackInstance(tmpInstance);
    assert.equal(restored.restored, true);
    assert.equal(restored.reenabledMods.length, 4);
    assert.equal(fs.readFileSync(path.join(tmpInstance, 'config/gtceu.yaml'), 'utf8'), originalGtceu);
    assert.equal(fs.existsSync(path.join(tmpInstance, 'mods/oculus-mc1.20.1-1.7.0.jar')), true);
  } finally {
    fs.rmSync(tmpInstance, { recursive: true, force: true });
  }
});
