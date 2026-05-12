import { useEffect, useState, useCallback } from 'react';

const ACTIONS = [
  { id: 'start', verb: 'Start', hint: 'Boot the server' },
  { id: 'idle', verb: 'Idle', hint: 'Auto-start on access' },
  { id: 'stop', verb: 'Stop', hint: 'Force everyone off' },
];

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(body.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export default function App() {
  const [bootState, setBootState] = useState('loading'); // loading | ready | unauthorized | error
  const [me, setMe] = useState(null);
  const [games, setGames] = useState([]);
  const [selected, setSelected] = useState(''); // slug or '' for main table
  const [busyAction, setBusyAction] = useState(null);
  const [log, setLog] = useState([]);
  const [bootError, setBootError] = useState(null);

  // Initial load: who am I + what games can I control
  useEffect(() => {
    (async () => {
      try {
        const [meRes, gamesRes] = await Promise.all([
          fetchJson('/api/me'),
          fetchJson('/api/games'),
        ]);
        setMe(meRes);
        const list = (gamesRes.games || []).map((g) => ({ slug: g.slug, label: g.label }));
        setGames(list);
        if (list.length > 0) {
          setSelected(list[0].slug);
        }
        setBootState('ready');
      } catch (err) {
        if (err.status === 401) {
          // SWA hasn't authenticated us yet — redirect to login
          window.location.href = '/.auth/login/aad?post_login_redirect_uri=' + encodeURIComponent(window.location.pathname);
          return;
        }
        setBootError(err.message);
        setBootState(err.status === 403 ? 'unauthorized' : 'error');
      }
    })();
  }, []);

  const appendLog = useCallback((entry) => {
    setLog((prev) => [{ ...entry, time: new Date() }, ...prev].slice(0, 50));
  }, []);

  const onAction = async (action) => {
    setBusyAction(action);
    const label = games.find((g) => g.slug === selected)?.label || selected;

    // For Start: open the game URL in a new tab immediately, synchronously
    // with the click. Doing this here (before any await) avoids browsers'
    // popup blockers, which only allow window.open from direct user gestures.
    // The Foundry instance shows its own "starting..." page while the
    // Forge boots up, so the user gets visible feedback right away.
    if (action === 'start' && selected) {
      const gameUrl = `https://${selected}.forge-vtt.com/game`;
      window.open(gameUrl, '_blank', 'noopener,noreferrer');
    }

    try {
      const body = await fetchJson(`/api/control/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ game: selected }),
      });

      // Forge response shape: { success: true/false } on success-but-refused (e.g. idle declined),
      // or { error, code } on actual errors. The API surfaces both transparently.
      // The API may also return { pending: true } if the Forge call is taking
      // longer than the SWA edge timeout — the action is still completing in
      // the background, just not awaited.
      if (body.error) {
        appendLog({ kind: 'err', msg: `${action.toUpperCase()} ${label} → ${body.error}` });
      } else if (body.pending) {
        appendLog({
          kind: 'info',
          msg: `${action.toUpperCase()} ${label} → still working… try the game URL in ~30s`,
        });
      } else if (body.success === false) {
        appendLog({
          kind: 'err',
          msg: `${action.toUpperCase()} ${label} → refused (likely in use)`,
        });
      } else {
        appendLog({ kind: 'ok', msg: `${action.toUpperCase()} ${label} → ok` });
      }
    } catch (err) {
      appendLog({ kind: 'err', msg: `${action.toUpperCase()} ${label} → ${err.message}` });
    } finally {
      setBusyAction(null);
    }
  };

  if (bootState === 'loading') {
    return (
      <div className="boot">
        <div className="spinner" />
        <div>Authenticating…</div>
      </div>
    );
  }

  if (bootState === 'unauthorized') {
    return (
      <div className="app">
        <header className="masthead">
          <div className="sub">Brown Dog Enterprises</div>
          <h1>Access Denied</h1>
        </header>
        <div className="error-box">
          <h2>Not on the allowlist</h2>
          <p>
            You're signed in, but your account isn't authorized to control these games.
            Contact the administrator if you believe this is in error.
          </p>
          <p style={{ marginTop: '1rem' }}>
            <a href="/.auth/logout" style={{ color: 'var(--accent)' }}>Sign out</a>
          </p>
        </div>
      </div>
    );
  }

  if (bootState === 'error') {
    return (
      <div className="app">
        <header className="masthead">
          <h1>Something went wrong</h1>
        </header>
        <div className="error-box">
          <p>{bootError}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="masthead">
        <div className="sub">Brown Dog Enterprises · TheForgeControlPanel</div>
        <h1>The Old World</h1>
        <div className="who">
          <span>Signed in as {me?.email}</span>
          <a href="/.auth/logout">Sign out</a>
        </div>
      </header>

      <section className="selector">
        <label htmlFor="game">Select game</label>
        <select
          id="game"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          disabled={!!busyAction}
        >
          {games.map((g) => (
            <option key={g.slug || '__main__'} value={g.slug}>
              {g.label}
            </option>
          ))}
        </select>
      </section>

      <section className="actions">
        {ACTIONS.map((a) => (
          <button
            key={a.id}
            className={`action ${a.id}`}
            onClick={() => onAction(a.id)}
            disabled={!!busyAction}
          >
            <span className="verb">
              {busyAction === a.id ? <span className="spinner" /> : a.verb}
            </span>
            <span className="hint">{a.hint}</span>
          </button>
        ))}
      </section>

      <section className="log" aria-label="Activity log">
        <div className="log-header">
          <span>Activity</span>
          <span>{log.length} {log.length === 1 ? 'entry' : 'entries'}</span>
        </div>
        {log.length === 0 ? (
          <div className="log-empty">No actions yet.</div>
        ) : (
          log.map((entry, i) => (
            <div key={i} className={`log-entry ${entry.kind}`}>
              <span className="time">
                {entry.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
              <span className="msg">{entry.msg}</span>
            </div>
          ))
        )}
      </section>
    </div>
  );
}
