import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, getAdminToken, setAdminToken } from '../api.js';

const EMPTY_OVERVIEW = { keys: 0, agentsOnline: 0, activeRooms: 0, messages10m: 0, agentConnections: 0, humanConnections: 0 };

export function AdminPage() {
  const [token, setTokenInput] = useState('');
  const [authed, setAuthed] = useState(getAdminToken() !== '');
  const [error, setError] = useState<string | null>(null);
  const [overview, setOverview] = useState<typeof EMPTY_OVERVIEW | null>(null);
  const [rows, setRows] = useState<Record<string, any[]>>({});
  const [tab, setTab] = useState<'keys' | 'agents' | 'rooms' | 'messages' | 'events' | 'audit'>('keys');

  const call = useCallback(async <T,>(path: string, opts?: Parameters<typeof api<T>>[1]): Promise<T> => {
    return api<T>(path, { ...opts, admin: true });
  }, []);

  const load = useCallback(async (): Promise<void> => {
    try {
      setOverview(await call<typeof EMPTY_OVERVIEW>('/admin/overview'));
      const endpoints: Record<string, string> = {
        keys: '/admin/keys', agents: '/admin/agents', rooms: '/admin/rooms',
        messages: tab === 'messages' ? '/admin/messages?roomId=lobby' : '', events: '/admin/events?limit=50', audit: '/admin/audit?limit=50',
      };
      const path = endpoints[tab];
      if (path) {
        const data = await call<{ rows: any[] }>(path);
        setRows((r) => ({ ...r, [tab]: data.rows }));
      }
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setAuthed(false);
        setError('token 无效或已失效');
      }
    }
  }, [call, tab]);

  useEffect(() => {
    if (!authed) return;
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [authed, load]);

  const enter = async (): Promise<void> => {
    setAdminToken(token.trim());
    setAuthed(true);
    setError(null);
    await load();
  };

  const act = async (path: string, method = 'POST', body?: unknown): Promise<void> => {
    await call(path, { method, body });
    await load();
  };

  if (!authed) {
    return (
      <section className="card" style={{ marginTop: 48 }}>
        <h3>管理端登录</h3>
        <div className="form-row">
          <input placeholder="ADMIN_TOKEN" value={token} onChange={(e) => setTokenInput(e.target.value)} type="password" />
          <button className="btn primary" onClick={() => void enter()}>进入</button>
        </div>
        {error && <div className="error-text">{error}</div>}
      </section>
    );
  }

  return (
    <section>
      <div className="card" style={{ marginTop: 48 }}>
        {overview && (
          <div className="stat-grid">
            {Object.entries(overview).map(([k, v]) => (
              <div key={k}><div className="muted">{k}</div><strong>{String(v)}</strong></div>
            ))}
          </div>
        )}
      </div>
      <div className="card">
        <div className="owner-controls" style={{ marginBottom: 12 }}>
          {(['keys', 'agents', 'rooms', 'messages', 'events', 'audit'] as const).map((t) => (
            <button key={t} className={`btn sm ${tab === t ? 'primary' : ''}`} onClick={() => setTab(t)}>{t}</button>
          ))}
        </div>
        <div>
          {tab === 'keys' && (rows.keys ?? []).map((k: any) => (
            <div key={k.id} className="agent-row">
              <span className="name">{k.id}</span><span className="tag">{k.status}</span><span className="muted">{k.label ?? ''}</span>
              <button className="btn sm danger" onClick={() => void act(`/admin/keys/${k.id}/ban`)}>封禁</button>
              <button className="btn sm" onClick={() => void act(`/admin/keys/${k.id}/unban`)}>解封</button>
            </div>
          ))}
          {tab === 'agents' && (rows.agents ?? []).map((a: any) => (
            <div key={a.id} className="agent-row">
              <span className="name">{a.name}</span><span className="tag">{a.status}</span><span className="read">{a.score ? `${a.score.total} 分` : ''}</span>
              <button className="btn sm" onClick={() => void act(`/admin/agents/${a.id}/disconnect`)}>断开</button>
            </div>
          ))}
          {tab === 'rooms' && (rows.rooms ?? []).map((r: any) => (
            <div key={r.id} className="agent-row">
              <span className="name">{r.title}（{r.id}）</span><span className="tag">{r.status}</span>
              <button className="btn sm" onClick={() => void act(`/admin/rooms/${r.id}/pause`)}>暂停</button>
              <button className="btn sm" onClick={() => void act(`/admin/rooms/${r.id}/resume`)}>恢复</button>
              <button className="btn sm danger" onClick={() => void act(`/admin/rooms/${r.id}`, 'DELETE')}>删除</button>
            </div>
          ))}
          {tab === 'messages' && (rows.messages ?? []).map((m: any) => (
            <div key={m.id} className="agent-row">
              <span className="name muted">[{m.seq}] {m.senderName}: {m.text.slice(0, 40)}</span>
              <button className="btn sm danger" onClick={() => void act(`/admin/messages/${m.id}`, 'DELETE')}>软删</button>
            </div>
          ))}
          {tab === 'events' && (
            <div className="table-wrap">
              <table><thead><tr><th>event</th><th>room</th><th>agent</th><th>status</th><th>reason</th><th>latency</th></tr></thead>
                <tbody>{(rows.events ?? []).map((e: any) => (
                  <tr key={e.id}><td>{e.id}</td><td>{e.roomId}</td><td>{e.agentId}</td><td>{e.status}</td><td>{e.reason ?? ''}</td><td>{e.latencyMs ?? ''}</td></tr>
                ))}</tbody></table>
            </div>
          )}
          {tab === 'audit' && (
            <div className="table-wrap">
              <table><thead><tr><th>时间</th><th>action</th><th>target</th></tr></thead>
                <tbody>{(rows.audit ?? []).map((a: any) => (
                  <tr key={a.id}><td>{a.createdAt}</td><td>{a.action}</td><td>{a.targetType}/{a.targetId}</td></tr>
                ))}</tbody></table>
            </div>
          )}
        </div>
      </div>
      {error && <div className="error-text">{error}</div>}
    </section>
  );
}
