# GTNH-Bot-v1 — Headless GregTech: New Horizons Automation Framework

A production-grade, headless Node.js automation client built on **Mineflayer**, **mineflayer-pathfinder**, **mineflayer-statemachine**, and **ProtoDef / Forge `FML|HS` packet serialization**. Its objective is autonomous progression through the **GregTech: New Horizons (GTNH)** Quest Book (Forge 1.7.10) — from Stone Age and Steam Tier through Low Voltage (LV), Medium Voltage (MV), High Voltage (HV), and beyond.

---

## System Architecture

Data definitions (BetterQuesting DAGs, JEI/NEI recipes, 3D multiblock schematics, and GregTech GUI slot maps) are strictly decoupled from client network/spatial execution:

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│                         STATIC & INGESTED DATA LAYER                         │
│  /data/quest_tree_template.json   /data/primitive_blast_furnace.json         │
│  /data/electric_blast_furnace.json   NEI ID Dumps + World Seed + JEI Dumps   │
└───────────────────┬───────────────────────────────────────┬──────────────────┘
                    │                                       │
                    ▼                                       ▼
┌───────────────────────────────────────┐ ┌────────────────────────────────────┐
│     src/craftingEngine.js             │ │   src/multiblockBuilder.js         │
│  • Quest Book & JEI Recipe DAGs       │ │  • 3D Palette/Voxel Matrix Parser  │
│  • Cycle Breaker (Ingot<->Nugget)     │ │  • Anchor [0,0,0] + 4-Way Rotation │
│  • Recursive Dependency Resolver      │◄┤  • Chunk Cache + DDA Raycast Scan  │
│  • WarehouseTracker (3D Chest Index)  │ │  • Craft-on-Missing Pause/Resume   │
│  • ContainerPacketController (#1-#24) │ │  • Sneak-Guarded block_place Pkts  │
└───────────────────┬───────────────────┘ └─────────────────┬──────────────────┘
                    │                                       │
                    └───────────────────┬───────────────────┘
                                        ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│          src/statemachine/hierarchy.js (3-Tier Nested State Machine)         │
│  Depth 0: Root Preemption Arbiter (Macro <-> Hazard Emergency <-> Low Power) │
│  Depth 1: Macro Era/Quest Progression | Emergency Mitigation | EU Recovery   │
│  Depth 2: MiningLoop | CraftingLoop | MultiblockLoop | WarehouseSortingLoop  │
└──────────────┬────────────────────────────────┬──────────────────────────────┘
               ▼                                ▼
┌──────────────────────────────────┐ ┌─────────────────────────────────────────┐
│  src/navigation/gtnhNavigator.js │ │  src/hazards/hazardMonitor.js           │
│  • mineflayer-pathfinder + Moves │ │  • Rain/Storm Unroofed Machine Shutdown │
│  • Lava Vein & Live Wire Margins │ │  • Over-Voltage Cable Explosion Guard   │
│  • Vertical Shaft maxDropDown=3  │ │  • Battery Buffer / Steam EU Telemetry  │
│  • Dynamic Pollution Chunk Costs │ │  • Pollution Gibbl & Infernal Mob Evade │
│  • 3D Amanatides-Woo Raycaster   │ └────────────────────┬────────────────────┘
└──────────────┬───────────────────┘                      │
               └────────────────────┬─────────────────────┘
                                    ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│      src/bot.js + src/protocol/forgeHandshake.js (Network & FML Layer)       │
│  • FML|HS 5-Phase Handshake (ServerHello -> ModList -> ModIdData -> Ack)     │
│  • Bidirectional Forge 1.7.10 Dynamic Numeric ID <-> mod:item:meta Bridge    │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Repository Structure

| Path | Responsibility |
| :--- | :--- |
| `package.json` | Dependencies (`mineflayer`, `mineflayer-pathfinder`, `mineflayer-statemachine`, `minecraft-protocol`, `@tcortega/minecraft-protocol-forge`, `protodef`, `prismarine-*`, `@dagrejs/graphlib`, `vec3`) and CLI scripts. |
| `src/bot.js` | Primary entry point: Forge client handshake bootstrap, plugin injection, world/packet event binding, state machine startup, and `--dry-run` verification mode. |
| `src/craftingEngine.js` | Quest Book & JEI Directed Acyclic Graph (DAG) engine, recursive sub-component resolver, `WarehouseTracker`, and `ContainerPacketController` (custom GT slot clicker + Programmed Circuits `#1`–`#24`). |
| `src/multiblockBuilder.js` | 3D blueprint parser, cardinal rotation transformer, raycast/chunk bounding-box scanner, missing-hatch pause/craft callback, and sneak-guarded `block_place` packet printer. |
| `src/protocol/forgeHandshake.js` | Forge `FML|HS` 1.7.10 / 1.8+ handshake state machine and `ModIdData` dynamic numeric block/item ID translator (`ForgeRegistryBridge`). |
| `src/navigation/gtnhNavigator.js` | 1.7.10 hazard-aware pathfinder wrapper (lava veins, shaft drops, GT pollution cloud exclusion weights, protected multiblock footprints, and 3D voxel DDA raycaster). |
| `src/hazards/hazardMonitor.js` | Rain/storm machine Soft-Mallet cutoff, cable voltage-tier guard, Battery Buffer/Turbine EU hysteresis monitor, pollution debuff detector, and hostile/Infernal mob evasion. |
| `src/statemachine/hierarchy.js` | 3-depth hierarchical `mineflayer-statemachine` orchestrating macro GTNH Eras/Quests, micro task loops, and emergency survival preemption. |
| `src/cli/ingestData.js` | CLI ingestion pipeline transforming BetterQuesting `DefaultQuests.json`, JEI recipe JSONs, NEI ID CSVs, and world seeds into a unified DAG database. |
| `src/cli/planCraft.js` | CLI planner printing the resolved dependency tree and topological machine steps for any GTNH item ID. |
| `src/cli/validateBlueprint.js` | CLI validator inspecting 3D multiblock JSON blueprints, rotations, bounding boxes, and GTNH hatch rules. |
| `data/quest_tree_template.json` | Canonical GTNH Quest Book DAG, JEI recipe dataset (Stone -> Steam -> LV -> MV -> HV), and GregTech container `windowProfiles`. |
| `data/primitive_blast_furnace.json` | Exact 3x3x4 Primitive Blast Furnace 3D matrix (30 Firebricks, Controller at `[0,0,0]`, ULV Input Hatch, ULV Output Hatch, 3-high hollow chimney). |
| `data/electric_blast_furnace.json` | Reference 3x3x4 Electric Blast Furnace 3D matrix (Heat Proof Casings, Cupronickel Coils, Input/Output Buses & Hatch, Maintenance Hatch, 2x LV Energy Hatches, Sky-facing Muffler Hatch). |
| `test/*.test.js` | Automated unit & integration test suite verifying FML handshake, DAG crafting, Programmed Circuit `#14`, 3x3x4 PBF construction, and GTNH hazard sensors. |

---

## 1. Quick Start & Booting the Headless Client

### Install Dependencies & Verify Readiness

```bash
npm install

# Run offline headless verification (Quest DAG + LV Circuit plan + 3x3x4 PBF validation)
npm run dry-run

# Run full unit & integration test suite
npm test
```

### Connecting to a Live Modded Forge 1.7.10 GTNH Server

GTNH runs on a modified **Forge 1.7.10** engine (`Forge 10.13.4.1614`, protocol version `5`). Two network deployment topologies are supported out of the box:

#### Topology A: ViaProxy `1.8.8 -> 1.7.10` Forge Bridge (`fml_passthrough`, Recommended)
Running [ViaProxy](https://github.com/ViaVersion/ViaProxy) locally in front of the 1.7.10 GTNH server translates chunk/entity wire framing to `1.8.8` for Mineflayer's physics engine while passing `FML|HS` custom payload channels through to `src/protocol/forgeHandshake.js`:

```bash
GTNH_HOST=127.0.0.1 \
GTNH_PORT=25568 \
GTNH_USERNAME=GTNH_Automaton \
GTNH_AUTH=offline \
GTNH_VERSION=1.8.8 \
GTNH_FORGE_MODE=fml_passthrough \
npm start
```

#### Topology B: Direct 1.7.10 Forge Protocol Client (`direct_1710_client`)
Initializes a raw `minecraft-protocol` 1.7 client with `FML|HS` (`\0FML\0` host tag, `ServerHello -> REGISTER -> ClientHello -> ModList -> ModIdData -> HandshakeAck`) before binding Mineflayer:

```bash
GTNH_HOST=play.my-gtnh-server.example \
GTNH_PORT=25565 \
GTNH_USERNAME=GTNH_Automaton \
GTNH_FORGE_MODE=direct_1710_client \
GTNH_FORGE_MODS_JSON=./data/server_modlist.json \
npm start
```

### Environment Variable Reference

| Variable | Default | Description |
| :--- | :--- | :--- |
| `GTNH_HOST` | `127.0.0.1` | Target GTNH server or local ViaProxy bind address. |
| `GTNH_PORT` | `25565` | Target TCP port. |
| `GTNH_USERNAME` | `GTNH_Automaton` | Bot account username. |
| `GTNH_AUTH` | `offline` | Auth mode (`offline` or `microsoft`). |
| `GTNH_VERSION` | `1.8.8` | Protocol version presented to Mineflayer (`1.8.8` via proxy or `1.7`). |
| `GTNH_FORGE_MODE` | `fml_passthrough` | `fml_passthrough` or `direct_1710_client`. |
| `GTNH_FORGE_MODS_JSON` | *(built-in GTNH core)* | Optional JSON array of `{ modid, version }` pairs matching your exact GTNH pack version. |
| `GTNH_REGISTRY_DUMP_JSON` | `null` | Optional pre-dumped NEI numeric ID table JSON. |
| `GTNH_QUEST_DB_PATH` | `data/quest_tree_template.json` | Path to compiled Quest Book + JEI DAG JSON database. |
| `GTNH_BLUEPRINTS_DIR` | `data/` | Directory scanned on startup for 3D multiblock `.json` blueprints. |
| `GTNH_INITIAL_TIER` | `STEAM` | Initial unlocked voltage tier (`STONE`, `STEAM`, `ULV`, `LV`, `MV`, `HV`, `EV`, `IV`). |
| `GTNH_AUTO_RECONNECT` | `1` | Set `0` to disable exponential-backoff auto-reconnect. |
| `BOT_DEBUG_WINDOWS` | `0` | Set `1` to log raw container `windowId`, `inventoryType`, `windowTitle`, and `slotCount` packets for GUI calibration. |

---

## 2. Piping Server Seed, BetterQuesting, and JEI/NEI Dumps into the Database

Because Forge 1.7.10 dynamically allocates numeric block/item IDs per world (`ModIdData`), while JEI and BetterQuesting reference canonical string IDs (such as `gregtech:gt.metaitem.01:32700` for an **LV Electronic Circuit**), GTNH-Bot-v1 includes both **automatic login-time `ModIdData` packet extraction** (`ForgeRegistryBridge.ingestRegistryPacket`) and an offline **CLI Ingestion Pipeline** (`src/cli/ingestData.js`).

### Step 1: Export Raw Data from Your GTNH Instance
1. **Server Seed**: Run `/seed` in-game (or inspect `level.dat` via NBTExplorer) to record the world seed for GTNH 3x3 chunk ore-vein grid calculations.
2. **BetterQuesting Quest Book**: Copy `config/betterquesting/DefaultQuests.json` from the GTNH server or client pack folder.
3. **NEI Numeric ID CSV Dump**: Open inventory -> **NEI Options** -> **Tools** -> **Data Dumps** -> set **Items** and **Blocks** to `CSV` -> click **Dump** (produces `dumps/item.csv` and `dumps/block.csv`).
4. **JEI / GTNH Recipe Registry JSON**: Export machine & shaped/shapeless recipes as JSON matching the `recipes` schema in `data/quest_tree_template.json` (`recipeId`, `machine`, `voltageTier`, `euPerTick`, `durationTicks`, `programmedCircuit`, `inputs`, `fluidInputs`, `outputs`).

### Step 2: Run the Ingestion & DAG Verification Pipeline

```bash
npm run ingest -- \
  --base ./data/quest_tree_template.json \
  --quests /path/to/GTNH/config/betterquesting/DefaultQuests.json \
  --jei /path/to/exported_jei_recipes.json \
  --nei-csv /path/to/GTNH/dumps/item.csv \
  --seed -4918273645192837465 \
  --out ./data/gtnh_compiled_db.json
```

`ingestData.js` normalizes all BetterQuesting prerequisites into `questGraph`, compiles all JEI recipes into `recipeDag`, automatically detects and breaks reverse storage-recompression cycles (e.g., `9x Steel Nugget <-> 1x Steel Ingot`), and verifies strict DAG acyclicity (`alg.isAcyclic`).

### Step 3: Inspect Crafting Plans via CLI

```bash
# Resolve 2x LV Electronic Circuits (gregtech:gt.metaitem.01:32700) at LV tier
npm run plan -- gregtech:gt.metaitem.01:32700 2 LV

# Resolve 1x Empty Fluid Cell in LV Bender (uses Programmed Circuit #14)
npm run plan -- IC2:itemCellEmpty:0 1 LV
```

---

## 3. Calibrating Custom GregTech Container Window Click Vectors

GregTech 5 Unofficial / GTNH machines use custom ModularUI / `GT_Container_BasicMachine` window layouts with battery slots, multi-input item grids, phantom fluid tanks, and dedicated **Programmed Circuit** slots rather than vanilla crafting slots.

### Step 1: Capture Raw Container Telemetry
Launch the bot with window debugging enabled and open the target GregTech machine once (or let the bot interact with it):

```bash
BOT_DEBUG_WINDOWS=1 npm start
```

The bot logs the exact `open_window` header (`windowId`, `inventoryType`, `windowTitle`, `slotCount`). Within any open container:
- Slots `0 .. containerSlotCount - 1` belong to the **GregTech machine GUI** (battery slot, item inputs, fluid phantom slots, item outputs, circuit slot, ghost-circuit button).
- Slots `playerInventoryOffset .. playerInventoryOffset + 26` map to the **player's 3x9 main inventory**.
- Slots `playerInventoryOffset + 27 .. playerInventoryOffset + 35` map to the **player's 9-slot hotbar**.

### Step 2: Register or Calibrate a `windowProfile`

Add or adjust the machine entry under `windowProfiles` in `data/quest_tree_template.json`:

```json
"gt_lv_bender": {
  "titlePattern": "Bending Machine",
  "containerSlotCount": 8,
  "batterySlot": 0,
  "inputSlots": [1],
  "outputSlots": [2],
  "circuitSlot": 3,
  "ghostCircuitSelectorSlot": 4,
  "fluidInputSlots": [],
  "fluidOutputSlots": [],
  "playerInventoryOffset": 8
}
```

Or calibrate dynamically in code via `ContainerPacketController.calibrateClickVector`:

```js
agent.containerController.calibrateClickVector('gt_lv_bender', {
  containerSlotCount: 8,
  inputSlots: [1],
  outputSlots: [2],
  circuitSlot: 3,
  ghostCircuitSelectorSlot: 4,
  playerInventoryOffset: 8
});
```

### Step 3: Programmed Circuit (`#1`–`#24`) Packet Simulation

When a JEI recipe specifies `"programmedCircuit": 14` (e.g. bending plates into fluid cells or rolled foils in `gt_lv_bender`), `ContainerPacketController.configureProgrammedCircuit('gt_lv_bender', 14, options)` supports both GTNH circuit paradigms:

1. **`strategy: 'physical'`**: Locates `gregtech:gt.integrated_circuit` in the player inventory section (`playerInventoryOffset + slot`), tags it with NBT `{ Configuration: 14b }` / damage `14`, lifts it (`mode: 0, mouseButton: 0`), and places it into `circuitSlot` (`slot: 3`).
2. **`strategy: 'ghost'`**: Targets GTNH's built-in Ghost Circuit selector (`ghostCircuitSelectorSlot: 4`), resets it via middle-click (`mode: 3, mouseButton: 2`), then steps cleanly to `#14` using 2x `+5` clicks (`mode: 1, mouseButton: 1`) followed by 4x `+1` clicks (`mode: 0, mouseButton: 1`).

---

## 4. 3D Blueprint Multiblock Printing & Missing-Component Recovery

Blueprints in `/data/*.json` map a 3D `layers[y][z][x]` symbol matrix around `anchorGridIndex` (pinned to the master `controller` block at relative `[0, 0, 0]`):

```bash
# Validate the 3x3x4 Primitive Blast Furnace blueprint rotated EAST
npm run validate-blueprint -- ./data/primitive_blast_furnace.json EAST

# Validate the Dual-LV Electric Blast Furnace blueprint
npm run validate-blueprint -- ./data/electric_blast_furnace.json NORTH
```

During `multiblockBuilder.executeBuild('primitive_blast_furnace', anchorPos, { facing: 'NORTH' })`:
1. **Scan**: Queries `bot.blockAt` + `navigator.hasLineOfSight` across the 3D bounding box to classify `satisfied`, `missing`, `mismatched`, and `obstructedAir` voxels (plus open chimney sky-clearance).
2. **GTNH Missing-Hatch / Casing Rule**: Cross-references every required casing (`gregtech:gt.blockcasings4:15`) and specialized hatch (`input_hatch`, `output_hatch`, `maintenance_hatch`, `energy_hatch`, `muffler_hatch`) against inventory + `WarehouseTracker`. If any component is short, construction **pauses at a saved checkpoint** and dispatches `craftingEngine.requestCraft(itemId, deficit)` before resuming.
3. **Packet Placement**: Excavates interior chimney obstructions first, then places blocks bottom-up (`y` ascending), engaging **sneak** (`setControlState('sneak', true)`) before sending `block_place` packets against interactive GregTech controllers/hatches so right-clicking places casings rather than opening machine GUIs, followed by GregTech Wrench orientation clicks.

---

## 5. GTNH Volatility & Hazard Mitigation Summary

- **Rain / Thunderstorm Explosion Cutoff**: `HazardMonitor` intercepts `rain` events and raw `game_state_change` packets (`start_raining`, `rain_level_change`, `thunder_level_change`), immediately locking exterior cable runs and sending Soft Mallet (`gt.metatool.01:14`) shutdown packets to any registered active electric machine without overhead sky cover (including GT5u's 1-block horizontal rain-splash margin).
- **Over-Voltage Guard**: `verifySafeCableConnection(cableTier, machineTier)` rejects wiring higher-tier EU sources into lower-tier machines before a catastrophic explosion can occur.
- **EU & Steam Backup Buffer Hysteresis**: Polls `tile_entity_data` NBT (`mStoredEnergy`, `mStoredSteam`, internal battery `GT.ItemCharge`) across Battery Buffers and Steam Turbines. Drops below `20%` trigger `lowPowerHalted = true`, preempting the Root State Machine into `LowPowerStandbyMachine` until buffers recover past `50%` so recipes never stall mid-craft and void expensive materials.
- **Pollution & Infernal Mob Evasion**: Monitors `entity_effect` packets for clustered GTNH smog symptoms (Poison, Weakness, Slowness, Nausea, Mining Fatigue), penalizes polluted chunks inside `GTNHNavigator`'s `exclusionAreasStep`, and retreats from Creepers and GTNH Infernal Mobs (`1UP`, `Fiery`, `Vengeance`, `Webber`, etc.) via `GoalInvert`.
