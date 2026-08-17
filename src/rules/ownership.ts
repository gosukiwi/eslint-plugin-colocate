import type { Rule } from "eslint";

const rule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description: "Enforce dependency-ownership file layout",
    },
    schema: [
      {
        type: "object",
        properties: {
          root: { type: "string" },
          ignore: { type: "array", items: { type: "string" } },
          layers: { type: "array", items: { type: "string" } },
        },
      },
    ],
    messages: {
      privateOutsideOwner: "",
      sharedTooHigh: "",
      sharedInsideOwner: "",
      singletonFolder: "",
      mismatchedEntry: "",
    },
  },
  create() {
    return {};
  },
};

export default rule;
