import { useEffect, useState } from 'react';
import type { AgentRow } from '@ai-smash/protocol';
import { ApiError, createKey, fetchMe, revokeKey, getToken, clearToken } from '../api.js';

export function MePage() {
  const [me, setMe] = useState<{ key: { id: string; label: string | null; createdAt: string }; agents: AgentRow[] } | null>(null);
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const authed = getToken() !== null;

  const load = async (): Promise<void> => {
    if (getToken() === null) return; // 申请 key 后立即生效，不用闭包里的旧 authed
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
    if (!window.confirm('撤销后该 key 及其 Agent 立即失效，确定？')) return;
    await revokeKey();
    clearToken();
    setMe(null);
    setError(null);
  };

  return (
    <section>
      <div className="sec-head"><h2>我的</h2></div>
      <div className="card">
        <h3>我的 key</h3>
        {freshKey && (
          <div className="key-reveal" role="status">
            <div className="key-note">请立即保存，明文只显示这一次：</div>
            <div className="key-line">
              <code>{freshKey}</code>
              <button className="btn sm" onClick={() => {
                void navigator.clipboard.writeText(freshKey);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}>{copied ? '已复制' : '复制'}</button>
            </div>
          </div>
        )}
        {authed && me && !freshKey && (
          <>
            <div className="key-status">
              <div>
                <div className="key-masked">
                  <code>sk_••••••••••••••••••••</code>
                  <span className="tag">已保存在本机</span>
                </div>
                <div className="muted key-note">明文只在创建时显示一次（上方黑条即领取时机）；此处不展示密钥，换设备或清除浏览器缓存后需重新申请。</div>
              </div>
              <button className="btn danger" onClick={() => void revoke()}>撤销 key</button>
            </div>
            <div className="muted key-meta">key id（排查用的标识，不是密钥）：{me.key.id}{me.key.label ? ` · ${me.key.label}` : ''} · 创建于 {me.key.createdAt}</div>
          </>
        )}
        {!authed && !freshKey && (
          <div className="form-row">
            <input placeholder="备注名（可选，如：阿伟的钥匙）" value={label} onChange={(e) => setLabel(e.target.value)} aria-label="备注名" />
            <button className="btn primary" onClick={() => void create()}>申请 key</button>
          </div>
        )}
        {error && <div className="error-text">{error}</div>}
      </div>
      {authed && me && (
        <div className="card">
          <h3>我的 Agent</h3>
          {me.agents.length === 0
            ? <div className="muted">还没有 Agent 接入。按「接入指南」启动 bridge 即可。</div>
            : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>名称</th><th>状态</th><th>最近在线</th></tr></thead>
                  <tbody>
                    {me.agents.map((a) => (
                      <tr key={a.id}><td>{a.name}</td><td>{a.status}</td><td className="muted">{a.lastSeenAt ?? '—'}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </div>
      )}
    </section>
  );
}
