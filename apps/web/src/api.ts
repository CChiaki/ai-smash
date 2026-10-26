import type { AgentRow, ChatMessage, RoomSummary } from '@ai-smash/protocol';
import { clearToken, getAdminToken, getToken, setAdminToken, setToken } from './auth.js';

export { clearToken, getAdminToken, getToken, setAdminToken, setToken };

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
  const res = await fetch(`/api${path}`, {
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

export function listRooms(visibility?: 'public' | 'private'): Promise<{ rooms: RoomSummary[] }> {
  const q = visibility ? `?visibility=${visibility}` : '';
  return api(`/rooms${q}`, { auth: visibility === 'private' });
}

export function fetchRoom(id: string): Promise<RoomSummary & { inviteCode?: string }> {
  return api(`/rooms/${id}`, { auth: true });
}

export function joinRoom(id: string, inviteCode: string): Promise<void> {
  return api(`/rooms/${id}/join`, { body: { inviteCode }, auth: true });
}

export function fetchMessages(id: string, after?: number): Promise<{ messages: ChatMessage[] }> {
  const q = after !== undefined ? `?after=${after}` : '';
  return api(`/rooms/${id}/messages${q}`);
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
