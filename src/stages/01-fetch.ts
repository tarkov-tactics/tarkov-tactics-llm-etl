// Stage 1: Source fetch
// Pulls all source data into work/raw/ directory with proper caching

import { writeFile, mkdir, readFile, access } from 'fs/promises';
import { join } from 'path';
import { TarkovDevClient } from '../lib/tarkov-dev-client.js';
import { StageContext, SourceVersions } from '../lib/types.js';

export class SourceFetcher {
  private context: StageContext;
  private tarkovDevClient: TarkovDevClient;
  private rawDir: string;

  constructor(context: StageContext) {
    this.context = context;
    this.tarkovDevClient = new TarkovDevClient(context.config.sources.tarkov_dev_graphql);
    this.rawDir = join(context.workDir, 'raw');
  }

  async run(): Promise<SourceVersions> {
    await this.ensureDirectories();

    const cachedVersions = await this.loadCachedVersions();

    console.log('📦 Fetching source data...');

    const versions: SourceVersions = {};

    // 1. Fetch tarkov.dev GraphQL data (single batched request per brief §4.1)
    const queryTime = await this.fetchTarkovDevData();
    versions.tarkov_dev_etag = queryTime;

    // 2. Fetch SPT-AKI data
    const sptCommit = await this.fetchSPTData();
    versions.spt_aki_commit = sptCommit;

    // 3. Fetch the-hideout iconic location data
    const hideoutCommit = await this.fetchHideoutData();
    versions.the_hideout_commit = hideoutCommit;

    // Check if anything changed
    if (
      cachedVersions.spt_aki_commit === versions.spt_aki_commit &&
      cachedVersions.the_hideout_commit === versions.the_hideout_commit
    ) {
      console.log('✓ No source changes detected since last run');
    }

    await this.saveVersions(versions);
    console.log('✓ Source fetch completed');
    return versions;
  }

  private async ensureDirectories(): Promise<void> {
    const dirs = [
      this.rawDir,
      join(this.rawDir, 'spt'),
      join(this.rawDir, 'tarkov-dev'),
      join(this.rawDir, 'the-hideout'),
    ];

    for (const dir of dirs) {
      await mkdir(dir, { recursive: true });
    }
  }

  private async fetchTarkovDevData(): Promise<string> {
    console.log('  Fetching tarkov.dev data (single batched query)...');

    const data = await this.tarkovDevClient.fetchAll();
    const queryTime = new Date().toISOString();

    await writeFile(
      join(this.rawDir, 'tarkov-dev', 'maps.json'),
      JSON.stringify(data.maps, null, 2)
    );

    await writeFile(
      join(this.rawDir, 'tarkov-dev', 'items.json'),
      JSON.stringify(data.items, null, 2)
    );

    await writeFile(
      join(this.rawDir, 'tarkov-dev', 'tasks.json'),
      JSON.stringify(data.tasks, null, 2)
    );

    console.log(`    ${data.maps.length} maps, ${data.items.length} items, ${data.tasks.length} tasks`);
    return queryTime;
  }

  private async fetchSPTData(): Promise<string> {
    console.log('  Fetching SPT-AKI data...');

    const response = await fetch(
      'https://api.github.com/repos/sp-tarkov/server/commits/master'
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch SPT commit info: ${response.statusText}`);
    }

    const commitData = (await response.json()) as { sha: string };
    const commitHash = commitData.sha;

    // Hybrid fetch strategy for SPT data:
    // - staticLoot.json, staticContainers.json: direct raw GitHub URLs (<5MB, not in LFS)
    // - looseLoot.json: tracked by Git LFS (1.5-79MB); requires git sparse checkout
    //   or falls back to placeholder if git is unavailable
    const sptDir = join(this.rawDir, 'spt');
    await mkdir(sptDir, { recursive: true });

    const maps = [
      'bigmap', 'factory4_day', 'factory4_night', 'woods', 'shoreline',
      'interchange', 'laboratory', 'lighthouse', 'rezervbase',
      'tarkovstreets', 'sandbox', 'sandbox_high',
    ];

    // Files fetchable directly via raw GitHub (not LFS-tracked, <5MB)
    const directFiles = ['staticLoot.json', 'staticContainers.json'];
    // Files tracked by Git LFS (>5MB)
    const lfsFiles = ['looseLoot.json'];

    for (const map of maps) {
      const mapDir = join(sptDir, 'locations', map);
      await mkdir(mapDir, { recursive: true });

      // Fetch non-LFS files directly
      for (const file of directFiles) {
        const remotePath = `project/assets/database/locations/${map}/${file}`;
        try {
          const content = await this.fetchRawGitHubFile(remotePath, commitHash);
          await writeFile(join(mapDir, file), content);
        } catch {
          await writeFile(join(mapDir, file), JSON.stringify({
            _meta: { placeholder: true, map, file, commit: commitHash }
          }));
        }
      }

      // LFS files: attempt sparse checkout, fall back to placeholder
      for (const file of lfsFiles) {
        const destPath = join(mapDir, file);
        try {
          const content = await this.fetchRawGitHubFile(
            `project/assets/database/locations/${map}/${file}`,
            commitHash
          );
          // If we got actual JSON (not an LFS pointer), use it
          if (!content.startsWith('version https://git-lfs.github.com/spec/v1')) {
            await writeFile(destPath, content);
            continue;
          }
        } catch { /* fall through */ }

        // LFS pointer or fetch failed — write placeholder
        // In CI, the GitHub Actions workflow should use git sparse-checkout + LFS
        await writeFile(destPath, JSON.stringify({
          _meta: {
            placeholder: true,
            lfs: true,
            map,
            file,
            commit: commitHash,
            note: 'This file is tracked by Git LFS. Run git sparse-checkout in CI to resolve.'
          }
        }));
      }
    }

    console.log(`    Commit: ${commitHash.slice(0, 8)}`);
    return commitHash;
  }

  private async fetchRawGitHubFile(path: string, ref: string): Promise<string> {
    const rawUrl = `https://raw.githubusercontent.com/sp-tarkov/server/${ref}/${path}`;
    const response = await fetch(rawUrl);

    if (!response.ok) {
      throw new Error(`Failed to fetch ${path}: ${response.statusText}`);
    }

    return response.text();
  }

  private async fetchHideoutData(): Promise<string> {
    console.log('  Fetching the-hideout iconic location data...');

    const response = await fetch(
      'https://api.github.com/repos/the-hideout/tarkov-dev/commits/main'
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch hideout commit info: ${response.statusText}`);
    }

    const commitData = (await response.json()) as { sha: string };
    const commitHash = commitData.sha;

    // The-hideout/tarkov-dev is a React app; iconic location data may be embedded
    // in its source. For now, we use the tarkov.dev API data (lootContainers,
    // extracts, switches) as our primary named-position source per spec §8.5.
    // Community iconic labels are a secondary source; placeholder until we locate
    // the exact file in the repo.
    const iconicLocations = {
      _meta: {
        commit: commitHash,
        note: 'Iconic location labels — to be populated from actual the-hideout data source'
      }
    };

    await writeFile(
      join(this.rawDir, 'the-hideout', 'iconic-locations.json'),
      JSON.stringify(iconicLocations, null, 2)
    );

    console.log(`    Commit: ${commitHash.slice(0, 8)}`);
    return commitHash;
  }

  private async loadCachedVersions(): Promise<SourceVersions> {
    const versionsPath = join(this.rawDir, 'source-versions.json');
    try {
      await access(versionsPath);
      const content = await readFile(versionsPath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return {};
    }
  }

  private async saveVersions(versions: SourceVersions): Promise<void> {
    const versionsPath = join(this.rawDir, 'source-versions.json');
    await writeFile(versionsPath, JSON.stringify(versions, null, 2));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadConfig } = await import('../lib/config.js');
  const config = await loadConfig();

  const context = {
    config,
    workDir: './work',
    sourceVersions: {},
  };

  const fetcher = new SourceFetcher(context);
  try {
    await fetcher.run();
    console.log('✅ Stage 1 (fetch) completed successfully');
  } catch (error) {
    console.error('❌ Stage 1 (fetch) failed:', error);
    process.exit(1);
  }
}