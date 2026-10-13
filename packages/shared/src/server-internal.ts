import type { Card } from './cards.js';
import type { ConnectionId, PlayerId } from './common.js';
import type { PublicSnapshot } from './game-state.js';

/** Server-only authority model. It is intentionally absent from every event schema. */
export interface ServerAuthoritativeState {
  public: PublicSnapshot;
  handsByPlayer: Readonly<Record<PlayerId, readonly Card[]>>;
  drawPile: readonly Card[];
  randomSeed: string;
  reconnectTokens: Readonly<Record<PlayerId, string>>;
  connectionIds: Readonly<Record<PlayerId, ConnectionId>>;
}
