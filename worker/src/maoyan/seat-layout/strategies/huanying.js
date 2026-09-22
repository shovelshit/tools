import { partsOf, positiveInteger } from "../common.js";

export const id = "huanying";
export function seatNumber(seat) {
  return positiveInteger(partsOf(seat?.seatNo)?.[2]);
}
