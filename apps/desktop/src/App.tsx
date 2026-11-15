import { AppWindow } from 'lucide-react';
import { useEffect, useState } from 'react';
import { MobileApp } from './features/mobile/MobileApp';
import { useIsPhone } from './lib/useIsPhone';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { ScreenBoundary } from './components/ErrorBoundary';
import { RequirePerm } from './components/RouteGuard';
import { ChangePinScreen, LockScreen } from './components/LockScreen';
import { PrintHost } from './components/print/PrintInvoice';
import { Loading, Toaster } from './components/ui';
import { Dashboard } from './features/dashboard/Dashboard';
import { GstPage } from './features/gst/GstPage';
import { ItemsPage } from './features/items/ItemsPage';
import { LabelsPage } from './features/items/LabelsPage';
import { GodownsPage } from './features/items/GodownsPage';
import { StockReportPage } from './features/items/StockReportPage';
import { ImportPage } from './features/import/ImportPage';
import { WelcomePage } from './features/welcome/WelcomePage';
import { MoneyPage } from './features/money/MoneyPage';
import { Onboarding } from './features/onboarding/Onboarding';
import { EnterprisePicker } from './features/enterprise/EnterprisePicker';
import { db, LAN } from './db/client';
import { PairPhone, ShopComputerOffline } from './features/lan/PairPhone';
import { useLanPaired } from './lan/client';
import { PartiesPage } from './features/parties/PartiesPage';
import { PartyDetail } from './features/parties/PartyDetail';
import { PosPage } from './features/pos/PosPage';
import { PurchaseEntry } from './features/purchases/PurchaseEntry';
import { PurchaseOrdersPage } from './features/purchases/OrdersPage';
import { CouponsPage } from './features/purchases/CouponsPage';
import { ReportsPage } from './features/reports/ReportsPage';
import { InvoiceList } from './features/sales/InvoiceList';
import { InvoiceView } from './features/sales/InvoiceView';
import { SettingsPage } from './features/settings/SettingsPage';
import { ExpensesPage } from './features/expenses/ExpensesPage';
import { StaffPage } from './features/staff/StaffPage';
import { ActivityPage } from './features/activity/ActivityPage';
import { MyPayPage } from './features/me/MyPayPage';
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
  const paired = useLanPaired();
  if (LAN && !paired) return <PairPhone />;
  return <Main />;
}

function Main() {
  const status = useApi('app.status');
  const session = useUi((s) => s.session);
  const setSession = useUi((s) => s.setSession);
  const phone = useIsPhone();
  const [forceDesktop, setForceDesktop] = useState(false);

  useEffect(() => {
    if (status.data && status.data.session?.userId !== session?.userId) setSession(status.data.session);
  }, [status.data, session?.userId, setSession]);

  if (LAN && status.error && !status.data) return <ShopComputerOffline error={status.error as Error} onRetry={() => void status.refetch()} />;
  if (status.isLoading || !status.data) return <Loading />;
  const enterprises = status.data.enterprises ?? [];
  const current = status.data.enterpriseId ?? null;
  if (!current) return <EnterprisePicker enterprises={enterprises} />;
  if (!status.data.company) return <Onboarding onCancel={enterprises.length ? () => void db.closeEnterprise() : undefined} />;
  if (!status.data.session) return <LockScreen users={status.data.users} company={status.data.company} enterpriseCount={enterprises.length} />;
  if (status.data.session.mustChangePin) return <ChangePinScreen name={status.data.session.name} />;
  // Phones (and salesmen on any screen) get the pocket app; the full desktop is a tap away for others.
  if (status.data.session.role === 'salesman' || (phone && !forceDesktop)) {
    return <MobileApp company={status.data.company} session={status.data.session} onDesktop={() => setForceDesktop(true)} />;
  }

  return (
    <HashRouter>
      <AppShell company={status.data.company}>
        <ScreenBoundary>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/pos" element={<RequirePerm perm="sale.create"><PosPage /></RequirePerm>} />
          <Route path="/sales" element={<RequirePerm perm="sale.view"><InvoiceList kind="sales_all" /></RequirePerm>} />
          <Route path="/sales/:id" element={<RequirePerm perm="sale.view"><InvoiceView /></RequirePerm>} />
          <Route path="/purchases" element={<RequirePerm perm="purchase.view"><InvoiceList kind="purchases_all" /></RequirePerm>} />
          <Route path="/purchases/new" element={<RequirePerm perm="purchase.create"><PurchaseEntry /></RequirePerm>} />
          <Route path="/purchases/coupons" element={<RequirePerm perm="purchase.view"><CouponsPage /></RequirePerm>} />
          <Route path="/purchases/orders" element={<RequirePerm perm="purchase.view"><PurchaseOrdersPage /></RequirePerm>} />
          <Route path="/purchases/:id" element={<RequirePerm perm="purchase.view"><InvoiceView /></RequirePerm>} />
          <Route path="/items" element={<RequirePerm perm="item.view"><ItemsPage /></RequirePerm>} />
          <Route path="/items/labels" element={<RequirePerm perm="item.edit"><LabelsPage /></RequirePerm>} />
          <Route path="/items/godowns" element={<RequirePerm perm="item.view"><GodownsPage /></RequirePerm>} />
          <Route path="/items/stock" element={<RequirePerm perm="item.view"><StockReportPage /></RequirePerm>} />
          <Route path="/import" element={<RequirePerm perm="settings.edit"><ImportPage /></RequirePerm>} />
          <Route path="/welcome" element={<RequirePerm perm="settings.edit"><WelcomePage /></RequirePerm>} />
          <Route path="/parties" element={<RequirePerm perm="party.view"><PartiesPage /></RequirePerm>} />
          <Route path="/parties/:id" element={<RequirePerm perm="party.view"><PartyDetail /></RequirePerm>} />
          <Route path="/money" element={<RequirePerm perm="payment.in"><MoneyPage /></RequirePerm>} />
          <Route path="/expenses" element={<RequirePerm perm="expense.view"><ExpensesPage /></RequirePerm>} />
          <Route path="/staff" element={<RequirePerm perm="payroll.manage"><StaffPage /></RequirePerm>} />
          <Route path="/activity" element={<RequirePerm perm="users.manage"><ActivityPage /></RequirePerm>} />
          <Route path="/me" element={<MyPayPage />} />
          <Route path="/reports" element={<RequirePerm perm="report.view"><ReportsPage /></RequirePerm>} />
          <Route path="/gst" element={<RequirePerm perm="gst.view"><GstPage /></RequirePerm>} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </ScreenBoundary>
      </AppShell>
    </HashRouter>
  );
}
