import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import type { RoomSeries, PublicSnapshot, PlayerId } from '@8cards/shared';
import { avatarImage } from './avatars.js';

export function presentationProgress(
  series: RoomSeries | undefined,
  now: number,
) {
  const p = series?.presentation;
  if (!p || now >= Date.parse(p.readyAt)) return undefined;
  const completed = Math.min(
    p.recipients.length,
    Math.max(0, Math.floor((now - Date.parse(p.dealsAt)) / p.stepMs)),
  );
  return {
    p,
    completed,
    stock: p.stockBefore - completed,
    count: (id: PlayerId) =>
      (p.beforeCounts.find((x) => x.playerId === id)?.count ?? 0) +
      p.recipients.slice(0, completed).filter((x) => x === id).length,
  };
}

export function usePresentation(series: RoomSeries | undefined) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!series?.presentation) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 40);
    return () => window.clearInterval(timer);
  }, [series?.presentation]);
  return presentationProgress(series, now);
}

export function PresentationStage({
  series,
  positions,
}: {
  series: RoomSeries | undefined;
  positions: Map<string, string>;
}) {
  const progress = usePresentation(series);
  const stage = useRef<HTMLDivElement>(null);
  const [flightStyle, setFlightStyle] = useState<CSSProperties>({});
  useLayoutEffect(() => {
    if (!progress) return;
    const update = () => {
      const element = stage.current;
      const root = element?.parentElement;
      const id = progress.p.recipients[progress.completed];
      if (!element || !root || !id) return;
      const stock = root.querySelector('.stock-stack')?.getBoundingClientRect();
      const seat = root.querySelector(
        '[data-player-id="' + CSS.escape(id) + '"]',
      );
      const target = (
        seat?.querySelector('.hand') ?? seat
      )?.getBoundingClientRect();
      if (!stock || !target) return;
      const bounds = element.getBoundingClientRect();
      const startX = stock.x + stock.width / 2 - bounds.x;
      const startY = stock.y + stock.height / 2 - bounds.y;
      const endX = target.x + target.width / 2 - bounds.x;
      const endY = target.y + target.height / 2 - bounds.y;
      const middleX = root
        .querySelector('.spectator-board')
        ?.getBoundingClientRect();
      const laneX = middleX
        ? middleX.x + middleX.width / 2 - bounds.x
        : bounds.width / 2;
      setFlightStyle({
        '--deal-x': startX + 'px',
        '--deal-y': startY + 'px',
        '--deal-dx': endX - startX + 'px',
        '--deal-dy': endY - startY + 'px',
        '--deal-lane': laneX - startX + 'px',
      } as CSSProperties);
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [progress?.p.id, progress?.completed]);
  if (!progress) return null;
  const { p, completed } = progress;
  const intro = Date.now() < Date.parse(p.dealsAt);
  return (
    <div
      ref={stage}
      className="presentation-stage"
      aria-label="权威发牌演出"
      data-presentation-id={p.id}
      data-completed={completed}
      data-total={p.recipients.length}
    >
      {intro && p.kind === 'initial' ? (
        <div
          className={
            series?.multiplierReason === 'easter-egg'
              ? 'egg-opening'
              : 'round-opening'
          }
          role="status"
        >
          <span>
            {series?.multiplierReason === 'easter-egg'
              ? '彩蛋局'
              : series?.multiplierReason === 'winning-streak'
                ? '连胜擂台局'
                : '洗牌 · 即将开局'}
          </span>
          <strong>
            {series?.multiplierReason === 'normal'
              ? '永城八张'
              : series?.multiplier + ' 倍'}
          </strong>
          <small>好运登场 · 随后逐张发牌</small>
        </div>
      ) : null}
      {!intro && completed < p.recipients.length ? (
        <i
          key={p.id + '-' + completed}
          className={
            'single-deal single-deal--' +
            (positions.get(p.recipients[completed]!) ?? 'top')
          }
          style={
            { ...flightStyle, '--deal-step': p.stepMs + 'ms' } as CSSProperties
          }
          data-recipient={p.recipients[completed]}
          aria-label="一张牌背飞向座位"
        >
          八
        </i>
      ) : null}
      {!intro && (
        <span className="deal-caption">
          {p.kind === 'initial' ? '逆时针发牌' : '按座次补牌'} {completed}/
          {p.recipients.length}
        </span>
      )}
    </div>
  );
}

const signed = (n: number) => (n >= 0 ? '+' : '') + n;
function AnimatedDelta({ value, delay }: { value: number; delay: number }) {
  const [shown, setShown] = useState(value);
  useEffect(() => {
    if (
      window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
      document.documentElement.dataset.reduceMotion === 'true'
    ) {
      setShown(value);
      return;
    }
    let frame = 0;
    const started = performance.now() + delay;
    const tick = (now: number) => {
      const ratio = Math.min(1, Math.max(0, (now - started) / 450));
      setShown(Math.round(value * ratio));
      if (ratio < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, delay]);
  return <span aria-label={'本局 ' + signed(value)}>{signed(shown)}</span>;
}
export function RoundRanking({
  series,
  players,
}: {
  series: RoomSeries | undefined;
  players: PublicSnapshot['room']['players'];
}) {
  const result = series?.lastRoundResult;
  if (!result) return null;
  return (
    <div className="round-ranking" aria-label="本局权威排名">
      <p className="round-reason">
        {result.reason === 'stuck-with-jokers'
          ? '空桌主攻憋王 · 提前结算'
          : result.reason === 'forfeit'
            ? '退出结算'
            : '完整出完排名'}
        {players.length === 4 ? ' · 保留原队伍计分' : ''}
      </p>
      {[...result.participants]
        .sort((a, b) => a.rank - b.rank)
        .map((item, index) => {
          const player = players.find((p) => p.playerId === item.playerId)!;
          const tied =
            result.participants.filter((p) => p.rank === item.rank).length > 1;
          return (
            <article
              className={'rank-row round-rank-row rank-row--' + item.rank}
              key={item.playerId}
              style={{ '--reveal-delay': index * 120 + 'ms' } as CSSProperties}
              data-rank={item.rank}
              data-player-id={item.playerId}
            >
              <b className="rank-medal">{item.rank}</b>
              <div className="rank-avatar">
                {avatarImage(player.avatarId) ? (
                  <img src={avatarImage(player.avatarId)!} alt="" />
                ) : (
                  player.nickname.slice(0, 1)
                )}
              </div>
              <span>
                <strong>{player.nickname}</strong>
                <small>
                  {tied ? '并列 ' : ''}第 {item.rank} 名 ·{' '}
                  {item.outcome === 'win'
                    ? '胜'
                    : item.outcome === 'loss'
                      ? '负'
                      : '未决'}
                  {players.length === 4
                    ? ' · ' + (player.seat % 2 === 0 ? '甲队' : '乙队')
                    : ''}
                </small>
                <small>
                  基础 {signed(item.baseScore)} × {item.multiplier} 倍 = 本局{' '}
                  {signed(item.delta)}
                </small>
              </span>
              <em className="round-delta">
                <AnimatedDelta value={item.delta} delay={index * 120} />
                <small>总分 {signed(item.totalScore)}</small>
              </em>
            </article>
          );
        })}
    </div>
  );
}
