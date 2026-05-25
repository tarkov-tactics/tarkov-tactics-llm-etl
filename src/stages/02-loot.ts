// Stage 2: Loot probability normalization
// Processes SPT-AKI raw location files into normalized loot probabilities

import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import { join } from 'path';
import { LootProbabilities, LootItem, LootConfidence, Position, StageContext } from '../lib/types.js';

// SPT-AKI raw data structures
interface SPTDistributionEntry {
  tpl: string;
  relativeProbability: number;
}

interface SPTLooseLootPoint {
  template: string;
  position: { x: number; y: number; z: number };
  itemDistribution: SPTDistributionEntry[];
}

// Map of known SPT internal map directory names to tarkov.dev IDs
const SPT_MAP_ID_MAP: Record<string, string> = {
  bigmap: '56f40101d2720b2a4d8b45d6',
  factory4_day: '55f2d3fd4bdc2d5f408b4567',
  factory4_night: '59fc81d786f774390775787e',
  interchange: '5714dbc024597771384a510d',
  laboratory: '5b0fc42d86f7744a585f9105',
  lighthouse: '5704e4dad2720bb55b8b4567',
  rezervbase: '5704e5fad2720bc05b8b4567',
  shoreline: '5704e554d2720bac5b8b456e',
  tarkovstreets: '653e6760052c01c1c805532f',
  woods: '5704e3c2d2720bac5b8b4567',
  sandbox: '653e6760052c01c1c805532f',
  sandbox_high: '65b8d6f5cdde2479cb2a3125',
};

export class LootNormalizer {
  private context: StageContext;
  private itemIndex: Set<string> = new Set();
  // Loot container types from tarkov.dev, keyed by map ID
  private mapContainerTypes: Map<string, Set<string>> = new Map();

  constructor(context: StageContext) {
    this.context = context;
  }

  async run(): Promise<LootProbabilities> {
    console.log('📊 Stage 2: Normalizing loot probabilities...');

    await this.loadItemIndex();
    await this.loadMapContainerTypes();

    const rawDir = join(this.context.workDir, 'raw');
    const outputDir = join(this.context.workDir, 'stage2');
    await mkdir(outputDir, { recursive: true });

    const result: LootProbabilities = {
      schema_version: '1.0',
      generated_at: new Date().toISOString(),
      game_patch: await this.getGamePatch(),
      maps: {},
    };

    const sptLocationsDir = join(rawDir, 'spt', 'locations');
    let mapDirs: string[];
    try {
      mapDirs = await readdir(sptLocationsDir);
    } catch {
      console.warn('  No SPT location data found, using empty loot data');
      mapDirs = [];
    }

    for (const mapDir of mapDirs) {
      const mapId = SPT_MAP_ID_MAP[mapDir] || mapDir;
      console.log(`  Processing map: ${mapDir} -> ${mapId}`);

      const mapResult = await this.processMap(join(sptLocationsDir, mapDir), mapId);
      if (mapResult) {
        result.maps[mapId] = mapResult;
      }
    }

    const outputPath = join(outputDir, 'loot-probabilities.json');
    await writeFile(outputPath, JSON.stringify(result, null, 2));
    console.log('✓ Stage 2 completed');

    return result;
  }

  private async loadItemIndex(): Promise<void> {
    try {
      const itemsPath = join(this.context.workDir, 'raw', 'tarkov-dev', 'items.json');
      const content = await readFile(itemsPath, 'utf-8');
      const items = JSON.parse(content) as Array<{ id: string }>;

      for (const item of items) {
        this.itemIndex.add(item.id);
      }

      console.log(`  Loaded ${this.itemIndex.size} items from tarkov.dev catalog`);
    } catch {
      console.warn('  Could not load tarkov.dev item catalog');
    }
  }

  private async loadMapContainerTypes(): Promise<void> {
    try {
      const mapsPath = join(this.context.workDir, 'raw', 'tarkov-dev', 'maps.json');
      const content = await readFile(mapsPath, 'utf-8');
      const maps = JSON.parse(content) as Array<{
        id: string;
        lootContainers?: Array<{ lootContainer: { id: string } }>;
      }>;

      for (const map of maps) {
        const containerTypes = new Set<string>();
        for (const lc of map.lootContainers || []) {
          containerTypes.add(lc.lootContainer.id);
        }
        this.mapContainerTypes.set(map.id, containerTypes);
      }
    } catch {
      // OK — uniform prior fallback won't fire
    }
  }

  private async processMap(
    mapPath: string,
    mapId: string
  ): Promise<LootProbabilities['maps'][string] | null> {
    const containers: Record<string, { items: LootItem[] }> = {};
    const looseRegions: LootProbabilities['maps'][string]['loose_loot_regions'] = [];

    // 1. Process looseLoot.json (per brief §4.2 step 2)
    try {
      const content = await readFile(join(mapPath, 'looseLoot.json'), 'utf-8');
      const data = JSON.parse(content);

      if (data._meta?.placeholder) {
        // Skip placeholder data
      } else {
        const spawnpoints = data.spawnpoints || data.spawnpointsForced || [];
        for (const point of spawnpoints) {
          if (!point.itemDistribution || point.itemDistribution.length === 0) continue;

          looseRegions.push({
            region_id: point.template || `region-${looseRegions.length}`,
            center: point.position || { x: 0, y: 0, z: 0 },
            radius: 1.0,
            items: this.normalizeDistribution(point.itemDistribution),
          });
        }
      }
    } catch { /* no loose loot data */ }

    // 2. Process staticLoot.json (per brief §4.2 step 1 — separate file)
    try {
      const content = await readFile(join(mapPath, 'staticLoot.json'), 'utf-8');
      const data = JSON.parse(content);

      if (!data._meta?.placeholder) {
        // staticLoot.json maps container type IDs to their item distributions
        for (const [containerType, containerData] of Object.entries(data)) {
          const cd = containerData as { itemDistribution?: SPTDistributionEntry[] };
          if (cd.itemDistribution && cd.itemDistribution.length > 0) {
            containers[containerType] = {
              items: this.normalizeDistribution(cd.itemDistribution),
            };
          }
        }
      }
    } catch { /* no static loot data */ }

    // 3. Process staticContainers.json (per brief §3 — separate file)
    try {
      const content = await readFile(join(mapPath, 'staticContainers.json'), 'utf-8');
      const data = JSON.parse(content);

      if (!data._meta?.placeholder && data.staticContainers) {
        for (const container of data.staticContainers) {
          const typeId = container.containerTypeId || container.containerId;
          if (!typeId) continue;
          const dist = container.itemDistribution || container.items || [];
          if (dist.length > 0 && !containers[typeId]) {
            containers[typeId] = {
              items: this.normalizeDistribution(dist),
            };
          }
        }
      }
    } catch { /* no static containers data */ }

    // 4. Uniform prior fallback (per brief §4.2 step 4)
    if (this.context.config.loot_probability.uniform_prior_fallback_enabled) {
      const apiContainers = this.mapContainerTypes.get(mapId);
      if (apiContainers) {
        for (const containerTypeId of apiContainers) {
          if (!containers[containerTypeId]) {
            // No SPT data for this container type — emit uniform prior
            const itemCount = this.itemIndex.size || 1;
            containers[containerTypeId] = {
              items: [{
                item_id: 'uniform_prior_placeholder',
                probability: 1.0 / itemCount,
                confidence: 'uniform_prior' as LootConfidence,
              }],
            };
          }
        }
      }
    }

    return {
      containers,
      loose_loot_regions: looseRegions,
    };
  }

  private normalizeDistribution(distribution: SPTDistributionEntry[]): LootItem[] {
    // Filter to only items that exist in the tarkov.dev catalog
    const matched = distribution.filter(item => this.itemIndex.has(item.tpl));
    const totalWeight = matched.reduce((sum, item) => sum + item.relativeProbability, 0);
    if (totalWeight === 0) return [];

    return matched.map(item => ({
      item_id: item.tpl,
      probability: item.relativeProbability / totalWeight,
      confidence: 'spt_direct' as LootConfidence,
    }));
  }

  private async getGamePatch(): Promise<string> {
    try {
      const versionsPath = join(this.context.workDir, 'raw', 'source-versions.json');
      const content = await readFile(versionsPath, 'utf-8');
      const versions = JSON.parse(content);
      return versions.game_patch || '0.16.5.1.40234';
    } catch {
      return '0.16.5.1.40234';
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadConfig } = await import('../lib/config.js');
  const config = await loadConfig();

  const context: StageContext = {
    config,
    workDir: './work',
    sourceVersions: {},
  };

  const normalizer = new LootNormalizer(context);
  try {
    await normalizer.run();
    console.log('✅ Stage 2 (loot) completed successfully');
  } catch (error) {
    console.error('❌ Stage 2 (loot) failed:', error);
    process.exit(1);
  }
}