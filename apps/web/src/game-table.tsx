import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  Card,
  CardId,
  GameAction,
  GamePublicState,
  PlayerId,
  PlayerView,
} from '@8cards/shared';
import { Badge, Button, Panel, PlayerSeat, PlayingCard } from '@8cards/ui';
import type { LobbyConnection } from './realtime-client.js';
import { avatarImage } from './avatars.js';

export type TableConnectionState =
  | 'connecting'
  | 'waiting-room'
  | 'disconnected'
  | 'resuming'
  | 'resume-failed'
  | 'started';

const suitOrder = { clubs: 0, diamonds: 1, hearts: 2, spades: 3 } as const;
const rankOrder = {
  '2': 0,
  '3': 1,
  '4': 2,
  '5': 3,
  '6': 4,
  '7': 5,
  '8': 6,
  '9': 7,
  '10': 8,
  J: 9,
  Q: 10,
  K: 11,
  A: 12,
} as const;

export const sortHand = (hand: readonly Card[]): Card[] =>
  [...hand].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'standard' ? -1 : 1;
    if (left.kind === 'joker' && right.kind === 'joker')
      return left.rank === right.rank
        ? 0
        : left.rank === 'small-joker'
          ? -1
          : 1;
    if (left.kind === 'standard' && right.kind === 'standard')
      return (
        suitOrder[left.suit] - suitOrder[right.suit] ||
        rankOrder[left.rank] - rankOrder[right.rank]
      );
    return 0;
  });

export interface TablePair {
  attack: GamePublicState['table'][number];
  defense?: GamePublicState['table'][number];
}

export const pairTable = (plays: GamePublicState['table']): TablePair[] => {
  const pairs: TablePair[] = [];
  for (const play of plays) {
    if (play.purpose === 'attack') pairs.push({ attack: play });
    else {
      const target = [...pairs].reverse().find((pair) => !pair.defense);
      if (target) target.defense = play;
    }
  }
  return pairs;
};

export const secondsRemaining = (deadline: string | null, now: number) =>
  deadline ? Math.max(0, Math.ceil((Date.parse(deadline) - now) / 1000)) : null;

const cardFace = (card: Card) =>
  card.kind === 'joker'
    ? {
        rank: card.rank === 'big-joker' ? '大王' : '小王',
        suit: 'joker' as const,
      }
    : {
        rank: card.rank,
        suit: (
          {
            clubs: 'club',
            diamonds: 'diamond',
            hearts: 'heart',
            spades: 'spade',
          } as const
        )[card.suit],
      };

const suitName = (suit: GamePublicState['trumpSuit']) =>
  suit
    ? (
        {
          clubs: '梅花 ♣',
          diamonds: '方片 ♦',
          hearts: '红桃 ♥',
          spades: '黑桃 ♠',
        } as const
      )[suit]
    : '尚未确定';

const roleName = (role: 'attacker' | 'defender' | 'observer') =>
  ({ attacker: '进攻方', defender: '防守方', observer: '旁观位' })[role];

export type RelativeSeat = 'self' | 'right' | 'top' | 'left';

export const relativeSeatMap = (
  seats: readonly { playerId: string; seat: number }[],
  viewerPlayerId: string,
): Map<string, RelativeSeat> => {
  const ordered = [...seats].sort((left, right) => left.seat - right.seat);
  const viewerIndex = ordered.findIndex(
    (player) => player.playerId === viewerPlayerId,
  );
  if (viewerIndex < 0) return new Map();
  const positions: Record<number, readonly RelativeSeat[]> = {
    2: ['self', 'top'],
    3: ['self', 'right', 'left'],
    4: ['self', 'right', 'top', 'left'],
  };
  const layout = positions[ordered.length] ?? [];
  return new Map(
    ordered.map((player, index) => [
      player.playerId,
      layout[(index - viewerIndex + ordered.length) % ordered.length]!,
    ]),
  );
};

export const playerRoleLabel = (
  player: GamePublicState['players'][number],
  game: GamePublicState,
  viewerTeam: GamePublicState['players'][number]['team'],
) => {
  const role =
    player.role === 'observer'
      ? '旁观本轮 · 不能跟牌'
      : player.playerId === game.attackerId
        ? '本轮主攻'
        : roleName(player.role);
  if (player.team === 'solo') return role;
  return `${player.team === viewerTeam ? '队友' : '对手'} · ${role}`;
};

export const resultCopy = (game: GamePublicState, viewerPlayerId: PlayerId) => {
  const winners = game.winnerPlayerIds ?? [];
  const losers = game.loserPlayerIds ?? [];
  const won = winners.includes(viewerPlayerId);
  const lost = losers.includes(viewerPlayerId);
  const teamGame = game.players.some((player) => player.team !== 'solo');
  const title = won
    ? teamGame
      ? '你所在的队伍获胜'
      : '你赢了'
    : lost
      ? teamGame
        ? '你所在的队伍落败'
        : '你因憋王落败'
      : winners.length
        ? teamGame
          ? '你所在的队伍落败'
          : '本局惜败'
        : '本局结束';
  const detail =
    game.resultReason === 'stuck-with-jokers'
      ? teamGame
        ? lost
          ? '本局因本队憋王结束。'
          : '本局因对方队伍憋王结束。'
        : lost || (winners.length > 0 && !won)
          ? '本局因你触发憋王结束。'
          : '本局因对手触发憋王结束。'
      : '本局由玩家率先出完手牌结束。';
  return { title, detail };
};

function CardView({
  card,
  compact = false,
}: {
  card: Card;
  compact?: boolean;
}) {
  return <PlayingCard {...cardFace(card)} compact={compact} />;
}

export function GameTable({
  view,
  connection,
  connectionState,
  onSafeReturn,
}: {
  view: PlayerView;
  connection: LobbyConnection | undefined;
  connectionState: TableConnectionState;
  onSafeReturn: () => void;
}) {
  const game = view.public.game!;
  const [selected, setSelected] = useState<CardId>();
  const [pending, setPending] = useState(false);
  const [pendingVersion, setPendingVersion] = useState<number>();
  const [actionError, setActionError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [chatOpen, setChatOpen] = useState(false);
  const [chatText, setChatText] = useState('');
  const [messages, setMessages] = useState<
    readonly import('@8cards/shared').ChatMessage[]
  >([]);
  const [history, setHistory] =
    useState<import('./realtime-client.js').VisitorHistory>();
  const [motionCue, setMotionCue] = useState<{
    kind: 'draw' | 'play' | 'collect';
    version: number;
  }>();
  const previousMotion = useRef({
    stockCount: game.stockCount,
    tableCount: game.table.length,
  });
  const hand = useMemo(() => sortHand(view.private.hand), [view.private.hand]);
  const pairs = useMemo(() => pairTable(game.table), [game.table]);
  const legal = useMemo(
    () => new Set(view.private.legalActionTypes),
    [view.private.legalActionTypes],
  );
  const selfGame = game.players.find(
    (player) => player.playerId === view.viewerPlayerId,
  )!;
  const self = view.public.room.players.find(
    (player) => player.playerId === view.viewerPlayerId,
  );
  const seatPositions = useMemo(
    () => relativeSeatMap(view.public.room.players, view.viewerPlayerId),
    [view.public.room.players, view.viewerPlayerId],
  );
  const otherPlayers = view.public.room.players.filter(
    (player) => player.playerId !== view.viewerPlayerId,
  );
  const remaining = secondsRemaining(game.turnDeadline, now);
  const blocked =
    connectionState !== 'started' ||
    !connection ||
    pending ||
    game.phase === 'finished';
  const unresolved = [...pairs].reverse().find((pair) => !pair.defense)?.attack
    .card.id;

  useEffect(() => {
    if (
      selected &&
      (!view.private.hand.some((card) => card.id === selected) ||
        (!legal.has('play-card') && !legal.has('beat-card')))
    )
      setSelected(undefined);
  }, [legal, selected, view.private.hand]);
  useEffect(() => {
    if (
      pendingVersion !== undefined &&
      view.public.stateVersion > pendingVersion
    ) {
      setPending(false);
      setPendingVersion(undefined);
    }
  }, [pendingVersion, view.public.stateVersion]);
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [game.turnDeadline]);
  useEffect(() => {
    if (!connection) return;
    const offChat = connection.subscribeChat(setMessages);
    const offHistory = connection.subscribeHistory(setHistory);
    if (game.phase === 'finished') void connection.history();
    return () => {
      offChat();
      offHistory();
    };
  }, [connection, game.phase]);
  useEffect(() => {
    const previous = previousMotion.current;
    let kind: 'draw' | 'play' | 'collect' | undefined;
    if (game.table.length === 0 && previous.tableCount > 0) kind = 'collect';
    else if (game.table.length > previous.tableCount) kind = 'play';
    else if (game.stockCount < previous.stockCount) kind = 'draw';
    previousMotion.current = {
      stockCount: game.stockCount,
      tableCount: game.table.length,
    };
    if (kind) setMotionCue({ kind, version: view.public.stateVersion });
  }, [game.stockCount, game.table.length, view.public.stateVersion]);

  const submit = async (action: GameAction) => {
    if (blocked || !connection) return;
    setPending(true);
    setPendingVersion(view.public.stateVersion);
    setActionError('');
    try {
      await connection.action(action);
    } catch (caught) {
      setActionError(
        caught instanceof Error ? caught.message : '操作失败，请重试',
      );
      setPending(false);
      setPendingVersion(undefined);
    }
  };
  const submitCard = () => {
    if (!selected) return;
    if (legal.has('beat-card') && unresolved)
      void submit({
        kind: 'beat-card',
        cardId: selected,
        targetCardId: unresolved,
      });
    else if (legal.has('play-card'))
      void submit({ kind: 'play-card', cardId: selected });
  };
  const cardAction = legal.has('beat-card') ? '压牌' : '出牌';
  const statusText =
    game.phase === 'finished'
      ? '本局已结束'
      : game.currentActorId === view.viewerPlayerId
        ? `轮到你${legal.has('beat-card') ? '压牌' : '出牌'}`
        : legal.has('collect')
          ? '你可随时收牌'
          : `等待${game.players.find((player) => player.playerId === game.currentActorId)?.role === 'defender' ? '防守方' : '进攻方'}操作`;
  const result = resultCopy(game, view.viewerPlayerId);

  return (
    <section
      className={`game-table game-table--${view.public.room.config.playerCount}`}
      aria-label={`${view.public.room.config.playerCount}人游戏牌桌`}
    >
      <header className="game-hud">
        <div>
          <small>{view.public.room.name}</small>
          <strong>房间 {view.public.room.code}</strong>
        </div>
        <div className="game-facts">
          <span>主牌 {suitName(game.trumpSuit)}</span>
          <span>牌墩 {game.stockCount} 张</span>
          <span>
            阶段{' '}
            {game.phase === 'attacking'
              ? '进攻'
              : game.phase === 'defending'
                ? '防守'
                : '结束'}
          </span>
        </div>
        <Badge tone={connectionState === 'started' ? 'green' : 'red'} dot>
          {connectionState === 'started'
            ? '实时连接'
            : connectionState === 'resuming'
              ? '正在恢复'
              : '连接中断'}
        </Badge>
        <button
          className="social-toggle"
          type="button"
          onClick={() => setChatOpen((value) => !value)}
        >
          聊天 {messages.length ? `(${messages.length})` : ''}
        </button>
        <p className="orientation-tip">
          当前为竖屏布局，旋转至横屏可获得更开阔的牌桌视野。
        </p>
      </header>

      <div className="player-ring" aria-label="其他玩家座位">
        {otherPlayers.map((player) => {
          const publicPlayer = game.players.find(
            (candidate) => candidate.playerId === player.playerId,
          );
          if (!publicPlayer) return null;
          const position = seatPositions.get(player.playerId) ?? 'top';
          return (
            <div
              className={`table-seat table-seat--${position}`}
              data-player-id={player.playerId}
              key={player.playerId}
            >
              <PlayerSeat
                name={player.nickname}
                avatar={
                  avatarImage(player.avatarId) ? (
                    <img src={avatarImage(player.avatarId)!} alt="" />
                  ) : (
                    player.nickname.slice(0, 1)
                  )
                }
                cards={publicPlayer.handCount}
                online={player.connection === 'online'}
                active={game.currentActorId === player.playerId}
                role={playerRoleLabel(publicPlayer, game, selfGame.team)}
              />
            </div>
          );
        })}
      </div>

      <aside
        className={`social-panel ${chatOpen ? 'open' : ''}`}
        aria-label="房间聊天"
      >
        <header>
          <strong>房间聊天</strong>
          <button type="button" onClick={() => setChatOpen(false)}>
            ×
          </button>
        </header>
        <div className="chat-messages" aria-live="polite">
          {messages.length ? (
            messages.map((item) => (
              <p key={item.messageId}>
                <b>{item.senderNickname}</b>
                <span>{item.message}</span>
                <time>
                  {new Date(item.sentAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </time>
              </p>
            ))
          ) : (
            <small>还没有消息，打个招呼吧。</small>
          )}
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const text = chatText.trim();
            if (!text || !connection) return;
            setChatText('');
            void connection
              .chat(text)
              .catch((caught) =>
                setActionError(
                  caught instanceof Error ? caught.message : '发送失败',
                ),
              );
          }}
        >
          <input
            aria-label="聊天内容"
            maxLength={300}
            value={chatText}
            onChange={(event) => setChatText(event.target.value)}
            placeholder="输入纯文字消息"
          />
          <Button type="submit" disabled={!chatText.trim()}>
            发送
          </Button>
        </form>
      </aside>

      <div className="center-table">
        {motionCue ? (
          <div
            className={`table-motion table-motion--${motionCue.kind}`}
            key={`${motionCue.kind}-${motionCue.version}`}
            aria-hidden="true"
          >
            <i />
            <i />
            <i />
          </div>
        ) : null}
        <div
          className={`turn-clock ${remaining !== null && remaining <= 5 ? 'urgent' : ''}`}
        >
          <strong>{remaining === 0 ? '…' : (remaining ?? '—')}</strong>
          <span>{remaining === 0 ? '等待服务器处理' : '秒'}</span>
        </div>
        <div className="indicator-card">
          <span>公开明牌</span>
          {game.exposedCard ? (
            <CardView card={game.exposedCard} compact />
          ) : (
            <i>牌墩已空</i>
          )}
        </div>
        <div className="table-pairs" aria-label="桌面攻防牌">
          {pairs.length ? (
            pairs.map((pair) => (
              <div className="table-pair" key={pair.attack.card.id}>
                <div>
                  <CardView card={pair.attack.card} compact />
                  <small>
                    {view.public.room.players.find(
                      (player) => player.playerId === pair.attack.playerId,
                    )?.nickname ?? '进攻方'}
                    ·攻
                  </small>
                </div>
                <div className={!pair.defense ? 'uncovered' : ''}>
                  {pair.defense ? (
                    <CardView card={pair.defense.card} compact />
                  ) : (
                    <span>待压</span>
                  )}
                  <small>{pair.defense ? '防牌' : '未压住'}</small>
                </div>
              </div>
            ))
          ) : (
            <p className="empty-table">等待本轮首张攻牌</p>
          )}
        </div>
        <p className="turn-status" key={`${game.currentActorId}-${game.phase}`}>
          {statusText}
        </p>
      </div>

      <div className="self-zone">
        <div className="self-summary">
          <strong>{self?.nickname ?? '本人'}</strong>
          <span>
            {playerRoleLabel(selfGame, game, selfGame.team)} · {hand.length}{' '}
            张牌
          </span>
        </div>
        <div className="hand" aria-label="本人手牌">
          {hand.map((card) => {
            const face = cardFace(card);
            const isSelected = selected === card.id;
            return (
              <PlayingCard
                key={card.id}
                {...face}
                selected={isSelected}
                disabled={blocked}
                role="button"
                tabIndex={blocked ? -1 : 0}
                aria-pressed={isSelected}
                onClick={() =>
                  !blocked && setSelected(isSelected ? undefined : card.id)
                }
                onKeyDown={(event) => {
                  if (
                    !blocked &&
                    (event.key === 'Enter' || event.key === ' ')
                  ) {
                    event.preventDefault();
                    setSelected(isSelected ? undefined : card.id);
                  }
                }}
              />
            );
          })}
        </div>
        <div className="action-bar">
          <Button
            disabled={
              blocked ||
              !selected ||
              (!legal.has('play-card') && !legal.has('beat-card'))
            }
            onClick={submitCard}
          >
            {pending ? '处理中…' : selected ? cardAction : '请选择一张牌'}
          </Button>
          <Button
            variant="secondary"
            disabled={blocked || !legal.has('pass')}
            onClick={() => void submit({ kind: 'pass' })}
          >
            过牌
          </Button>
          <Button
            variant="danger"
            disabled={blocked || !legal.has('collect')}
            onClick={() => void submit({ kind: 'collect' })}
          >
            收牌
          </Button>
          <Button
            variant="ghost"
            disabled={blocked || !legal.has('exchange-trump-two')}
            onClick={() => void submit({ kind: 'exchange-trump-two' })}
          >
            主 2 换明牌
          </Button>
        </div>
        {!selected && (legal.has('play-card') || legal.has('beat-card')) && (
          <p className="action-hint">
            请选择一张牌；具体合法性由服务器最终裁决。
          </p>
        )}
        {actionError && (
          <p className="error" role="alert">
            {actionError}
          </p>
        )}
      </div>

      {game.phase === 'finished' && (
        <div className="table-overlay finished" role="dialog" aria-modal="true">
          <Panel>
            <p className="eyebrow">本局结束</p>
            <h2>{result.title}</h2>
            <p>{result.detail}</p>
            <div className="settlement-participants">
              {view.public.room.players.map((player) => (
                <span key={player.playerId}>
                  {player.nickname} ·{' '}
                  {game.winnerPlayerIds?.includes(player.playerId)
                    ? '胜'
                    : game.loserPlayerIds?.includes(player.playerId)
                      ? '负'
                      : view.public.room.config.playerCount === 2
                        ? '负'
                        : '未决'}
                </span>
              ))}
            </div>
            {history && (
              <p className="history-summary">
                当前访客累计 {history.stats.games} 局 · {history.stats.wins} 胜
                · {history.stats.losses} 负
                {history.stats.unresolved
                  ? ` · ${history.stats.unresolved} 未决`
                  : ''}
              </p>
            )}
            {history?.persistenceStatus === 'pending' && (
              <p className="error">
                对局已权威结束，但战绩仍在等待保存，请稍后重试查询。
              </p>
            )}
            <Button onClick={onSafeReturn}>返回安全首页</Button>
          </Panel>
        </div>
      )}
      {connectionState !== 'started' && game.phase !== 'finished' && (
        <div className="table-overlay" role="alert">
          <Panel>
            <h2>
              {connectionState === 'resuming'
                ? '正在恢复牌局'
                : '牌桌连接已中断'}
            </h2>
            <p>
              恢复期间已停用全部操作；成功后会同步最新手牌、桌面、版本和倒计时。
            </p>
          </Panel>
        </div>
      )}
    </section>
  );
}
