/** Kept separate from api.ts so the UI bundle doesn't pull in the repositories. */
const READ = /\.(status|list|get|search|categories|nextPlu|batches|preview|ledger|dashboard|register|itemProfit|billProfit|stock|expiry|daybook|cashbook|outstanding|health|summary|eway)$/;
export const isMutation = (m: string) => !READ.test(m) && !m.startsWith('reports.') && m !== 'hsn.search';
