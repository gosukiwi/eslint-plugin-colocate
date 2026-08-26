import { createRequire } from "node:module";
const require = 1;
export function real(): unknown {
  const require = createRequire(import.meta.url);
  return require("./Feature/helper.ts");
}
