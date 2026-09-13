interface DirStamp {
    mtimeMs: number;
    ctimeMs: number;
    size: number;
}
export declare function collectSourceFiles(resolvedRoot: string, ignoreGlobs: string[]): {
    files: string[];
    dirStamps: Map<string, DirStamp>;
};
export {};
