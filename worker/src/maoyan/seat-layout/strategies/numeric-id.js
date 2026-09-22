import { positiveInteger } from "../common.js";

export const id = "numeric-id";
export function seatNumber(seat) {
  return positiveInteger(seat?.columnId);
}
