'use strict';

const fs = require('fs');
const path = require('path');
const { CraftingEngine } = require('../craftingEngine');
const { normalizeItemId } = require('../protocol/forgeHandshake');

/**
 * Recursive-descent parser for FTB Quests 1.20.1 `.snbt` files (supports newline- or
 * comma-delimited compounds/lists, `10L`/`2.5d`/`1b` numeric suffixes, `[I; ...]` typed
 * arrays, `#` comments, and compound item tags).
 */
function parseSnbt(sourceText) {
  const src = String(sourceText || '');
  let pos = 0;

  const skipTrivia = () => {
    while (pos < src.length) {
      const ch = src[pos];
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === ',') {
        pos += 1;
      } else if (ch === '#') {
        while (pos < src.length && src[pos] !== '\n') pos += 1;
      } else {
        break;
      }
    }
  };

  const parseQuotedString = (quoteChar) => {
    pos += 1; // skip opening quote
    let out = '';
    while (pos < src.length) {
      const ch = src[pos];
      if (ch === '\\' && pos + 1 < src.length) {
        const next = src[pos + 1];
        if (next === 'n') out += '\n';
        else if (next === 't') out += '\t';
        else if (next === 'r') out += '\r';
        else out += next;
        pos += 2;
        continue;
      }
      if (ch === quoteChar) {
        pos += 1;
        return out;
      }
      out += ch;
      pos += 1;
    }
    return out;
  };

  const parseBareToken = () => {
    const start = pos;
    while (pos < src.length) {
      const ch = src[pos];
      if (
        ch === ' ' ||
        ch === '\t' ||
        ch === '\r' ||
        ch === '\n' ||
        ch === ',' ||
        ch === ':' ||
        ch === '{' ||
        ch === '}' ||
        ch === '[' ||
        ch === ']'
      ) {
        break;
      }
      pos += 1;
    }
    return src.slice(start, pos);
  };

  const coerceScalar = (token) => {
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (/^-?\d+[bBsSlL]$/.test(token)) {
      return Number(token.slice(0, -1));
    }
    if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?[fFdD]?$/.test(token)) {
      const cleaned = token.replace(/[fFdD]$/, '');
      const num = Number(cleaned);
      if (!Number.isNaN(num)) return num;
    }
    return token;
  };

  const parseCompound = () => {
    pos += 1; // '{'
    const obj = {};
    while (pos < src.length) {
      skipTrivia();
      if (pos >= src.length || src[pos] === '}') {
        pos += 1;
        break;
      }
      const key =
        src[pos] === '"' || src[pos] === "'"
          ? parseQuotedString(src[pos])
          : parseBareToken();
      skipTrivia();
      if (src[pos] === ':') {
        pos += 1;
      }
      skipTrivia();
      obj[key] = parseValue();
    }
    return obj;
  };

  const parseList = () => {
    pos += 1; // '['
    skipTrivia();
    // Optional SNBT typed array prefix e.g. [I; 1, 2]
    if (
      pos + 1 < src.length &&
      (src[pos] === 'B' || src[pos] === 'I' || src[pos] === 'L') &&
      src[pos + 1] === ';'
    ) {
      pos += 2;
    }
    const arr = [];
    while (pos < src.length) {
      skipTrivia();
      if (pos >= src.length || src[pos] === ']') {
        pos += 1;
        break;
      }
      arr.push(parseValue());
    }
    return arr;
  };

  const parseValue = () => {
    skipTrivia();
    const ch = src[pos];
    if (ch === '{') return parseCompound();
    if (ch === '[') return parseList();
    if (ch === '"' || ch === "'") return parseQuotedString(ch);
    return coerceScalar(parseBareToken());
  };

  return parseValue();
}

const GTL_CHAPTER_ERA_MAP = Object.freeze({
  '77F8039ACE718C6C': 'STEAM_ULV',
  '393DD40CAFBB69A5': 'LV_TIER',
  '6AE49AAF3BDC94C1': 'MV_TIER',
  '3FFA6F604319D492': 'HV_TIER',
  '68D3F02D34DEAF83': 'EV_TIER'
});

function extractFtbItemStack(rawItemField, explicitCount) {
  if (!rawItemField) return null;
  if (typeof rawItemField === 'string') {
    return {
      itemId: normalizeItemId(rawItemField),
      count: Number(explicitCount) || 1
    };
  }
  if (typeof rawItemField === 'object' && rawItemField.id) {
    const out = {
      itemId: normalizeItemId(rawItemField.id),
      count: Number(explicitCount ?? rawItemField.Count ?? 1) || 1
    };
    if (rawItemField.tag && typeof rawItemField.tag === 'object') {
      out.nbtTag = rawItemField.tag;
    }
    return out;
  }
  return null;
}

/**
 * Converts a parsed FTB Quests `.snbt` chapter object (from GregTech Leisure
 * `config/ftbquests/quests/chapters/*.snbt`) into canonical Quest DAG nodes.
 */
function transformFtbQuestsChapter(chapterObj, fallbackEra = null) {
  if (!chapterObj || typeof chapterObj !== 'object') return [];
  const chapterId = String(chapterObj.id || chapterObj.filename || '');
  const inferredEra =
    fallbackEra ||
    GTL_CHAPTER_ERA_MAP[chapterId] ||
    inferEraFromTitle(chapterObj.title) ||
    'STEAM_ULV';

  const quests = [];
  for (const q of chapterObj.quests || []) {
    if (!q || !q.id) continue;
    const questId = String(q.id);
    const dependencies = Array.isArray(q.dependencies) ? q.dependencies.map(String) : [];
    const dependencyLogic = q.min_required_dependencies === 1 && dependencies.length > 1 ? 'OR' : 'AND';

    const requiredItems = [];
    let consumeItems = false;
    for (const t of q.tasks || []) {
      if (!t || typeof t !== 'object') continue;
      if (t.consume_items) consumeItems = true;
      const stk = extractFtbItemStack(t.item, t.count);
      if (stk) {
        requiredItems.push(stk);
      }
    }

    const tasks = [];
    if (requiredItems.length > 0) {
      tasks.push({
        taskIndex: 0,
        type: 'retrieval',
        consume: consumeItems,
        requiredItems
      });
    }

    const guaranteedRewards = [];
    for (const r of q.rewards || []) {
      const stk = extractFtbItemStack(r?.item, r?.count);
      if (stk) {
        guaranteedRewards.push(stk);
      }
    }

    quests.push({
      questId,
      ftbHexId: questId,
      name: String(q.title || `GTL Quest ${questId}`),
      era: inferredEra,
      dependencies,
      dependencyLogic,
      tasks,
      rewards: {
        guaranteed: guaranteedRewards,
        choices: []
      }
    });
  }

  return quests;
}

function inferEraFromTitle(title) {
  const upper = String(title || '').toUpperCase();
  if (upper.includes('STEAM') || upper.includes('ULV')) return 'STEAM_ULV';
  if (/\bLV\b/.test(upper)) return 'LV_TIER';
  if (/\bMV\b/.test(upper)) return 'MV_TIER';
  if (/\bHV\b/.test(upper)) return 'HV_TIER';
  if (/\bEV\b/.test(upper)) return 'EV_TIER';
  return null;
}

/**
 * Legacy BetterQuesting JSON transformer retained for backwards compatibility.
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
    const name = props['name:8'] || props.name || `Quest #${rawId}`;
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
        const count = stk['Count:3'] ?? stk.Count ?? 1;
        return {
          itemId: normalizeItemId(modItem),
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
 * Parses a Forge / JEI / KubeJS registry CSV (`Name,ID,...`) into `modid:name -> numericId`.
 */
function parseNeiIdCsv(csvContent) {
  const lines = String(csvContent || '').split(/\r?\n/);
  const entries = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split(',');
    if (cols.length < 2) continue;
    const name = normalizeItemId(cols[0].replace(/^"|"$/g, '').trim());
    const id = Number(cols[1]);
    if (name && Number.isFinite(id)) {
      entries.push({ name, id, kind: 'item' });
    }
  }
  return entries;
}

function mergeQuestsDeduplicated(existingQuests, importedQuests) {
  const byId = new Map();
  for (const q of existingQuests || []) {
    byId.set(q.questId, q);
  }
  for (const q of importedQuests || []) {
    if (!byId.has(q.questId)) {
      byId.set(q.questId, q);
    }
  }
  return Array.from(byId.values());
}

/**
 * Merges base GTL template, optional FTB Quests `.snbt` chapter file or directory
 * (`--ftbquests` / `--ftbquests-dir`), optional JEI/KubeJS recipe JSON (`--jei`),
 * and world seed metadata into a validated DAG JSON database.
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
  const ftbFile = getArg('--ftbquests', null);
  const ftbDir = getArg('--ftbquests-dir', null);
  const bqPath = getArg('--quests', null);
  const jeiPath = getArg('--jei', null);
  const neiCsvPath = getArg('--nei-csv', null);
  const worldSeed = getArg('--seed', null);
  const outPath = getArg('--out', null);

  const database = JSON.parse(fs.readFileSync(basePath, 'utf8'));
  let snbtQuestsImported = 0;

  if (worldSeed) {
    database.metadata = {
      ...(database.metadata || {}),
      worldSeed: String(worldSeed),
      ingestedAt: new Date().toISOString()
    };
  }

  if (ftbFile && fs.existsSync(ftbFile)) {
    const parsedSnbt = parseSnbt(fs.readFileSync(ftbFile, 'utf8'));
    const quests = transformFtbQuestsChapter(parsedSnbt);
    snbtQuestsImported += quests.length;
    database.quests = mergeQuestsDeduplicated(database.quests, quests);
  }

  if (ftbDir && fs.existsSync(ftbDir)) {
    const files = fs.readdirSync(ftbDir).filter((f) => f.endsWith('.snbt')).sort();
    for (const file of files) {
      const parsedSnbt = parseSnbt(fs.readFileSync(path.join(ftbDir, file), 'utf8'));
      const quests = transformFtbQuestsChapter(parsedSnbt);
      snbtQuestsImported += quests.length;
      database.quests = mergeQuestsDeduplicated(database.quests, quests);
    }
  }

  if (bqPath && fs.existsSync(bqPath)) {
    const rawBq = JSON.parse(fs.readFileSync(bqPath, 'utf8'));
    const importedQuests = transformBetterQuestingDump(rawBq);
    database.quests = mergeQuestsDeduplicated(database.quests, importedQuests);
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

  const engine = new CraftingEngine();
  const summary = engine.ingestDatabase(database);

  if (outPath) {
    fs.writeFileSync(path.resolve(outPath), JSON.stringify(database, null, 2), 'utf8');
  }

  return {
    summary,
    snbtQuestsImported,
    neiEntriesCount: neiEntries.length,
    worldSeed: database.metadata?.worldSeed || null,
    writtenTo: outPath ? path.resolve(outPath) : null
  };
}

if (require.main === module) {
  const report = runIngestPipeline(process.argv.slice(2));
  console.log('[GTL Ingest Pipeline] FTB Quests SNBT + GTCEu Recipe DAG Summary:');
  console.log(JSON.stringify(report, null, 2));
}

module.exports = {
  parseSnbt,
  transformFtbQuestsChapter,
  transformBetterQuestingDump,
  parseNeiIdCsv,
  runIngestPipeline
};
