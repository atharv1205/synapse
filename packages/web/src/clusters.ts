/**
 * Folder clusters for large repositories.
 *
 * Deliberately free of React and three.js, and of value imports from the rest of the app,
 * so it can be unit-tested with Node directly.
 */

/** The slice of a positioned node clustering needs. */
export interface ClusterInput {
  index: number;
  path: string;
  importance: number;
  x: number;
  y: number;
  z: number;
}

export interface Cluster {
  /** The folder path, or `folder/+N` for an overflow group of folders. */
  id: string;
  /** What to show on the map. */
  label: string;
  /** The folder the cluster stands for. Overflow groups name their parent folder. */
  folder: string;
  /** Node indices of its files. */
  members: number[];
  /** How many folders an overflow group folded together; 0 for an ordinary cluster. */
  folded: number;
  /** Importance of its most important file, which colours the bubble. */
  importance: number;
  /** Centroid of its files' positions in the layout. */
  x: number;
  y: number;
  z: number;
  /** How far its files spread from the centroid (90th percentile), for framing it. */
  spread: number;
}

export interface ClusterEdge {
  from: number;
  to: number;
  /** How many file-level imports run between the two clusters. */
  weight: number;
}

export interface Clustering {
  clusters: Cluster[];
  edges: ClusterEdge[];
  /** For each node index, the index of its cluster. */
  clusterOf: Int32Array;
}

export interface ClusterOptions {
  /** Stop splitting once there are this many clusters. */
  target?: number;
  /** Never more than this many; the excess folds into overflow groups. */
  max?: number;
}

/** Folder of a path, "" for files at the root. */
function folderOf(filePath: string): string {
  const slash = filePath.lastIndexOf("/");
  return slash === -1 ? "" : filePath.slice(0, slash);
}

/**
 * Groups files by folder, finest where it matters.
 *
 * Starting from one group of everything, it repeatedly splits the largest group into its
 * immediate subfolders until there are about `target` groups. Files sitting directly in
 * a folder form their own group beside its subfolders. When a split would pass `max`
 * groups, as `homeassistant/components` with its 1,500 integrations would, the largest
 * subfolders that fit become groups and the rest fold into one overflow group, so the
 * map never shows more bubbles than can be read.
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

  /** Sub-groups of a group: one per next path segment, plus its own direct files. */
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

  // Past the target, a group still splits while it holds far more than its fair share of
  // files, so one giant folder does not end up as a single bubble beside many tiny ones.
  const oversized = (2 * nodes.length) / target;

  for (;;) {
    // The largest group that can still split. A group whose files all sit directly in
    // one folder has nowhere finer to go.
    const candidates = groups
      .filter((g) => g.splittable)
      .sort((a, b) => b.members.length - a.members.length);
    const largest = candidates[0];
    if (!largest) break;
    if (groups.length >= target && (groups.length >= max || largest.members.length <= oversized)) break;

    const children = childrenOf(largest);
    if (children.size <= 1) {
      // Only one way down: descend without spending a group on it.
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
          // A folder's own direct files cannot split further.
          splittable: prefix !== largest.prefix,
          folded: 0,
        })),
      ];
      continue;
    }

    // Too many subfolders: keep the largest few, fold the rest into one group that never
    // splits, and carry on with the other groups. The folder gets a share of the target
    // in proportion to its files, so one huge folder cannot spend the whole budget
    // and leave its equally large neighbours (tests/ beside components/) unsplit.
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

/** Builds clusters with positions, colours and the imports between them. */
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

  // Folders with the same name (packages/core/src, packages/web/src) would make
  // identical bubbles, so clashing labels take their parent folder, and the full path if
  // even that clashes.
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
