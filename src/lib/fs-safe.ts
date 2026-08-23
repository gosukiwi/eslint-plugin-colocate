import fs from "node:fs";

// The rule runs inside ESLint's process: an uncaught fs error here aborts the
// user's entire lint run. Every filesystem read goes through these helpers, and
// a missing or unreadable path always degrades to "skip" rather than throwing.

export function safeRealpath(filePath: string): string | undefined {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return undefined;
  }
}

export function safeStat(filePath: string): fs.Stats | undefined {
  try {
    return fs.statSync(filePath);
  } catch {
    return undefined;
  }
}

export function safeReadFile(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

export function safeReaddir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
