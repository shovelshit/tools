import { partsOf, positiveInteger } from "../common.js";

export const id = "wanda";
export function seatNumber(seat) {
  return positiveInteger(partsOf(seat?.seatNo)?.[1]);
}
