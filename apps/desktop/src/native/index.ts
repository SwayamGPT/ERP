/**
 * The bridge to the desktop shell (Tauri, src-tauri/). Everything here is optional: in a browser or
 * on a phone `isNative()` is false and the app uses the browser's print dialog and IndexedDB.
 */
export const isNative = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

async function invoke<T>(cmd: string, args?: unknown, headers?: Record<string, string>): Promise<T> {
  const { invoke: inv } = await import('@tauri-apps/api/core');
  return inv<T>(cmd, args as never, headers ? { headers } : undefined);
}

const localDate = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const native = {
  /** Database files on disk (atomic save, previous copy, 7 daily backups). */
  storeRead: async (key: string): Promise<Uint8Array | null> => {
    const b = new Uint8Array(await invoke<ArrayBuffer>('store_read', { key }));
    return b.length ? b : null;
  },
  storeWrite: (key: string, bytes: Uint8Array) => invoke<void>('store_write', bytes, { 'x-key': key, 'x-today': localDate() }),
  storeDelete: (key: string) => invoke<void>('store_delete', { key }),
  storeInfo: (key: string) => invoke<[string, string[]]>('store_info', { key }),
  /** Raw bytes to a receipt / label printer: "192.168.1.50:9100" or an installed printer's name. */
  printRaw: (target: string, bytes: Uint8Array) => invoke<void>('print_raw', bytes, { 'x-target': target }),
  printers: () => invoke<string[]>('printers_list'),
  serialPorts: () => invoke<string[]>('serial_ports'),
  /** Try every serial port at the usual speeds (takes up to a minute). */
  scaleFind: () => invoke<{ port: string; baud: number; request: string | null; kg: number } | null>('scale_find'),
  /** The last 50 printer / scale calls, newest first. */
  hwEvents: () => invoke<Array<{ at: number; device: string; ok: boolean; detail: string; ms: number }>>('hw_events'),
  scaleRead: (port: string, baud: number, request?: string) => invoke<{ kg: number; stable: boolean }>('scale_read', { port, baud, request: request || null }),
};
