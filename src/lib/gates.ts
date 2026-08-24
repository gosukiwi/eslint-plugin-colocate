import path from "node:path";
import type { Graph } from "./graph.js";

const gatesByGraph = new WeakMap<Graph, Map<string, string>>();

/**
 * Structural on purpose. The ownership model only treats an `index` as an entry
 * when code outside the directory imports through it, because a convenience
 * barrel over loose helpers must not redraw ownership boundaries. Access is the
 * other question: a door is a door the moment it exists, or adding one would
 * gate nothing until every consumer had already migrated to it.
 */
export function isEntryFile(filePath: string): boolean {
  const base = path.basename(filePath, path.extname(filePath));
  return base === "index" || base === path.basename(path.dirname(filePath));
}

/**
 * Every gated directory mapped to the entry that names it. `index` wins when a
 * directory holds both spellings: it is the door that makes the bare directory
 * specifier resolve, so it is the shorter fix to suggest, and picking it is a
 * stable tiebreak rather than a filesystem-order accident.
 */
export function getGates(graph: Graph): Map<string, string> {
  const cached = gatesByGraph.get(graph);
  if (cached !== undefined) {
    return cached;
  }

  const gates = new Map<string, string>();
  for (const file of graph.files) {
    if (!isEntryFile(file)) {
      continue;
    }
    const dir = path.dirname(file);
    const isIndex = path.basename(file, path.extname(file)) === "index";
    if (!gates.has(dir) || isIndex) {
      gates.set(dir, file);
    }
  }

  gatesByGraph.set(graph, gates);
  return gates;
}

function isInsideDir(filePath: string, dir: string): boolean {
  return filePath.startsWith(dir + path.sep);
}

/**
 * The innermost gate containing `target` but not `importer`, or undefined when
 * no boundary separates them.
 *
 * Walking up from the target finds the innermost one directly: a deeper gate
 * always nests inside a shallower one, so an importer inside the deeper gate is
 * inside the shallower one too. The first directory that both gates the target
 * and excludes the importer is therefore the innermost such gate.
 */
export function findCrossedGate(
  target: string,
  importer: string,
  graph: Graph,
  rootDir: string,
): { dir: string; entry: string } | undefined {
  // Checked against the file itself, not against the gate map: a directory with
  // both doors maps only to its index, and `Dir/Dir.ts` is still a legal target.
  if (isEntryFile(target)) {
    return undefined;
  }

  const gates = getGates(graph);
  let dir = path.dirname(target);

  while (true) {
    const entry = gates.get(dir);
    if (entry !== undefined && !isInsideDir(importer, dir)) {
      return { dir, entry };
    }
    if (dir === rootDir) {
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return undefined;
}
