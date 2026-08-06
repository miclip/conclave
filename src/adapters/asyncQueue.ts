/**
 * A single-consumer async queue for adapter event streams.
 *
 * Extracted rather than duplicated: both adapters need identical delivery semantics, and
 * this is pure infrastructure with no agent-specific behaviour in it. Everything that
 * genuinely differs between adapters stays in the adapters.
 */
export class AsyncQueue<T> {
  #items: T[] = []
  #waiters: ((v: IteratorResult<T>) => void)[] = []
  #closed = false

  push(item: T): void {
    const w = this.#waiters.shift()
    if (w) w({ value: item, done: false })
    else this.#items.push(item)
  }

  close(): void {
    this.#closed = true
    for (const w of this.#waiters.splice(0)) w({ value: undefined as never, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () =>
        new Promise<IteratorResult<T>>((resolve) => {
          const item = this.#items.shift()
          if (item !== undefined) resolve({ value: item, done: false })
          else if (this.#closed) resolve({ value: undefined as never, done: true })
          else this.#waiters.push(resolve)
        }),
    }
  }
}
