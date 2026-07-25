// Run async work over a list with a bounded number in flight.
//
// The agents were processing jobs strictly one at a time, so a 328-job run
// took about 40 minutes at ~8s per model call — almost all of it spent waiting
// on the network rather than doing anything. Running a handful concurrently
// cuts that to a few minutes.
//
// Bounded, not unbounded: firing 328 requests at once would hit NVIDIA's rate
// limit and turn a slow run into a failed one. A small pool keeps throughput
// high while staying well inside the limit.

/**
 * @param {Array} items
 * @param {number} concurrency  How many to have in flight at once.
 * @param {(item, index) => Promise} worker
 * @param {(done: number, total: number) => void} [onProgress]
 * @returns {Promise<Array<{status:'ok'|'error', value?:any, error?:Error, item:any}>>}
 *          Results in the same order as `items`. Never rejects — a failed item
 *          is reported, so one bad row can't abandon the rest of the run.
 */
async function mapPool(items, concurrency, worker, onProgress) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;

  async function runner() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;

      try {
        results[index] = { status: 'ok', value: await worker(items[index], index), item: items[index] };
      } catch (error) {
        results[index] = { status: 'error', error, item: items[index] };
      }

      done++;
      if (onProgress) onProgress(done, items.length);
    }
  }

  const size = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: size }, runner));
  return results;
}

module.exports = { mapPool };
