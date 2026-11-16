import { create } from 'zustand';
import { native } from './index';

/**
 * Receipts on their way to the printer. A sale is saved first and printed after: if the printer
 * is off, out of paper or busy, the job waits here (and survives a restart) instead of the bill
 * screen showing an error mid-sale. A banner offers "Retry" once the printer is back.
 */
export interface PrintJob {
  id: string;
  target: string;
  label: string;
  /** base64 of the raw bytes */
  data: string;
  at: number;
  tries: number;
  state: 'sending' | 'failed';
  error?: string;
}

const KEY = 'hisaab.printq';
const MAX_KEPT = 20;

const toB64 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function loadJobs(): PrintJob[] {
  try {
    return (JSON.parse(localStorage.getItem(KEY) ?? '[]') as PrintJob[]).map((j) => ({ ...j, state: 'failed' as const }));
  } catch {
    return [];
  }
}
function saveJobs(jobs: PrintJob[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(jobs.filter((j) => j.state === 'failed')));
  } catch {
    /* private mode / no storage */
  }
}

/** Where bytes go; tests swap in a fake printer. */
export const printTransport = { send: (target: string, bytes: Uint8Array) => native.printRaw(target, bytes) };

interface QueueState {
  jobs: PrintJob[];
  /** Print now; on failure keep the job for a retry. Resolves to the error message, or null when printed. */
  submit: (target: string, bytes: Uint8Array, label: string) => Promise<string | null>;
  retry: (id: string) => Promise<string | null>;
  retryAll: () => Promise<void>;
  discard: (id: string) => void;
  discardAll: () => void;
}

let seq = 0;

export const usePrintQueue = create<QueueState>((set, get) => {
  const update = (id: string, patch: Partial<PrintJob> | null) => {
    const jobs = patch === null ? get().jobs.filter((j) => j.id !== id) : get().jobs.map((j) => (j.id === id ? { ...j, ...patch } : j));
    set({ jobs });
    saveJobs(jobs);
  };
  const attempt = async (job: PrintJob): Promise<string | null> => {
    update(job.id, { state: 'sending', tries: job.tries + 1 });
    try {
      await printTransport.send(job.target, fromB64(job.data));
      update(job.id, null);
      return null;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      update(job.id, { state: 'failed', error });
      return error;
    }
  };
  return {
    jobs: loadJobs(),
    submit: async (target, bytes, label) => {
      const job: PrintJob = { id: `${Date.now()}-${++seq}`, target, label, data: toB64(bytes), at: Date.now(), tries: 0, state: 'sending' };
      const jobs = [...get().jobs, job].slice(-MAX_KEPT);
      set({ jobs });
      return attempt(job);
    },
    retry: async (id) => {
      const job = get().jobs.find((j) => j.id === id);
      return job && job.state !== 'sending' ? attempt(job) : null;
    },
    retryAll: async () => {
      // Oldest first, one at a time: receipt printers take one job at a time.
      for (const j of get().jobs.filter((x) => x.state === 'failed')) await attempt(j);
    },
    discard: (id) => update(id, null),
    discardAll: () => {
      set({ jobs: [] });
      saveJobs([]);
    },
  };
});

/** Send to the printer through the queue; throws (keeping the job) if it could not print. */
export async function printQueued(target: string, bytes: Uint8Array, label: string) {
  const err = await usePrintQueue.getState().submit(target, bytes, label);
  if (err) throw new Error(err);
}
