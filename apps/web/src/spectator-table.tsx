import { useEffect, useState, type FormEvent } from 'react';
import { Badge, Button, Panel, PlayerSeat, PlayingCard } from '@8cards/ui';
import type { Card, ChatMessage, SpectatorView } from '@8cards/shared';
import type { SpectatorConnection, VisitorHistory } from './realtime-client.js';

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
}: {
  view: SpectatorView;
  connection: SpectatorConnection;
  onReturn: () => void;
}) {
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [history, setHistory] = useState<VisitorHistory>();
  const [text, setText] = useState('');
  const game = view.public.game;
  useEffect(() => {
    const a = connection.subscribeChat(setMessages);
    const b = connection.subscribeHistory(setHistory);
    if (game?.phase === 'finished') void connection.history();
    return () => {
      a();
      b();
    };
  }, [connection, game?.phase]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    if (!value) return;
    setText('');
    void connection.chat(value);
  };
  return (
    <section className="spectator-layout">
      <Panel className="spectator-board" tone="felt">
        <header className="room-title">
          <div>
            <p className="eyebrow">只读观战</p>
            <h1>{view.public.room.name}</h1>
          </div>
          <Badge tone="gold" dot>
            观战中 · 不能操作
          </Badge>
        </header>
        <div className="spectator-seats">
          {view.public.room.players.map((player) => {
            const count = game?.players.find(
              (item) => item.playerId === player.playerId,
            )?.handCount;
            return (
              <PlayerSeat
                key={player.playerId}
                name={player.nickname}
                avatar={player.nickname.slice(0, 1)}
                online={player.connection === 'online'}
                {...(count === undefined ? {} : { cards: count })}
                {...(game?.currentActorId === player.playerId
                  ? { role: '当前行动者' }
                  : {})}
              />
            );
          })}
        </div>
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
        {game?.phase === 'finished' && (
          <Panel className="spectator-settlement">
            <h2>本局已结束</h2>
            <p>
              {game.resultReason === 'stuck-with-jokers'
                ? '憋王结算'
                : '空手获胜'}
            </p>
            {history && <p>本浏览器累计 {history.stats.games} 局</p>}
          </Panel>
        )}
        <Button variant="ghost" onClick={onReturn}>
          返回首页
        </Button>
      </Panel>
      <Panel className="spectator-chat">
        <h2>房间聊天</h2>
        <div className="chat-messages">
          {messages.map((item) => (
            <p key={item.messageId}>
              <b>{item.senderNickname}</b>
              <span>{item.message}</span>
            </p>
          ))}
        </div>
        <form onSubmit={submit}>
          <input
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
