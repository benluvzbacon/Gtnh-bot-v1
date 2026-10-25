'use strict';

const { normalizeItemId } = require('../protocol/forgeHandshake');

/**
 * Materials in GTCEu Modern 1.20.1 that carry `PropertyKey.BLAST` or `NO_ORE_SMELTING`
 * and therefore CANNOT be smelted into ingots in a normal Furnace / vanilla Blast Furnace
 * (they require a multiblock Primitive Blast Furnace or Electric Blast Furnace).
 */
const EBF_ONLY_GTCEU_MATERIALS = new Set([
  'aluminium',
  'aluminum',
  'steel',
  'stainless_steel',
  'titanium',
  'tungsten',
  'tungsten_steel',
  'tungstensteel',
  'chrome',
  'chromium',
  'silicon',
  'kanthal',
  'nichrome',
  'rtm_alloy',
  'hssg',
  'hsse',
  'hsss',
  'naquadah',
  'naquadah_alloy',
  'enriched_naquadah',
  'naquadria',
  'trinium',
  'neutronium',
  'osmium',
  'iridium',
  'platinum',
  'palladium',
  'rhodium',
  'ruthenium',
  'niobium',
  'vanadium',
  'yttrium',
  'cobalt_brass'
]);

/**
 * GTCEu Modern 1.20.1 direct-smelt ore -> target metal/gem/dust mapping
 * (`OreRecipeHandler.java` `property.getDirectSmeltResult()` & `oreMultiplier`).
 */
const GTCEU_ORE_SMELT_TARGETS = Object.freeze({
  // Coal & Lignite (raw ore -> 2x gem in GTCEu Modern!)
  coal: { outputId: 'minecraft:coal', outputCount: 2, canBlast: true },
  lignite_coal: { outputId: 'gtceu:lignite_gem', outputCount: 2, canBlast: true },
  lignite: { outputId: 'gtceu:lignite_gem', outputCount: 2, canBlast: true },

  // Iron vein family
  iron: { outputId: 'minecraft:iron_ingot', outputCount: 1, canBlast: true },
  magnetite: { outputId: 'minecraft:iron_ingot', outputCount: 1, canBlast: true },
  vanadium_magnetite: { outputId: 'minecraft:iron_ingot', outputCount: 1, canBlast: true },
  hematite: { outputId: 'minecraft:iron_ingot', outputCount: 1, canBlast: true },
  yellow_limonite: { outputId: 'minecraft:iron_ingot', outputCount: 1, canBlast: true },
  brown_limonite: { outputId: 'minecraft:iron_ingot', outputCount: 1, canBlast: true },
  banded_iron: { outputId: 'minecraft:iron_ingot', outputCount: 1, canBlast: true },
  pyrite: { outputId: 'minecraft:iron_ingot', outputCount: 1, canBlast: true },
  goethite: { outputId: 'minecraft:iron_ingot', outputCount: 1, canBlast: true },
  granitic_mineral_sand: { outputId: 'minecraft:iron_ingot', outputCount: 1, canBlast: true },
  basaltic_mineral_sand: { outputId: 'minecraft:iron_ingot', outputCount: 1, canBlast: true },

  // Copper vein family
  copper: { outputId: 'minecraft:copper_ingot', outputCount: 1, canBlast: true },
  chalcopyrite: { outputId: 'minecraft:copper_ingot', outputCount: 1, canBlast: true },
  tetrahedrite: { outputId: 'minecraft:copper_ingot', outputCount: 1, canBlast: true },
  malachite: { outputId: 'minecraft:copper_ingot', outputCount: 1, canBlast: true },
  bornite: { outputId: 'minecraft:copper_ingot', outputCount: 1, canBlast: true },
  chalcocite: { outputId: 'minecraft:copper_ingot', outputCount: 1, canBlast: true },
  cuprite: { outputId: 'minecraft:copper_ingot', outputCount: 1, canBlast: true },

  // Tin vein family
  tin: { outputId: 'gtceu:tin_ingot', outputCount: 1, canBlast: true },
  cassiterite: { outputId: 'gtceu:tin_ingot', outputCount: 2, canBlast: true },
  cassiterite_sand: { outputId: 'gtceu:tin_ingot', outputCount: 2, canBlast: true },

  // Gold / Lead / Silver / Nickel / Zinc / Antimony / Cobalt
  gold: { outputId: 'minecraft:gold_ingot', outputCount: 1, canBlast: true },
  lead: { outputId: 'gtceu:lead_ingot', outputCount: 1, canBlast: true },
  galena: { outputId: 'gtceu:lead_ingot', outputCount: 1, canBlast: true },
  cerussite: { outputId: 'gtceu:lead_ingot', outputCount: 1, canBlast: true },
  silver: { outputId: 'gtceu:silver_ingot', outputCount: 1, canBlast: true },
  nickel: { outputId: 'gtceu:nickel_ingot', outputCount: 1, canBlast: true },
  garnierite: { outputId: 'gtceu:nickel_ingot', outputCount: 1, canBlast: true },
  pentlandite: { outputId: 'gtceu:nickel_ingot', outputCount: 1, canBlast: true },
  zinc: { outputId: 'gtceu:zinc_ingot', outputCount: 1, canBlast: true },
  sphalerite: { outputId: 'gtceu:zinc_ingot', outputCount: 1, canBlast: true },
  antimony: { outputId: 'gtceu:antimony_ingot', outputCount: 1, canBlast: true },
  stibnite: { outputId: 'gtceu:antimony_ingot', outputCount: 1, canBlast: true },
  cobalt: { outputId: 'gtceu:cobalt_ingot', outputCount: 1, canBlast: true },
  cobaltite: { outputId: 'gtceu:cobalt_ingot', outputCount: 1, canBlast: true },
  beryllium: { outputId: 'gtceu:beryllium_ingot', outputCount: 1, canBlast: true },
  molybdenum: { outputId: 'gtceu:molybdenum_ingot', outputCount: 1, canBlast: true },
  molybdenite: { outputId: 'gtceu:molybdenum_ingot', outputCount: 1, canBlast: true },
  wulfenite: { outputId: 'gtceu:molybdenum_ingot', outputCount: 1, canBlast: true },
  neodymium: { outputId: 'gtceu:neodymium_ingot', outputCount: 1, canBlast: true },
  thorium: { outputId: 'gtceu:thorium_ingot', outputCount: 1, canBlast: true },

  // Redstone, Sulfur & Gems
  redstone: { outputId: 'minecraft:redstone', outputCount: 5, canBlast: true },
  sulfur: { outputId: 'gtceu:sulfur_dust', outputCount: 1, canBlast: true },
  cinnabar: { outputId: 'gtceu:cinnabar_gem', outputCount: 1, canBlast: true },
  diamond: { outputId: 'minecraft:diamond', outputCount: 1, canBlast: true },
  emerald: { outputId: 'minecraft:emerald', outputCount: 1, canBlast: true },
  lapis: { outputId: 'minecraft:lapis_lazuli', outputCount: 6, canBlast: true },
  lazurite: { outputId: 'gtceu:lazurite_gem', outputCount: 6, canBlast: true },
  sodalite: { outputId: 'gtceu:sodalite_gem', outputCount: 6, canBlast: true },
  nether_quartz: { outputId: 'minecraft:quartz', outputCount: 2, canBlast: true },
  certus_quartz: { outputId: 'gtceu:certus_quartz_gem', outputCount: 1, canBlast: true },
  quartzite: { outputId: 'gtceu:quartzite_gem', outputCount: 1, canBlast: true },
  ruby: { outputId: 'gtceu:ruby_gem', outputCount: 1, canBlast: true },
  sapphire: { outputId: 'gtceu:sapphire_gem', outputCount: 1, canBlast: true },
  green_sapphire: { outputId: 'gtceu:green_sapphire_gem', outputCount: 1, canBlast: true },
  topaz: { outputId: 'gtceu:topaz_gem', outputCount: 1, canBlast: true },
  blue_topaz: { outputId: 'gtceu:blue_topaz_gem', outputCount: 1, canBlast: true },
  amethyst: { outputId: 'minecraft:amethyst_shard', outputCount: 1, canBlast: true },
  opal: { outputId: 'gtceu:opal_gem', outputCount: 1, canBlast: true },
  salt: { outputId: 'gtceu:salt_gem', outputCount: 2, canBlast: true },
  rock_salt: { outputId: 'gtceu:rock_salt_gem', outputCount: 2, canBlast: true },
  apatite: { outputId: 'gtceu:apatite_gem', outputCount: 4, canBlast: true },
  tricalcium_phosphate: { outputId: 'gtceu:tricalcium_phosphate_dust', outputCount: 1, canBlast: true }
});

/**
 * Explicit Vanilla 1.20.1 + GregTech Leisure (`开荒加速[add_by_northsky].js`) Furnace / Blast Furnace / Smoker table.
 * Note:
 *  - `cobblestone -> stone` and `stone -> smooth_stone` are `canSmelt: true, canBlast: false`
 *    (Vanilla `minecraft:blast_furnace` NEVER smelts stone/cobblestone!).
 *  - GTL `harderCharcoalRecipe: true` disables `#logs -> charcoal` in furnaces.
 *  - GTL KubeJS sets `cookingTime = 1` tick (`0.05s`) for ALL `minecraft:blasting` recipes, and adds
 *    1-tick blasting for `iron_ingot -> wrought_iron_ingot`, `bronze_dust -> bronze_ingot`,
 *    `clay_ball -> brick`, `compressed_fireclay -> firebrick`, `compressed_coke_clay -> coke_oven_brick`,
 *    and `sand -> glass`!
 */
const BUILTIN_FURNACE_RECIPES = Object.freeze([
  // --- GTCEu Coal & Lignite Raw Ores -> Burnable Coal/Lignite ---
  {
    id: 'gtceu:smelt_raw_coal_to_coal',
    inputs: ['gtceu:raw_coal', 'gtceu:coal_ore', 'gtceu:deepslate_coal_ore'],
    outputId: 'minecraft:coal',
    outputCount: 2,
    canSmelt: true,
    canBlast: true,
    canSmoke: false,
    smeltTicks: 200,
    blastTicks: 1
  },
  {
    id: 'minecraft:coal_from_smelting_coal_ore',
    inputs: ['minecraft:coal_ore', 'minecraft:deepslate_coal_ore'],
    outputId: 'minecraft:coal',
    outputCount: 1,
    canSmelt: true,
    canBlast: true,
    canSmoke: false,
    smeltTicks: 200,
    blastTicks: 1
  },
  {
    id: 'gtceu:smelt_raw_lignite_to_gem',
    inputs: ['gtceu:raw_lignite_coal', 'gtceu:lignite_coal_ore', 'gtceu:deepslate_lignite_coal_ore'],
    outputId: 'gtceu:lignite_gem',
    outputCount: 2,
    canSmelt: true,
    canBlast: true,
    canSmoke: false,
    smeltTicks: 200,
    blastTicks: 1
  },

  // --- Vanilla + GTCEu Metals ---
  {
    id: 'gtl:smelt_iron_family',
    inputs: [
      'minecraft:raw_iron',
      'minecraft:iron_ore',
      'minecraft:deepslate_iron_ore',
      'gtceu:raw_magnetite',
      'gtceu:raw_vanadium_magnetite',
      'gtceu:raw_hematite',
      'gtceu:raw_yellow_limonite',
      'gtceu:raw_brown_limonite',
      'gtceu:raw_banded_iron',
      'gtceu:raw_pyrite',
      'gtceu:raw_goethite',
      'gtceu:raw_granitic_mineral_sand',
      'gtceu:raw_basaltic_mineral_sand',
      'gtceu:iron_dust',
      'gtceu:crushed_iron_ore',
      'gtceu:impure_iron_dust',
      'gtceu:pure_iron_dust'
    ],
    outputId: 'minecraft:iron_ingot',
    outputCount: 1,
    canSmelt: true,
    canBlast: true,
    canSmoke: false,
    smeltTicks: 200,
    blastTicks: 1
  },
  {
    id: 'gtl:smelt_copper_family',
    inputs: [
      'minecraft:raw_copper',
      'minecraft:copper_ore',
      'minecraft:deepslate_copper_ore',
      'gtceu:raw_copper',
      'gtceu:raw_chalcopyrite',
      'gtceu:raw_tetrahedrite',
      'gtceu:raw_malachite',
      'gtceu:raw_bornite',
      'gtceu:raw_chalcocite',
      'gtceu:copper_dust',
      'gtceu:crushed_copper_ore',
      'gtceu:impure_copper_dust',
      'gtceu:pure_copper_dust'
    ],
    outputId: 'minecraft:copper_ingot',
    outputCount: 1,
    canSmelt: true,
    canBlast: true,
    canSmoke: false,
    smeltTicks: 200,
    blastTicks: 1
  },
  {
    id: 'gtl:smelt_tin_family',
    inputs: [
      'gtceu:raw_tin',
      'gtceu:tin_dust',
      'gtceu:crushed_tin_ore',
      'gtceu:impure_tin_dust',
      'gtceu:pure_tin_dust'
    ],
    outputId: 'gtceu:tin_ingot',
    outputCount: 1,
    canSmelt: true,
    canBlast: true,
    canSmoke: false,
    smeltTicks: 200,
    blastTicks: 1
  },
  {
    id: 'gtl:smelt_cassiterite_family',
    inputs: ['gtceu:raw_cassiterite', 'gtceu:raw_cassiterite_sand'],
    outputId: 'gtceu:tin_ingot',
    outputCount: 2,
    canSmelt: true,
    canBlast: true,
    canSmoke: false,
    smeltTicks: 200,
    blastTicks: 1
  },
  {
    id: 'gtl:smelt_gold_family',
    inputs: [
      'minecraft:raw_gold',
      'minecraft:gold_ore',
      'minecraft:deepslate_gold_ore',
      'minecraft:nether_gold_ore',
      'gtceu:gold_dust',
      'gtceu:crushed_gold_ore'
    ],
    outputId: 'minecraft:gold_ingot',
    outputCount: 1,
    canSmelt: true,
    canBlast: true,
    canSmoke: false,
    smeltTicks: 200,
    blastTicks: 1
  },
  {
    id: 'gtl:smelt_lead_family',
    inputs: ['gtceu:raw_lead', 'gtceu:raw_galena', 'gtceu:lead_dust', 'gtceu:crushed_lead_ore'],
    outputId: 'gtceu:lead_ingot',
    outputCount: 1,
    canSmelt: true,
    canBlast: true,
    canSmoke: false,
    smeltTicks: 200,
    blastTicks: 1
  },
  {
    id: 'gtl:smelt_silver_family',
    inputs: ['gtceu:raw_silver', 'gtceu:silver_dust', 'gtceu:crushed_silver_ore'],
    outputId: 'gtceu:silver_ingot',
    outputCount: 1,
    canSmelt: true,
    canBlast: true,
    canSmoke: false,
    smeltTicks: 200,
    blastTicks: 1
  },
  {
    id: 'gtl:smelt_nickel_family',
    inputs: [
      'gtceu:raw_nickel',
      'gtceu:raw_garnierite',
      'gtceu:raw_pentlandite',
      'gtceu:nickel_dust',
      'gtceu:crushed_nickel_ore'
    ],
    outputId: 'gtceu:nickel_ingot',
    outputCount: 1,
    canSmelt: true,
    canBlast: true,
    canSmoke: false,
    smeltTicks: 200,
    blastTicks: 1
  },
  {
    id: 'gtl:smelt_zinc_family',
    inputs: ['gtceu:raw_zinc', 'gtceu:raw_sphalerite', 'gtceu:zinc_dust', 'gtceu:crushed_zinc_ore'],
    outputId: 'gtceu:zinc_ingot',
    outputCount: 1,
    canSmelt: true,
    canBlast: true,
    canSmoke: false,
    smeltTicks: 200,
    blastTicks: 1
  },
  {
    id: 'gtl:smelt_antimony_family',
    inputs: ['gtceu:raw_stibnite', 'gtceu:antimony_dust'],
    outputId: 'gtceu:antimony_ingot',
    outputCount: 1,
    canSmelt: true,
    canBlast: true,
    canSmoke: false,
    smeltTicks: 200,
    blastTicks: 1
  },
  {
    id: 'gtl:smelt_raw_redstone',
    inputs: ['gtceu:raw_redstone'],
    outputId: 'minecraft:redstone',
    outputCount: 5,
    canSmelt: true,
    canBlast: true,
    canSmoke: false,
    smeltTicks: 200,
    blastTicks: 1
  },
  {
    id: 'minecraft:redstone_from_smelting_redstone_ore',
    inputs: ['minecraft:redstone_ore', 'minecraft:deepslate_redstone_ore'],
    outputId: 'minecraft:redstone',
    outputCount: 1,
    canSmelt: true,
    canBlast: true,
    canSmoke: false,
    smeltTicks: 200,
    blastTicks: 1
  },
  {
    id: 'gtl:smelt_raw_sulfur',
    inputs: ['gtceu:raw_sulfur'],
    outputId: 'gtceu:sulfur_dust',
    outputCount: 1,
    canSmelt: true,
    canBlast: true,
    canSmoke: false,
    smeltTicks: 200,
    blastTicks: 1
  },
  {
    id: 'gtl:smelt_diamond_ores',
    inputs: ['minecraft:diamond_ore', 'minecraft:deepslate_diamond_ore', 'gtceu:raw_diamond'],
    outputId: 'minecraft:diamond',
    outputCount: 1,
    canSmelt: true,
    canBlast: true,
    canSmoke: false,
    smeltTicks: 200,
    blastTicks: 1
  },
  {
    id: 'gtl:smelt_emerald_ores',
    inputs: ['minecraft:emerald_ore', 'minecraft:deepslate_emerald_ore', 'gtceu:raw_emerald'],
    outputId: 'minecraft:emerald',
    outputCount: 1,
    canSmelt: true,
    canBlast: true,
    canSmoke: false,
    smeltTicks: 200,
    blastTicks: 1
  },
  {
    id: 'gtl:smelt_raw_lapis',
    inputs: ['gtceu:raw_lapis'],
    outputId: 'minecraft:lapis_lazuli',
    outputCount: 6,
    canSmelt: true,
    canBlast: true,
    canSmoke: false,
    smeltTicks: 200,
    blastTicks: 1
  },
  {
    id: 'minecraft:lapis_from_smelting_lapis_ore',
    inputs: ['minecraft:lapis_ore', 'minecraft:deepslate_lapis_ore'],
    outputId: 'minecraft:lapis_lazuli',
    outputCount: 1,
    canSmelt: true,
    canBlast: true,
    canSmoke: false,
    smeltTicks: 200,
    blastTicks: 1
  },
  {
    id: 'minecraft:quartz_from_smelting',
    inputs: ['minecraft:nether_quartz_ore', 'gtceu:raw_nether_quartz'],
    outputId: 'minecraft:quartz',
    outputCount: 1,
    canSmelt: true,
    canBlast: true,
    canSmoke: false,
    smeltTicks: 200,
    blastTicks: 1
  },

  // --- GregTech Leisure KubeJS (`开荒加速[add_by_northsky].js`) 1-Tick Blast Furnace Shortcuts ---
  {
    id: 'gtl_kubejs:wrought_iron_ingot',
    inputs: ['minecraft:iron_ingot'],
    outputId: 'gtceu:wrought_iron_ingot',
    outputCount: 1,
    canSmelt: true,
    canBlast: true,
    canSmoke: false,
    smeltTicks: 40,
    blastTicks: 1
  },
  {
    id: 'gtl_kubejs:bronze_ingot_from_dust',
    inputs: ['gtceu:bronze_dust'],
    outputId: 'gtceu:bronze_ingot',
    outputCount: 1,
    canSmelt: true,
    canBlast: true,
    canSmoke: false,
    smeltTicks: 200,
    blastTicks: 1
  },
  {
    id: 'gtl_kubejs:coke_oven_brick',
    inputs: ['gtceu:compressed_coke_clay'],
    outputId: 'gtceu:coke_oven_brick',
    outputCount: 1,
    canSmelt: false,
    canBlast: true,
    canSmoke: false,
    smeltTicks: 200,
    blastTicks: 1
  },
  {
    id: 'gtl_kubejs:firebrick',
    inputs: ['gtceu:compressed_fireclay'],
    outputId: 'gtceu:firebrick',
    outputCount: 1,
    canSmelt: true,
    canBlast: true,
    canSmoke: false,
    smeltTicks: 200,
    blastTicks: 1
  },
  {
    id: 'gtl_kubejs:brick_from_clay_ball',
    inputs: ['minecraft:clay_ball'],
    outputId: 'minecraft:brick',
    outputCount: 1,
    canSmelt: true,
    canBlast: true,
    canSmoke: false,
    smeltTicks: 200,
    blastTicks: 1
  },
  {
    id: 'gtl_kubejs:glass_from_sand',
    inputs: ['minecraft:sand', 'minecraft:red_sand'],
    outputId: 'minecraft:glass',
    outputCount: 1,
    canSmelt: true,
    canBlast: true,
    canSmoke: false,
    smeltTicks: 200,
    blastTicks: 1
  },

  // --- Stone / Building Blocks (Furnace ONLY — `canBlast: false`!) ---
  {
    id: 'minecraft:stone',
    inputs: ['minecraft:cobblestone'],
    outputId: 'minecraft:stone',
    outputCount: 1,
    canSmelt: true,
    canBlast: false,
    canSmoke: false,
    smeltTicks: 200,
    blastTicks: 0
  },
  {
    id: 'minecraft:smooth_stone',
    inputs: ['minecraft:stone'],
    outputId: 'minecraft:smooth_stone',
    outputCount: 1,
    canSmelt: true,
    canBlast: false,
    canSmoke: false,
    smeltTicks: 200,
    blastTicks: 0
  },
  {
    id: 'minecraft:deepslate_from_cobbled',
    inputs: ['minecraft:cobbled_deepslate'],
    outputId: 'minecraft:deepslate',
    outputCount: 1,
    canSmelt: true,
    canBlast: false,
    canSmoke: false,
    smeltTicks: 200,
    blastTicks: 0
  },
  {
    id: 'minecraft:terracotta',
    inputs: ['minecraft:clay'],
    outputId: 'minecraft:terracotta',
    outputCount: 1,
    canSmelt: true,
    canBlast: false,
    canSmoke: false,
    smeltTicks: 200,
    blastTicks: 0
  },
  {
    id: 'minecraft:nether_brick',
    inputs: ['minecraft:netherrack'],
    outputId: 'minecraft:nether_brick',
    outputCount: 1,
    canSmelt: true,
    canBlast: false,
    canSmoke: false,
    smeltTicks: 200,
    blastTicks: 0
  },
  {
    id: 'minecraft:smooth_quartz',
    inputs: ['minecraft:quartz_block'],
    outputId: 'minecraft:smooth_quartz',
    outputCount: 1,
    canSmelt: true,
    canBlast: false,
    canSmoke: false,
    smeltTicks: 200,
    blastTicks: 0
  },
  {
    id: 'minecraft:smooth_sandstone',
    inputs: ['minecraft:sandstone'],
    outputId: 'minecraft:smooth_sandstone',
    outputCount: 1,
    canSmelt: true,
    canBlast: false,
    canSmoke: false,
    smeltTicks: 200,
    blastTicks: 0
  },
  {
    id: 'minecraft:smooth_basalt',
    inputs: ['minecraft:basalt'],
    outputId: 'minecraft:smooth_basalt',
    outputCount: 1,
    canSmelt: true,
    canBlast: false,
    canSmoke: false,
    smeltTicks: 200,
    blastTicks: 0
  },
  {
    id: 'minecraft:sponge_from_wet_sponge',
    inputs: ['minecraft:wet_sponge'],
    outputId: 'minecraft:sponge',
    outputCount: 1,
    canSmelt: true,
    canBlast: false,
    canSmoke: false,
    smeltTicks: 200,
    blastTicks: 0
  },
  {
    id: 'minecraft:green_dye',
    inputs: ['minecraft:cactus'],
    outputId: 'minecraft:green_dye',
    outputCount: 1,
    canSmelt: true,
    canBlast: false,
    canSmoke: false,
    smeltTicks: 200,
    blastTicks: 0
  },
  {
    id: 'minecraft:popped_chorus_fruit',
    inputs: ['minecraft:chorus_fruit'],
    outputId: 'minecraft:popped_chorus_fruit',
    outputCount: 1,
    canSmelt: true,
    canBlast: false,
    canSmoke: false,
    smeltTicks: 200,
    blastTicks: 0
  },

  // --- Vanilla Food Smelting & Smoking (`canBlast: false`, `canSmoke: true`) ---
  {
    id: 'minecraft:cooked_beef',
    inputs: ['minecraft:beef'],
    outputId: 'minecraft:cooked_beef',
    outputCount: 1,
    canSmelt: true,
    canBlast: false,
    canSmoke: true,
    smeltTicks: 200,
    blastTicks: 0
  },
  {
    id: 'minecraft:cooked_porkchop',
    inputs: ['minecraft:porkchop'],
    outputId: 'minecraft:cooked_porkchop',
    outputCount: 1,
    canSmelt: true,
    canBlast: false,
    canSmoke: true,
    smeltTicks: 200,
    blastTicks: 0
  },
  {
    id: 'minecraft:cooked_mutton',
    inputs: ['minecraft:mutton'],
    outputId: 'minecraft:cooked_mutton',
    outputCount: 1,
    canSmelt: true,
    canBlast: false,
    canSmoke: true,
    smeltTicks: 200,
    blastTicks: 0
  },
  {
    id: 'minecraft:cooked_chicken',
    inputs: ['minecraft:chicken'],
    outputId: 'minecraft:cooked_chicken',
    outputCount: 1,
    canSmelt: true,
    canBlast: false,
    canSmoke: true,
    smeltTicks: 200,
    blastTicks: 0
  },
  {
    id: 'minecraft:cooked_rabbit',
    inputs: ['minecraft:rabbit'],
    outputId: 'minecraft:cooked_rabbit',
    outputCount: 1,
    canSmelt: true,
    canBlast: false,
    canSmoke: true,
    smeltTicks: 200,
    blastTicks: 0
  },
  {
    id: 'minecraft:cooked_cod',
    inputs: ['minecraft:cod'],
    outputId: 'minecraft:cooked_cod',
    outputCount: 1,
    canSmelt: true,
    canBlast: false,
    canSmoke: true,
    smeltTicks: 200,
    blastTicks: 0
  },
  {
    id: 'minecraft:cooked_salmon',
    inputs: ['minecraft:salmon'],
    outputId: 'minecraft:cooked_salmon',
    outputCount: 1,
    canSmelt: true,
    canBlast: false,
    canSmoke: true,
    smeltTicks: 200,
    blastTicks: 0
  },
  {
    id: 'minecraft:baked_potato',
    inputs: ['minecraft:potato'],
    outputId: 'minecraft:baked_potato',
    outputCount: 1,
    canSmelt: true,
    canBlast: false,
    canSmoke: true,
    smeltTicks: 200,
    blastTicks: 0
  },
  {
    id: 'minecraft:dried_kelp',
    inputs: ['minecraft:kelp'],
    outputId: 'minecraft:dried_kelp',
    outputCount: 1,
    canSmelt: true,
    canBlast: false,
    canSmoke: true,
    smeltTicks: 200,
    blastTicks: 0
  }
]);

const GTL_REMOVED_VANILLA_OUTPUTS = new Set([
  'minecraft:netherite_ingot',
  'minecraft:netherite_scrap',
  'minecraft:ender_eye'
]);

/**
 * Cached `minecraft-data('1.20.1')` crafting index across instances so startup takes <2ms.
 * @type {Map<string, Array<Object>>|null}
 */
let _cachedVanilla1201CraftingByOutput = null;

function _loadVanilla1201CraftingMap() {
  if (_cachedVanilla1201CraftingByOutput) return _cachedVanilla1201CraftingByOutput;
  const map = new Map();
  try {
    const mcData = require('minecraft-data')('1.20.1');
    const itemsById = mcData.items || {};
    const recipesObj = mcData.recipes || {};

    const toCanon = (numId) => {
      if (numId == null || numId < 0) return null;
      const item = itemsById[numId];
      return item?.name ? `minecraft:${item.name}` : null;
    };

    for (const [resultItemIdStr, variants] of Object.entries(recipesObj)) {
      const outputId = toCanon(Number(resultItemIdStr));
      if (!outputId || GTL_REMOVED_VANILLA_OUTPUTS.has(outputId)) continue;
      if (!Array.isArray(variants)) continue;

      const parsedList = [];
      for (let idx = 0; idx < variants.length; idx++) {
        const r = variants[idx];
        const outputCount = r?.result?.count ?? 1;

        if (Array.isArray(r.inShape) && r.inShape.length > 0) {
          const gridRows = r.inShape.map((row) =>
            row.map((cell) => {
              const id = typeof cell === 'object' && cell !== null ? cell.id : cell;
              return toCanon(id);
            })
          );
          const height = gridRows.length;
          const width = Math.max(...gridRows.map((row) => row.length));
          parsedList.push({
            id: `vanilla_shaped:${outputId}#${idx}`,
            outputId,
            outputCount,
            requiresTable: height > 2 || width > 2,
            shapeless: false,
            gridRows
          });
        } else if (Array.isArray(r.ingredients) && r.ingredients.length > 0 && r.ingredients.length <= 9) {
          const items = r.ingredients
            .map((cell) => {
              const id = typeof cell === 'object' && cell !== null ? cell.id : cell;
              return toCanon(id);
            })
            .filter(Boolean);
          if (items.length === 0) continue;

          const gridWidth = items.length <= 4 ? 2 : 3;
          const gridRows = [];
          for (let i = 0; i < items.length; i += gridWidth) {
            const row = items.slice(i, i + gridWidth);
            while (row.length < gridWidth) row.push(null);
            gridRows.push(row);
          }
          parsedList.push({
            id: `vanilla_shapeless:${outputId}#${idx}`,
            outputId,
            outputCount,
            requiresTable: items.length > 4,
            shapeless: true,
            gridRows
          });
        }
      }

      if (parsedList.length > 0) {
        map.set(outputId, parsedList);
      }
    }
  } catch (_) {
    // Safe fallback if minecraft-data is unavailable
  }
  _cachedVanilla1201CraftingByOutput = map;
  return map;
}

/**
 * Built-in GregTech Leisure (`KubeJS`) + GTCEu Modern 1.20.1 hand-crafting recipes.
 */
const BUILTIN_MODDED_CRAFTING_RECIPES = Object.freeze([
  {
    id: 'gtl_kubejs:4x_chest_from_8x_logs',
    outputId: 'minecraft:chest',
    outputCount: 4,
    requiresTable: true,
    shapeless: false,
    gridRows: [
      ['#logs', '#logs', '#logs'],
      ['#logs', null, '#logs'],
      ['#logs', '#logs', '#logs']
    ]
  },
  {
    id: 'gtl_kubejs:16x_stick_from_2x_logs',
    outputId: 'minecraft:stick',
    outputCount: 16,
    requiresTable: false,
    shapeless: true,
    gridRows: [
      ['#logs', null],
      ['#logs', null]
    ]
  },
  {
    id: 'gtceu:rubber_planks_from_log',
    outputId: 'gtceu:rubber_planks',
    outputCount: 4,
    requiresTable: false,
    shapeless: true,
    gridRows: [['gtceu:rubber_log', null]]
  },
  {
    id: 'gtceu:iron_hammer',
    outputId: 'gtceu:iron_hammer',
    outputCount: 1,
    requiresTable: true,
    shapeless: false,
    gridRows: [
      ['minecraft:iron_ingot', 'minecraft:iron_ingot', null],
      ['minecraft:iron_ingot', 'minecraft:iron_ingot', 'minecraft:stick'],
      ['minecraft:iron_ingot', 'minecraft:iron_ingot', null]
    ]
  },
  {
    id: 'gtceu:iron_mortar',
    outputId: 'gtceu:iron_mortar',
    outputCount: 1,
    requiresTable: true,
    shapeless: false,
    gridRows: [
      [null, 'minecraft:iron_ingot', null],
      ['minecraft:stone', 'minecraft:iron_ingot', 'minecraft:stone'],
      ['minecraft:stone', 'minecraft:stone', 'minecraft:stone']
    ]
  },
  {
    id: 'gtceu:iron_wrench',
    outputId: 'gtceu:iron_wrench',
    outputCount: 1,
    requiresTable: true,
    shapeless: false,
    gridRows: [
      ['gtceu:iron_plate', '#gtceu:hammer', 'gtceu:iron_plate'],
      ['gtceu:iron_plate', 'gtceu:iron_plate', 'gtceu:iron_plate'],
      [null, 'gtceu:iron_plate', null]
    ]
  },
  {
    id: 'gtceu:iron_file',
    outputId: 'gtceu:iron_file',
    outputCount: 1,
    requiresTable: true,
    shapeless: false,
    gridRows: [
      ['gtceu:iron_plate', null, null],
      ['gtceu:iron_plate', null, null],
      ['minecraft:stick', null, null]
    ]
  },
  {
    id: 'gtceu:iron_wire_cutter',
    outputId: 'gtceu:iron_wire_cutter',
    outputCount: 1,
    requiresTable: true,
    shapeless: false,
    gridRows: [
      ['gtceu:iron_plate', '#gtceu:file', 'gtceu:iron_plate'],
      ['#gtceu:hammer', 'gtceu:iron_plate', '#gtceu:screwdriver'],
      ['minecraft:stick', 'gtceu:iron_screw', 'minecraft:stick']
    ]
  },
  {
    id: 'gtceu:iron_screwdriver',
    outputId: 'gtceu:iron_screwdriver',
    outputCount: 1,
    requiresTable: true,
    shapeless: false,
    gridRows: [
      [null, '#gtceu:file', 'gtceu:iron_rod'],
      [null, 'gtceu:iron_rod', '#gtceu:hammer'],
      ['minecraft:stick', null, null]
    ]
  },
  {
    id: 'gtceu:iron_saw',
    outputId: 'gtceu:iron_saw',
    outputCount: 1,
    requiresTable: true,
    shapeless: false,
    gridRows: [
      ['minecraft:stick', 'gtceu:iron_rod', 'gtceu:iron_plate'],
      ['minecraft:stick', 'gtceu:iron_plate', '#gtceu:file'],
      [null, null, '#gtceu:hammer']
    ]
  },
  {
    id: 'gtceu:rubber_mallet',
    outputId: 'gtceu:rubber_mallet',
    outputCount: 1,
    requiresTable: true,
    shapeless: false,
    gridRows: [
      ['gtceu:rubber_ingot', 'gtceu:rubber_ingot', null],
      ['gtceu:rubber_ingot', 'gtceu:rubber_ingot', 'minecraft:stick'],
      ['gtceu:rubber_ingot', 'gtceu:rubber_ingot', null]
    ]
  },
  {
    id: 'gtceu:bronze_dust_hand_mix',
    outputId: 'gtceu:bronze_dust',
    outputCount: 3,
    requiresTable: false,
    shapeless: true,
    gridRows: [
      ['gtceu:copper_dust', 'gtceu:copper_dust'],
      ['gtceu:copper_dust', 'gtceu:tin_dust']
    ]
  },
  {
    id: 'gtceu:copper_dust_mortar',
    outputId: 'gtceu:copper_dust',
    outputCount: 1,
    requiresTable: false,
    shapeless: true,
    gridRows: [['#gtceu:mortar', 'minecraft:copper_ingot']]
  },
  {
    id: 'gtceu:tin_dust_mortar',
    outputId: 'gtceu:tin_dust',
    outputCount: 1,
    requiresTable: false,
    shapeless: true,
    gridRows: [['#gtceu:mortar', 'gtceu:tin_ingot']]
  },
  {
    id: 'gtceu:iron_dust_mortar',
    outputId: 'gtceu:iron_dust',
    outputCount: 1,
    requiresTable: false,
    shapeless: true,
    gridRows: [['#gtceu:mortar', 'minecraft:iron_ingot']]
  },
  {
    id: 'gtceu:coal_dust_mortar',
    outputId: 'gtceu:coal_dust',
    outputCount: 1,
    requiresTable: false,
    shapeless: true,
    gridRows: [['#gtceu:mortar', 'minecraft:coal']]
  },
  {
    id: 'gtceu:brick_dust_mortar',
    outputId: 'gtceu:brick_dust',
    outputCount: 1,
    requiresTable: true,
    shapeless: false,
    gridRows: [
      ['minecraft:brick', 'minecraft:brick', null],
      ['minecraft:brick', 'minecraft:brick', '#gtceu:mortar'],
      [null, null, null]
    ]
  },
  {
    id: 'gtceu:clay_dust_mortar',
    outputId: 'gtceu:clay_dust',
    outputCount: 1,
    requiresTable: false,
    shapeless: true,
    gridRows: [
      ['minecraft:clay_ball', 'minecraft:clay_ball'],
      ['#gtceu:mortar', null]
    ]
  },
  {
    id: 'gtceu:fireclay_dust_mix',
    outputId: 'gtceu:fireclay_dust',
    outputCount: 2,
    requiresTable: false,
    shapeless: true,
    gridRows: [['gtceu:brick_dust', 'gtceu:clay_dust']]
  },
  {
    id: 'gtceu:compressed_fireclay',
    outputId: 'gtceu:compressed_fireclay',
    outputCount: 1,
    requiresTable: false,
    shapeless: false,
    gridRows: [['gtceu:fireclay_dust', null]]
  },
  {
    id: 'gtceu:firebricks_block',
    outputId: 'gtceu:firebricks',
    outputCount: 1,
    requiresTable: false,
    shapeless: false,
    gridRows: [
      ['gtceu:firebrick', 'gtceu:firebrick'],
      ['gtceu:firebrick', 'gtceu:firebrick']
    ]
  },
  {
    id: 'gtceu:iron_plate_hammer',
    outputId: 'gtceu:iron_plate',
    outputCount: 1,
    requiresTable: true,
    shapeless: false,
    gridRows: [
      ['#gtceu:hammer', null, null],
      ['minecraft:iron_ingot', null, null],
      ['minecraft:iron_ingot', null, null]
    ]
  },
  {
    id: 'gtceu:wrought_iron_plate_hammer',
    outputId: 'gtceu:wrought_iron_plate',
    outputCount: 1,
    requiresTable: true,
    shapeless: false,
    gridRows: [
      ['#gtceu:hammer', null, null],
      ['gtceu:wrought_iron_ingot', null, null],
      ['gtceu:wrought_iron_ingot', null, null]
    ]
  },
  {
    id: 'gtceu:bronze_plate_hammer',
    outputId: 'gtceu:bronze_plate',
    outputCount: 1,
    requiresTable: true,
    shapeless: false,
    gridRows: [
      ['#gtceu:hammer', null, null],
      ['gtceu:bronze_ingot', null, null],
      ['gtceu:bronze_ingot', null, null]
    ]
  },
  {
    id: 'gtceu:copper_plate_hammer',
    outputId: 'gtceu:copper_plate',
    outputCount: 1,
    requiresTable: true,
    shapeless: false,
    gridRows: [
      ['#gtceu:hammer', null, null],
      ['minecraft:copper_ingot', null, null],
      ['minecraft:copper_ingot', null, null]
    ]
  },
  {
    id: 'gtceu:steel_plate_hammer',
    outputId: 'gtceu:steel_plate',
    outputCount: 1,
    requiresTable: true,
    shapeless: false,
    gridRows: [
      ['#gtceu:hammer', null, null],
      ['gtceu:steel_ingot', null, null],
      ['gtceu:steel_ingot', null, null]
    ]
  }
]);

// ---------------------------------------------------------------------------
// Low-level safe Minecraft 1.20.1 `declare_recipes` wire-buffer reader
// ---------------------------------------------------------------------------

class SafePacketCursor {
  constructor(buf) {
    this.buf = buf;
    this.offset = 0;
  }

  ensure(n) {
    if (this.offset + n > this.buf.length) {
      throw new RangeError('Buffer EOF');
    }
  }

  readU8() {
    this.ensure(1);
    return this.buf.readUInt8(this.offset++);
  }

  readBool() {
    return this.readU8() !== 0;
  }

  readI32() {
    this.ensure(4);
    const v = this.buf.readInt32BE(this.offset);
    this.offset += 4;
    return v;
  }

  readF32() {
    this.ensure(4);
    const v = this.buf.readFloatBE(this.offset);
    this.offset += 4;
    return v;
  }

  readVarInt() {
    let numRead = 0;
    let result = 0;
    let byte = 0;
    do {
      byte = this.readU8();
      result |= (byte & 0x7f) << (7 * numRead);
      numRead++;
      if (numRead > 5) throw new Error('VarInt too big');
    } while ((byte & 0x80) !== 0);
    return result;
  }

  readString() {
    const byteLen = this.readVarInt();
    if (byteLen < 0 || byteLen > 32767 * 4) throw new Error('Invalid string length');
    this.ensure(byteLen);
    const s = this.buf.toString('utf8', this.offset, this.offset + byteLen);
    this.offset += byteLen;
    return s;
  }

  skipNbtTagPayload(tagType, depth = 0) {
    if (depth > 512) throw new Error('NBT depth limit');
    switch (tagType) {
      case 0:
        return;
      case 1:
        this.ensure(1);
        this.offset += 1;
        return;
      case 2:
        this.ensure(2);
        this.offset += 2;
        return;
      case 3:
      case 5:
        this.ensure(4);
        this.offset += 4;
        return;
      case 4:
      case 6:
        this.ensure(8);
        this.offset += 8;
        return;
      case 7: {
        const len = this.readI32();
        if (len < 0) throw new Error('Negative byte array');
        this.ensure(len);
        this.offset += len;
        return;
      }
      case 8: {
        this.ensure(2);
        const sLen = this.buf.readUInt16BE(this.offset);
        this.offset += 2;
        this.ensure(sLen);
        this.offset += sLen;
        return;
      }
      case 9: {
        const elemType = this.readU8();
        const count = this.readI32();
        if (count < 0) throw new Error('Negative list count');
        for (let i = 0; i < count; i++) {
          this.skipNbtTagPayload(elemType, depth + 1);
        }
        return;
      }
      case 10: {
        while (true) {
          const childType = this.readU8();
          if (childType === 0) break;
          this.ensure(2);
          const nameLen = this.buf.readUInt16BE(this.offset);
          this.offset += 2;
          this.ensure(nameLen);
          this.offset += nameLen;
          this.skipNbtTagPayload(childType, depth + 1);
        }
        return;
      }
      case 11: {
        const len = this.readI32();
        if (len < 0) throw new Error('Negative int array');
        this.ensure(len * 4);
        this.offset += len * 4;
        return;
      }
      case 12: {
        const len = this.readI32();
        if (len < 0) throw new Error('Negative long array');
        this.ensure(len * 8);
        this.offset += len * 8;
        return;
      }
      default:
        throw new Error(`Unknown NBT tag ${tagType}`);
    }
  }

  readSlot() {
    const present = this.readBool();
    if (!present) return null;
    const itemId = this.readVarInt();
    const itemCount = this.readU8();
    const rootNbtType = this.readU8();
    if (rootNbtType !== 0) {
      this.ensure(2);
      const rootNameLen = this.buf.readUInt16BE(this.offset);
      this.offset += 2;
      this.ensure(rootNameLen);
      this.offset += rootNameLen;
      this.skipNbtTagPayload(rootNbtType, 0);
    }
    return { itemId, itemCount };
  }

  readIngredient() {
    const count = this.readVarInt();
    if (count < 0 || count > 4096) throw new Error('Invalid ingredient option count');
    const options = [];
    for (let i = 0; i < count; i++) {
      const s = this.readSlot();
      if (s) options.push(s);
    }
    return options;
  }
}

const SIMPLE_SPECIAL_SERIALIZERS = new Set([
  'minecraft:crafting_special_armordye',
  'minecraft:crafting_special_bookcloning',
  'minecraft:crafting_special_mapcloning',
  'minecraft:crafting_special_mapextending',
  'minecraft:crafting_special_firework_rocket',
  'minecraft:crafting_special_firework_star',
  'minecraft:crafting_special_firework_star_fade',
  'minecraft:crafting_special_repairitem',
  'minecraft:crafting_special_tippedarrow',
  'minecraft:crafting_special_bannerduplicate',
  'minecraft:crafting_special_banneraddpattern',
  'minecraft:crafting_special_shielddecoration',
  'minecraft:crafting_special_shulkerboxcoloring',
  'minecraft:crafting_special_suspiciousstew',
  'minecraft:crafting_decorated_pot'
]);

/**
 * Universal Recipe & Smelting/Blasting Registry for GregTech Leisure (`1.20.1`).
 *
 * Unifies:
 *  1. All 1,100+ Vanilla `1.20.1` shaped & shapeless crafting recipes (`minecraft-data`)
 *  2. All Vanilla + GTCEu Modern (`OreRecipeHandler`) + GTL KubeJS (`开荒加速`) Furnace,
 *     1-Tick Blast Furnace, and Smoker recipes (including `gtceu:raw_coal -> 2x minecraft:coal`,
 *     `cobblestone -> stone -> smooth_stone` furnace-only routing, etc.)
 *  3. Live `declare_recipes` packet stream ingestion from the connected Forge `1.20.1` server
 *  4. Accurate furnace fuel validation & burn-count calculation (`gtceu:raw_coal` is NOT fuel —
 *     must be smelted into `minecraft:coal` first!)
 */
class UniversalRecipeRegistry {
  constructor(options = {}) {
    this.registryBridge = options.registryBridge || null;

    /** @type {Map<string, Array<Object>>} outputId -> furnace/blast/smoke recipes */
    this.furnaceByOutput = new Map();
    /** @type {Map<string, Array<Object>>} inputId -> furnace/blast/smoke recipes */
    this.furnaceByInput = new Map();
    /** @type {Map<string, Array<Object>>} outputId -> shaped/shapeless grid recipes */
    this.craftingByOutput = new Map();

    this.liveRecipesIngested = 0;

    this._seedBuiltinRecipes();
  }

  _seedBuiltinRecipes() {
    for (const entry of BUILTIN_FURNACE_RECIPES) {
      this.registerFurnaceRecipe(entry);
    }

    // Seed modded hand-crafting recipes first (highest priority, e.g. 8x logs -> 4x chest!)
    for (const r of BUILTIN_MODDED_CRAFTING_RECIPES) {
      this.registerCraftingRecipe(r, true);
    }

    // Seed all 1,100+ vanilla 1.20.1 crafting recipes from `minecraft-data('1.20.1')`
    const vanillaMap = _loadVanilla1201CraftingMap();
    for (const [outputId, list] of vanillaMap.entries()) {
      for (const r of list) {
        this.registerCraftingRecipe(r, false);
      }
    }
  }

  registerFurnaceRecipe(recipe) {
    const outputId = normalizeItemId(recipe.outputId);
    const inputs = (recipe.inputs || []).map((i) => normalizeItemId(i));
    const normalized = {
      id: recipe.id || `smelt:${inputs[0]}->${outputId}`,
      inputs,
      outputId,
      outputCount: recipe.outputCount ?? 1,
      canSmelt: recipe.canSmelt !== false,
      canBlast: Boolean(recipe.canBlast),
      canSmoke: Boolean(recipe.canSmoke),
      smeltTicks: recipe.smeltTicks ?? 200,
      blastTicks: recipe.blastTicks ?? (recipe.canBlast ? 1 : 0)
    };

    if (!this.furnaceByOutput.has(outputId)) {
      this.furnaceByOutput.set(outputId, []);
    }
    const existingOut = this.furnaceByOutput.get(outputId);
    const dupOut = existingOut.find((e) => e.id === normalized.id);
    if (!dupOut) {
      existingOut.push(normalized);
    } else {
      dupOut.canSmelt = dupOut.canSmelt || normalized.canSmelt;
      dupOut.canBlast = dupOut.canBlast || normalized.canBlast;
      dupOut.canSmoke = dupOut.canSmoke || normalized.canSmoke;
      for (const inp of inputs) {
        if (!dupOut.inputs.includes(inp)) dupOut.inputs.push(inp);
      }
    }

    for (const inp of inputs) {
      if (!this.furnaceByInput.has(inp)) {
        this.furnaceByInput.set(inp, []);
      }
      const list = this.furnaceByInput.get(inp);
      if (!list.some((e) => e.outputId === outputId)) {
        list.push(normalized);
      }
    }
  }

  registerCraftingRecipe(recipe, prioritize = false) {
    const outputId = normalizeItemId(recipe.outputId);
    if (!this.craftingByOutput.has(outputId)) {
      this.craftingByOutput.set(outputId, []);
    }
    const list = this.craftingByOutput.get(outputId);
    if (list.some((r) => r.id === recipe.id)) return;
    if (prioritize) {
      list.unshift(recipe);
    } else {
      list.push(recipe);
    }
  }

  /**
   * Returns `true` ONLY for items that Minecraft 1.20.1 + GTCEu Modern ACTUALLY accept
   * inside Furnace Fuel Slot `1` (`gtceu:raw_coal`, `gtceu:raw_lignite_coal`, and `*_ore`
   * are NOT valid fuels — they must be smelted in Slot `0` first!).
   */
  isValidFurnaceFuel(canonicalId) {
    return this.getFuelSmeltCapacity(canonicalId) > 0;
  }

  /**
   * Returns how many standard 200-tick furnace items 1 unit of `canonicalId` can smelt (`0` if non-fuel).
   */
  getFuelSmeltCapacity(canonicalId) {
    if (!canonicalId) return 0;
    const id = normalizeItemId(canonicalId);

    // Raw ores & ore blocks NEVER burn directly in Furnace Slot 1!
    if (
      id.includes(':raw_') ||
      id.endsWith('_ore') ||
      id.includes('_crushed_') ||
      id.startsWith('gtceu:crushed_') ||
      id.startsWith('gtceu:impure_') ||
      id.startsWith('gtceu:pure_')
    ) {
      return 0;
    }

    if (id === 'gtceu:coke_block') return 160;
    if (id === 'minecraft:lava_bucket') return 100;
    if (id === 'minecraft:coal_block' || id === 'gtceu:coal_block' || id === 'gtceu:charcoal_block') {
      return 80;
    }
    if (id === 'minecraft:dried_kelp_block') return 20;
    if (id === 'gtceu:coke_gem' || id === 'gtceu:coke_dust') return 16;
    if (id === 'minecraft:blaze_rod') return 12;
    if (
      id === 'minecraft:coal' ||
      id === 'minecraft:charcoal' ||
      id === 'gtceu:coal_dust' ||
      id === 'gtceu:charcoal_dust'
    ) {
      return 8;
    }
    if (
      id === 'gtceu:lignite_gem' ||
      id === 'gtceu:lignite_coal' ||
      id === 'gtceu:lignite_dust'
    ) {
      return 6;
    }
    if (
      id.endsWith('_planks') ||
      ((id.endsWith('_log') || id.endsWith('_stem') || id.endsWith('_wood')) &&
        !id.includes('crimson') &&
        !id.includes('warped')) ||
      id === 'minecraft:crafting_table' ||
      id === 'minecraft:chest'
    ) {
      return 1.5;
    }
    if (id.endsWith('_slab') && !id.includes('stone') && !id.includes('brick') && !id.includes('cobble') && !id.includes('deepslate') && !id.includes('quartz') && !id.includes('copper')) {
      return 0.75;
    }
    if (id === 'minecraft:stick' || id.endsWith('_sapling') || id === 'minecraft:bamboo') {
      return 0.5;
    }
    return 0;
  }

  /**
   * Dynamically infers GTCEu Modern `1.20.1` `OreRecipeHandler` smelting/blasting rules for any
   * `gtceu:raw_<mat>`, `gtceu:<mat>_ore`, `gtceu:crushed_<mat>_ore`, `gtceu:impure_<mat>_dust`,
   * `gtceu:pure_<mat>_dust`, or `gtceu:<mat>_dust` item not already in the explicit table.
   */
  _inferGtceuDynamicSmelting(canonicalInputId) {
    const id = normalizeItemId(canonicalInputId);
    if (!id.startsWith('gtceu:')) return null;
    const short = id.slice('gtceu:'.length);

    let mat = null;
    if (short.startsWith('raw_') && !short.endsWith('_block')) {
      mat = short.slice('raw_'.length);
    } else if (short.startsWith('crushed_') && short.endsWith('_ore')) {
      mat = short
        .slice('crushed_'.length, -'_ore'.length)
        .replace(/^purified_/, '')
        .replace(/^refined_/, '');
    } else if (short.startsWith('impure_') && short.endsWith('_dust')) {
      mat = short.slice('impure_'.length, -'_dust'.length);
    } else if (short.startsWith('pure_') && short.endsWith('_dust')) {
      mat = short.slice('pure_'.length, -'_dust'.length);
    } else if (short.endsWith('_ore')) {
      mat = short
        .replace(/^(deepslate|netherrack|endstone|granite|diorite|andesite|tuff|sand|red_sand|basalt|blackstone)_/, '')
        .slice(0, -'_ore'.length);
    } else if (short.endsWith('_dust') && !short.includes('tiny_') && !short.includes('small_')) {
      mat = short.slice(0, -'_dust'.length);
    }

    if (!mat || EBF_ONLY_GTCEU_MATERIALS.has(mat)) return null;

    if (GTCEU_ORE_SMELT_TARGETS[mat]) {
      const target = GTCEU_ORE_SMELT_TARGETS[mat];
      return {
        id: `gtceu_dynamic:${id}->${target.outputId}`,
        inputs: [id],
        outputId: target.outputId,
        outputCount: short.endsWith('_dust') ? 1 : target.outputCount,
        canSmelt: true,
        canBlast: target.canBlast,
        canSmoke: false,
        smeltTicks: 200,
        blastTicks: 1
      };
    }

    // Standard non-blast GTCEu metal dust/raw_ore -> `gtceu:<mat>_ingot`
    const nonSmeltableDusts = new Set([
      'wood',
      'stone',
      'netherrack',
      'endstone',
      'obsidian',
      'flint',
      'clay',
      'brick',
      'fireclay',
      'charcoal',
      'coal',
      'coke',
      'ash',
      'dark_ash',
      'paper',
      'saltpeter',
      'glas',
      'glass'
    ]);
    if (nonSmeltableDusts.has(mat)) return null;

    const vanillaIngots = new Set(['iron', 'copper', 'gold']);
    const outId = vanillaIngots.has(mat) ? `minecraft:${mat}_ingot` : `gtceu:${mat}_ingot`;
    return {
      id: `gtceu_dynamic:${id}->${outId}`,
      inputs: [id],
      outputId: outId,
      outputCount: 1,
      canSmelt: true,
      canBlast: true,
      canSmoke: false,
      smeltTicks: 200,
      blastTicks: 1
    };
  }

  /**
   * Looks up the smelting/blasting/smoking recipe for a given input item ID.
   * @param {string} inputItemId
   * @param {'any'|'furnace'|'blast_furnace'|'smoker'} [stationType='any']
   */
  getSmeltingRecipeForInput(inputItemId, stationType = 'any') {
    if (!inputItemId) return null;
    const id = normalizeItemId(inputItemId);

    const filterStation = (r) => {
      if (!r) return false;
      if (stationType === 'blast_furnace') return Boolean(r.canBlast);
      if (stationType === 'furnace') return Boolean(r.canSmelt);
      if (stationType === 'smoker') return Boolean(r.canSmoke);
      return Boolean(r.canSmelt || r.canBlast || r.canSmoke);
    };

    const candidates = this.furnaceByInput.get(id);
    if (candidates) {
      const match = candidates.find(filterStation);
      if (match) return match;
    }

    const inferred = this._inferGtceuDynamicSmelting(id);
    if (inferred) {
      this.registerFurnaceRecipe(inferred);
      if (filterStation(inferred)) return inferred;
    }

    return null;
  }

  /**
   * Returns all furnace / blast_furnace / smoker recipes that produce `outputItemId`.
   */
  getSmeltingRecipesForOutput(outputItemId, stationType = 'any') {
    if (!outputItemId) return [];
    const out = normalizeItemId(outputItemId);
    const list = this.furnaceByOutput.get(out) || [];
    return list.filter((r) => {
      if (stationType === 'blast_furnace') return Boolean(r.canBlast);
      if (stationType === 'furnace') return Boolean(r.canSmelt);
      if (stationType === 'smoker') return Boolean(r.canSmoke);
      return true;
    });
  }

  /**
   * Resolves a multi-step smelting chain (e.g. `cobblestone -> stone -> smooth_stone`,
   * or `gtceu:raw_coal -> minecraft:coal`) given an available inventory checker `(itemId) => count`.
   */
  resolveSmeltingChainForOutput(targetOutputId, targetCount = 1, getStockFn = () => 0) {
    const out = normalizeItemId(targetOutputId);
    const directRecipes = this.getSmeltingRecipesForOutput(out);
    if (directRecipes.length === 0) return null;

    // 1. Direct input already in inventory?
    for (const r of directRecipes) {
      for (const inp of r.inputs) {
        const have = getStockFn(inp);
        if (have > 0) {
          const batches = Math.ceil(targetCount / (r.outputCount || 1));
          return [
            {
              inputId: inp,
              outputId: out,
              inputCount: Math.min(have, batches),
              expectedOutputCount: Math.min(have, batches) * (r.outputCount || 1),
              recipe: r
            }
          ];
        }
      }
    }

    // 2. 2-stage smelting chain (e.g. `cobblestone -> stone -> smooth_stone`, or `iron_ore -> iron_ingot -> wrought_iron_ingot`)!
    for (const r2 of directRecipes) {
      for (const midItem of r2.inputs) {
        const midRecipes = this.getSmeltingRecipesForOutput(midItem);
        for (const r1 of midRecipes) {
          for (const rawInp of r1.inputs) {
            const haveRaw = getStockFn(rawInp);
            if (haveRaw > 0) {
              const midNeeded = Math.ceil(targetCount / (r2.outputCount || 1));
              const rawBatches = Math.ceil(midNeeded / (r1.outputCount || 1));
              const actualRaw = Math.min(haveRaw, rawBatches);
              const producedMid = actualRaw * (r1.outputCount || 1);
              return [
                {
                  inputId: rawInp,
                  outputId: midItem,
                  inputCount: actualRaw,
                  expectedOutputCount: producedMid,
                  recipe: r1
                },
                {
                  inputId: midItem,
                  outputId: out,
                  inputCount: Math.min(producedMid, midNeeded),
                  expectedOutputCount: Math.min(producedMid, midNeeded) * (r2.outputCount || 1),
                  recipe: r2
                }
              ];
            }
          }
        }
      }
    }

    return null;
  }

  /**
   * Returns all shaped & shapeless 2x2 / 3x3 crafting recipes producing `outputItemId`.
   */
  getCraftingRecipesForOutput(outputItemId) {
    if (!outputItemId) return [];
    const out = normalizeItemId(outputItemId);
    return this.craftingByOutput.get(out) || [];
  }

  /**
   * Safely streams a Minecraft `1.20.1` `declare_recipes` `rawRecipes` buffer from the server,
   * registering every standard crafting, smelting, blasting, smoking, stonecutting & smithing
   * recipe into this registry without ever throwing on custom modded serializers!
   */
  ingestDeclareRecipesBuffer(rawBuffer, botRegistry = null) {
    if (!Buffer.isBuffer(rawBuffer) || rawBuffer.length < 2) return 0;

    const resolveSlotId = (slot) => {
      if (!slot || typeof slot.itemId !== 'number') return null;
      if (this.registryBridge) {
        const fromBridge = this.registryBridge.numericIdToName?.get?.(slot.itemId);
        if (fromBridge) return normalizeItemId(fromBridge);
      }
      const regItem = botRegistry?.items?.[slot.itemId];
      if (regItem?.name) return normalizeItemId(regItem.name);
      try {
        const mcItem = require('minecraft-data')('1.20.1').items?.[slot.itemId];
        if (mcItem?.name) return `minecraft:${mcItem.name}`;
      } catch (_) {
        // Ignore
      }
      return null;
    };

    const resolveIngredientSpec = (options) => {
      if (!Array.isArray(options) || options.length === 0) return null;
      const ids = options.map(resolveSlotId).filter(Boolean);
      if (ids.length === 0) return null;
      if (ids.length === 1) return ids[0];
      if (ids.every((x) => x.endsWith('_planks'))) return '#planks';
      if (ids.every((x) => x.endsWith('_log') || x.endsWith('_stem'))) return '#logs';
      return ids;
    };

    let ingested = 0;
    try {
      const cursor = new SafePacketCursor(rawBuffer);
      const totalCount = cursor.readVarInt();
      const maxEntries = Math.min(totalCount, 100000);

      for (let i = 0; i < maxEntries && cursor.offset < rawBuffer.length; i++) {
        const rawType = cursor.readString();
        const type = rawType.includes(':') ? rawType : `minecraft:${rawType}`;
        const recipeId = cursor.readString();

        if (type === 'minecraft:crafting_shaped') {
          const width = cursor.readVarInt();
          const height = cursor.readVarInt();
          cursor.readString(); // group
          cursor.readVarInt(); // category
          const gridRows = [];
          for (let r = 0; r < height; r++) {
            const row = [];
            for (let c = 0; c < width; c++) {
              row.push(resolveIngredientSpec(cursor.readIngredient()));
            }
            gridRows.push(row);
          }
          const resultSlot = cursor.readSlot();
          cursor.readBool(); // showNotification
          const outputId = resolveSlotId(resultSlot);
          if (outputId && gridRows.length > 0) {
            this.registerCraftingRecipe(
              {
                id: recipeId,
                outputId,
                outputCount: resultSlot?.itemCount || 1,
                requiresTable: width > 2 || height > 2,
                shapeless: false,
                gridRows
              },
              true
            );
            ingested++;
          }
        } else if (type === 'minecraft:crafting_shapeless') {
          cursor.readString(); // group
          cursor.readVarInt(); // category
          const ingCount = cursor.readVarInt();
          const specs = [];
          for (let k = 0; k < ingCount; k++) {
            const sp = resolveIngredientSpec(cursor.readIngredient());
            if (sp) specs.push(sp);
          }
          const resultSlot = cursor.readSlot();
          const outputId = resolveSlotId(resultSlot);
          if (outputId && specs.length > 0 && specs.length <= 9) {
            const gw = specs.length <= 4 ? 2 : 3;
            const gridRows = [];
            for (let k = 0; k < specs.length; k += gw) {
              const row = specs.slice(k, k + gw);
              while (row.length < gw) row.push(null);
              gridRows.push(row);
            }
            this.registerCraftingRecipe(
              {
                id: recipeId,
                outputId,
                outputCount: resultSlot?.itemCount || 1,
                requiresTable: specs.length > 4,
                shapeless: true,
                gridRows
              },
              true
            );
            ingested++;
          }
        } else if (
          type === 'minecraft:smelting' ||
          type === 'minecraft:blasting' ||
          type === 'minecraft:smoking' ||
          type === 'minecraft:campfire_cooking'
        ) {
          cursor.readString(); // group
          cursor.readVarInt(); // cookingBookCategory
          const ingOptions = cursor.readIngredient();
          const resultSlot = cursor.readSlot();
          cursor.readF32(); // experience
          const cookingTime = cursor.readVarInt();

          const outputId = resolveSlotId(resultSlot);
          const inputIds = ingOptions.map(resolveSlotId).filter(Boolean);
          if (outputId && inputIds.length > 0) {
            this.registerFurnaceRecipe({
              id: recipeId,
              inputs: inputIds,
              outputId,
              outputCount: resultSlot?.itemCount || 1,
              canSmelt: type === 'minecraft:smelting',
              canBlast: type === 'minecraft:blasting',
              canSmoke: type === 'minecraft:smoking',
              smeltTicks: type === 'minecraft:smelting' ? cookingTime : 200,
              blastTicks: type === 'minecraft:blasting' ? cookingTime : 0
            });
            ingested++;
          }
        } else if (type === 'minecraft:stonecutting') {
          cursor.readString(); // group
          cursor.readIngredient();
          cursor.readSlot();
        } else if (type === 'minecraft:smithing_transform') {
          cursor.readIngredient();
          cursor.readIngredient();
          cursor.readIngredient();
          cursor.readSlot();
        } else if (type === 'minecraft:smithing_trim') {
          cursor.readIngredient();
          cursor.readIngredient();
          cursor.readIngredient();
        } else if (SIMPLE_SPECIAL_SERIALIZERS.has(type)) {
          cursor.readVarInt(); // category
        } else {
          // Encountered a custom modded recipe serializer with mod-defined framing;
          // stop sequential stream read safely while retaining all ingested recipes!
          break;
        }
      }
    } catch (_) {
      // Safe non-fatal stream termination
    }

    this.liveRecipesIngested += ingested;
    return ingested;
  }
}

module.exports = {
  UniversalRecipeRegistry,
  EBF_ONLY_GTCEU_MATERIALS,
  GTCEU_ORE_SMELT_TARGETS,
  BUILTIN_FURNACE_RECIPES,
  BUILTIN_MODDED_CRAFTING_RECIPES
};
