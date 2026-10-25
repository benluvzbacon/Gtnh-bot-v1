'use strict';

const fs = require('fs');
const path = require('path');
const { CraftingEngine } = require('../craftingEngine');
const { normalizeItemId } = require('../protocol/forgeHandshake');

/**
 * Normalizes a BetterQuesting 1.7.10 (`DefaultQuests.json` `questDatabase:9`) dump
 * into the bot's canonical Quest DAG array.
 */
function transformBetterQuestingDump(bqJson) {
  if (!bqJson || typeof bqJson !== 'object') return [];
  if (Array.isArray(bqJson.quests)) return bqJson.quests;

  const db = bqJson['questDatabase:9'] || bqJson.questDatabase || {};
  const quests = [];

  for (const entry of Object.values(db)) {
    if (!entry || typeof entry !== 'object') continue;
    const rawId = entry['questID:3'] ?? entry.questID ?? quests.length + 1;
    const props = entry['properties:10']?.['betterquesting:10'] || entry.properties || {};
    const name = props['name:8'] || props.name || `GTNH Quest #${rawId}`;
    const logic = props['questLogic:8'] || props.questLogic || 'AND';

    const preReqsRaw = entry['preRequisites:11'] || entry.preRequisites || [];
    const dependencies = preReqsRaw.map((id) => `bq_quest_${id}`);

    const tasksObj = entry['tasks:9'] || entry.tasks || {};
    const tasks = [];
    for (const [idxKey, t] of Object.entries(tasksObj)) {
      const taskTypeRaw = String(t['taskID:8'] || t.taskID || 'retrieval').toLowerCase();
      const reqItemsObj = t['requiredItems:9'] || t.requiredItems || {};
      const requiredItems = Object.values(reqItemsObj).map((stk) => {
        const modItem = stk['id:8'] || stk.id || 'minecraft:stone';
        const meta = stk['Damage:2'] ?? stk.Damage ?? 0;
        const count = stk['Count:3'] ?? stk.Count ?? 1;
        return {
          itemId: normalizeItemId(`${modItem}:${meta}`),
          count
        };
      });

      tasks.push({
        taskIndex: Number(String(idxKey).split(':')[0]) || tasks.length,
        type: taskTypeRaw.includes('craft') ? 'crafting' : 'retrieval',
        consume: Boolean(t['consume:1'] ?? t.consume ?? false),
        requiredItems
      });
    }

    quests.push({
      questId: `bq_quest_${rawId}`,
      bqNumericId: Number(rawId),
      name,
      era: 'IMPORTED',
      dependencies,
      dependencyLogic: logic,
      tasks,
      rewards: { guaranteed: [], choices: [] }
    });
  }

  return quests;
}

/**
 * Parses an NEI 1.7.10 item/block ID CSV dump (`Name,ID,Has BlockItem,...`)
 * into a dictionary mapping `modid:name -> numericId`.
 */
function parseNeiIdCsv(csvContent) {
  const lines = String(csvContent || '').split(/\r?\n/);
  const entries = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split(',');
    if (cols.length < 2) continue;
    const name = cols[0].replace(/^"|"$/g, '').trim();
    const id = Number(cols[1]);
    if (name && Number.isFinite(id)) {
      entries.push({ name, id, kind: id < 4096 ? 'block' : 'item' });
    }
  }
  return entries;
}

/**
 * Merges base template, optional BetterQuesting dump, optional JEI recipes JSON,
 * and server seed metadata into an output database JSON file.
 */
function runIngestPipeline(cliArgs) {
  const getArg = (flag, fallback = null) => {
    const idx = cliArgs.indexOf(flag);
    return idx !== -1 && idx + 1 < cliArgs.length ? cliArgs[idx + 1] : fallback;
  };

  const basePath = getArg(
    '--base',
    path.resolve(__dirname, '../../data/quest_tree_template.json')
  );
  const bqPath = getArg('--quests', null);
  const jeiPath = getArg('--jei', null);
  const neiCsvPath = getArg('--nei-csv', null);
  const worldSeed = getArg('--seed', null);
  const outPath = getArg('--out', null);

  const database = JSON.parse(fs.readFileSync(basePath, 'utf8'));

  if (worldSeed) {
    database.metadata = {
      ...(database.metadata || {}),
      worldSeed: String(worldSeed),
      ingestedAt: new Date().toISOString()
    };
  }

  if (bqPath && fs.existsSync(bqPath)) {
    const rawBq = JSON.parse(fs.readFileSync(bqPath, 'utf8'));
    const importedQuests = transformBetterQuestingDump(rawBq);
    database.quests = [...(database.quests || []), ...importedQuests];
  }

  if (jeiPath && fs.existsSync(jeiPath)) {
    const rawJei = JSON.parse(fs.readFileSync(jeiPath, 'utf8'));
    const importedRecipes = Array.isArray(rawJei) ? rawJei : rawJei.recipes || [];
    database.recipes = [...(database.recipes || []), ...importedRecipes];
  }

  let neiEntries = [];
  if (neiCsvPath && fs.existsSync(neiCsvPath)) {
    neiEntries = parseNeiIdCsv(fs.readFileSync(neiCsvPath, 'utf8'));
    database.registryDump = neiEntries;
  }

  // Validate DAG integrity via CraftingEngine
  const engine = new CraftingEngine();
  const summary = engine.ingestDatabase(database);

  if (outPath) {
    fs.writeFileSync(path.resolve(outPath), JSON.stringify(database, null, 2), 'utf8');
  }

  return {
    summary,
    neiEntriesCount: neiEntries.length,
    worldSeed: database.metadata?.worldSeed || null,
    writtenTo: outPath ? path.resolve(outPath) : null
  };
}

if (require.main === module) {
  const report = runIngestPipeline(process.argv.slice(2));
  console.log('[GTNH Ingest Pipeline] Validation & DAG Build Summary:');
  console.log(JSON.stringify(report, null, 2));
}

module.exports = {
  transformBetterQuestingDump,
  parseNeiIdCsv,
  runIngestPipeline
};
