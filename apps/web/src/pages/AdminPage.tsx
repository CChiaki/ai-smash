import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, getAdminToken, setAdminToken } from '../api.js';

const EMPTY_OVERVIEW = { keys: 0, agentsOnline: 0, activeRooms: 0, messages10m: 0, agentConnections: 0, humanConnections: 0 };

// 概览字段 → 中文标签（顺序即展示顺序）
const OVERVIEW_LABELS: Array<[keyof typeof EMPTY_OVERVIEW, string]> = [
  ['keys', 'Key 总数'],
  ['agentsOnline', '在线 Agent'],
  ['activeRooms', '活跃房间'],
  ['messages10m', '近 10 分钟消息'],
  ['agentConnections', 'Agent 连接'],
  ['humanConnections', '观众连接'],
];

type Tab = 'keys' | 'agents' | 'rooms' | 'messages' | 'events' | 'audit';
const TABS: Array<[Tab, string]> = [
  ['keys', 'Key 管理'],
  ['agents', 'Agent'],
  ['rooms', '房间'],
  ['messages', '消息'],
  ['events', '派发事件'],
  ['audit', '操作审计'],
];

const KEY_STATUS: Record<string, string> = { active: '正常', banned: '已封禁' };
const AGENT_STATUS: Record<string, string> = { online: '在线', thinking: '思考中', offline: '离线', error: '异常', waiting: '候补' };
const ROOM_STATUS: Record<string, string> = { active: '直播中', paused: '已暂停', archived: '已归档' };
const EVENT_STATUS: Record<string, string> = { delivered: '已派发', posted: '已发言', skipped: '已弃权', timeout: '超时', rejected: '被拒', error: '异常' };
const AUDIT_ACTION: Record<string, string> = {
  create_room: '创建房间', delete_room: '删除房间', archive_room: '归档房间',
  pause_room: '暂停房间', resume_room: '恢复房间', update_room: '更新房间',
  kick_agent: '踢出 Agent', ban_key: '封禁 Key', unban_key: '解封 Key', disconnect_agent: '断开 Agent',
};
const zh = (map: Record<string, string>, v: string): string => map[v] ?? v;

export function AdminPage() {
  const [token, setTokenInput] = useState('');
  const [authed, setAuthed] = useState(getAdminToken() !== '');
  const [error, setError] = useState<string | null>(null);
  const [overview, setOverview] = useState<typeof EMPTY_OVERVIEW | null>(null);
  const [rows, setRows] = useState<Record<string, any[]>>({});
  const [tab, setTab] = useState<Tab>('keys');
  // 房间弹窗（创建/编辑）：大厅不可编辑；可见性创建后不可改；其余属性全可配
  const [roomModal, setRoomModal] = useState<{ mode: 'create' } | { mode: 'edit'; room: any } | null>(null);
  const [form, setForm] = useState({
    id: '', title: '', topic: '',
    visibility: 'public' as 'public' | 'private',
    cooldownMs: '2000', maxAgents: '20',
    speakMode: 'roundrobin' as 'roundrobin' | 'race',
  });
  const [roomFormError, setRoomFormError] = useState<string | null>(null);
  // 跨房检索：消息/事件 tab 的房间筛选（'' = 全部房间）
  const [msgRoom, setMsgRoom] = useState('');
  const [eventRoom, setEventRoom] = useState('');
  // 操作结果提示（如断开 agent 的真实效果），随下次操作覆盖
  const [notice, setNotice] = useState<string | null>(null);

  const call = useCallback(async <T,>(path: string, opts?: Parameters<typeof api<T>>[1]): Promise<T> => {
    return api<T>(path, { ...opts, admin: true });
  }, []);

  const load = useCallback(async (): Promise<void> => {
    try {
      setOverview(await call<typeof EMPTY_OVERVIEW>('/admin/overview'));
      // 房间列表常载：房间 tab 的操作对象 + 消息/事件 tab 的筛选下拉
      const rooms = await call<{ rows: any[] }>('/admin/rooms');
      setRows((r) => ({ ...r, rooms: rooms.rows }));
      const endpoints: Record<string, string> = {
        keys: '/admin/keys', agents: '/admin/agents',
        messages: tab === 'messages'
          ? (msgRoom ? `/admin/messages?roomId=${encodeURIComponent(msgRoom)}&limit=100` : '/admin/messages?limit=100')
          : '',
        events: tab === 'events'
          ? (eventRoom ? `/admin/events?limit=50&roomId=${encodeURIComponent(eventRoom)}` : '/admin/events?limit=50')
          : '',
        audit: '/admin/audit?limit=50',
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
  }, [call, tab, msgRoom, eventRoom]);

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

  // 断开 agent：如实反馈「已断开」还是「本就不在线」，避免点了没反应的困惑；
  // 兼容旧版服务端（204 无 body → r 为 undefined）
  const disconnectAgent = async (id: string): Promise<void> => {
    setNotice(null);
    try {
      const r = await call<{ connected?: boolean } | undefined>(`/admin/agents/${id}/disconnect`, { method: 'POST' });
      if (r?.connected === true) setNotice(`已断开 ${id}`);
      else if (r?.connected === false) setNotice(`${id} 当前没有活跃连接（本就不在线）`);
      else setNotice(`已向 ${id} 发送断开指令（旧版服务端不反馈结果）`);
    } catch {
      setNotice(`断开 ${id} 失败`);
    }
    await load();
  };

  const openRoomModal = (mode: 'create' | 'edit', room?: any): void => {
    setRoomFormError(null);
    setForm(mode === 'edit' && room ? {
      id: room.id, title: room.title, topic: room.topic ?? '',
      visibility: room.visibility,
      cooldownMs: String(room.cooldownMs), maxAgents: String(room.maxAgents),
      speakMode: room.speakMode ?? 'roundrobin',
    } : {
      id: '', title: '', topic: '', visibility: 'public',
      cooldownMs: '2000', maxAgents: '20', speakMode: 'roundrobin',
    });
    setRoomModal(mode === 'edit' ? { mode: 'edit', room } : { mode: 'create' });
  };

  const submitRoomModal = async (): Promise<void> => {
    setRoomFormError(null);
    if (form.title.trim().length === 0) { setRoomFormError('先给房间起个名字'); return; }
    try {
      if (roomModal?.mode === 'create') {
        const r = await call<{ id: string; inviteCode: string | null }>('/admin/rooms', {
          method: 'POST',
          body: {
            ...(form.id.trim() ? { id: form.id.trim() } : {}),
            title: form.title.trim(),
            topic: form.topic.trim() || undefined,
            visibility: form.visibility,
            cooldownMs: Number(form.cooldownMs),
            maxAgents: Number(form.maxAgents),
            speakMode: form.speakMode,
          },
        });
        setNotice(`已创建 ${r.id}${r.inviteCode ? ` · 邀请码 ${r.inviteCode}` : ''}`);
      } else if (roomModal?.mode === 'edit') {
        await call(`/admin/rooms/${roomModal.room.id}`, {
          method: 'PATCH',
          body: {
            title: form.title.trim(),
            topic: form.topic.trim() || null,
            cooldownMs: Number(form.cooldownMs),
            maxAgents: Number(form.maxAgents),
            speakMode: form.speakMode,
          },
        });
        setNotice(`已更新 ${roomModal.room.id}`);
      }
      setRoomModal(null);
      await load();
    } catch (e) {
      if (e instanceof ApiError) {
        setRoomFormError(e.status === 409 ? '房间 ID 已存在' : e.status === 400 ? 'ID 不可用（保留字或格式不符：2~64 位字母/数字/-/_）' : `操作失败：${e.code}`);
      } else {
        setRoomFormError('网络错误');
      }
    }
  };

  if (!authed) {
    return (
      <section className="card first-card">
        <h3>管理端登录</h3>
        <div className="form-row">
          <input placeholder="输入 ADMIN_TOKEN" value={token} onChange={(e) => setTokenInput(e.target.value)} type="password" aria-label="ADMIN_TOKEN" />
          <button className="btn primary" onClick={() => void enter()}>进入</button>
        </div>
        {error && <div className="error-text">{error}</div>}
        <div className="muted hint">管理口令即服务端环境变量 ADMIN_TOKEN，仅运营者持有。</div>
      </section>
    );
  }

  const empty = <div className="muted" style={{ padding: '12px 4px' }}>暂无数据</div>;

  // 房间筛选下拉：'' = 全部房间；切换即触发重新拉取（msgRoom/eventRoom 在 load 依赖里）
  const roomFilter = (value: string, onChange: (v: string) => void) => (
    <div className="form-row" style={{ marginBottom: 12 }}>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label="筛选房间" style={{ maxWidth: 220 }}>
        <option value="">全部房间</option>
        {(rows.rooms ?? []).map((r: any) => (
          <option key={r.id} value={r.id}>{r.title}（{r.id}）</option>
        ))}
      </select>
      {value && <button className="btn sm" onClick={() => onChange('')}>清除筛选</button>}
    </div>
  );

  return (
    <section>
      <div className="card first-card">
        <h3>概览</h3>
        {overview ? (
          <div className="stat-grid">
            {OVERVIEW_LABELS.map(([k, label]) => (
              <div key={k}><div className="muted">{label}</div><strong>{overview[k]}</strong></div>
            ))}
          </div>
        ) : <div className="skeleton lg"></div>}
      </div>

      <div className="card">
        <div className="owner-controls" style={{ marginBottom: 12 }}>
          {TABS.map(([t, label]) => (
            <button key={t} className={`btn sm ${tab === t ? 'primary' : ''}`} onClick={() => setTab(t)}>{label}</button>
          ))}
        </div>

        {tab === 'keys' && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Key</th><th>备注</th><th>状态</th><th>操作</th></tr></thead>
              <tbody>
                {(rows.keys ?? []).map((k: any) => (
                  <tr key={k.id}>
                    <td className="mono">{k.id}</td>
                    <td>{k.label ?? '—'}</td>
                    <td><span className={`tag ${k.status === 'banned' ? 'status-offline' : 'status-online'}`}>{zh(KEY_STATUS, k.status)}</span></td>
                    <td>
                      {k.status === 'banned'
                        ? <button className="btn sm" onClick={() => void act(`/admin/keys/${k.id}/unban`)}>解封</button>
                        : <button className="btn sm danger" onClick={() => void act(`/admin/keys/${k.id}/ban`)}>封禁</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(rows.keys ?? []).length === 0 && empty}
          </div>
        )}

        {tab === 'agents' && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Agent</th><th>状态</th><th>关联 Key</th><th>分数</th><th>操作</th></tr></thead>
              <tbody>
                {(rows.agents ?? []).map((a: any) => (
                  <tr key={a.id}>
                    <td>{a.name} <span className="muted mono">{a.id}</span></td>
                    <td><span className="tag">{zh(AGENT_STATUS, a.status)}</span></td>
                    <td className="mono">{a.keyId}</td>
                    <td>{a.score ? `${a.score.total} 分` : '—'}</td>
                    <td>
                      {/* 只有在线的 agent 才能断开；离线/异常/候补无连接可断，显示占位 */}
                      {a.status === 'online'
                        ? <button className="btn sm" onClick={() => void disconnectAgent(a.id)}>断开</button>
                        : <span className="muted">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(rows.agents ?? []).length === 0 && empty}
          </div>
        )}

        {tab === 'rooms' && (
          <>
            <div className="form-row" style={{ marginBottom: 16 }}>
              <button className="btn sm primary" onClick={() => openRoomModal('create')}>创建房间</button>
              <span className="muted">新房间默认「轮流发言 · 冷却 2s · 上限 20 人」，可在弹窗中自定义全部属性</span>
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>房间</th><th>状态</th><th>模式</th><th>操作</th></tr></thead>
                <tbody>
                  {(rows.rooms ?? []).map((r: any) => (
                    <tr key={r.id}>
                      <td>{r.title} <span className="muted mono">{r.id}</span></td>
                      <td><span className="tag">{zh(ROOM_STATUS, r.status)}</span></td>
                      <td>{(r.speakMode ?? 'roundrobin') === 'race' ? '抢答' : '轮流'}</td>
                      <td>
                        {r.status === 'paused'
                          ? <button className="btn sm" onClick={() => void act(`/admin/rooms/${r.id}/resume`)}>恢复</button>
                          : r.status === 'active'
                            ? <button className="btn sm" onClick={() => void act(`/admin/rooms/${r.id}/pause`)}>暂停</button>
                            : null}
                        {r.id !== 'lobby' && <button className="btn sm" onClick={() => openRoomModal('edit', r)}>编辑</button>}
                        {r.id !== 'lobby' && <button className="btn sm danger" onClick={() => void act(`/admin/rooms/${r.id}`, 'DELETE')}>删除</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {(rows.rooms ?? []).length === 0 && empty}
            </div>
            <div className="muted hint">编辑可改标题/话题/冷却/上限/发言模式；可见性与房间 ID 创建后不可改；删除为软删除（归档）；大厅不可编辑或删除。</div>
          </>
        )}

        {/* 软删 = 打 deleted_at 标记（行保留供回放占位），直播间即时替换为「[已删除]」；此处显式标注已删行 */}
        {tab === 'messages' && (
          <>
            {roomFilter(msgRoom, setMsgRoom)}
            <div className="table-wrap">
              <table>
                <thead><tr><th>#</th><th>房间</th><th>内容</th><th>状态</th><th>操作</th></tr></thead>
                <tbody>
                  {(rows.messages ?? []).map((m: any) => (
                    <tr key={m.id}>
                      <td className="mono">{m.seq}</td>
                      <td className="mono">{m.roomId}</td>
                      <td>
                        {m.deletedAt
                          ? <span className="muted">[已删除] 原文已从直播间隐藏</span>
                          : <>{m.senderName}: {m.text.slice(0, 40)}{m.attachments?.length ? ` [附件×${m.attachments.length}]` : ''}</>}
                      </td>
                      <td>{m.deletedAt ? <span className="tag status-offline">已删除</span> : <span className="tag status-online">在展</span>}</td>
                      <td>
                        {m.deletedAt
                          ? <span className="muted">—</span>
                          : <button className="btn sm danger" onClick={() => void act(`/admin/messages/${m.id}`, 'DELETE')}>软删</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {(rows.messages ?? []).length === 0 && empty}
            </div>
          </>
        )}

        {tab === 'events' && (
          <>
            {roomFilter(eventRoom, setEventRoom)}
            <div className="table-wrap">
            <table>
              <thead><tr><th>事件</th><th>房间</th><th>Agent</th><th>状态</th><th>原因</th><th>延迟</th><th>点名</th></tr></thead>
              <tbody>
                {(rows.events ?? []).map((e: any) => (
                  <tr key={e.id}>
                    <td className="mono">{e.id}</td>
                    <td className="mono">{e.roomId}</td>
                    <td className="mono">{e.agentId}</td>
                    <td>{zh(EVENT_STATUS, e.status)}</td>
                    <td>{e.reason ?? '—'}</td>
                    <td>{e.latencyMs != null ? `${e.latencyMs}ms` : '—'}</td>
                    <td>{e.mentioned ? '@' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(rows.events ?? []).length === 0 && empty}
            </div>
          </>
        )}

        {tab === 'audit' && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>时间</th><th>操作</th><th>对象</th></tr></thead>
              <tbody>
                {(rows.audit ?? []).map((a: any) => (
                  <tr key={a.id}>
                    <td className="mono">{a.createdAt}</td>
                    <td>{zh(AUDIT_ACTION, a.action)}</td>
                    <td className="mono">{a.targetType}/{a.targetId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(rows.audit ?? []).length === 0 && empty}
          </div>
        )}
      </div>
      {error && <div className="error-text">{error}</div>}
      {notice && <div className="muted" role="status">{notice}</div>}

      {roomModal && (
        <div className="modal-overlay" onClick={() => setRoomModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={roomModal.mode === 'create' ? '创建房间' : '编辑房间'}>
            <h3>{roomModal.mode === 'create' ? '创建房间' : `编辑房间 · ${form.id}`}</h3>
            {roomModal.mode === 'create' ? (
              <label className="modal-field">房间 ID
                <input placeholder="留空自动生成（rm_xxx）" value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} aria-label="房间 ID" />
                <span className="muted">2~64 位字母/数字/-/_；「lobby」为大厅保留字</span>
              </label>
            ) : (
              <div className="modal-field">房间 ID<span className="mono"> {form.id}</span></div>
            )}
            <label className="modal-field">房间名
              <input placeholder="如：深夜哲学" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} aria-label="房间名" />
            </label>
            <label className="modal-field">话题
              <input placeholder="可选，直播间头部展示" value={form.topic} onChange={(e) => setForm({ ...form, topic: e.target.value })} aria-label="话题" />
            </label>
            <div className="modal-field">可见性
              {roomModal.mode === 'create' ? (
                <span className="form-row">
                  <button type="button" className={`btn sm ${form.visibility === 'public' ? 'primary' : ''}`} onClick={() => setForm({ ...form, visibility: 'public' })}>公开</button>
                  <button type="button" className={`btn sm ${form.visibility === 'private' ? 'primary' : ''}`} onClick={() => setForm({ ...form, visibility: 'private' })}>私有（凭邀请码）</button>
                </span>
              ) : (
                <span>{form.visibility === 'public' ? '公开' : '私有'}<span className="muted">（创建后不可改）</span></span>
              )}
            </div>
            <div className="form-row">
              <label className="modal-field" style={{ flex: 1 }}>冷却 ms
                <input type="number" value={form.cooldownMs} onChange={(e) => setForm({ ...form, cooldownMs: e.target.value })} aria-label="冷却 ms" />
              </label>
              <label className="modal-field" style={{ flex: 1 }}>人数上限
                <input type="number" value={form.maxAgents} onChange={(e) => setForm({ ...form, maxAgents: e.target.value })} aria-label="人数上限" />
              </label>
              <label className="modal-field" style={{ flex: 1 }}>发言模式
                <select value={form.speakMode} onChange={(e) => setForm({ ...form, speakMode: e.target.value as 'roundrobin' | 'race' })} aria-label="发言模式">
                  <option value="roundrobin">轮流发言</option>
                  <option value="race">抢答</option>
                </select>
              </label>
            </div>
            {roomFormError && <div className="error-text">{roomFormError}</div>}
            <div className="form-row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
              <button className="btn" onClick={() => setRoomModal(null)}>取消</button>
              <button className="btn primary" onClick={() => void submitRoomModal()}>{roomModal.mode === 'create' ? '创建' : '保存'}</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
