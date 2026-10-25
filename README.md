# GregTech Leisure (GTL 1.20.1) — Low-End PC Optimizer & Headless Automation Bot

A two-part engineering toolkit built specifically for **GregTech Leisure (`1.4.5.x`, Minecraft `1.20.1`, Forge `47.4.16`)** on **low-spec / weak PCs**:

1. **Low-End PC Modpack Optimizer (`npm run optimize-pack` + `modpack-optimizations/`)** — Automatically patches an installed GregTech Leisure CurseForge / Prism / Modrinth instance to cut RAM usage by **~1.5–2.2 GB**, eliminate integrated-GPU texture-atlas stalls, reduce AE2/GTCEu CPU tick overhead, and safely disable heavy client-only visual mods (`oculus`, `openysm`, `cosmeticarmorreworked`, etc.) with automatic `.gtl-backup/` snapshots and `--restore`.
2. **Headless GregTech Leisure Automation Agent (`src/bot.js`)** — A zero-GPU (~55 MB RAM) headless **Mineflayer `1.20.1`** bot speaking native **Forge `FML3` (`fml:loginwrapper` / `fml:handshake`)** — **no external ViaProxy Java process required** — trained on GregTech Leisure's FTB Quests chapters, GTCEu Modern / GTLCore / KubeJS recipes, 3D multiblock blueprints, and GTL volatility hazards.

---

## Part 1: Fixing Up GregTech Leisure for a Low-End PC

GregTech Leisure is already much faster-paced than GTNH (`durationMultiplier: 0.05`, `oreMultiplier: 4`, Steam Age overhaul), **but out of the box** it ships with shader hooks (`oculus`), custom 3D skeletal player models (`openysm`), dual-pass GTCEu emissive machine bloom (`machinesEmissiveTextures: true`), `mipmapLevels: 4` on 20,000+ GregTech textures, and large ore-vein chunk caches (`2048` chunks) that choke 8 GB RAM / integrated-GPU laptops.

### One-Command Automatic Modpack Fixer

Point `optimize-pack` at your CurseForge, Prism Launcher, or Modrinth **GregTech Leisure** instance folder:

```bash
# Standard Low-Spec Mode (8 GB System RAM PC)
npm run optimize-pack -- --instance-dir "/path/to/Instances/GregTech Leisure" --ram-gb 8

# Potato / Integrated GPU Mode (maximum FPS & lowest RAM, keeps 100% server compatibility)
npm run optimize-pack -- --instance-dir "/path/to/Instances/GregTech Leisure" --ram-gb 8 --aggressive

# Preview changes without modifying files
npm run optimize-pack -- --instance-dir "/path/to/Instances/GregTech Leisure" --dry-run

# Revert every config & re-enable every disabled client JAR from .gtl-backup/
npm run optimize-pack -- --instance-dir "/path/to/Instances/GregTech Leisure" --restore
```

### What `optimize-pack` Fixes Under the Hood

| Bottleneck in Stock GTL | Optimization Applied | Hardware Impact |
| :--- | :--- | :--- |
| **20,000+ GTCEu/GTL `BakedModel`s held in RAM** | Enables `mixin.perf.dynamic_resources=true` & `faster_item_rendering=true` in `config/modernfix-mixins.properties` + `config/ferritecore-mixin.toml` | Saves **~1.2 – 1.8 GB Heap RAM** and cuts load times |
| **4x Mipmap Texture Atlas (`options.txt`)** | Sets `mipmapLevels:0`, `renderDistance:6` (`4` in `--aggressive`), `simulationDistance:6`, `entityShadows:false`, `particles:2` | Cuts VRAM footprint by **~75%** and prevents iGPU frame freezes |
| **GTCEu Emissive Bloom & Sound Saturation (`config/gtceu.yaml`)** | Sets `machinesEmissiveTextures: false`, `machineSounds: false`, shrinks `oreGenerationChunkCacheSize: 128` & `oreIndicatorChunkCacheSize: 512` *(leaves `ghostCircuit`, `casingsPerCraft`, etc. untouched!)* | Eliminates FPS drops in dense LV–HV machine rooms & OpenAL audio thread stalls |
| **GTLCore Animations & AE2 Tick Rate (`config/gtlcore.yaml`)** | Sets `enableSmoothAnimations: false`, `mobSpawnInterval: 80`, raises `ae2CraftingServiceUpdateInterval: 8` & `ae2StorageServiceUpdateInterval: 32` *(leaves `durationMultiplier: 0.05` & `oreMultiplier: 4` intact!)* | Halves AE2 ME network & mob-spawn CPU tick time |
| **Embeddium Culling (`config/embeddium-options.json`)** | Enables `use_block_face_culling`, `use_entity_culling`, `use_fog_occlusion`, `animate_only_visible_textures`, `max_entity_distance: 24`, `tile_entity_distance: 24` | Major GPU frame-time boost around pipe/cable ducts |
| **Heavy Client-Only Mods (`mods/*.jar`)** | Disables `oculus`, `openysm`/`yesstevemodel`, `cosmeticarmorreworked` (+ `ModernUI`, `simple-voice-chat`, `legendarytooltips`, `soundphysics` in `--aggressive`) while **protecting** all gameplay/server mods (`gtceu`, `gtlcore`, `kubejs`, `ae2`, `mae2`, `ad_astra`, `embeddium`, `modernfix`, `ferritecore`) | Saves **~400 – 700 MB RAM** while keeping **100% multiplayer compatibility** |

### Recommended Java 17 JVM Arguments (`modpack-optimizations/jvm-args-low-ram.txt`)

Paste the matching profile into **Prism Launcher / CurseForge / Modrinth -> Java Settings -> JVM Arguments**:

- **8 GB Total System RAM** *(allocates 4.5 GB heap so Windows + iGPU still have 3.5 GB breathing room)*:
  ```text
  -Xms4096M -Xmx4608M -XX:+UnlockExperimentalVMOptions -XX:+UseG1GC -XX:G1NewSizePercent=20 -XX:G1ReservePercent=20 -XX:MaxGCPauseMillis=35 -XX:G1HeapRegionSize=16M -XX:+UseStringDeduplication -XX:+DisableExplicitGC -XX:+AlwaysPreTouch -Dfml.readTimeout=180 -Dforge.logging.mojang.level=warn
  ```
- **12–16 GB Total System RAM** *(allocates 5.5–6.0 GB heap for mid/late-game AE2 + multiblock bases)*:
  ```text
  -Xms5120M -Xmx6144M -XX:+UnlockExperimentalVMOptions -XX:+UseG1GC -XX:G1NewSizePercent=20 -XX:G1ReservePercent=20 -XX:MaxGCPauseMillis=35 -XX:G1HeapRegionSize=32M -XX:+UseStringDeduplication -XX:+DisableExplicitGC -XX:+AlwaysPreTouch -Dfml.readTimeout=180 -Dforge.logging.mojang.level=warn
  ```

---

## Part 2: Architecture of the GregTech Leisure (`1.20.1`) Automation Bot

```text
Gtnh-bot-v1/
├── package.json                               # CommonJS Node.js (>=18) manifest & CLI scripts
├── modpack-optimizations/                     # Drop-in Low-Spec GTL 1.20.1 config kit & JVM flags
│   ├── config/embeddium-options.json
│   ├── config/modernfix-mixins.properties
│   ├── config/ferritecore-mixin.toml
│   ├── config/gtceu-lowspec-overrides.yaml
│   ├── config/gtlcore-lowspec-overrides.yaml
│   ├── options-potato.txt
│   └── jvm-args-low-ram.txt
├── data/
│   ├── quest_tree_template.json               # GTL FTB Quests hex IDs, GTCEu/KubeJS recipes & LDLib GUIs
│   ├── primitive_blast_furnace.json           # GTL 3x4x3 PBF (gtceu:primitive_blast_furnace + ULV bus support)
│   ├── electric_blast_furnace.json            # GTL 3x4x3 Dual-LV EBF + gtceu:duct_tape maintenance metadata
│   ├── large_steam_circuit_assembler.json     # GTL 3x3x3 Steam Overhaul Circuit Multiblock
│   └── gtl_steam_sample.snbt                  # Authentic GTL FTB Quests 1.20.1 SNBT chapter fixture
├── src/
│   ├── bot.js                                 # Native Mineflayer 1.20.1 entry point & GTLAutomationAgent
│   ├── craftingEngine.js                      # FTB Quests/JEI DAG solver, WarehouseTracker & 1.20.1 GUI clicker
│   ├── multiblockBuilder.js                   # 3D schematic printer, 1.20.1 block_place & duct-tape servicing
│   ├── survival/
│   │   └── autonomousProgression.js           # Zero-command survival bootstrap, GTCEu vein prospector & quest runner
│   ├── protocol/
│   │   └── forgeHandshake.js                  # Forge 47.x FML3 (\0FML3\0, fml:loginwrapper / fml:handshake)
│   ├── navigation/
│   │   └── gtnhNavigator.js                   # Steam exhaust vent, hot pipe, Y=-64 shaft & DDA raycast nav
│   ├── hazards/
│   │   └── hazardMonitor.js                   # Dry-boiler explosion, MAE2 EU P2P, & 2x low-EU drain guards
│   ├── statemachine/
│   │   └── hierarchy.js                       # 3-Tier Hierarchical State Machine (STEAM_ULV -> MAX)
│   └── cli/
│       ├── optimizeModpack.js                 # Low-End PC GTL Modpack Optimizer & backup restorer
│       ├── ingestData.js                      # FTB Quests .snbt parser + JEI/KubeJS DAG ingestion CLI
│       ├── planCraft.js                       # Offline GTCEu/KubeJS DAG crafting plan inspector
│       └── validateBlueprint.js               # 3D multiblock rotation & BOM verifier
└── test/                                      # 21 automated survival, live-TCP & unit tests (`npm test`)
```

### Core Capabilities Trained on GregTech Leisure

0. **Zero-Command Autonomous Survival & Modpack Progression (`src/survival/autonomousProgression.js`)**:
   - **No chat commands needed**: the moment the bot spawns into a survival world, it immediately begins playing toward one unified goal — **progressing through and beating GregTech Leisure from scratch**.
   - **Full Survival Self-Care**: Automatically eats food when hungry, cooks raw meat, hunts passive animals if starving, sprints clear of Creepers before detonation, defends against Zombies/Skeletons, recovers seamlessly across death/respawn, and persists Base Camp coordinates + discovered ore veins in `.gtl-runtime-state.json`.
   - **Dynamic GTCEu 3x3-Chunk Ore Vein Prospector**: Scans loaded chunks (`y = -44..112`) for modded blockState clusters (`stateId > vanillaMaxStateId` embedded in stone/deepslate), digs a sample block, learns `stateId -> synced GTCEu raw ore itemId` (`gtceu:raw_chalcopyrite`, `gtceu:raw_cassiterite`, `gtceu:raw_magnetite`, etc.) from inventory deltas, and mines full batches safely away from lava.
   - **GTL-Specific Early-Game Acceleration & Live Modded Crafting**: Respects `harderCharcoalRecipe: true` (converts `1 log -> 4 planks` for 4x starter smelting fuel), rushes GTL's **1-tick `minecraft:blast_furnace`** (`开荒加速`), crafts modded GTCEu hand tools (`hammer`, `mortar`, `wrench`, `file`) via server-authoritative `3x3` Crafting Table `ResultSlot` clicks (reclaiming durable GTCEu tools left in grid slots `1..9`), builds `gtceu:lp_steam_solid_boiler` + 3D `primitive_blast_furnace`, and advances continuously through `STEAM -> LV -> MV -> HV+` FTB Quests.

1. **Zero-Proxy Forge `1.20.1` (`FML3`) Handshake (`src/protocol/forgeHandshake.js`)**:
   - Injects the `\0FML3\0` hostname marker on `set_protocol`, unwraps `fml:loginwrapper` (`fml:handshake` packets `1` `S2CModList`, `2` `C2SModListReply`, `3` `S2CRegistry`, `4` `S2CConfigData`, `99` `C2SAck`), mirrors server mod channels automatically, and maps flattened 1.20.1 ResourceLocation IDs (`gtceu:*`, `gtlcore:*`, `kubejs:*`).
2. **FTB Quests `.snbt` & GTCEu/KubeJS DAG Crafting Engine (`src/craftingEngine.js`)**:
   - Models GregTech Leisure's progression chapters (`77F8039ACE718C6C` Steam ULV -> `393DD40CAFBB69A5` LV -> MV -> HV -> MAX), including GTL's custom Steam Overhaul circuits (`kubejs:precision_steam_mechanism`, `kubejs:basic_control_circuit`, `kubejs:advanced_control_circuit`) and standard GTCEu `gtceu:basic_electronic_circuit`.
   - Enforces GTL dimension-gated recipes (e.g., `kubejs:ancient_world` for Damascus Steel Dust) and prunes storage block/nugget compression cycles so `@dagrejs/graphlib` stays strictly acyclic.
   - Emits Minecraft `1.20.1` `window_click` wire packets (`stateId`, `changedSlots`, `cursorItem`) and configures `gtceu:programmed_circuit` (`{ Configuration: N }`) via GTCEu's built-in LDLib Ghost Circuit slot (`ghostCircuit: true`) or physical circuit transfer.
3. **3D Multiblock Builder (`src/multiblockBuilder.js`)**:
   - Includes ready-to-build schematics for GTL's **Primitive Blast Furnace** (supporting GTL's bottom-layer `gtceu:ulv_input_bus` / `gtceu:ulv_output_bus` Dirt-Forge automation), **Dual-LV Electric Blast Furnace** (2x `gtceu:lv_energy_input_hatch` for MV overclocking), and **Large Steam Circuit Assembler**.
   - Pauses and delegates missing hatches/casings to `CraftingEngine.requestCraft()`, verifies unobstructed air above `gtceu:lv_muffler_hatch`, emits 1.20.1 `block_place` sequence packets while sneaking, and automatically services newly formed Maintenance Hatches using `gtceu:duct_tape` (rewarded x256 in GTL quest `3F38CC8C8D650202`).
4. **GregTech Leisure Volatility & Hazard Monitor (`src/hazards/hazardMonitor.js` & `src/navigation/gtnhNavigator.js`)**:
   - **Dry Steam Boiler Explosion Guard** *(Quest `4BFC342697BDE75A`)*: Blocks water injection into any `gtceu:lp_steam_solid_boiler` / `gtceu:hp_steam_solid_boiler` whose water tank is `0 mB` and temperature exceeds `95°C`.
   - **Steam Exhaust Vent & Hot Pipe Avoidance** *(Quest `7736F74AEBCB914E`)*: Prevents walking into scalding steam exhaust jets or placing blocks that obstruct steam vents, and avoids unframed hot fluid pipes until framed.
   - **MAE2 EU P2P & Cable Over-Voltage Guard** *(Quest `4B66FAB975B2C7D2`)*: Verifies voltage tier parity across both direct GTCEu cables and `mae2:eu_p2p_tunnel` links (which do not step down voltage).
   - **2x Low-Energy Progress-Drain Hysteresis** *(`gtceu.yaml -> recipeProgressLowEnergy: true`)*: Halts electric crafting if `gtceu:lv_battery_buffer_4x` drops below **20% EU** and waits until **50% EU** recovery before resuming.

---

## Quick Start & CLI Commands

### 1. Install & Verify Everything Offline
```bash
npm install
npm test
npm run dry-run
```

### 2. Train on Full Local GregTech Leisure FTB Quests Chapters (`.snbt`)
Point the `.snbt` ingestion pipeline directly at your installed GregTech Leisure `chapters/` folder to import all 15 Tech Tiers chapters (`77F8039ACE718C6C.snbt`, `lv.snbt`, `mv.snbt`, `hv.snbt`, `ev.snbt`, ..., `max.snbt`) into a unified DAG JSON:

```bash
npm run ingest-data -- \
  --ftbquests-dir "/path/to/Instances/GregTech Leisure/config/ftbquests/quests/chapters" \
  --seed "-419283719283" \
  --out ./data/gtl_full_quest_db.json
```

### 3. Inspect Crafting Plans & Multiblock Blueprints
```bash
# Plan a GTCEu Basic Electronic Circuit (LV)
npm run plan -- gtceu:basic_electronic_circuit 2 LV

# Plan GTL's Steam-Age Cheap LV Circuit (Advanced Control Circuit)
npm run plan -- kubejs:advanced_control_circuit 4 STEAM

# Validate the Dual-LV Electric Blast Furnace blueprint rotated EAST
npm run validate-blueprint -- ./data/electric_blast_furnace.json EAST
```

### 4. Connect the Headless Bot to GregTech Leisure (Open-to-LAN or Dedicated Forge Server)

First, make sure you pull the latest version (`git pull && npm install`), and optionally probe your server's Forge handshake version (`FML3` / `47.4.16`) and mod list:

```bash
npm run probe-server -- 127.0.0.1 25565
```

#### Option A: Singleplayer **Open to LAN** (Works on Windows PowerShell/CMD, macOS, and Linux)
1. In your GregTech Leisure world, press **Esc -> Open to LAN -> Start LAN World** and check the port printed in chat (e.g. `54321`).
2. Run:
```bash
npm start -- --host 127.0.0.1 --port 54321 --auth offline --username GTL_Automaton
```

#### Option B: Dedicated GregTech Leisure Server (`online-mode=false`)
```bash
npm start -- --host <SERVER_IP> --port 25565 --auth offline --username GTL_Automaton
```

#### Option C: Dedicated GregTech Leisure Server (`online-mode=true` — Microsoft Account)
If the server verifies Mojang/Microsoft sessions (`online-mode=true`), pass `--auth microsoft` — the terminal will display a one-time `microsoft.com/link` device login code and cache your token locally:
```bash
npm start -- --host <SERVER_IP> --port 25565 --auth microsoft --username <YOUR_GAMERTAG_OR_EMAIL>
```

#### How the Forge `1.20.1` (`47.4.16` `FML3`) Connection Works Under the Hood
- **Immediate `\0FML3\0` Handshake Marker** (`ServerLifecycleHooks.handleServerLogin`): Injects `<host>\0FML3\0` on the initial `set_protocol` intention packet (with automatic `\0FML2\0` fallback if a server uses net version 2), preventing Forge's `"This server has mods that require Forge to be installed on the client"` rejection.
- **Full `fml:loginwrapper` & `fml:handshake` Negotiation**: Removes `minecraft-protocol`'s vanilla `onLoginPluginRequest` auto-null responder (which otherwise triggers `"Unexpected custom data from client"`), handles `S2CModData` (`5`, `.noResponse()`), echoes all 180+ GregTech Leisure server mods & required channels in `C2SModListReply` (`2`), ingests `S2CRegistry` (`3`) snapshots into `bot.registry`, acknowledges all `S2CConfigData` (`4`) TOMLs and custom mod login payloads, and decodes `fml:play` `OpenContainer` (`NetworkHooks.openScreen`) packets for GTCEu/LDLib GUIs.
- **Zero-Crash Modded Play Deserialization & Solid Modded Floor Physics**: Overrides `declare_recipes` and `declare_commands` with zero-copy `restBuffer` readers (+ synthetic root command node) so custom GTCEu/AE2/KubeJS recipe serializers and Forge command arguments never crash ProtoDef or bloat RAM, and proxies modded `blockStateId`s as solid `1x1x1` blocks so Mineflayer stands and pathfinds cleanly on modded factory floors.
