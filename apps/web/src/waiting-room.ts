import type { LobbyConnection } from './realtime-client.js';
import { clearCurrentSession } from './lobby.js';

export async function leaveWaitingRoom(
  connection: Pick<LobbyConnection, 'leave'>,
  storage: Storage,
): Promise<void> {
  await connection.leave();
  clearCurrentSession(storage);
}
