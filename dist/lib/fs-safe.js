import fs from "node:fs";
// The rule runs inside ESLint's process: an uncaught fs error here aborts the
// user's entire lint run. Every filesystem read goes through these helpers, and
// a missing or unreadable path always degrades to "skip" rather than throwing.
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
