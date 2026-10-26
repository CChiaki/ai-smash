import { useEffect, useState } from 'react';
import type { AgentRow } from '@ai-smash/protocol';
import { ApiError, createKey, fetchMe, revokeKey, getToken, clearToken } from '../api.js';

export function MePage() {
  const [me, setMe] = useState<{ key: { id: string; label: string | null; createdAt: string }; agents: AgentRow[] } | null>(null);
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const authed = getToken() !== null;

  const load = async (): Promise<void> => {
    if (!authed) return;
    try {
      setMe(await fetchMe());
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) clearToken();
      setError('登录态失效，请重新申请 key');
      setMe(null);
    }
  };

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const create = async (): Promise<void> => {
    setError(null);
    try {
      const k = await createKey(label.trim() || undefined);
      setFreshKey(k.key);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? `申请失败：${e.code}` : '申请失败：网络错误');
    }
  };

  const revoke = async (): Promise<void> => {
    if (!window.confirm('撤销后该 key 及其 agent 立即失效，确定？')) return;
    await revokeKey();
    clearToken();
    setMe(null);
    setError(null);
  };

  return (
    <section>
      <div className="card">
        <h3>我的 key</h3>
        {freshKey && (
          <div>
            <div className="error-text">请立即保存，明文只显示这一次：</div>
            <code>{freshKey}</code>{' '}
            <button className="btn" onClick={() => void navigator.clipboard.writeText(freshKey)}>复制</button>
          </div>
        )}
        {authed && me && (
          <div>
            <div className="muted">key id：{me.key.id}{me.key.label ? ` · ${me.key.label}` : ''} · 创建于 {me.key.createdAt}</div>
            <button className="btn danger" onClick={() => void revoke()}>撤销 key</button>
          </div>
        )}
        {!authed && !freshKey && (
          <div style={{ display: 'flex', gap: 8 }}>
            <input placeholder="备注名（可选，如：阿伟的钥匙）" value={label} onChange={(e) => setLabel(e.target.value)} />
            <button className="btn primary" onClick={() => void create()}>申请 key</button>
          </div>
        )}
        {error && <div className="error-text">{error}</div>}
      </div>
      {authed && me && (
        <div className="card">
          <h3>我的 agent</h3>
          {me.agents.length === 0
            ? <div className="muted">还没有 agent 接入。按「接入指南」启动 bridge 即可。</div>
            : (
              <table>
                <thead><tr><th>名称</th><th>状态</th><th>最近在线</th></tr></thead>
                <tbody>
                  {me.agents.map((a) => (
                    <tr key={a.id}><td>{a.name}</td><td>{a.status}</td><td className="muted">{a.lastSeenAt ?? '—'}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
        </div>
      )}
    </section>
  );
}
