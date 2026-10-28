/** Orders scans and exports. Cancellation also invalidates work already awaiting a digest. */
export class SampleQueue {
  private tail = Promise.resolve();
  private generation = 0;

  enqueue(task: (isCurrent: () => boolean) => void | Promise<void>): Promise<void> {
    const generation = this.generation;
    const isCurrent = () => generation === this.generation;
    const next = this.tail.then(async () => { if (isCurrent()) await task(isCurrent); });
    // One failed operation must not prevent later scans or exports.
    this.tail = next.catch(() => {});
    return next;
  }

  cancel() { this.generation++; }
}
