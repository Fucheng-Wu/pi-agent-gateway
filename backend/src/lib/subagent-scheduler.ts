/** One FIFO budget shared by all descendants and agents waiting to resume. */
export class SubagentScheduler {
  private inUse = 0;
  private limit = 3;
  private readonly queue: Array<{ grant: () => void; reject: (error: Error) => void }> = [];
  get active(): number { return this.inUse; }
  setLimit(limit: number): void { this.limit = limit; this.drain(); }

  acquire(limit: number, signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(new Error("子代理任务已取消"));
    this.limit = limit;
    return new Promise((resolve, reject) => {
      const request = {
        grant: () => {
          signal.removeEventListener("abort", abort);
          this.inUse++;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            this.inUse--;
            this.drain();
          });
        },
        reject: (error: Error) => { signal.removeEventListener("abort", abort); reject(error); },
      };
      const abort = () => {
        const index = this.queue.indexOf(request);
        if (index >= 0) this.queue.splice(index, 1);
        request.reject(new Error("子代理任务已取消"));
      };
      signal.addEventListener("abort", abort, { once: true });
      this.queue.push(request);
      this.drain();
    });
  }
  private drain(): void { while (this.inUse < this.limit && this.queue.length) this.queue.shift()!.grant(); }
}
