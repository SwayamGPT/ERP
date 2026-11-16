import { amountInWords } from '@hisaab/core';
import type { Company } from '../../db/types';
import type { StaffReceipt } from '../../db/repos/staff';
import { fmtDate, inr } from '../../lib/format';

const MODE: Record<string, string> = { cash: 'Cash', upi: 'UPI', bank: 'Bank transfer', card: 'Card', cheque: 'Cheque' };
const monthName = (p: string) => new Date(`${p}-01T00:00:00`).toLocaleString('en-IN', { month: 'long', year: 'numeric' });

/**
 * A receipt for money handed to a staff member, printed twice on one A4 sheet: the employee keeps
 * one, the shop keeps the other signed. Salary / bonus payments (full or part) and money taken
 * before payday.
 */
export function StaffReceiptSheet({ r, company }: { r: StaffReceipt; company: Company }) {
  return (
    <div style={{ fontFamily: 'Inter, system-ui, sans-serif', color: '#000', fontSize: 10.5, lineHeight: 1.25 }}>
      <Copy r={r} company={company} who="Employee copy" />
      <div style={{ borderTop: '1px dashed #000', margin: '4mm 0', position: 'relative' }}>
        <span style={{ position: 'absolute', top: -8, left: '50%', transform: 'translateX(-50%)', background: '#fff', padding: '0 6px', fontSize: 9 }}>✂ cut here</span>
      </div>
      <Copy r={r} company={company} who="Shop copy" />
    </div>
  );
}

const th: React.CSSProperties = { textAlign: 'left', borderBottom: '1px solid #000', padding: '2px 4px', fontWeight: 600 };
const td: React.CSSProperties = { padding: '1.5px 4px', borderBottom: '1px solid #ddd' };
const right: React.CSSProperties = { textAlign: 'right' };

function Copy({ r, company, who }: { r: StaffReceipt; company: Company; who: string }) {
  const salary = r.type === 'salary';
  const amount = salary ? r.paidNow : r.amount;
  const title = salary ? (r.balance > 0 ? 'SALARY RECEIPT — PART PAYMENT' : 'SALARY RECEIPT — PAID IN FULL') : r.type === 'advance' ? 'RECEIPT — MONEY TAKEN BEFORE PAYDAY' : 'RECEIPT — ADVANCE PAID BACK';
  return (
    <div style={{ border: '1px solid #000', padding: '4mm', position: 'relative', breakInside: 'avoid' }} data-testid="staff-receipt">
      {r.cancelled && <div style={{ position: 'absolute', top: '40%', left: 0, right: 0, textAlign: 'center', fontSize: 40, fontWeight: 700, opacity: 0.15, transform: 'rotate(-12deg)' }}>CANCELLED</div>}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{company.name}</div>
          <div style={{ fontSize: 10 }}>{[company.address, company.city].filter(Boolean).join(', ')}{company.phone ? ` · ${company.phone}` : ''}</div>
        </div>
        <div style={{ textAlign: 'right', fontSize: 10 }}>
          <div style={{ fontWeight: 600 }}>{who}</div>
          <div>No. {r.number}</div>
          <div>Date {fmtDate(r.date)}</div>
        </div>
      </div>
      <div style={{ textAlign: 'center', fontWeight: 700, margin: '2mm 0 1.5mm', letterSpacing: 0.5 }}>{title}</div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '2mm' }}>
        <div>Paid to: <b>{r.employee.name}</b>{r.employee.designation ? ` (${r.employee.designation})` : ''}{r.employee.phone ? ` · ${r.employee.phone}` : ''}</div>
        {salary && r.period && <div>For: <b>{monthName(r.period)}</b></div>}
      </div>

      {salary ? (
        <>
          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '2mm' }}>
            <tbody>
              {r.working ? (
                <>
                  <tr><td style={td}>Monthly salary</td><td style={{ ...td, ...right }}>{inr(r.working.monthly)}</td></tr>
                  {r.working.paidDays !== r.working.daysInMonth && <tr><td style={td}>Days worked</td><td style={{ ...td, ...right }}>{r.working.paidDays} of {r.working.daysInMonth}</td></tr>}
                  {r.working.incentive > 0 && <tr><td style={td}>Incentive</td><td style={{ ...td, ...right }}>+ {inr(r.working.incentive)}</td></tr>}
                  {r.working.bonus > 0 && <tr><td style={td}>Bonus</td><td style={{ ...td, ...right }}>+ {inr(r.working.bonus)}</td></tr>}
                  {r.working.deduction > 0 && <tr><td style={td}>Deduction</td><td style={{ ...td, ...right }}>− {inr(r.working.deduction)}</td></tr>}
                </>
              ) : (
                <tr><td style={td}>{r.title}</td><td style={td} /></tr>
              )}
              <tr><td style={{ ...td, fontWeight: 700 }}>Total payable</td><td style={{ ...td, ...right, fontWeight: 700 }}>{inr(r.billAmount)}</td></tr>
            </tbody>
          </table>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>Date</th><th style={th}>Payments</th><th style={th}>How</th><th style={{ ...th, ...right }}>Amount</th></tr></thead>
            <tbody>
              {r.history.map((h, i) => (
                <tr key={i} style={h.current ? { fontWeight: 700 } : undefined}>
                  <td style={td}>{fmtDate(h.date)}</td>
                  <td style={td}>{h.label}{h.current ? ' (this receipt)' : ''}</td>
                  <td style={td}>{h.mode ? MODE[h.mode] ?? h.mode : '—'}</td>
                  <td style={{ ...td, ...right }}>{inr(h.amount)}</td>
                </tr>
              ))}
              <tr><td style={td} colSpan={3}>Paid so far</td><td style={{ ...td, ...right, fontWeight: 600 }}>{inr(r.paidToDate)}</td></tr>
              <tr><td style={{ ...td, fontWeight: 700 }} colSpan={3}>{r.balance > 0 ? 'Balance still due to the employee' : 'Balance due'}</td><td style={{ ...td, ...right, fontWeight: 700 }} data-testid="receipt-balance">{inr(r.balance)}</td></tr>
            </tbody>
          </table>
        </>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <tbody>
            <tr><td style={td}>{r.type === 'advance' ? 'Amount taken' : 'Amount paid back'}{r.note ? ` — ${r.note}` : ''}</td><td style={{ ...td, ...right, fontWeight: 700 }}>{inr(r.amount)}</td></tr>
            <tr><td style={td}>Paid by</td><td style={{ ...td, ...right }}>{r.mode ? MODE[r.mode] ?? r.mode : '—'}</td></tr>
          </tbody>
        </table>
      )}

      {r.takenInMonth.length > 0 && (
        <div style={{ marginTop: '2mm' }}>
          <div style={{ fontWeight: 600, marginBottom: 1 }}>Money taken before payday in {monthName((salary && r.period) || r.date.slice(0, 7))}</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }} data-testid="receipt-taken">
            <tbody>
              {r.takenInMonth.map((t, i) => (
                <tr key={i} style={t.current ? { fontWeight: 700 } : undefined}>
                  <td style={td}>{fmtDate(t.date)}</td><td style={td}>{t.label}</td><td style={td}>{t.mode ? MODE[t.mode] ?? t.mode : ''}</td><td style={{ ...td, ...right }}>{inr(t.amount)}</td>
                </tr>
              ))}
              <tr><td style={td} colSpan={3}>Total taken this month</td><td style={{ ...td, ...right, fontWeight: 600 }}>{inr(r.takenInMonth.reduce((s, t) => s + t.amount, 0))}</td></tr>
            </tbody>
          </table>
        </div>
      )}
      <div style={{ marginTop: '2mm', display: 'flex', justifyContent: 'space-between' }}>
        <span>Advance still to be adjusted: <b>{inr(r.advanceOutstanding)}</b></span>
      </div>
      <div style={{ marginTop: '2mm' }}>
        Received {salary && r.adjustedNow > 0 ? <>in hand <b>{inr(amount)}</b> and <b>{inr(r.adjustedNow)}</b> adjusted from advance</> : <><b>{inr(amount)}</b></>} — <i>{amountInWords(amount)}</i>.
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '9mm', fontSize: 10 }}>
        <div style={{ borderTop: '1px solid #000', paddingTop: 2, width: '40%', textAlign: 'center' }}>Signature of {r.employee.name}</div>
        <div style={{ borderTop: '1px solid #000', paddingTop: 2, width: '40%', textAlign: 'center' }}>For {company.name}</div>
      </div>
    </div>
  );
}

/** Fetch a staff receipt and open the print dialog with both copies. */
export async function printStaffReceipt(key: { kind: 'pay' | 'move'; id: number }) {
  const [{ call }, { printDocument }] = await Promise.all([import('../../db/client'), import('../../components/print/PrintDoc')]);
  const [r, st] = await Promise.all([call('staff.receipt', key), call('app.status')]);
  if (!st.company) return;
  printDocument(`${st.company.name} ${r.number}`, <StaffReceiptSheet r={r} company={st.company} />, 'a4');
}
