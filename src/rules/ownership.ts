import type { Rule } from "eslint";
import { ownershipFindings } from "../lib/findings.js";
import { resolveSubject } from "../lib/subject.js";

// `root` and `ignore` are options here too, but resolveSubject is what reads
// them - see the schema below, which is still the whole contract.
interface RuleOptions {
  layers?: string[];
}

const rule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description: "Enforce dependency-ownership file layout",
      url: "https://github.com/gosukiwi/eslint-plugin-colocate#what-it-reports",
    },
    schema: [
      {
        type: "object",
        properties: {
          root: { type: "string" },
          ignore: { type: "array", items: { type: "string" } },
          layers: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      privateOutsideOwner:
        "File is imported by a single owner but sits outside that owner's folder.",
      sharedTooHigh:
        "File is imported by multiple owners but sits above their common ancestor directory.",
      sharedInsideOwner:
        "File is imported by multiple owners but sits inside a single owner's folder.",
      singletonFolder:
        "Directory contains a single source file with no companion CSS; colocate or flatten the file.",
      mismatchedEntry:
        "Index re-exports a single local module but outside imports use this barrel instead of the named entry file.",
    },
  },
  create(context) {
    const options = (context.options[0] ?? {}) as RuleOptions;
    const layers = options.layers ?? [];

    return {
      Program(node) {
        // Resolved here rather than in create() for the same reason it always
        // was: a configured root that does not exist, or a linted path that is
        // not on disk (processors, --stdin-filename, a file deleted mid-run),
        // means "nothing to say" rather than a crash.
        const subject = resolveSubject(context);
        if (subject === undefined) {
          return;
        }

        // Report on the first statement so eslint-disable comments still apply under ESLint 10.
        const reportNode = node.body[0] ?? node;
        for (const messageId of ownershipFindings(
          subject,
          context.cwd,
          layers,
        )) {
          context.report({ node: reportNode, messageId });
        }
      },
    };
  },
};

export default rule;
