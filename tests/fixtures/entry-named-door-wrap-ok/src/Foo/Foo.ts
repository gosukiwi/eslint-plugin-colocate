import { x } from "./sib";
function wrap(v: typeof x) {
  return v;
}
export const y = wrap(x);
