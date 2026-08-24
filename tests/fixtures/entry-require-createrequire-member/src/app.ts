import * as mod from "node:module";

const require = mod.createRequire(import.meta.url);

export const real = require("./Feature/helper");
