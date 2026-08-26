import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
export const real = require("./Feature/helper");

export function shadowed(require: (id: string) => unknown) {
  // Not the CJS require, so not an edge and not a boundary crossing.
  return require("./Feature/helper");
}
