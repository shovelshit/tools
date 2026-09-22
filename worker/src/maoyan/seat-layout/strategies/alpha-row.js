import { positiveInteger } from "../common.js";

export const id = "alpha-row";
export function seatNumber(seat) {
  return positiveInteger(seat?.columnId);
}
