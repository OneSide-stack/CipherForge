export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

const DIFF_COLORS: Record<string, string> = {
  Beginner: 'teal',
  Intermediate: 'blue',
  Advanced: 'ember',
  Expert: 'red',
};

export function difficultyTone(difficulty: string): string {
  return DIFF_COLORS[difficulty] ?? 'blue';
}

export function stateTone(state: string): string {
  if (state === 'ready') return 'teal';
  if (state === 'failed') return 'red';
  if (state === 'expired') return 'amber';
  if (state === 'stopped') return 'blue';
  return 'amber';
}

export function stateLabel(state: string): string {
  return state.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function minutesLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export function timeLeft(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'expired';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function relativeTime(iso?: string | null): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diff = Date.now() - then;
  const abs = Math.abs(diff);
  const units: [number, string][] = [
    [60_000, 'min'],
    [3_600_000, 'hr'],
    [86_400_000, 'day'],
    [604_800_000, 'wk'],
  ];
  if (abs < 60_000) return diff >= 0 ? 'just now' : 'in a moment';
  if (abs < 3_600_000) return `${diff >= 0 ? '' : 'in '}${Math.round(abs / 60_000)} min${diff >= 0 ? ' ago' : ''}`;
  if (abs < 86_400_000) return `${diff >= 0 ? '' : 'in '}${Math.round(abs / 3_600_000)} hr${diff >= 0 ? ' ago' : ''}`;
  if (abs < 604_800_000) return `${diff >= 0 ? '' : 'in '}${Math.round(abs / 86_400_000)} day${Math.round(abs / 86_400_000) === 1 ? '' : 's'}${diff >= 0 ? ' ago' : ''}`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function initials(name: string): string {
  return name
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}

export function percent(done: number, total: number): number {
  if (!total) return 0;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}
