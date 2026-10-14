import type { AvatarId } from '@8cards/shared';

export const AVATAR_STORAGE_KEY = '8cards:lobby:avatar';

export const avatarOptions: readonly AvatarId[] = [
  'default',
  'avatar-1',
  'avatar-2',
  'avatar-3',
  'avatar-4',
  'avatar-5',
  'avatar-6',
  'avatar-7',
  'avatar-8',
  'avatar-9',
];

export function loadAvatarId(storage: Storage): AvatarId {
  const stored = storage.getItem(AVATAR_STORAGE_KEY);
  return avatarOptions.includes(stored as AvatarId)
    ? (stored as AvatarId)
    : 'default';
}

export function avatarImage(avatarId: AvatarId | undefined): string | null {
  return avatarId && avatarId !== 'default' ? `/avatars/${avatarId}.jpg` : null;
}
