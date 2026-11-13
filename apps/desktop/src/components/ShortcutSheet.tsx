import { useUi } from '../lib/store';
import { Dialog } from './ui';

const GROUPS: Array<{ title: string; keys: Array<[string, string]> }> = [
  {
    title: 'Anywhere',
    keys: [
      ['Ctrl K', 'Search & jump to anything'],
      ['?', 'Show this cheat-sheet'],
      ['Alt N', 'New bill'],
      ['Alt P', 'New purchase'],
      ['Alt S', 'Sales & returns'],
      ['Alt I', 'Items'],
      ['Alt C', 'Customers & suppliers'],
      ['Alt M', 'Money & cash flow'],
      ['Alt E', 'Expenses'],
      ['Alt R', 'Reports'],
      ['Alt G', 'GST returns'],
      ['Alt L', 'Lock / switch user'],
      ['Ctrl B', 'Collapse sidebar'],
    ],
  },
  {
    title: 'Billing screen',
    keys: [
      ['Enter', 'Add item → quantity → next item'],
      ['F1', 'Focus item search'],
      ['F2', 'Hold bill (park it)'],
      ['F3', 'Held bills — resume'],
      ['F4', 'Paid by cash'],
      ['F5', 'Paid by UPI (shows QR)'],
      ['F6', 'Udhaar / credit'],
      ['F7', 'Pick customer'],
      ['F8', 'Bill discount'],
      ['F9', 'Save & print'],
      ['F10', 'Save without printing'],
      ['Ctrl ↑ / ↓', 'Select line'],
      ['+ / −', 'Change quantity of selected line'],
      ['Del', 'Remove selected line'],
      ['Esc', 'Clear bill / close'],
    ],
  },
];

export function ShortcutSheet() {
  const { shortcutsOpen, setShortcutsOpen } = useUi();
  return (
    <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} title="Keyboard shortcuts" description="Hisaab is built to be used without a mouse. The badges on buttons show these keys too." size="lg">
      <div className="grid gap-6 md:grid-cols-2">
        {GROUPS.map((g) => (
          <div key={g.title}>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-faint">{g.title}</h4>
            <ul className="space-y-1.5">
              {g.keys.map(([k, d]) => (
                <li key={k} className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-muted">{d}</span>
                  <span className="flex gap-1">
                    {k.split(' ').map((p) => (
                      <kbd key={p} className="kbd">
                        {p}
                      </kbd>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
