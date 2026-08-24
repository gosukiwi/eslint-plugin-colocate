import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export async function loadDynamic() {
  return import("./Feature/helper.js");
}

export const real = require("./Feature/helper.js");
