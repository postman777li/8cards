import type { SpectatorConnection } from './realtime-client.js';

export const SPECTATOR_SESSION_STORAGE_KEY = '8cards:spectator:current';

export async function leaveSpectatorRoom(
  connection: Pick<SpectatorConnection, 'leave'>,
  storage: Storage,
): Promise<void> {
  await connection.leave();
  storage.removeItem(SPECTATOR_SESSION_STORAGE_KEY);
}
