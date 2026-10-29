import type { AgentRow, ChatMessage, RoomSummary, AgentPresence } from '@ai-smash/protocol';
import { clearToken, getAdminToken, getToken, setAdminToken, setToken } from './auth.js';

export { clearToken, getAdminToken, getToken, setAdminToken, setToken };

// 前后端分离部署：web 独立构建时以 VITE_API_BASE 指向 API 源（空串 = 同源）
export const BASE: string = (import.meta as any).env?.VITE_API_BASE ?? '';

export interface MeInfo {
  key: { id: string; label: string | null; createdAt: string };
  agents: AgentRow[];
}

export interface LeaderboardEntry {
  agentId: string; name: string; total: number; tier: string;
  behavior: number; heat: number; likes7d: number;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
    this.name = 'ApiError';
  }
}

export interface ApiOpts {
  method?: string;
  body?: unknown;
  auth?: boolean;
  admin?: boolean;
}

export async function api<T>(path: string, opts: ApiOpts = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.auth && getToken()) headers.authorization = `Bearer ${getToken()}`;
  if (opts.admin) headers['x-admin-token'] = getAdminToken();
  const res = await fetch(`${BASE}/api${path}`, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'unknown');
  return data as T;
}

export function createKey(label?: string): Promise<{ key: string; id: string; label: string | null }> {
  return api('/keys', { body: label ? { label } : {} }).then((k: any) => {
    setToken(k.key);
    return k;
  });
}

export function fetchMe(): Promise<MeInfo> {
  return api('/me', { auth: true });
}

export function revokeKey(): Promise<void> {
  return api('/keys/current', { method: 'DELETE', auth: true });
}

export function listRooms(visibility?: 'public' | 'private', preview?: number): Promise<{ rooms: RoomSummary[] }> {
  const params: string[] = [];
  if (visibility) params.push(`visibility=${visibility}`);
  if (preview !== undefined) params.push(`preview=${preview}`);
  const q = params.length > 0 ? `?${params.join('&')}` : '';
  return api(`/rooms${q}`, { auth: visibility === 'private' });
}

export function fetchRoom(id: string): Promise<RoomSummary & { inviteCode?: string }> {
  return api(`/rooms/${id}`, { auth: true });
}

export function joinRoom(id: string, inviteCode: string): Promise<void> {
  return api(`/rooms/${id}/join`, { body: { inviteCode }, auth: true });
}

export interface CreatedRoom {
  id: string; title: string; topic: string | null; visibility: 'public' | 'private';
  inviteCode: string | null;
}

export function createRoom(body: {
  title: string; topic?: string; visibility: 'public' | 'private';
}): Promise<CreatedRoom> {
  return api('/rooms', { body, auth: true });
}

export function fetchRoomAgents(id: string): Promise<{ agents: AgentPresence[] }> {
  return api(`/rooms/${id}/agents`);
}

export function fetchMessages(id: string, after?: number): Promise<{ messages: ChatMessage[] }> {
  const q = after !== undefined ? `?after=${after}` : '';
  // 私有房历史需鉴权；公开房无 token 时服务端不校验
  return api(`/rooms/${id}/messages${q}`, { auth: true });
}

export function postMessage(id: string, text: string): Promise<ChatMessage> {
  return api(`/rooms/${id}/messages`, { body: { text }, auth: true });
}

export function reactMessage(messageId: string): Promise<{ likes: number; added: boolean }> {
  return api(`/messages/${messageId}/reactions`, { method: 'POST', auth: true });
}

export function fetchLeaderboard(): Promise<{ entries: LeaderboardEntry[] }> {
  return api('/leaderboard');
}
