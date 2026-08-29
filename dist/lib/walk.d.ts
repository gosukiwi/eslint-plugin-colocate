export declare function collectSourceFiles(resolvedRoot: string, ignoreGlobs: string[]): {
    files: string[];
    dirStamps: Map<string, {
        mtimeMs: number;
        ctimeMs: number;
        size: number;
    }>;
};
