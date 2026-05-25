// Stage 3: Spawn cluster pre-computation
// Filters PMC player spawns and clusters them spatially per map

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { SpawnClusters, SpawnCluster, Position, StageContext } from '../lib/types.js';
import { proximityCluster, enforceClusterLimits, ClusterablePoint } from '../lib/clustering.js';

interface RawSpawn {
  zoneName: string;
  categories: string[];
  sides: string[];
  position: Position;
}

interface SpawnPoint extends ClusterablePoint {
  position: Position;
  zoneName: string;
}

export class SpawnClusterer {
  private context: StageContext;

  constructor(context: StageContext) {
    this.context = context;
  }

  async run(): Promise<SpawnClusters> {
    console.log('🎯 Stage 3: Computing spawn clusters...');

    const outputDir = join(this.context.workDir, 'stage3');
    await mkdir(outputDir, { recursive: true });

    const mapsPath = join(this.context.workDir, 'raw', 'tarkov-dev', 'maps.json');
    const mapsContent = await readFile(mapsPath, 'utf-8');
    const maps = JSON.parse(mapsContent) as Array<{
      id: string;
      name: string;
      spawns: RawSpawn[];
    }>;

    const config = this.context.config.spawn_clustering;

    const result: SpawnClusters = {
      schema_version: '1.0',
      generated_at: new Date().toISOString(),
      config: {
        max_clusters_per_map: config.max_clusters_per_map,
        min_clusters_per_map: config.min_clusters_per_map,
        default_proximity_threshold_m: config.default_proximity_threshold_m,
      },
      maps: {},
    };

    for (const map of maps) {
      console.log(`  Processing map: ${map.name} (${map.id})`);
      const mapResult = this.processMap(map, config);
      result.maps[map.id] = mapResult;
    }

    const outputPath = join(outputDir, 'spawn-clusters.json');
    await writeFile(outputPath, JSON.stringify(result, null, 2));
    console.log('✓ Stage 3 completed');

    return result;
  }

  private processMap(
    map: { id: string; name: string; spawns: RawSpawn[] },
    config: StageContext['config']['spawn_clustering']
  ): SpawnClusters['maps'][string] {
    // Step 1: Filter to PMC player spawns only
    // Per spec §9.1: sides contains "Pmc" AND categories contains "Player"
    // API returns lowercase values: "all" includes PMC, "pmc" is PMC-specific
    // "scav" in sides means scav-only spawn
    const pmcSpawns = map.spawns.filter(spawn => {
      const hasPmcSide = spawn.sides.some(
        s => s.toLowerCase() === 'pmc' || s.toLowerCase() === 'all'
      );
      const hasPlayerCategory = spawn.categories.some(
        c => c.toLowerCase() === 'player'
      );
      // Exclude scav-only spawns
      const isScavOnly = spawn.sides.length === 1 && spawn.sides[0].toLowerCase() === 'scav';

      return hasPmcSide && hasPlayerCategory && !isScavOnly;
    });

    console.log(`    Found ${pmcSpawns.length} PMC player spawns (from ${map.spawns.length} total)`);

    // Step 2: Get proximity threshold (per-map override or default)
    const normalizedMapName = map.name.toLowerCase().replace(/\s+/g, '-');
    const perMapOverride = config.per_map_overrides[normalizedMapName]
      || config.per_map_overrides[map.id];
    const threshold = perMapOverride?.proximity_threshold_m ?? config.default_proximity_threshold_m;

    // If no PMC spawns found, record the map with no clusters
    if (pmcSpawns.length === 0) {
      console.log(`    No PMC spawns found for ${map.name}`);
      return {
        proximity_threshold_used_m: threshold,
        clusters: [],
      };
    }

    // Step 3: Convert to clusterable points
    const spawnPoints: SpawnPoint[] = pmcSpawns.map(spawn => ({
      position: spawn.position,
      zoneName: spawn.zoneName || 'unknown',
    }));

    // Step 4: Cluster spatially
    let clusters = proximityCluster(spawnPoints, threshold);

    // Step 5: Enforce cluster count constraints (per-map override or global)
    const maxClusters = (perMapOverride as Record<string, unknown>)?.max_clusters as number
      ?? config.max_clusters_per_map;
    clusters = enforceClusterLimits(clusters, config.min_clusters_per_map, maxClusters);

    console.log(`    Produced ${clusters.length} clusters (threshold: ${threshold}m)`);

    // Step 6: Convert to output format
    const spawnClusters: SpawnCluster[] = clusters.map((cluster, index) => {
      const zoneNames = cluster.members.map(m => (m as SpawnPoint).zoneName);
      return {
        cluster_id: `${map.id}-spawn-${index + 1}`,
        centroid: cluster.centroid,
        radius_m: Math.round(cluster.radius * 100) / 100,
        member_count: cluster.members.length,
        zone_names: [...new Set(zoneNames)],
        members: cluster.members.map(m => ({
          position: m.position,
          zone_name: (m as SpawnPoint).zoneName,
        })),
      };
    });

    return {
      proximity_threshold_used_m: threshold,
      clusters: spawnClusters,
    };
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

  const clusterer = new SpawnClusterer(context);
  try {
    await clusterer.run();
    console.log('✅ Stage 3 (spawns) completed successfully');
  } catch (error) {
    console.error('❌ Stage 3 (spawns) failed:', error);
    process.exit(1);
  }
}