import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const x = require("./sib");
export { x };
