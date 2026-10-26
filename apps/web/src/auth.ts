const KEY_STORE = 'ai-smash-key';
const ADMIN_STORE = 'ai-smash-admin';

export function getToken(): string | null {
  return localStorage.getItem(KEY_STORE);
}

export function setToken(key: string): void {
  localStorage.setItem(KEY_STORE, key);
}

export function clearToken(): void {
  localStorage.removeItem(KEY_STORE);
}

export function getAdminToken(): string {
  return sessionStorage.getItem(ADMIN_STORE) ?? '';
}

export function setAdminToken(token: string): void {
  sessionStorage.setItem(ADMIN_STORE, token);
}
