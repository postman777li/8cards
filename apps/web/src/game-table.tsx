import { useEffect, useMemo, useState } from 'react';
import type {
  Card,
  CardId,
  GameAction,
  GamePublicState,
  PlayerView,
} from '@8cards/shared';
import { Badge, Button, Panel, PlayerSeat, PlayingCard } from '@8cards/ui';
import type { LobbyConnection } from './realtime-client.js';

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
  const hand = useMemo(() => sortHand(view.private.hand), [view.private.hand]);
  const pairs = useMemo(() => pairTable(game.table), [game.table]);
  const legal = useMemo(
    () => new Set(view.private.legalActionTypes),
    [view.private.legalActionTypes],
  );
  const selfGame = game.players.find(
    (player) => player.playerId === view.viewerPlayerId,
  )!;
  const opponentGame = game.players.find(
    (player) => player.playerId !== view.viewerPlayerId,
  );
  const opponent = view.public.room.players.find(
    (player) => player.playerId === opponentGame?.playerId,
  );
  const self = view.public.room.players.find(
    (player) => player.playerId === view.viewerPlayerId,
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
          : '等待对方操作';

  if (view.public.room.config.playerCount !== 2) {
    return (
      <section className="multiplayer-placeholder">
        <Panel tone="felt">
          <p className="eyebrow">安全占位</p>
          <h1>{view.public.room.config.playerCount} 人牌桌将在任务 17 完成</h1>
          <p>
            当前连接与本人权威状态已安全保留，本页面不会套用二人操作或展示其他玩家手牌。
          </p>
          <Badge tone={connectionState === 'started' ? 'green' : 'red'} dot>
            {connectionState === 'started' ? '实时连接' : '连接需恢复'}
          </Badge>
        </Panel>
      </section>
    );
  }

  return (
    <section className="game-table" aria-label="二人游戏牌桌">
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
        <p className="orientation-tip">
          当前为竖屏布局，旋转至横屏可获得更开阔的牌桌视野。
        </p>
      </header>

      <div className="opponent-zone">
        {opponent && opponentGame && (
          <PlayerSeat
            name={opponent.nickname}
            avatar={opponent.nickname.slice(0, 1)}
            cards={opponentGame.handCount}
            online={opponent.connection === 'online'}
            active={game.currentActorId === opponent.playerId}
            role={roleName(opponentGame.role)}
          />
        )}
      </div>

      <div className="center-table">
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
                  <small>攻牌</small>
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
        <p className="turn-status">{statusText}</p>
      </div>

      <div className="self-zone">
        <div className="self-summary">
          <strong>{self?.nickname ?? '本人'}</strong>
          <span>
            {roleName(selfGame.role)} · {hand.length} 张牌
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
            <h2>
              {game.winnerPlayerIds?.includes(view.viewerPlayerId)
                ? '你赢了'
                : '本局惜败'}
            </h2>
            <p>
              {game.resultReason === 'stuck-with-jokers'
                ? '本局因憋王结束。'
                : '本局由玩家率先出完手牌结束。'}
              完整战绩与结算详情将在任务 18 提供。
            </p>
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
