// Stage 4: Iconic location ingestion and cluster naming
// Implements the source hierarchy from spec §8.5:
//   1. Primary game-data API (extracts, switches, named positions)
//   2. Community iconic-location labels (the-hideout)
//   3. Synthetic identifier (fallback)

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { NamedPOIs, SpawnClusters, IconicLabel, Position, StageContext } from '../lib/types.js';
import { euclideanDistance } from '../lib/clustering.js';

interface NamedPosition {
  name: string;
  position: Position;
  source: string;
}

interface RawIconicLocation {
  name: string;
  center: Position;
  layer_range_y: [number, number];
  source: string;
}

export class NameResolver {
  private context: StageContext;

  constructor(context: StageContext) {
    this.context = context;
  }

  async run(): Promise<NamedPOIs> {
    console.log('🏷️  Stage 4: Resolving location names...');

    const outputDir = join(this.context.workDir, 'stage4');
    await mkdir(outputDir, { recursive: true });

    const clustersPath = join(this.context.workDir, 'stage3', 'spawn-clusters.json');
    const clustersContent = await readFile(clustersPath, 'utf-8');
    const spawnClusters: SpawnClusters = JSON.parse(clustersContent);

    // Load all naming sources
    const apiNamedPositions = await this.loadAPINamedPositions();
    const iconicLocations = await this.loadIconicLocations();

    const result: NamedPOIs = {
      schema_version: '1.0',
      generated_at: new Date().toISOString(),
      maps: {},
    };

    for (const [mapId, mapData] of Object.entries(spawnClusters.maps)) {
      console.log(`  Processing map: ${mapId}`);

      const mapApiPositions = apiNamedPositions.get(mapId) || [];
      const mapIconicLabels = iconicLocations[mapId] || [];
      const spawnClusterNames: Record<string, { name: string; source: 'iconic_match' | 'synthetic' }> = {};

      for (const cluster of mapData.clusters) {
        // Source hierarchy per §8.5:
        // 1. Try tarkov.dev named positions (extracts, switches)
        const apiMatch = this.findNearestNamedPosition(
          cluster.centroid,
          mapApiPositions,
          this.context.config.naming.iconic_match_radius_m
        );

        if (apiMatch) {
          spawnClusterNames[cluster.cluster_id] = {
            name: apiMatch.name,
            source: 'iconic_match',
          };
          console.log(`    ${cluster.cluster_id} -> "${apiMatch.name}" (API: ${apiMatch.source})`);
          continue;
        }

        // 2. Try community iconic labels
        const iconicMatch = this.findNearestIconicLabel(
          cluster.centroid,
          mapIconicLabels,
          this.context.config.naming.iconic_match_radius_m,
          this.context.config.naming.layer_aware_matching
        );

        if (iconicMatch) {
          spawnClusterNames[cluster.cluster_id] = {
            name: iconicMatch.name,
            source: 'iconic_match',
          };
          console.log(`    ${cluster.cluster_id} -> "${iconicMatch.name}" (iconic)`);
          continue;
        }

        // 3. Synthetic identifier (per spec: "<map>-spawn-<index>")
        spawnClusterNames[cluster.cluster_id] = {
          name: cluster.cluster_id,
          source: 'synthetic',
        };
        console.log(`    ${cluster.cluster_id} -> synthetic`);
      }

      result.maps[mapId] = {
        iconic_labels: mapIconicLabels.map(label => ({
          name: label.name,
          center: label.center,
          layer_range_y: label.layer_range_y,
          source: 'the-hideout/tarkov-dev' as const,
        })),
        spawn_cluster_names: spawnClusterNames,
      };
    }

    const outputPath = join(outputDir, 'named-pois.json');
    await writeFile(outputPath, JSON.stringify(result, null, 2));
    console.log('✓ Stage 4 completed');

    return result;
  }

  /**
   * Extract named positions from tarkov.dev map data (extracts, switches, boss spawns).
   * Per §8.5 source hierarchy #1: "Primary game-data API."
   */
  private async loadAPINamedPositions(): Promise<Map<string, NamedPosition[]>> {
    const result = new Map<string, NamedPosition[]>();

    try {
      const mapsPath = join(this.context.workDir, 'raw', 'tarkov-dev', 'maps.json');
      const content = await readFile(mapsPath, 'utf-8');
      const maps = JSON.parse(content) as Array<{
        id: string;
        extracts?: Array<{ name: string; position: Position | null }>;
        switches?: Array<{ name: string; position: Position | null }>;
      }>;

      for (const map of maps) {
        const positions: NamedPosition[] = [];

        for (const extract of map.extracts || []) {
          if (extract.position && extract.name) {
            positions.push({
              name: extract.name,
              position: extract.position,
              source: 'extract',
            });
          }
        }

        for (const sw of map.switches || []) {
          if (sw.position && sw.name) {
            positions.push({
              name: sw.name,
              position: sw.position,
              source: 'switch',
            });
          }
        }

        // Boss spawn locations don't have positions in the API,
        // so we can't use them for spatial matching.

        result.set(map.id, positions);
      }
    } catch {
      console.warn('  Could not load tarkov.dev map data for named positions');
    }

    return result;
  }

  private async loadIconicLocations(): Promise<Record<string, RawIconicLocation[]>> {
    try {
      const iconicPath = join(this.context.workDir, 'raw', 'the-hideout', 'iconic-locations.json');
      const content = await readFile(iconicPath, 'utf-8');
      const data = JSON.parse(content);
      const result: Record<string, RawIconicLocation[]> = {};
      for (const [key, value] of Object.entries(data)) {
        if (key !== '_meta' && Array.isArray(value)) {
          result[key] = value as RawIconicLocation[];
        }
      }
      return result;
    } catch {
      return {};
    }
  }

  private findNearestNamedPosition(
    position: Position,
    namedPositions: NamedPosition[],
    maxRadius: number
  ): NamedPosition | null {
    let nearest: NamedPosition | null = null;
    let nearestDistance = Infinity;

    for (const np of namedPositions) {
      const distance = euclideanDistance(position, np.position);
      if (distance <= maxRadius && distance < nearestDistance) {
        nearest = np;
        nearestDistance = distance;
      }
    }

    return nearest;
  }

  private findNearestIconicLabel(
    position: Position,
    labels: RawIconicLocation[],
    maxRadius: number,
    layerAware: boolean
  ): RawIconicLocation | null {
    let nearest: RawIconicLocation | null = null;
    let nearestDistance = Infinity;

    for (const label of labels) {
      if (layerAware) {
        const [yMin, yMax] = label.layer_range_y;
        if (position.y < yMin || position.y > yMax) {
          continue;
        }
      }

      const distance = euclideanDistance(position, label.center);
      if (distance <= maxRadius && distance < nearestDistance) {
        nearest = label;
        nearestDistance = distance;
      }
    }

    return nearest;
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

  const resolver = new NameResolver(context);
  try {
    await resolver.run();
    console.log('✅ Stage 4 (names) completed successfully');
  } catch (error) {
    console.error('❌ Stage 4 (names) failed:', error);
    process.exit(1);
  }
}