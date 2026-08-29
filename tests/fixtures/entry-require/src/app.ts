import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
export const real = require("./Feature/helper");

export function shadowed(require: (id: string) => unknown) {
  return require("./Feature/helper");
}
