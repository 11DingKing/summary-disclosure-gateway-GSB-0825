/**
 * In-process async mutex. Publishes are serialized so the optimistic
 * concurrency check (expectedRevision) + revision bump is atomic even
 * under concurrent requests against the same SQLite file.
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
