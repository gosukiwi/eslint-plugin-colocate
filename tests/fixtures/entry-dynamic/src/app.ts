import lazy = require("./Feature/viaEquals");

export async function load() {
  return import("./Feature/helper");
}

export const eq = lazy;
