import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { terminalUrl } from '../lib/api';
import { cx } from '../lib/format';

type Conn = 'connecting' | 'live' | 'closed' | 'error';

export function TerminalPane({ sessionId, enabled }: { sessionId: string; enabled: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Conn>('connecting');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !hostRef.current) return;
    let disposed = false;
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 13,
      lineHeight: 1.25,
      theme: {
        background: '#05080c',
        foreground: '#c6d4e3',
        cursor: '#ff8a4c',
        selectionBackground: 'rgba(255,122,69,0.3)',
        black: '#0a0f16',
        red: '#ff6b76',
        green: '#49d994',
        yellow: '#ffc857',
        blue: '#5aa9ff',
        magenta: '#a78bfa',
        cyan: '#3ad9b0',
        white: '#dbe6f2',
      },
      scrollback: 4000,
      convertEol: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    const doFit = () => {
      try {
        fit.fit();
      } catch {
        /* container not measurable yet */
      }
    };
    requestAnimationFrame(doFit);

    const enc = (s: string) => {
      const bytes = new TextEncoder().encode(s);
      let bin = '';
      for (const b of bytes) bin += String.fromCharCode(b);
      return btoa(bin);
    };
    const dec = (b64: string) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    };

    const connect = () => {
      if (disposed) return;
      setStatus('connecting');
      setError(null);
      socket = new WebSocket(terminalUrl(sessionId));
      socket.onopen = () => {
        setStatus('live');
        term.focus();
        doFit();
        socket?.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      };
      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data));
          if (msg.type === 'output') term.write(dec(msg.data));
          else if (msg.type === 'exit') {
            term.write(`\r\n\x1b[38;5;243m[session process exited: ${msg.code ?? 0}]\x1b[0m\r\n`);
            setStatus('closed');
          } else if (msg.type === 'error') setError(String(msg.message ?? 'terminal error'));
        } catch {
          /* ignore malformed frame */
        }
      };
      socket.onclose = (event) => {
        if (disposed) return;
        setStatus(event.code === 1006 ? 'error' : 'closed');
        if (event.code === 1006) setError('Terminal connection lost. Reconnecting…');
        retry = setTimeout(connect, event.code === 1000 ? 4000 : 1800);
      };
      socket.onerror = () => setStatus('error');
    };

    const inputSub = term.onData((data) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data: enc(data) }));
    });
    const resizeSub = term.onResize(({ cols, rows }) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols, rows }));
    });
    const observer = new ResizeObserver(() => doFit());
    observer.observe(hostRef.current);
    connect();

    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      observer.disconnect();
      inputSub.dispose();
      resizeSub.dispose();
      socket?.close();
      term.dispose();
    };
  }, [sessionId, enabled]);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="panel-head" style={{ background: 'rgba(255,255,255,0.015)' }}>
        <span className={cx('dot', status === 'live' ? 'ok' : status === 'error' ? 'bad' : 'warn', status === 'live' && 'live')} />
        <h3>workspace terminal</h3>
        <span className="tiny mono muted" style={{ marginLeft: 'auto' }}>{status === 'live' ? 'connected' : status}</span>
      </div>
      {error && <div className="banner bad" style={{ margin: 8 }}>{error}</div>}
      <div className="terminal-wrap" ref={hostRef} />
    </div>
  );
}
