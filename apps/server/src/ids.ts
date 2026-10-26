import { createHash, randomBytes } from 'node:crypto';

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('base64url')}`;
}

export function newKey(): string {
  return `sk_${randomBytes(24).toString('base64url')}`;
}

export function newInviteCode(): string {
  return randomBytes(6).toString('base64url');
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
