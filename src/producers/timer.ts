import type { HarnessContext } from "../worker/context.ts";

export function fireDueReservations(ctx: HarnessContext): void {
  ctx.reservations.fireDue(ctx.clock.now());
}
