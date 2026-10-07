/**
 * Folder clusters for big repos.
 *
 * No React, no three.js and no value imports from the rest of the app, so Node can
 * unit-test it directly.
 */

/** The bits of a positioned node that clustering needs. */
export interface ClusterInput {
  index: number;
  path: string;
  importance: number;
  x: number;
  y: number;
  z: number;
}

export interface Cluster {
  /** Folder path, or `folder/+N` for an overflow group of folders. */
  id: string;
  /** Text shown on the map. */
  label: string;
  /** The folder this cluster stands for. Overflow groups use their parent folder. */
  folder: string;
  /** Node indices of its files. */
  members: number[];
  /** How many folders an overflow group merged. 0 for a normal cluster. */
  folded: number;
  /** Importance of its top file. This colours the bubble. */
  importance: number;
  /** Centre of its files' positions in the layout. */
  x: number;
  y: number;
  z: number;
  /** How far its files spread from the centre (90th percentile), for framing. */
  spread: number;
}

export interface ClusterEdge {
  from: number;
  to: number;
  /** How many file imports go between the two clusters. */
  weight: number;
}

export interface Clustering {
  clusters: Cluster[];
  edges: ClusterEdge[];
  /** Node index -> cluster index. */
  clusterOf: Int32Array;
}

export interface ClusterOptions {
  /** Stop splitting once we have this many clusters. */
  target?: number;
  /** Hard cap. Anything over it gets folded into overflow groups. */
  max?: number;
}

/** Folder of a path, "" for files at the root. */
function folderOf(filePath: string): string {
  const slash = filePath.lastIndexOf("/");
  return slash === -1 ? "" : filePath.slice(0, slash);
}

/**
 * Group files by folder, going finer where it matters.
 *
 * We start with one group holding everything and keep splitting the biggest group into
 * its subfolders until there are about `target` groups. Files sitting directly in a
 * folder get their own group next to its subfolders. If a split would go past `max` (like
 * `homeassistant/components` with its 1,500 integrations), the biggest subfolders that
 * fit become groups and the rest get folded into one overflow group, so the map never has
 * more bubbles than you can read.
 */
export function clusterByFolder(nodes: ClusterInput[], options: ClusterOptions = {}): Map<string, number[]> {
  const target = options.target ?? 40;
  const max = Math.max(target, options.max ?? 80);

  interface Group {
    prefix: string;
    members: ClusterInput[];
    splittable: boolean;
    folded: number;
  }

  /** Sub-groups: one per next path segment, plus the folder's own files. */
  const childrenOf = (group: Group): Map<string, ClusterInput[]> => {
    const children = new Map<string, ClusterInput[]>();
    for (const node of group.members) {
      const folder = folderOf(node.path);
      const rest = group.prefix === "" ? folder : folder.slice(group.prefix.length + 1);
      const segment = rest === "" ? "" : rest.split("/")[0]!;
      const key = segment === "" ? group.prefix : group.prefix === "" ? segment : `${group.prefix}/${segment}`;
      const list = children.get(key);
      if (list) list.push(node);
      else children.set(key, [node]);
    }
    return children;
  };

  let groups: Group[] = [{ prefix: "", members: nodes, splittable: true, folded: 0 }];
  const result = new Map<string, number[]>();

  // Even past the target, keep splitting a group while it has way more than its fair
  // share of files, so one giant folder doesn't end up as a single bubble next to lots of
  // tiny ones.
  const oversized = (2 * nodes.length) / target;

  for (;;) {
    // Biggest group that can still split. A group whose files all sit directly in one
    // folder can't go any finer.
    const candidates = groups
      .filter((g) => g.splittable)
      .sort((a, b) => b.members.length - a.members.length);
    const largest = candidates[0];
    if (!largest) break;
    if (groups.length >= target && (groups.length >= max || largest.members.length <= oversized)) break;

    const children = childrenOf(largest);
    if (children.size <= 1) {
      // Only one way down, so go down without using up a group.
      const [onlyKey, onlyMembers] = [...children.entries()][0] ?? ["", []];
      if (onlyKey === largest.prefix) largest.splittable = false;
      else {
        largest.prefix = onlyKey;
        largest.members = onlyMembers;
      }
      continue;
    }

    const rest = groups.filter((g) => g !== largest);
    const room = max - rest.length;

    const ordered = [...children.entries()].sort((a, b) => b[1].length - a[1].length);

    if (ordered.length <= room) {
      groups = [
        ...rest,
        ...ordered.map(([prefix, members]) => ({
          prefix,
          members,
          // A folder's own direct files can't be split further.
          splittable: prefix !== largest.prefix,
          folded: 0,
        })),
      ];
      continue;
    }

    // Too many subfolders: keep the biggest few, fold the rest into one group that never
    // splits, and move on to the other groups. Each folder gets a share of the target
    // based on its size, so one huge folder can't use up the whole budget and leave an
    // equally big neighbour (tests/ next to components/) unsplit.
    const share = largest.members.length / nodes.length;
    const kept = ordered.slice(0, Math.max(1, Math.min(room - 1, Math.floor((target - 1) * share))));
    const overflow = ordered.slice(kept.length);
    groups = [
      ...rest,
      ...kept.map(([prefix, members]) => ({ prefix, members, splittable: prefix !== largest.prefix, folded: 0 })),
      {
        prefix: `${largest.prefix}/+${overflow.length}`,
        members: overflow.flatMap(([, members]) => members),
        splittable: false,
        folded: overflow.length,
      },
    ];
  }

  for (const group of groups) {
    result.set(group.prefix, group.members.map((m) => m.index));
  }
  return result;
}

/** Build clusters with positions, colours and the imports between them. */
export function buildClustering(
  nodes: ClusterInput[],
  edges: Array<{ from: number; to: number }>,
  options: ClusterOptions = {},
): Clustering {
  const byIndex = new Map(nodes.map((n) => [n.index, n]));
  const groups = clusterByFolder(nodes, options);
  const clusterOf = new Int32Array(nodes.length === 0 ? 0 : Math.max(...nodes.map((n) => n.index)) + 1).fill(-1);

  const clusters: Cluster[] = [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([id, members], position) => {
      const folded = /\/\+(\d+)$/.exec(id);
      const folder = folded ? id.slice(0, folded.index) : id;
      const name = folder === "" ? "(root)" : folder.split("/").pop()!;
      const files = members.map((i) => byIndex.get(i)!);
      for (const i of members) clusterOf[i] = position;
      const x = files.reduce((s, f) => s + f.x, 0) / files.length;
      const y = files.reduce((s, f) => s + f.y, 0) / files.length;
      const z = files.reduce((s, f) => s + f.z, 0) / files.length;
      const distances = files.map((f) => Math.hypot(f.x - x, f.y - y, f.z - z)).sort((a, b) => a - b);
      return {
        id,
        label: folded ? `${name}/ +${folded[1]} more` : `${name}/`,
        folder,
        members,
        folded: folded ? Number(folded[1]) : 0,
        importance: Math.max(...files.map((f) => f.importance)),
        x,
        y,
        z,
        spread: distances[Math.min(distances.length - 1, Math.floor(distances.length * 0.9))] ?? 0,
      };
    });

  // Folders with the same name (packages/core/src, packages/web/src) would give identical
  // bubbles, so clashing labels get their parent folder added, or the full path if that
  // still clashes.
  const baseName = (folder: string, depth: number) =>
    folder === "" ? "(root)" : folder.split("/").slice(-depth).join("/");
  for (const depth of [1, 2]) {
    const counts = new Map<string, number>();
    const nameOf = (c: Cluster) => baseName(c.folder, depth);
    for (const c of clusters) counts.set(nameOf(c), (counts.get(nameOf(c)) ?? 0) + 1);
    for (const c of clusters) {
      const clash = (counts.get(nameOf(c)) ?? 0) > 1;
      const name = clash ? (depth === 1 ? baseName(c.folder, 2) : c.folder || "(root)") : nameOf(c);
      if (depth === 1 || clash) c.label = c.folded ? `${name}/ +${c.folded} more` : `${name}/`;
    }
    if (![...counts.values()].some((n) => n > 1)) break;
  }

  const weights = new Map<string, ClusterEdge>();
  for (const edge of edges) {
    const from = clusterOf[edge.from] ?? -1;
    const to = clusterOf[edge.to] ?? -1;
    if (from < 0 || to < 0 || from === to) continue;
    const key = `${from}>${to}`;
    const existing = weights.get(key);
    if (existing) existing.weight++;
    else weights.set(key, { from, to, weight: 1 });
  }

  return { clusters, edges: [...weights.values()], clusterOf };
}
