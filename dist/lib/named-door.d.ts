import { type Graph } from "./graph.js";
export declare function isNamedDoor(filePath: string): boolean;
export declare function namedDoorReexports(filePath: string, graph: Graph, content?: string): readonly {
    target: string;
    pos: number;
}[];
