import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Badge, Button, Panel, PlayerSeat, PlayingCard } from '@8cards/ui';
import type { Card, ChatMessage, SpectatorView } from '@8cards/shared';
import type { SpectatorConnection, VisitorHistory } from './realtime-client.js';
import { ReactionIcon } from './reaction-icon.js';
import {
  usePresentation,
  PresentationStage,
  RoundRanking,
} from './round-presentation.js';
import { secondsRemaining } from './game-table.js';
import { avatarImage } from './avatars.js';
import { QUICK_PHRASES, REACTIONS, reactionLabel } from './experience.js';

const face = (card: Card) =>
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

export function SpectatorTable({
  view,
  connection,
  onReturn,
  leaving,
  leaveError,
}: {
  view: SpectatorView;
  connection: SpectatorConnection;
  onReturn: () => void;
  leaving: boolean;
  leaveError: string;
}) {
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [history, setHistory] = useState<VisitorHistory>();
  const [text, setText] = useState('');
  const [chatOpen, setChatOpen] = useState(false);
  const messageList = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (messageList.current)
      messageList.current.scrollTop = messageList.current.scrollHeight;
  }, [messages, chatOpen]);
  const game = view.public.game;
  const progress = usePresentation(view.public.series);
  const [now, setNow] = useState(Date.now);
  const [reaction, setReaction] =
    useState<import('@8cards/shared').ReactionEvent>();
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => connection.subscribeReactions(setReaction), [connection]);
  useEffect(() => {
    if (!reaction) return;
    const t = window.setTimeout(() => setReaction(undefined), 2100);
    return () => window.clearTimeout(t);
  }, [reaction]);
  useEffect(() => {
    const a = connection.subscribeChat(setMessages);
    const b = connection.subscribeHistory(setHistory);
    if (
      game?.phase === 'finished' ||
      view.public.series?.phase === 'series-result'
    )
      void connection.history();
    return () => {
      a();
      b();
    };
  }, [connection, game?.phase, view.public.series?.phase]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    if (!value) return;
    setText('');
    void connection.chat(value);
  };
  return (
    <section className="spectator-layout">
      {reaction ? (
        <div className="reaction-burst" role="status">
          <ReactionIcon id={reaction.reactionId} />
          <strong>{reactionLabel[reaction.reactionId]}</strong>
        </div>
      ) : null}
      <PresentationStage
        series={view.public.series}
        positions={
          new Map(
            view.public.room.players.map((p, i) => [
              p.playerId,
              ['self', 'right', 'top', 'left'][i]!,
            ]),
          )
        }
      />
      <Panel className="spectator-board" tone="felt">
        <header className="room-title">
          <div>
            <p className="eyebrow">只读观战</p>
            <h1>{view.public.room.name}</h1>
          </div>
          <Badge tone="gold" dot>
            观战中 · 不能操作
          </Badge>
          <button
            className="spectator-chat-toggle"
            type="button"
            aria-label="打开观战聊天"
            aria-expanded={chatOpen}
            onClick={() => setChatOpen(true)}
          >
            聊天
          </button>
        </header>
        <div className="spectator-seats">
          {view.public.room.players.map((player) => {
            const count =
              progress?.count(player.playerId) ??
              game?.players.find((item) => item.playerId === player.playerId)
                ?.handCount;
            return (
              <div key={player.playerId} data-player-id={player.playerId}>
                <PlayerSeat
                  name={player.nickname}
                  avatar={
                    avatarImage(player.avatarId) ? (
                      <img src={avatarImage(player.avatarId)!} alt="" />
                    ) : (
                      player.nickname.slice(0, 1)
                    )
                  }
                  online={player.connection === 'online'}
                  {...(count === undefined ? {} : { cards: count })}
                  {...(game?.currentActorId === player.playerId
                    ? { role: '当前行动者' }
                    : {})}
                />
              </div>
            );
          })}
        </div>
        {game ? (
          <div className="spectator-timing">
            <div className="stock-stack">
              <span>
                牌墩 <strong>{progress?.stock ?? game.stockCount}</strong>
              </span>
            </div>
            <div className="turn-clock">
              <strong>
                {secondsRemaining(game.turnDeadline, now) ?? '发牌'}
              </strong>
              <span>{progress ? '计时未开始' : '秒'}</span>
            </div>
          </div>
        ) : null}
        <div className="spectator-table-cards">
          {game?.table.length ? (
            game.table.map((play) => (
              <div key={`${play.card.id}-${play.purpose}`}>
                <PlayingCard {...face(play.card)} compact />
                <small>{play.purpose === 'attack' ? '攻' : '防'}</small>
              </div>
            ))
          ) : (
            <p>桌面暂时没有牌</p>
          )}
        </div>
        {(game?.phase === 'finished' ||
          view.public.series?.lastRoundResult) && (
          <Panel className="spectator-settlement">
            <h2>本局已结束</h2>
            <p>
              {view.public.series?.lastRoundResult?.reason === 'forfeit'
                ? '退出结算'
                : game?.resultReason === 'stuck-with-jokers'
                  ? '憋王结算'
                  : '空手获胜'}
            </p>
            <RoundRanking
              series={view.public.series}
              players={view.public.room.players}
            />
            {view.public.series?.phase === 'continue-vote' ? (
              <p>
                继续投票{' '}
                {
                  view.public.series.continueVotes.filter(
                    (vote) => vote.choice === 'continue',
                  ).length
                }
                /{view.public.series.continueVotes.length}
              </p>
            ) : null}
            {history && <p>本浏览器累计 {history.stats.games} 局</p>}
          </Panel>
        )}
        {leaveError && (
          <p className="error" role="alert">
            {leaveError}
          </p>
        )}
        <Button variant="ghost" onClick={onReturn} disabled={leaving}>
          {leaving ? '正在安全离开…' : '返回首页'}
        </Button>
      </Panel>
      <Panel className={`spectator-chat ${chatOpen ? 'is-open' : ''}`}>
        <header className="spectator-chat-header">
          <h2>房间聊天</h2>
          <button
            className="spectator-chat-close"
            type="button"
            aria-label="关闭观战聊天"
            onClick={() => setChatOpen(false)}
          >
            ×
          </button>
        </header>
        <div className="chat-messages" ref={messageList}>
          {messages.map((item) => (
            <p key={item.messageId}>
              <b>{item.senderNickname}</b>
              <span>{item.message}</span>
            </p>
          ))}
        </div>
        <div className="quick-phrases" aria-label="观战快捷语">
          {QUICK_PHRASES.map((phrase) => (
            <button
              type="button"
              key={phrase}
              onClick={() => void connection.chat(phrase).catch(() => {})}
            >
              {phrase}
            </button>
          ))}
        </div>
        <div className="reaction-picker" aria-label="观战表情互动">
          {REACTIONS.map((item) => (
            <button
              type="button"
              key={item}
              aria-label={reactionLabel[item]}
              onClick={() => void connection.reaction(item).catch(() => {})}
            >
              <ReactionIcon id={item} />
              <span>{reactionLabel[item]}</span>
            </button>
          ))}
        </div>
        <form onSubmit={submit}>
          <input
            aria-label="观战聊天内容"
            maxLength={300}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="以观战者身份发言"
          />
          <Button type="submit">发送</Button>
        </form>
      </Panel>
    </section>
  );
}
