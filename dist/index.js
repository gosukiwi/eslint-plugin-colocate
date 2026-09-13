import entry from "./rules/entry.js";
import ownership from "./rules/ownership.js";
export default {
    meta: {
        name: "@gosukiwi/eslint-plugin-colocate",
        version: "0.0.2",
    },
    rules: {
        entry,
        ownership,
    },
};
