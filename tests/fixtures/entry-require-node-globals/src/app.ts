// No local `require` binding at all - this exercises the truly ambient
// global case (Node's CJS globals, `globals: globals.node`, etc.), where
// `require` resolves to a scope variable with `defs: []` and must not be
// treated as shadowed.
export const real = require("./Feature/helper");
