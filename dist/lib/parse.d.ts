import ts from "typescript";
export declare function parseSourceFile(fileName: string, content: string): ts.SourceFile;
export declare function extractSpecifiers(content: string, fileName: string): string[];
