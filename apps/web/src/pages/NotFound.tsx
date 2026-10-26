import { Link } from 'react-router-dom';

export function NotFound() {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div className="center">
        <div className="eyebrow">404 · no such route</div>
        <h1 style={{ fontSize: 44 }}>That path is not in the map.</h1>
        <p className="muted" style={{ marginTop: 8 }}>The page you requested does not exist in CipherForge Academy.</p>
        <div className="row gap-8" style={{ marginTop: 20, justifyContent: 'center' }}>
          <Link to="/app" className="btn btn-primary">Dashboard</Link>
          <Link to="/app/labs" className="btn">Lab catalog</Link>
        </div>
      </div>
    </div>
  );
}
