import { User } from 'oidc-client-ts';
import { createContext, ReactNode, useContext, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { api, currentFacility, setFacility } from './api';
import { completeLogin, currentTenant, currentUser, loadConfig, login, logout, rolesOf } from './auth';
import { ColorGuide } from './pages/ColorGuide';
import { Dashboard } from './pages/Dashboard';
import { EdiMessages } from './pages/Edi';
import { EquipmentPage } from './pages/Equipment';
import { Events } from './pages/Events';
import { Gate } from './pages/Gate';
import { InvoiceDetail, Invoices } from './pages/Invoices';
import { UnitDetail, Units } from './pages/Units';
import { VisitDetail, Visits } from './pages/Visits';
import { Terminal } from './pages/Terminal';
import { WorkQueueDetail, WorkQueues } from './pages/Work';
import { YardView } from './pages/Yard';
import { useLiveState } from './live';

interface Facility { code: string; name: string; facilityType: string; kinds?: string[]; unlocode: string | null; complexCode: string; currency: string }

interface Session {
  user: User;
  roles: string[];
  tenant: string;
  facilities: Facility[];
  facility: string;
  setFacility: (code: string) => void;
}

const SessionContext = createContext<Session | null>(null);
export const useSession = () => useContext(SessionContext)!;

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/callback" element={<Callback />} />
        <Route path="/*" element={<RequireSession><Shell /></RequireSession>} />
      </Routes>
    </BrowserRouter>
  );
}

function RequireSession({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [facility, setFac] = useState<string>(currentFacility() ?? '');
  const navigate = useNavigate();
  useEffect(() => {
    (async () => {
      const user = await currentUser().catch(() => null);
      if (!user) {
        navigate('/login', { replace: true });
        return;
      }
      const facilities = await api.get<Facility[]>('/v1/facilities', { facility: false }).catch(() => [] as Facility[]);
      const chosen = facilities.find((f) => f.code === currentFacility())?.code
        ?? facilities.find((f) => f.kinds?.includes('SEAPORT'))?.code ?? facilities[0]?.code ?? '';
      if (chosen) setFacility(chosen);
      setFac(chosen);
      setSession({ user, roles: rolesOf(user), tenant: currentTenant()!, facilities, facility: chosen, setFacility: () => undefined });
    })();
  }, [navigate]);
  if (session === undefined) return <div className="center muted">Loading…</div>;
  if (!session) return null;
  const value: Session = {
    ...session,
    facility,
    setFacility: (code) => {
      setFacility(code);
      setFac(code);
    },
  };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

function Login() {
  const [tenant, setTenant] = useState(currentTenant() ?? '');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    loadConfig().then((c) => setTenant((t) => t || c.defaultTenant)).catch((e) => setError(e.message));
  }, []);
  return (
    <div className="login">
      <form onSubmit={(e) => { e.preventDefault(); login(tenant.trim()).catch((err) => setError(err.message)); }}>
        <h1>Terminal Operating System</h1>
        <p className="muted">Sign in with your organisation's account.</p>
        <label>Organisation code
          <input value={tenant} onChange={(e) => setTenant(e.target.value)} required pattern="[a-z0-9][a-z0-9\-]{1,39}" autoFocus />
        </label>
        <button className="primary" type="submit">Continue to sign-in</button>
        {error && <p className="error">{error}</p>}
      </form>
    </div>
  );
}

function Callback() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    completeLogin().then((to) => navigate(to, { replace: true })).catch((e) => setError(e.message));
  }, [navigate]);
  return <div className="center">{error ? <p className="error">Sign-in failed: {error} <a href="/login">Try again</a></p> : 'Signing in…'}</div>;
}

const NAV = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/visits', label: 'Vessel visits' },
  { to: '/units', label: 'Units' },
  { to: '/yard', label: 'Yard' },
  { to: '/work', label: 'Work queues' },
  { to: '/equipment', label: 'Equipment' },
  { to: '/gate', label: 'Gate' },
  { to: '/invoices', label: 'Invoices' },
  { to: '/edi', label: 'EDI messages' },
  { to: '/terminal', label: 'Terminal' },
  { to: '/events', label: 'Events' },
  { to: '/colors', label: 'Colour guide' },
];

function Shell() {
  const s = useSession();
  const name = (s.user.profile.name ?? s.user.profile.preferred_username ?? 'User') as string;
  return (
    <div className="shell">
      <aside className="nav">
        <div className="brand">TOS</div>
        <nav>{NAV.map((n) => <NavLink key={n.to} to={n.to} end={n.end}>{n.label}</NavLink>)}</nav>
      </aside>
      <div className="main">
        <header className="topbar">
          <span className="tenant" title="Organisation">{s.tenant}</span>
          <label className="facility">Terminal{' '}
            <select value={s.facility} onChange={(e) => s.setFacility(e.target.value)}>
              {s.facilities.map((f) => <option key={f.code} value={f.code}>{f.code} · {f.name}</option>)}
            </select>
          </label>
          <span className="spacer" />
          <LiveDot />
          <span className="user" title={s.roles.filter((r) => r.startsWith('tos:')).join(', ')}>{name}</span>
          <button className="link" onClick={() => logout()}>Sign out</button>
        </header>
        <main className="content" key={s.facility}>
          {!s.facility ? <p className="muted">No terminal is set up for this organisation yet.</p> : (
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/visits" element={<Visits />} />
              <Route path="/visits/:id" element={<VisitDetail />} />
              <Route path="/units" element={<Units />} />
              <Route path="/units/:id" element={<UnitDetail />} />
              <Route path="/yard" element={<YardView />} />
              <Route path="/work" element={<WorkQueues />} />
              <Route path="/work/:code" element={<WorkQueueDetail />} />
              <Route path="/equipment" element={<EquipmentPage />} />
              <Route path="/terminal" element={<Terminal />} />
              <Route path="/gate" element={<Gate />} />
              <Route path="/invoices" element={<Invoices />} />
              <Route path="/invoices/:id" element={<InvoiceDetail />} />
              <Route path="/edi" element={<EdiMessages />} />
              <Route path="/events" element={<Events />} />
              <Route path="/colors" element={<ColorGuide />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          )}
        </main>
      </div>
    </div>
  );
}

function LiveDot() {
  const state = useLiveState();
  const label = { live: 'Live', connecting: 'Connecting…', offline: 'Offline' }[state];
  return <span className={`live-dot ${state}`} title={state === 'live' ? 'Screens update as events happen' : 'Live updates paused; retrying'}>{label}</span>;
}
