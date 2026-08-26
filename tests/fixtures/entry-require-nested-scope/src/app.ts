export function load(require: (id: string) => unknown): unknown {
  const nested = () => require("./Feature/helper.ts");
  return nested();
}
