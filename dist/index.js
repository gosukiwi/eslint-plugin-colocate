import entry from "./rules/entry.js";
import ownership from "./rules/ownership.js";
export default {
    meta: {
        name: "eslint-plugin-colocate",
        version: "0.0.1",
    },
    rules: {
        entry,
        ownership,
    },
};
