import { AppWindow } from 'lucide-react';
import { useEffect } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { LockScreen } from './components/LockScreen';
import { PrintHost } from './components/print/PrintInvoice';
import { Loading, Toaster } from './components/ui';
import { Dashboard } from './features/dashboard/Dashboard';
import { GstPage } from './features/gst/GstPage';
import { ItemsPage } from './features/items/ItemsPage';
import { LabelsPage } from './features/items/LabelsPage';
import { MoneyPage } from './features/money/MoneyPage';
import { Onboarding } from './features/onboarding/Onboarding';
import { EnterprisePicker } from './features/enterprise/EnterprisePicker';
import { db } from './db/client';
import { PartiesPage } from './features/parties/PartiesPage';
import { PartyDetail } from './features/parties/PartyDetail';
import { PosPage } from './features/pos/PosPage';
import { PurchaseEntry } from './features/purchases/PurchaseEntry';
import { ReportsPage } from './features/reports/ReportsPage';
import { InvoiceList } from './features/sales/InvoiceList';
import { InvoiceView } from './features/sales/InvoiceView';
import { SettingsPage } from './features/settings/SettingsPage';
import { ExpensesPage } from './features/expenses/ExpensesPage';
import { StaffPage } from './features/staff/StaffPage';
import { ActivityPage } from './features/activity/ActivityPage';
import { useApi } from './lib/useApi';
import { useUi } from './lib/store';

export function App({ blocked }: { blocked: boolean }) {
  if (blocked) {
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="card max-w-md p-8 text-center">
          <AppWindow className="mx-auto mb-3 h-8 w-8 text-primary" />
          <h1 className="text-lg font-semibold">Hisaab is already open</h1>
          <p className="mt-1 text-sm text-muted">Hisaab is open in another window or tab. Close it and reload this page, so your bills are never overwritten.</p>
        </div>
      </div>
    );
  }
  return (
    <>
      <Boot />
      <Toaster />
      <PrintHost />
    </>
  );
}

function Boot() {
  const status = useApi('app.status');
  const session = useUi((s) => s.session);
  const setSession = useUi((s) => s.setSession);

  useEffect(() => {
    if (status.data && status.data.session?.userId !== session?.userId) setSession(status.data.session);
  }, [status.data, session?.userId, setSession]);

  if (status.isLoading || !status.data) return <Loading />;
  const enterprises = status.data.enterprises ?? [];
  const current = status.data.enterpriseId ?? null;
  if (!current) return <EnterprisePicker enterprises={enterprises} />;
  if (!status.data.company) return <Onboarding onCancel={enterprises.length ? () => void db.closeEnterprise() : undefined} />;
  if (!status.data.session) return <LockScreen users={status.data.users} company={status.data.company} enterpriseCount={enterprises.length} />;

  return (
    <HashRouter>
      <AppShell company={status.data.company}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/pos" element={<PosPage />} />
          <Route path="/sales" element={<InvoiceList kind="sales_all" />} />
          <Route path="/sales/:id" element={<InvoiceView />} />
          <Route path="/purchases" element={<InvoiceList kind="purchases_all" />} />
          <Route path="/purchases/new" element={<PurchaseEntry />} />
          <Route path="/purchases/:id" element={<InvoiceView />} />
          <Route path="/items" element={<ItemsPage />} />
          <Route path="/items/labels" element={<LabelsPage />} />
          <Route path="/parties" element={<PartiesPage />} />
          <Route path="/parties/:id" element={<PartyDetail />} />
          <Route path="/money" element={<MoneyPage />} />
          <Route path="/expenses" element={<ExpensesPage />} />
          <Route path="/staff" element={<StaffPage />} />
          <Route path="/activity" element={<ActivityPage />} />
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/gst" element={<GstPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppShell>
    </HashRouter>
  );
}
