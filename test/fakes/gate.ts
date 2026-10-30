/** 각본이 io 도중에 멈춰 있게 한다. 그사이 테스트가 시간을 흘리거나 메시지를 넣고 `open`으로 풀어 준다. */
export class Gate {
  readonly #opened: Promise<void>;
  #open = () => {};

  constructor() {
    this.#opened = new Promise((resolve) => (this.#open = resolve));
  }

  wait(): Promise<void> {
    return this.#opened;
  }

  open(): void {
    this.#open();
  }
}
