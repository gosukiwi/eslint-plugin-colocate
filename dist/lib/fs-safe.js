import fs from "node:fs";
export function safeRealpath(filePath) {
    try {
        return fs.realpathSync(filePath);
    }
    catch {
        return undefined;
    }
}
export function safeStat(filePath) {
    try {
        return fs.statSync(filePath);
    }
    catch {
        return undefined;
    }
}
export function safeReadFile(filePath) {
    try {
        return fs.readFileSync(filePath, "utf8");
    }
    catch {
        return undefined;
    }
}
export function safeReaddir(dir) {
    try {
        return fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return [];
    }
}
