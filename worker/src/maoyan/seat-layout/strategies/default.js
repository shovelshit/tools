import { positiveInteger } from "../common.js";

export const id = "default";
export function seatNumber(seat) {
  return positiveInteger(seat?.columnId);
}
