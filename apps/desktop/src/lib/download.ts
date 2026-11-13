export function downloadBlob(data: BlobPart, filename: string, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
export const downloadJson = (obj: unknown, filename: string) => downloadBlob(JSON.stringify(obj, null, 2), filename, 'application/json');
export const downloadCsv = (csv: string, filename: string) => downloadBlob(csv, filename, 'text/csv;charset=utf-8');
