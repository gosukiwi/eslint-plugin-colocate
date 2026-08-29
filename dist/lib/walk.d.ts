export declare function collectSourceFiles(resolvedRoot: string, ignoreGlobs: string[]): {
    files: string[];
    dirs: string[];
    dirStamps: Map<string, {
        mtimeMs: number;
        ctimeMs: number;
        size: number;
    }>;
};
