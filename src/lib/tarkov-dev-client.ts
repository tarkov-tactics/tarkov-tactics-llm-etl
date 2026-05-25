// GraphQL client for tarkov.dev API

export interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{
    message: string;
    locations?: Array<{ line: number; column: number }>;
  }>;
}

export class TarkovDevClient {
  private endpoint: string;

  constructor(endpoint = 'https://api.tarkov.dev/graphql') {
    this.endpoint = endpoint;
  }

  private async query<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = (await response.json()) as GraphQLResponse<T>;

    if (result.errors) {
      throw new Error(`GraphQL errors: ${result.errors.map(e => e.message).join(', ')}`);
    }

    if (!result.data) {
      throw new Error('No data returned from GraphQL query');
    }

    return result.data;
  }

  /**
   * Fetch all data in a single batched GraphQL request to minimize round-trips.
   * Per brief §4.1: "the fetch must batch related queries to minimize round-trips"
   */
  async fetchAll() {
    const query = `
      query FetchAll($lang: LanguageCode) {
        maps(lang: $lang) {
          id
          name
          normalizedName
          raidDuration
          spawns {
            zoneName
            categories
            sides
            position { x y z }
          }
          extracts {
            id
            name
            faction
            position { x y z }
          }
          locks {
            lockType
            key { id name }
            needsPower
            position { x y z }
          }
          switches {
            id
            name
            position { x y z }
          }
          bosses {
            boss { id name }
            spawnChance
            spawnLocations { name chance }
          }
          lootContainers {
            lootContainer { id name normalizedName }
            position { x y z }
          }
        }
        items(lang: $lang) {
          id
          name
          shortName
          types
          width
          height
          properties {
            ... on ItemPropertiesKey {
              uses
            }
          }
          buyFor {
            source
            price
            currency
            requirements { type value }
          }
          sellFor {
            source
            price
            currency
          }
        }
        tasks(lang: $lang) {
          id
          name
          map { id name }
          objectives {
            id
            type
            description
            optional
            maps { id name }
          }
          taskRequirements {
            task { id }
          }
        }
      }
    `;

    const result = await this.query<{
      maps: TarkovDevMapRaw[];
      items: TarkovDevItemRaw[];
      tasks: TarkovDevTaskRaw[];
    }>(query, { lang: 'en' });
    return result;
  }
}

// Raw API response types

export interface TarkovDevMapRaw {
  id: string;
  name: string;
  normalizedName: string;
  raidDuration: number | null;
  spawns: Array<{
    zoneName: string;
    categories: string[];
    sides: string[];
    position: { x: number; y: number; z: number };
  }>;
  extracts: Array<{
    id: string;
    name: string;
    faction: string | null;
    position: { x: number; y: number; z: number } | null;
  }>;
  locks: Array<{
    lockType: string;
    key: { id: string; name: string } | null;
    needsPower: boolean;
    position: { x: number; y: number; z: number } | null;
  }>;
  switches: Array<{
    id: string;
    name: string;
    position: { x: number; y: number; z: number } | null;
  }>;
  bosses: Array<{
    boss: { id: string; name: string };
    spawnChance: number;
    spawnLocations: Array<{
      name: string;
      chance: number;
    }>;
  }>;
  lootContainers: Array<{
    lootContainer: { id: string; name: string; normalizedName: string };
    position: { x: number; y: number; z: number };
  }>;
}

export interface TarkovDevItemRaw {
  id: string;
  name: string;
  shortName: string;
  types: string[];
  width: number;
  height: number;
  properties: {
    uses?: number;
  } | null;
  buyFor: Array<{
    source: string;
    price: number;
    currency: string;
    requirements: Array<{ type: string; value: number }>;
  }>;
  sellFor: Array<{
    source: string;
    price: number;
    currency: string;
  }>;
}

export interface TarkovDevTaskRaw {
  id: string;
  name: string;
  map: { id: string; name: string } | null;
  objectives: Array<{
    id: string;
    type: string;
    description: string;
    optional: boolean;
    maps: Array<{ id: string; name: string }> | null;
  }>;
  taskRequirements: Array<{
    task: { id: string };
  }>;
}