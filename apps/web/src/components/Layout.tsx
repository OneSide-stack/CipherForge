import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { cx, initials } from '../lib/format';
import { Badge } from './ui';

const icons = {
  dashboard: <path d="M3 12h7V3H3v9Zm0 9h7v-6H3v6Zm11 0h7V9h-7v12Zm0-18v3h7V3h-7Z" />,
  labs: <path d="M9 3h6M10 3v6.5L4.8 18a2 2 0 0 0 1.7 3h11a2 2 0 0 0 1.7-3L14 9.5V3M7.5 15h9" />,
  paths: <path d="M6 3v12a3 3 0 0 0 3 3h6m0 0-3-3m3 3-3 3M18 3v6" />,
  leaderboard: <path d="M4 20V10m8 10V4m8 16v-7" />,
  achievements: <path d="M8 21h8m-4-4v4M7 4h10v4a5 5 0 0 1-10 0V4Zm10 1h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3" />,
  qa: <path d="M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />,
  admin: <path d="M12 2 4 6v6c0 5 3.4 9.3 8 10 4.6-.7 8-5 8-10V6l-8-4Zm0 6v4m0 4h.01" />,
  terminal: <path d="m4 17 6-6-6-6m8 14h8" />,
};

function Icon({ name }: { name: keyof typeof icons }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {icons[name]}
    </svg>
  );
}

const NAV = [
  { to: '/app', label: 'Dashboard', icon: 'dashboard' as const, end: true },
  { to: '/app/labs', label: 'Lab catalog', icon: 'labs' as const },
  { to: '/app/paths', label: 'Learning paths', icon: 'paths' as const },
  { to: '/app/leaderboard', label: 'Leaderboard', icon: 'leaderboard' as const },
  { to: '/app/achievements', label: 'Achievements', icon: 'achievements' as const },
  { to: '/app/qa', label: 'QA & tests', icon: 'qa' as const },
];

export function Layout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const location = useLocation();
  const [open, setOpen] = useState(false);

  useEffect(() => setOpen(false), [location.pathname]);

  const crumbs = (() => {
    const parts = location.pathname.replace(/^\/app\/?/, '').split('/').filter(Boolean);
    if (!parts.length) return [{ label: 'Dashboard' }];
    const first = parts[0];
    const labels: Record<string, string> = { labs: 'Lab catalog', paths: 'Learning paths', leaderboard: 'Leaderboard', achievements: 'Achievements', qa: 'QA & tests', admin: 'Administration', sessions: 'Lab session', profile: 'Profile' };
    const out = [{ label: labels[first] ?? first }];
    if (parts[1]) out.push({ label: parts[0] === 'sessions' ? parts[1].slice(0, 8) : parts[1] });
    return out;
  })();

  return (
    <div className="shell">
      {open && <div className="scrim" onClick={() => setOpen(false)} />}
      <aside className={cx('sidebar', open && 'open')}>
        <Link to="/app" className="brand">
          <div className="brand-mark">CF</div>
          <div>
            <div className="brand-name">CipherForge</div>
            <div className="brand-sub">Academy</div>
          </div>
        </Link>

        <nav className="nav">
          <div className="nav-label">Training</div>
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => cx('nav-link', isActive && 'active')}>
              <Icon name={item.icon} />
              {item.label}
            </NavLink>
          ))}
          {user?.role === 'admin' && (
            <>
              <div className="nav-label">Operations</div>
              <NavLink to="/app/admin" className={({ isActive }) => cx('nav-link', isActive && 'active')}>
                <Icon name="admin" />
                Administration
              </NavLink>
            </>
          )}
        </nav>

        <div className="sidebar-foot">
          <div className="userchip">
            <div className="avatar">{initials(user?.username ?? 'CF')}</div>
            <div className="grow">
              <div className="userchip-name truncate">{user?.username ?? 'Signed in'}</div>
              <div className="userchip-meta">{user ? `${user.rank.name} · ${user.xp} XP` : ''}</div>
            </div>
          </div>
          <div className="row gap-6">
            <Link to="/app/profile" className="btn btn-ghost btn-sm grow">Profile</Link>
            <button className="btn btn-ghost btn-sm" onClick={() => void logout()}>Sign out</button>
          </div>
          <div className="tiny muted mono" style={{ padding: '0 4px' }}>isolated labs · verified progress</div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <button className="btn btn-ghost btn-sm mobile-nav" onClick={() => setOpen(true)} aria-label="Open navigation">☰</button>
          <div className="crumbs">
            {crumbs.map((c, i) => (
              <span key={i} className="row gap-6">
                {i > 0 && <span>/</span>}
                <b>{c.label}</b>
              </span>
            ))}
          </div>
          <div className="topbar-right">
            {user && <Badge tone="ember">{user.rank.name}</Badge>}
            {user && <Badge tone="teal">{user.xp} XP</Badge>}
            <Link to="/app/labs" className="btn btn-primary btn-sm">Start a lab</Link>
          </div>
        </header>
        <main className="page">{children}</main>
      </div>
    </div>
  );
}
