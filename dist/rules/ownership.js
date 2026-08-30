import { ownershipFindings } from "../lib/findings.js";
import { resolveSubject } from "../lib/subject.js";
const rule = {
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
            privateOutsideOwner: "File is imported by a single owner but sits outside that owner's folder.",
            sharedTooHigh: "File is imported by multiple owners but sits above their common ancestor directory.",
            sharedInsideOwner: "File is imported by multiple owners but sits inside a single owner's folder.",
            singletonFolder: "Directory contains a single source file with no companion CSS; colocate or flatten the file.",
        },
    },
    create(context) {
        const options = (context.options[0] ?? {});
        const layers = options.layers ?? [];
        return {
            Program(node) {
                const subject = resolveSubject(context);
                if (subject === undefined) {
                    return;
                }
                const reportNode = node.body[0] ?? node;
                for (const messageId of ownershipFindings(subject, context.cwd, layers)) {
                    context.report({ node: reportNode, messageId });
                }
            },
        };
    },
};
export default rule;
