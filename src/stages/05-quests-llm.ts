// Stage 5: Quest structured-field enrichment (LLM stage)
// Only includes quests that need enrichment — consumer app falls back to
// tarkov.dev structured data for quests not listed here.

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import {
  QuestEnhancements,
  QuestConstraints,
  QuestObjectiveEnhancement,
  StageContext,
} from '../lib/types.js';
import { callLLM, isLLMConfigured, getLLMModelIdentifier, LLMMessage } from '../llm/client.js';

// Objective types where LLM enrichment adds value
const ENRICHABLE_TYPES = ['shoot', 'mark', 'plantItem', 'visitPlace', 'extract'];

interface RawTask {
  id: string;
  name: string;
  objectives: Array<{
    id: string;
    type: string;
    description: string;
    optional: boolean;
    maps?: Array<{ id: string; name: string }>;
  }>;
}

export class QuestEnricher {
  private context: StageContext;
  private promptTemplate: string = '';

  constructor(context: StageContext) {
    this.context = context;
  }

  async run(): Promise<QuestEnhancements> {
    console.log('📝 Stage 5: Quest enrichment...');

    const outputDir = join(this.context.workDir, 'stage5');
    await mkdir(outputDir, { recursive: true });

    const llmConfigured = isLLMConfigured() && this.context.config.llm.enabled;
    const modelId = getLLMModelIdentifier();

    const result: QuestEnhancements = {
      schema_version: '1.0',
      generated_at: new Date().toISOString(),
      llm_model: modelId,
      quests: {},
    };

    const tasksPath = join(this.context.workDir, 'raw', 'tarkov-dev', 'tasks.json');
    const tasksContent = await readFile(tasksPath, 'utf-8');
    const tasks: RawTask[] = JSON.parse(tasksContent);

    // Filter to quests that actually need enrichment
    const enrichableTasks = tasks.filter(t => this.needsEnrichment(t));
    console.log(`  ${enrichableTasks.length} quests need enrichment (of ${tasks.length} total)`);

    if (!llmConfigured) {
      console.log('  LLM not configured — extracting deterministic constraints only');
      for (const task of enrichableTasks) {
        result.quests[task.id] = {
          enrichment_status: 'skipped',
          objectives: task.objectives
            .filter(obj => ENRICHABLE_TYPES.includes(obj.type))
            .map(obj => ({
              objective_id: obj.id,
              constraints: this.extractDeterministicConstraints(obj),
              source_text: obj.description,
              reviewed_by: null,
              reviewed_at: null,
            })),
        };
      }
    } else {
      console.log(`  LLM configured: ${modelId}`);
      this.promptTemplate = await this.loadPromptTemplate();

      const diffEntries: string[] = [];
      let enriched = 0;
      let failed = 0;
      let processed = 0;

      for (const task of enrichableTasks) {
        const objectives: QuestObjectiveEnhancement[] = [];

        for (const obj of task.objectives) {
          if (!ENRICHABLE_TYPES.includes(obj.type)) continue;
          processed++;
          if (processed % 25 === 0) {
            console.log(`    Progress: ${processed} objectives processed (${enriched} enriched, ${failed} failed)`);
          }

          try {
            const llmConstraints = await this.enrichObjectiveWithLLM(obj);

            if (llmConstraints) {
              const deterministicConstraints = this.extractDeterministicConstraints(obj);
              const merged = this.mergeConstraints(deterministicConstraints, llmConstraints);

              objectives.push({
                objective_id: obj.id,
                constraints: merged,
                source_text: obj.description,
                reviewed_by: null,
                reviewed_at: null,
              });

              diffEntries.push(this.formatDiffEntry(task, obj, merged));
              enriched++;
            } else {
              objectives.push({
                objective_id: obj.id,
                constraints: this.extractDeterministicConstraints(obj),
                source_text: obj.description,
                reviewed_by: null,
                reviewed_at: null,
              });
              failed++;
            }
          } catch (error) {
            console.error(`    Error on ${task.name}/${obj.id}: ${error}`);
            objectives.push({
              objective_id: obj.id,
              constraints: this.extractDeterministicConstraints(obj),
              source_text: obj.description,
              reviewed_by: null,
              reviewed_at: null,
            });
            failed++;
          }
        }

        if (objectives.length > 0) {
          result.quests[task.id] = {
            enrichment_status: enriched > 0 ? 'review_pending' : 'skipped',
            objectives,
          };
        }
      }

      console.log(`  Enriched: ${enriched}, Failed/skipped: ${failed}`);

      if (diffEntries.length > 0) {
        const diffContent = this.formatDiffDocument(diffEntries);
        await writeFile(join(outputDir, 'quest-enhancements.diff.md'), diffContent);
        console.log(`  Generated diff with ${diffEntries.length} enriched objectives`);
      }
    }

    const outputPath = join(outputDir, 'quest-enhancements.json');
    await writeFile(outputPath, JSON.stringify(result, null, 2));
    console.log('✓ Stage 5 completed');

    return result;
  }

  private needsEnrichment(task: RawTask): boolean {
    return task.objectives.some(obj =>
      ENRICHABLE_TYPES.includes(obj.type) && obj.description.length > 0
    );
  }

  private extractDeterministicConstraints(
    obj: { description: string; maps?: Array<{ id: string }> }
  ): QuestConstraints {
    return {
      maps: obj.maps && obj.maps.length > 0 ? obj.maps.map(m => m.id) : null,
      zone: null,
      body_parts: null,
      weapon_specific_item: null,
      weapon_class: null,
      weapon_mods_required: [],
      wearing_required: [],
      not_wearing: [],
      distance_min_m: null,
      distance_max_m: null,
      time_of_day: null,
      shot_type: null,
      health_state: null,
      required_keys: [],
    };
  }

  private async enrichObjectiveWithLLM(
    obj: { id: string; type: string; description: string; maps?: Array<{ id: string; name: string }> }
  ): Promise<QuestConstraints | null> {
    const messages: LLMMessage[] = [
      { role: 'system', content: this.promptTemplate },
      {
        role: 'user',
        content: `Extract constraints from this quest objective:\n\nObjective type: ${obj.type}\nDescription: "${obj.description}"${obj.maps ? `\nMaps: ${obj.maps.map(m => `${m.name} (${m.id})`).join(', ')}` : ''}\n\nReturn ONLY the JSON object.`,
      },
    ];

    try {
      const response = await callLLM(messages);
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const constraints = JSON.parse(jsonMatch[0]) as QuestConstraints;
      if (!this.validateConstraints(constraints)) return null;

      return constraints;
    } catch (error) {
      console.warn(`    LLM call failed for ${obj.id}: ${error}`);
      return null;
    }
  }

  private validateConstraints(constraints: unknown): constraints is QuestConstraints {
    if (!constraints || typeof constraints !== 'object') return false;
    const c = constraints as Record<string, unknown>;

    for (const field of ['weapon_mods_required', 'wearing_required', 'not_wearing', 'required_keys']) {
      if (c[field] !== undefined && !Array.isArray(c[field])) return false;
    }

    for (const field of ['distance_min_m', 'distance_max_m']) {
      if (c[field] !== undefined && c[field] !== null && typeof c[field] !== 'number') return false;
    }

    return true;
  }

  private mergeConstraints(deterministic: QuestConstraints, llm: QuestConstraints): QuestConstraints {
    // Normalize LLM output quirks: weapon_class must be string|null, not array
    let weaponClass = llm.weapon_class;
    if (Array.isArray(weaponClass)) {
      weaponClass = weaponClass[0] || null;
    }

    return {
      maps: deterministic.maps || llm.maps,
      zone: llm.zone ?? null,
      body_parts: llm.body_parts,
      weapon_specific_item: llm.weapon_specific_item ?? null,
      weapon_class: typeof weaponClass === 'string' ? weaponClass : null,
      weapon_mods_required: llm.weapon_mods_required || [],
      wearing_required: llm.wearing_required || [],
      not_wearing: llm.not_wearing || [],
      distance_min_m: typeof llm.distance_min_m === 'number' ? llm.distance_min_m : null,
      distance_max_m: typeof llm.distance_max_m === 'number' ? llm.distance_max_m : null,
      time_of_day: typeof llm.time_of_day === 'string' ? llm.time_of_day : null,
      shot_type: typeof llm.shot_type === 'string' ? llm.shot_type : null,
      health_state: typeof llm.health_state === 'string' ? llm.health_state : null,
      required_keys: llm.required_keys || [],
    };
  }

  private async loadPromptTemplate(): Promise<string> {
    const templatePath = this.context.config.llm.prompt_template_path;
    try {
      return await readFile(templatePath, 'utf-8');
    } catch {
      console.warn('  Could not load prompt template, using built-in');
      return 'You are a game data parser. Extract constraint fields from quest objective text. Return only JSON.';
    }
  }

  private formatDiffEntry(
    task: RawTask,
    obj: { id: string; description: string },
    constraints: QuestConstraints
  ): string {
    const active = Object.entries(constraints)
      .filter(([_, v]) => v !== null && (!Array.isArray(v) || v.length > 0))
      .map(([k, v]) => `  - **${k}**: ${JSON.stringify(v)}`)
      .join('\n');

    return `### ${task.name} — Objective ${obj.id}\n\n**Source text:** "${obj.description}"\n\n**Extracted constraints:**\n${active || '  (none)'}\n`;
  }

  private formatDiffDocument(entries: string[]): string {
    return `# Quest Enhancement Diff — Human Review Required\n\nGenerated: ${new Date().toISOString()}\nModel: ${getLLMModelIdentifier()}\n\nReview each entry below. Approve by merging the PR.\n\n---\n\n${entries.join('\n---\n\n')}\n`;
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

  const enricher = new QuestEnricher(context);
  try {
    await enricher.run();
    console.log('✅ Stage 5 (quests) completed successfully');
  } catch (error) {
    console.error('❌ Stage 5 (quests) failed:', error);
    process.exit(1);
  }
}