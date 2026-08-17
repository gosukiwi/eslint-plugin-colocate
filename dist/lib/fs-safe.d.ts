import fs from "node:fs";
export declare function safeRealpath(filePath: string): string | undefined;
export declare function safeStat(filePath: string): fs.Stats | undefined;
export declare function safeReadFile(filePath: string): string | undefined;
export declare function safeReaddir(dir: string): fs.Dirent[];
