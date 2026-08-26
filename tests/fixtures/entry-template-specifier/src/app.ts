declare const suffix: string;

export const viaTemplate = import(`./Feature/helper.ts`);
export const viaEscape = import(`./Feature/hel\u0070er.ts`);
export const viaSubstitution = import(`./Feature/helper${suffix}`);
