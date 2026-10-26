import { createContext, useCallback, useContext, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx, percent } from '../lib/format';

export function Badge({ children, tone, className, style }: { children: ReactNode; tone?: string; className?: string; style?: CSSProperties }) {
  return <span className={cx('badge', tone, className)} style={style}>{children}</span>;
}

export function Button({
  children,
  onClick,
  variant = 'default',
  size,
  disabled,
  type = 'button',
  className,
  title,
  style,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'default' | 'primary' | 'ghost' | 'danger';
  size?: 'sm' | 'lg';
  disabled?: boolean;
  type?: 'button' | 'submit';
  className?: string;
  title?: string;
  style?: CSSProperties;
}) {
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      style={style}
      className={cx('btn', variant !== 'default' && `btn-${variant}`, size && `btn-${size}`, className)}
    >
      {children}
    </button>
  );
}

export function Card({ children, className, pad = true, style }: { children: ReactNode; className?: string; pad?: boolean; style?: CSSProperties }) {
  return <div className={cx('card', pad && 'card-pad', className)} style={style}>{children}</div>;
}

export function Progress({ value, total, tone }: { value: number; total: number; tone?: 'teal' }) {
  return (
    <div className={cx('progress', tone)} role="progressbar" aria-valuenow={percent(value, total)} aria-valuemin={0} aria-valuemax={100}>
      <span style={{ width: `${percent(value, total)}%` }} />
    </div>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: string; tone?: 'ember' | 'teal' | 'blue' }) {
  return (
    <div className={cx('stat', tone)}>
      <div className="k">{label}</div>
      <div className="v">{value}</div>
      {sub && <div className="s">{sub}</div>}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="row gap-10 muted" style={{ padding: 20, justifyContent: 'center' }}>
      <span className="spinner" />
      {label ?? 'Loading…'}
    </div>
  );
}

export function Empty({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3 style={{ marginBottom: 6, color: 'var(--text-dim)' }}>{title}</h3>
      {body && <p className="tiny">{body}</p>}
      {action && <div style={{ marginTop: 14 }}>{action}</div>}
    </div>
  );
}

export function Banner({ children, tone, style }: { children: ReactNode; tone?: 'warn' | 'bad' | 'ok'; style?: CSSProperties }) {
  return <div className={cx('banner', tone)} style={style}>{children}</div>;
}

type Toast = { id: number; title: string; body?: string; tone?: 'ok' | 'bad' };
const ToastCtx = createContext<{ push: (t: Omit<Toast, 'id'>) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((toast: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { ...toast, id }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 5200);
  }, []);
  const value = useMemo(() => ({ push }), [push]);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      {createPortal(
        <div className="toasts">
          {toasts.map((t) => (
            <div key={t.id} className={cx('toast', t.tone)}>
              <div style={{ fontWeight: 600, fontSize: 13.5 }}>{t.title}</div>
              {t.body && <div className="tiny muted" style={{ marginTop: 3 }}>{t.body}</div>}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error('useToast outside provider');
  return ctx;
}

export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <h3>{title}</h3>
          <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div style={{ padding: 18 }}>{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export function StatusDot({ tone, live }: { tone: 'ok' | 'warn' | 'bad' | 'idle'; live?: boolean }) {
  return <span className={cx('dot', tone !== 'idle' && tone, live && 'live')} />;
}

export function SectionTitle({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="section-title">
      <h2>{title}</h2>
      {hint && <span className="hint">{hint}</span>}
      {action && <div style={{ marginLeft: 'auto' }}>{action}</div>}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="tiny muted" style={{ marginTop: 5 }}>{hint}</span>}
    </label>
  );
}
