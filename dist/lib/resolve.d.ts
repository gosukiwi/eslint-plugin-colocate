import ts from "typescript";
export interface ResolutionSettings {
    options: ts.CompilerOptions;
    cache: ts.ModuleResolutionCache;
    configPaths: string[];
}
export declare function findTsconfig(rootDir: string): string | undefined;
export declare function createResolutionSettings(rootDir: string): ResolutionSettings;
export declare function resolveSpecifier(specifier: string, fromDir: string, settings?: ResolutionSettings): string | undefined;
