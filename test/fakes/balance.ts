import type { BalanceSource } from "../../src/ports.ts";

export class FakeBalance implements BalanceSource {
  amount = 100;
  fetchCount = 0;
  #failNext = 0;

  failNextFetches(count = 1): void {
    this.#failNext += count;
  }

  async fetchBalance(): Promise<number> {
    this.fetchCount++;
    if (this.#failNext > 0) {
      this.#failNext--;
      throw new Error("잔액 API가 응답하지 않는다");
    }
    return this.amount;
  }
}
