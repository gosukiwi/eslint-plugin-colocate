import ownership from "./rules/ownership.js";
export default {
    meta: {
        name: "file-ownership-lint",
        version: "0.0.0",
    },
    rules: {
        ownership,
    },
};
