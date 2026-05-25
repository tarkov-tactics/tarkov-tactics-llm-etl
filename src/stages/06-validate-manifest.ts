// Stage 6: Cross-reference validation and manifest generation

import { readFile, writeFile, mkdir, stat } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';
import {
  Manifest,
  ManifestFile,
  LootProbabilities,
  SpawnClusters,
  NamedPOIs,
  QuestEnhancements,
  StageContext,
} from '../lib/types.js';
import { initializeSchemas, schemaValidator } from '../lib/schema-validator.js';

interface ValidationIssue {
  severity: 'error' | 'warning';
  stage: string;
  message: string;
}

export class Validator {
  private context: StageContext;
  private issues: ValidationIssue[] = [];

  constructor(context: StageContext) {
    this.context = context;
  }

  async run(): Promise<Manifest> {
    console.log('🔍 Stage 6: Validating and generating manifest...');

    // Initialize JSON schemas for AJV validation (per brief §10 step 1)
    await initializeSchemas();

    const outputDir = join(this.context.workDir, 'publish');
    await mkdir(outputDir, { recursive: true });

    // Load all outputs
    const lootProbs = await this.loadJSON<LootProbabilities>('stage2', 'loot-probabilities.json');
    const spawnClusters = await this.loadJSON<SpawnClusters>('stage3', 'spawn-clusters.json');
    const namedPois = await this.loadJSON<NamedPOIs>('stage4', 'named-pois.json');
    const questEnhancements = await this.loadJSON<QuestEnhancements>('stage5', 'quest-enhancements.json');

    // Load reference data
    const items = await this.loadJSON<Array<{ id: string }>>('raw/tarkov-dev', 'items.json');
    const maps = await this.loadJSON<Array<{ id: string }>>('raw/tarkov-dev', 'maps.json');
    const tasks = await this.loadJSON<Array<{ id: string }>>('raw/tarkov-dev', 'tasks.json');

    const itemIds = new Set(items?.map(i => i.id) || []);
    const mapIds = new Set(maps?.map(m => m.id) || []);
    const taskIds = new Set(tasks?.map(t => t.id) || []);

    // Run cross-reference validations
    if (lootProbs) this.validateLootProbabilities(lootProbs, itemIds, mapIds);
    if (spawnClusters) this.validateSpawnClusters(spawnClusters, mapIds);
    if (questEnhancements) this.validateQuestEnhancements(questEnhancements, taskIds);

    // Run AJV schema validation on every output file (per brief §10 step 1)
    const schemaFiles = [
      { stageDir: 'stage2', fileName: 'loot-probabilities.json', schemaName: 'loot-probabilities' },
      { stageDir: 'stage3', fileName: 'spawn-clusters.json', schemaName: 'spawn-clusters' },
      { stageDir: 'stage4', fileName: 'named-pois.json', schemaName: 'named-pois' },
      { stageDir: 'stage5', fileName: 'quest-enhancements.json', schemaName: 'quest-enhancements' },
    ];

    for (const sf of schemaFiles) {
      const filePath = join(this.context.workDir, sf.stageDir, sf.fileName);
      const result = await schemaValidator.validateFile(sf.schemaName, filePath);
      if (!result.valid) {
        this.issues.push({
          severity: 'error',
          stage: 'schema',
          message: `${sf.fileName} failed schema validation: ${result.errors?.join('; ')}`,
        });
      }
    }

    // Copy validated files to publish directory
    const publishFiles: ManifestFile[] = [];

    const filesToPublish = [
      { stageDir: 'stage2', fileName: 'loot-probabilities.json' },
      { stageDir: 'stage3', fileName: 'spawn-clusters.json' },
      { stageDir: 'stage4', fileName: 'named-pois.json' },
      { stageDir: 'stage5', fileName: 'quest-enhancements.json' },
    ];

    for (const file of filesToPublish) {
      try {
        const sourcePath = join(this.context.workDir, file.stageDir, file.fileName);
        const content = await readFile(sourcePath, 'utf-8');
        const destPath = join(outputDir, file.fileName);
        await writeFile(destPath, content);

        const hash = createHash('sha256').update(content).digest('hex');
        const fileStats = await stat(sourcePath);

        publishFiles.push({
          name: file.fileName,
          sha256: hash,
          size_bytes: fileStats.size,
        });
      } catch (error) {
        this.issues.push({
          severity: 'error',
          stage: 'manifest',
          message: `Missing file: ${file.fileName}`,
        });
      }
    }

    // Check total publish size
    const totalSizeBytes = publishFiles.reduce((sum, f) => sum + f.size_bytes, 0);
    const totalSizeMB = totalSizeBytes / (1024 * 1024);
    const maxSizeMB = this.context.config.validation.max_publish_size_mb;

    if (totalSizeMB > maxSizeMB) {
      this.issues.push({
        severity: 'error',
        stage: 'manifest',
        message: `Total publish size ${totalSizeMB.toFixed(1)}MB exceeds cap of ${maxSizeMB}MB`,
      });
    }

    // Load source versions
    let sourceVersions = this.context.sourceVersions;
    try {
      const versionsPath = join(this.context.workDir, 'raw', 'source-versions.json');
      const versionsContent = await readFile(versionsPath, 'utf-8');
      sourceVersions = JSON.parse(versionsContent);
    } catch {
      // Use context versions
    }

    // Generate manifest
    const gamePatch = lootProbs?.game_patch || '0.16.5.1.40234';
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z/, 'Z').slice(0, 15) + 'Z';
    const version = `${gamePatch}+${timestamp}`;

    const manifest: Manifest = {
      schema_version: '1.0',
      version,
      game_patch: gamePatch,
      generated_at: new Date().toISOString(),
      sources: {
        spt_aki_commit: sourceVersions.spt_aki_commit || 'unknown',
        tarkov_dev_query_time: new Date().toISOString(),
        the_hideout_commit: sourceVersions.the_hideout_commit || 'unknown',
      },
      llm: {
        model: questEnhancements?.llm_model || 'none',
        stage_5_completed: questEnhancements
          ? Object.values(questEnhancements.quests).some(q => q.enrichment_status !== 'skipped')
          : false,
      },
      files: publishFiles,
    };

    // Write manifest
    const manifestPath = join(outputDir, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    // Generate validation report
    const report = this.generateReport();
    await writeFile(join(outputDir, 'validation-report.md'), report);

    // Report results
    const errors = this.issues.filter(i => i.severity === 'error');
    const warnings = this.issues.filter(i => i.severity === 'warning');

    console.log(`  Errors: ${errors.length}, Warnings: ${warnings.length}`);
    console.log(`  Total publish size: ${totalSizeMB.toFixed(2)} MB`);

    if (errors.length > 0) {
      console.error('❌ Validation failed:');
      for (const error of errors) {
        console.error(`  [${error.stage}] ${error.message}`);
      }
      throw new Error(`Validation failed with ${errors.length} error(s)`);
    }

    console.log('✓ Stage 6 completed');
    return manifest;
  }

  private async loadJSON<T>(stageDir: string, fileName: string): Promise<T | null> {
    try {
      const filePath = join(this.context.workDir, stageDir, fileName);
      const content = await readFile(filePath, 'utf-8');
      return JSON.parse(content) as T;
    } catch {
      return null;
    }
  }

  private validateLootProbabilities(
    loot: LootProbabilities,
    itemIds: Set<string>,
    mapIds: Set<string>
  ): void {
    for (const [mapId, mapData] of Object.entries(loot.maps)) {
      if (!mapIds.has(mapId)) {
        this.issues.push({
          severity: 'error',
          stage: 'loot',
          message: `Map ID "${mapId}" not found in tarkov.dev catalog`,
        });
      }

      // Validate container item IDs
      for (const [containerType, container] of Object.entries(mapData.containers)) {
        for (const item of container.items) {
          if (item.confidence === 'spt_direct' && !itemIds.has(item.item_id)) {
            if (this.context.config.validation.fail_on_unmatched_item_ids) {
              this.issues.push({
                severity: 'error',
                stage: 'loot',
                message: `Unmatched item "${item.item_id}" in ${mapId}/${containerType} marked as spt_direct`,
              });
            } else {
              this.issues.push({
                severity: 'warning',
                stage: 'loot',
                message: `Unmatched item "${item.item_id}" in ${mapId}/${containerType}`,
              });
            }
          }
        }

        // Validate probabilities sum to ~1
        const totalProb = container.items.reduce((sum, i) => sum + i.probability, 0);
        if (container.items.length > 0 && Math.abs(totalProb - 1.0) > 0.01) {
          this.issues.push({
            severity: 'warning',
            stage: 'loot',
            message: `Probabilities for ${mapId}/${containerType} sum to ${totalProb.toFixed(4)}, expected ~1.0`,
          });
        }
      }

      // Validate loose loot regions
      for (const region of mapData.loose_loot_regions) {
        const totalProb = region.items.reduce((sum, i) => sum + i.probability, 0);
        if (region.items.length > 0 && Math.abs(totalProb - 1.0) > 0.01) {
          this.issues.push({
            severity: 'warning',
            stage: 'loot',
            message: `Probabilities for loose loot region ${region.region_id} on ${mapId} sum to ${totalProb.toFixed(4)}`,
          });
        }
      }
    }
  }

  private validateSpawnClusters(clusters: SpawnClusters, mapIds: Set<string>): void {
    for (const [mapId, mapData] of Object.entries(clusters.maps)) {
      if (!mapIds.has(mapId)) {
        this.issues.push({
          severity: 'warning',
          stage: 'spawns',
          message: `Map ID "${mapId}" not found in tarkov.dev catalog`,
        });
      }

      for (const cluster of mapData.clusters) {
        if (cluster.member_count === 0) {
          this.issues.push({
            severity: 'error',
            stage: 'spawns',
            message: `Cluster "${cluster.cluster_id}" has 0 member spawn points`,
          });
        }

        if (cluster.members.length !== cluster.member_count) {
          this.issues.push({
            severity: 'error',
            stage: 'spawns',
            message: `Cluster "${cluster.cluster_id}" member_count (${cluster.member_count}) doesn't match members array length (${cluster.members.length})`,
          });
        }
      }
    }
  }

  private validateQuestEnhancements(quests: QuestEnhancements, taskIds: Set<string>): void {
    for (const [questId, questData] of Object.entries(quests.quests)) {
      if (!taskIds.has(questId)) {
        this.issues.push({
          severity: 'error',
          stage: 'quests',
          message: `Quest ID "${questId}" not found in tarkov.dev task catalog`,
        });
      }
    }
  }

  private generateReport(): string {
    const errors = this.issues.filter(i => i.severity === 'error');
    const warnings = this.issues.filter(i => i.severity === 'warning');

    let report = `# Validation Report\n\nGenerated: ${new Date().toISOString()}\n\n`;
    report += `## Summary\n\n- Errors: ${errors.length}\n- Warnings: ${warnings.length}\n\n`;

    if (errors.length > 0) {
      report += `## Errors\n\n`;
      for (const issue of errors) {
        report += `- **[${issue.stage}]** ${issue.message}\n`;
      }
      report += '\n';
    }

    if (warnings.length > 0) {
      report += `## Warnings\n\n`;
      for (const issue of warnings) {
        report += `- **[${issue.stage}]** ${issue.message}\n`;
      }
      report += '\n';
    }

    if (errors.length === 0 && warnings.length === 0) {
      report += `All validations passed.\n`;
    }

    return report;
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

  const validator = new Validator(context);
  try {
    await validator.run();
    console.log('✅ Stage 6 (validate) completed successfully');
  } catch (error) {
    console.error('❌ Stage 6 (validate) failed:', error);
    process.exit(1);
  }
}