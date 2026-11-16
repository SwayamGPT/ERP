import { beforeEach, describe, expect, it } from 'vitest';
import { printQueued, printTransport, usePrintQueue } from '../src/native/printQueue';

describe('print queue', () => {
  let printed: Uint8Array[];
  let online: boolean;
  beforeEach(() => {
    printed = [];
    online = true;
    usePrintQueue.getState().discardAll();
    printTransport.send = async (_t, b) => {
      if (!online) throw new Error('Cannot reach the printer at 192.168.1.50:9100');
      printed.push(b);
    };
  });

  it('prints straight away when the printer is fine', async () => {
    expect(await usePrintQueue.getState().submit('p', new Uint8Array([1, 2, 3]), 'Bill 1')).toBeNull();
    expect(printed).toEqual([new Uint8Array([1, 2, 3])]);
    expect(usePrintQueue.getState().jobs).toHaveLength(0);
  });

  it('keeps receipts while the printer is off and sends them in order once it is back', async () => {
    online = false;
    expect(await usePrintQueue.getState().submit('p', new Uint8Array([1]), 'Bill 1')).toContain('Cannot reach');
    await expect(printQueued('p', new Uint8Array([2]), 'Bill 2')).rejects.toThrow('Cannot reach');
    const jobs = usePrintQueue.getState().jobs;
    expect(jobs.map((j) => [j.label, j.state])).toEqual([['Bill 1', 'failed'], ['Bill 2', 'failed']]);

    online = true;
    await usePrintQueue.getState().retryAll();
    expect(printed.map((b) => b[0])).toEqual([1, 2]);
    expect(usePrintQueue.getState().jobs).toHaveLength(0);
  });

  it('can drop waiting jobs', async () => {
    online = false;
    await usePrintQueue.getState().submit('p', new Uint8Array(70_000).fill(7), 'Big');
    expect(usePrintQueue.getState().jobs).toHaveLength(1);
    online = true;
    await usePrintQueue.getState().retryAll();
    expect(printed[0].length).toBe(70_000);
    online = false;
    await usePrintQueue.getState().submit('p', new Uint8Array([9]), 'X');
    usePrintQueue.getState().discardAll();
    expect(usePrintQueue.getState().jobs).toHaveLength(0);
  });
});
