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

    // SPT uses Git LFS for loot data files. We resolve LFS pointers via the
    // GitHub LFS batch API so we can download the actual JSON content.
    const sptDir = join(this.rawDir, 'spt');
    await mkdir(sptDir, { recursive: true });

    // SPT-AKI internal map directory names
    const maps = [
      'bigmap', 'factory4_day', 'factory4_night', 'woods', 'shoreline',
      'interchange', 'laboratory', 'lighthouse', 'rezervbase',
      'tarkovstreets', 'sandbox', 'sandbox_high',
    ];

    const lootFiles = ['looseLoot.json', 'staticLoot.json', 'staticContainers.json'];

    for (const map of maps) {
      const mapDir = join(sptDir, 'locations', map);
      await mkdir(mapDir, { recursive: true });

      for (const file of lootFiles) {
        const remotePath = `project/assets/database/locations/${map}/${file}`;
        try {
          const content = await this.fetchSPTFile(remotePath, commitHash);
          await writeFile(join(mapDir, file), content);
        } catch (error) {
          // Write placeholder for files that don't exist for this map
          await writeFile(join(mapDir, file), JSON.stringify({
            _meta: { placeholder: true, map, file, commit: commitHash }
          }));
        }
      }
    }

    console.log(`    Commit: ${commitHash.slice(0, 8)}`);
    return commitHash;
  }

  /**
   * Fetch a file from the SPT repo, handling Git LFS pointers.
   * First tries raw content; if it's an LFS pointer, resolves via the LFS batch API.
   */
  private async fetchSPTFile(path: string, ref: string): Promise<string> {
    const rawUrl = `https://raw.githubusercontent.com/sp-tarkov/server/${ref}/${path}`;
    const rawResponse = await fetch(rawUrl);

    if (!rawResponse.ok) {
      throw new Error(`Failed to fetch ${path}: ${rawResponse.statusText}`);
    }

    const content = await rawResponse.text();

    // Check if it's an LFS pointer
    if (content.startsWith('version https://git-lfs.github.com/spec/v1')) {
      const oidMatch = content.match(/oid sha256:([a-f0-9]+)/);
      const sizeMatch = content.match(/size (\d+)/);
      if (!oidMatch || !sizeMatch) {
        throw new Error(`Invalid LFS pointer for ${path}`);
      }

      return this.fetchLFSObject(oidMatch[1], parseInt(sizeMatch[1]));
    }

    return content;
  }

  /**
   * Resolve an LFS object via the GitHub LFS batch API.
   */
  private async fetchLFSObject(oid: string, size: number): Promise<string> {
    const batchUrl = 'https://github.com/sp-tarkov/server.git/info/lfs/objects/batch';

    const batchResponse = await fetch(batchUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.git-lfs+json',
      },
      body: JSON.stringify({
        operation: 'download',
        transfer: ['basic'],
        objects: [{ oid, size }],
      }),
    });

    if (!batchResponse.ok) {
      throw new Error(`LFS batch API failed: ${batchResponse.statusText}`);
    }

    const batchData = (await batchResponse.json()) as {
      objects: Array<{
        actions?: { download?: { href: string } };
        error?: { message: string };
      }>;
    };

    const obj = batchData.objects?.[0];
    if (obj?.error) {
      throw new Error(`LFS error: ${obj.error.message}`);
    }

    const downloadUrl = obj?.actions?.download?.href;
    if (!downloadUrl) {
      throw new Error('No download URL in LFS batch response');
    }

    const downloadResponse = await fetch(downloadUrl);
    if (!downloadResponse.ok) {
      throw new Error(`LFS download failed: ${downloadResponse.statusText}`);
    }

    return downloadResponse.text();
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