import { useEffect, useState } from 'react';
import { Badge, Button, Panel, PlayerSeat, PlayingCard } from '@8cards/ui';

import { prototypeScenes, sceneFromHash, type SceneId } from './navigation.js';

const Icon = ({ children }: { children: string }) => (
  <span aria-hidden="true">{children}</span>
);

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand ${compact ? 'brand--compact' : ''}`}>
      <span className="brand__seal" aria-hidden="true">
        八
      </span>
      <div>
        <strong>永城八张</strong>
        <span>YONGCHENG EIGHT</span>
      </div>
    </div>
  );
}

function SceneNav({
  scene,
  onChange,
}: {
  scene: SceneId;
  onChange: (scene: SceneId) => void;
}) {
  return (
    <nav className="scene-nav" aria-label="原型场景导航">
      <Brand compact />
      <div className="scene-nav__links">
        {prototypeScenes.map((item, index) => (
          <button
            type="button"
            key={item.id}
            className={scene === item.id ? 'is-current' : ''}
            aria-current={scene === item.id ? 'page' : undefined}
            onClick={() => onChange(item.id)}
          >
            <span>{String(index + 1).padStart(2, '0')}</span>
            {item.label}
          </button>
        ))}
      </div>
      <Badge tone="green" dot>
        本地原型
      </Badge>
    </nav>
  );
}

function HomeScene({ go }: { go: (scene: SceneId) => void }) {
  const [nickname, setNickname] = useState('麦田守望者');
  const [roomCode, setRoomCode] = useState('');

  return (
    <main className="home-scene scene-shell">
      <div className="ambient ambient--one" />
      <div className="ambient ambient--two" />
      <section className="home-hero" aria-labelledby="home-title">
        <p className="eyebrow">
          <span /> 河南永城 · 好友局
        </p>
        <h1 id="home-title">
          <span>一桌老友，</span>八张见真章。
        </h1>
        <p className="home-hero__lead">
          熟悉的乡音与牌局，跨过距离重新围坐。无需注册，叫上朋友就开局。
        </p>
        <div className="home-hero__features" aria-label="游戏特色">
          <span>
            <Icon>◈</Icon> 2—4 人私密房
          </span>
          <span>
            <Icon>↺</Icon> 断线可重连
          </span>
          <span>
            <Icon>◎</Icon> 电脑 · 手机横屏
          </span>
        </div>
      </section>
      <Panel className="entry-card" aria-labelledby="entry-title">
        <div className="entry-card__heading">
          <div>
            <span className="section-kicker">今晚打几圈</span>
            <h2 id="entry-title">入座开局</h2>
          </div>
          <span className="entry-card__ornament" aria-hidden="true">
            ♠
          </span>
        </div>
        <label className="field">
          <span>你的昵称</span>
          <span className="field__control">
            <Icon>人</Icon>
            <input
              value={nickname}
              maxLength={12}
              onChange={(event) => setNickname(event.target.value)}
            />
          </span>
        </label>
        <Button
          size="large"
          className="entry-card__primary"
          onClick={() => go('create')}
          icon={<Icon>＋</Icon>}
        >
          创建好友房
        </Button>
        <div className="divider">
          <span>或者加入牌局</span>
        </div>
        <div className="join-row">
          <label className="field field--inline">
            <span className="sr-only">六位房间短码</span>
            <span className="field__control">
              <Icon>#</Icon>
              <input
                value={roomCode}
                maxLength={6}
                placeholder="输入 6 位房间码"
                onChange={(event) =>
                  setRoomCode(event.target.value.toUpperCase())
                }
              />
            </span>
          </label>
          <Button variant="secondary" onClick={() => go('waiting')}>
            加入
          </Button>
        </div>
        <p className="entry-card__note">
          <Icon>◆</Icon> 当前为视觉原型，房间与对局均为模拟数据
        </p>
      </Panel>
      <footer className="home-footer">
        <button type="button">
          <Icon>▤</Icon> 玩法规则
        </button>
        <span />
        <button type="button">
          <Icon>◷</Icon> 历史战绩
        </button>
        <small>原创视觉概念 · UI PROTOTYPE 04</small>
      </footer>
    </main>
  );
}

function Toggle({
  label,
  description,
  checked,
  onChange,
  icon,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  icon: string;
}) {
  return (
    <label className="toggle-row">
      <span className="setting-row__icon">{icon}</span>
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="toggle-row__control" aria-hidden="true">
        <span />
      </span>
    </label>
  );
}

function CreateScene({ go }: { go: (scene: SceneId) => void }) {
  const [mode, setMode] = useState(4);
  const [spectators, setSpectators] = useState(true);
  const [chat, setChat] = useState(true);
  return (
    <main className="form-scene scene-shell">
      <div className="form-scene__backdrop" aria-hidden="true">
        <span>八</span>
      </div>
      <header className="page-heading">
        <button
          className="back-button"
          type="button"
          onClick={() => go('home')}
          aria-label="返回首页"
        >
          ←
        </button>
        <div>
          <p className="eyebrow">
            <span /> 好友牌局
          </p>
          <h1>创建房间</h1>
          <p>定好规矩，等老友入座。</p>
        </div>
        <Badge tone="gold">预计 1 分钟</Badge>
      </header>
      <div className="create-layout">
        <Panel className="create-form">
          <label className="field">
            <span>
              房间名称 <small>最多 16 个字</small>
            </span>
            <span className="field__control">
              <Icon>屋</Icon>
              <input defaultValue="老城南门好友局" maxLength={16} />
            </span>
          </label>
          <fieldset className="choice-group">
            <legend>参与人数</legend>
            <div className="mode-grid">
              {[2, 3, 4].map((value) => (
                <button
                  type="button"
                  key={value}
                  className={mode === value ? 'is-selected' : ''}
                  onClick={() => setMode(value)}
                >
                  <span className="mode-grid__figures" aria-hidden="true">
                    {'●'.repeat(value)}
                  </span>
                  <strong>{value} 人局</strong>
                  <small>
                    {value === 2
                      ? '短兵相接'
                      : value === 3
                        ? '各自为战'
                        : '对家组队'}
                  </small>
                  <span className="mode-grid__check">✓</span>
                </button>
              ))}
            </div>
          </fieldset>
          <div className="setting-row">
            <div>
              <span className="setting-row__icon">◷</span>
              <span>
                <strong>行动倒计时</strong>
                <small>超时将执行默认动作</small>
              </span>
            </div>
            <span className="stepper">
              <button type="button" aria-label="减少时间">
                −
              </button>
              <strong>20 秒</strong>
              <button type="button" aria-label="增加时间">
                ＋
              </button>
            </span>
          </div>
          <Toggle
            label="允许观战"
            description="观战者无法查看任何玩家手牌"
            checked={spectators}
            onChange={setSpectators}
            icon="◉"
          />
          <Toggle
            label="房间聊天"
            description="仅本房间玩家与观战者可见"
            checked={chat}
            onChange={setChat}
            icon="◌"
          />
          <Button
            size="large"
            className="create-form__submit"
            onClick={() => go('waiting')}
          >
            创建房间 <Icon>→</Icon>
          </Button>
        </Panel>
        <aside className="create-preview" aria-label="房间设置预览">
          <div className="preview-table">
            <span className="preview-table__center">
              八<small>YONGCHENG</small>
            </span>
            {[0, 1, 2, 3].map((seat) => (
              <span
                key={seat}
                className={`preview-seat preview-seat--${seat} ${seat >= mode ? 'is-hidden' : ''}`}
              />
            ))}
          </div>
          <div>
            <span className="section-kicker">房间预览</span>
            <h2>老城南门好友局</h2>
            <p>
              {mode} 人 · 20 秒 · {spectators ? '允许观战' : '禁止观战'} ·{' '}
              {chat ? '开启聊天' : '关闭聊天'}
            </p>
          </div>
          <blockquote>
            “牌桌规矩由服务端统一执行，本页仅展示未来的创建体验。”
          </blockquote>
        </aside>
      </div>
    </main>
  );
}

function WaitingScene({ go }: { go: (scene: SceneId) => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <main className="waiting-scene scene-shell">
      <header className="room-bar">
        <Brand compact />
        <div className="room-bar__title">
          <span>四人好友局</span>
          <strong>老城南门好友局</strong>
        </div>
        <div className="room-code">
          <span>房间码</span>
          <strong>Y8K 204</strong>
          <button type="button" onClick={() => setCopied(true)}>
            {copied ? '已复制 ✓' : '复制邀请'}
          </button>
        </div>
        <button className="icon-button" type="button" aria-label="房间设置">
          ⚙
        </button>
      </header>
      <section className="waiting-content">
        <div className="waiting-main">
          <div className="waiting-copy">
            <Badge tone="green" dot>
              房间已就绪
            </Badge>
            <h1>等一位老友入座</h1>
            <p>4 人对家模式 · 20 秒倒计时 · 允许观战</p>
          </div>
          <div className="seat-grid">
            <PlayerSeat
              name="麦田守望者"
              avatar="麦"
              status="房主 · 已准备"
              role="房主"
            />
            <PlayerSeat name="豫东小旋风" avatar="风" status="已准备" />
            <PlayerSeat name="归德客" avatar="归" status="已准备" />
            <div className="empty-seat">
              <span>＋</span>
              <strong>等待玩家</strong>
              <small>分享房间码邀请好友</small>
            </div>
          </div>
          <div className="waiting-actions">
            <Button variant="secondary" icon={<Icon>↗</Icon>}>
              分享邀请
            </Button>
            <Button size="large" disabled>
              等待玩家到齐 · 3/4
            </Button>
          </div>
        </div>
        <Panel as="aside" className="chat-panel" aria-label="房间聊天演示">
          <header>
            <div>
              <strong>牌桌闲聊</strong>
              <span>3 人在线</span>
            </div>
            <Badge tone="neutral">模拟消息</Badge>
          </header>
          <div className="chat-panel__messages">
            <p className="system-message">19:48 · 豫东小旋风加入了房间</p>
            <div className="chat-message">
              <span>风</span>
              <p>
                <strong>
                  豫东小旋风 <small>19:49</small>
                </strong>
                我到了，就差老张了。
              </p>
            </div>
            <div className="chat-message chat-message--self">
              <span>麦</span>
              <p>
                <strong>
                  麦田守望者 <small>19:49</small>
                </strong>
                我把房间码再发他一遍。
              </p>
            </div>
            <div className="chat-message">
              <span>归</span>
              <p>
                <strong>
                  归德客 <small>19:50</small>
                </strong>
                今晚可别又剩俩王 😄
              </p>
            </div>
          </div>
          <div className="chat-panel__input">
            <input placeholder="说点什么…" aria-label="聊天消息（原型）" />
            <button type="button" aria-label="发送消息">
              ↑
            </button>
          </div>
        </Panel>
      </section>
      <button
        className="prototype-skip"
        type="button"
        onClick={() => go('table')}
      >
        原型演示：直接进入牌桌 →
      </button>
    </main>
  );
}

const handCards = [
  { rank: '2', suit: 'heart' as const, legal: false, disabled: true },
  { rank: '3', suit: 'spade' as const, legal: true, disabled: false },
  { rank: '5', suit: 'club' as const, legal: true, disabled: false },
  { rank: '5', suit: 'diamond' as const, legal: true, disabled: false },
  { rank: '8', suit: 'heart' as const, legal: false, disabled: false },
  { rank: '10', suit: 'club' as const, legal: false, disabled: false },
  { rank: 'Q', suit: 'spade' as const, legal: false, disabled: false },
  { rank: 'A', suit: 'heart' as const, legal: false, disabled: false },
];

function TableScene({ go }: { go: (scene: SceneId) => void }) {
  const [selected, setSelected] = useState<number[]>([2]);
  const toggleCard = (index: number) =>
    setSelected((current) =>
      current.includes(index)
        ? current.filter((item) => item !== index)
        : [...current, index],
    );
  return (
    <main className="table-scene scene-shell">
      <header className="table-hud">
        <Brand compact />
        <div className="table-hud__room">
          <strong>老城南门好友局</strong>
          <span>#Y8K204 · 第 3 局</span>
        </div>
        <div className="table-hud__status">
          <Badge tone="green" dot>
            网络良好
          </Badge>
          <button type="button" aria-label="声音">
            ♪
          </button>
          <button type="button" aria-label="设置">
            ⚙
          </button>
          <button type="button" aria-label="聊天">
            ◌<span>2</span>
          </button>
        </div>
      </header>
      <section className="game-table" aria-label="四人游戏牌桌视觉原型">
        <div className="felt-texture" />
        <div className="table-brand" aria-hidden="true">
          <span>永城</span>
          <strong>八张</strong>
          <small>YONGCHENG EIGHT</small>
        </div>
        <div className="seat-position seat-position--top">
          <PlayerSeat
            name="对家 · 豫东小旋风"
            avatar="风"
            cards={6}
            role="旁观本轮"
            compact
          />
        </div>
        <div className="seat-position seat-position--left">
          <PlayerSeat name="归德客" avatar="归" cards={5} role="进攻" compact />
        </div>
        <div className="seat-position seat-position--right">
          <PlayerSeat
            name="老张"
            avatar="张"
            cards={7}
            role="防守"
            active
            compact
          />
        </div>
        <div className="round-info">
          <div>
            <span>主牌</span>
            <strong className="suit-red">♥ 红桃</strong>
          </div>
          <i />
          <div>
            <span>当前行动</span>
            <strong>你 · 进攻方</strong>
          </div>
          <i />
          <div>
            <span>牌墩</span>
            <strong>18 张</strong>
          </div>
        </div>
        <div className="timer-ring" aria-label="剩余 12 秒">
          <svg viewBox="0 0 48 48" aria-hidden="true">
            <circle cx="24" cy="24" r="20" />
            <circle className="timer-ring__progress" cx="24" cy="24" r="20" />
          </svg>
          <strong>12</strong>
          <span>秒</span>
        </div>
        <div className="deck-stack" aria-label="牌墩剩余 18 张">
          <PlayingCard rank="" suit="club" facedown compact />
          <span>18</span>
        </div>
        <div className="played-cards">
          <span className="played-cards__label">桌面 · 引牌 5</span>
          <PlayingCard rank="5" suit="heart" compact />
          <PlayingCard rank="8" suit="heart" compact />
        </div>
        <div className="player-zone">
          <div className="player-zone__identity">
            <span className="avatar-small">麦</span>
            <span>
              <strong>麦田守望者</strong>
              <small>
                <Badge tone="gold">进攻方</Badge> 8 张牌
              </small>
            </span>
          </div>
          <div className="hand" aria-label="你的模拟手牌">
            {handCards.map((card, index) => (
              <button
                key={`${card.rank}-${card.suit}`}
                type="button"
                className="hand__card-button"
                disabled={card.disabled}
                onClick={() => toggleCard(index)}
                aria-pressed={selected.includes(index)}
              >
                <PlayingCard
                  rank={card.rank}
                  suit={card.suit}
                  legal={card.legal}
                  disabled={card.disabled}
                  selected={selected.includes(index)}
                />
              </button>
            ))}
          </div>
          <div className="action-bar">
            <Button variant="ghost" disabled>
              主 2 换明牌
            </Button>
            <Button variant="secondary">过</Button>
            <Button variant="danger" disabled>
              收牌
            </Button>
            <Button size="large" onClick={() => go('result')}>
              出牌 <span className="key-hint">空格</span>
            </Button>
          </div>
          <p className="turn-hint">
            <span>✓</span> 绿色描边并带“可出”标签的牌为合法牌；灰暗牌当前不可用
          </p>
        </div>
      </section>
    </main>
  );
}

function ResultScene({ go }: { go: (scene: SceneId) => void }) {
  return (
    <main className="result-scene scene-shell">
      <div className="result-rays" aria-hidden="true" />
      <section className="result-card" aria-labelledby="result-title">
        <span className="result-card__laurel" aria-hidden="true">
          ❧ · ♛ · ❧
        </span>
        <p className="eyebrow">
          <span /> 本局结算
        </p>
        <h1 id="result-title">漂亮收官！</h1>
        <p>
          你与 <strong>豫东小旋风</strong> 率先出完手牌
        </p>
        <div className="winner-pair">
          <div>
            <span>麦</span>
            <strong>麦田守望者</strong>
            <small>首位出完</small>
          </div>
          <i>搭档</i>
          <div>
            <span>风</span>
            <strong>豫东小旋风</strong>
            <small>剩余 2 张</small>
          </div>
        </div>
        <div className="result-stats">
          <div>
            <span>本局用时</span>
            <strong>08:42</strong>
          </div>
          <div>
            <span>成功防守</span>
            <strong>6 次</strong>
          </div>
          <div>
            <span>连胜</span>
            <strong>2 局</strong>
          </div>
        </div>
        <div className="result-actions">
          <Button size="large" onClick={() => go('waiting')}>
            再来一局
          </Button>
          <Button
            size="large"
            variant="secondary"
            onClick={() => go('waiting')}
          >
            返回房间
          </Button>
        </div>
        <button className="result-share" type="button">
          ↗ 分享战绩
        </button>
      </section>
      <p className="result-note">
        本页为静态结算演示，不包含真实胜负判断或战绩保存
      </p>
    </main>
  );
}

export function App() {
  const [scene, setScene] = useState<SceneId>(() =>
    sceneFromHash(window.location.hash),
  );
  useEffect(() => {
    const onHashChange = () => setScene(sceneFromHash(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  const go = (next: SceneId) => {
    window.location.hash = `/${next}`;
    setScene(next);
  };
  return (
    <div className={`prototype prototype--${scene}`}>
      <SceneNav scene={scene} onChange={go} />
      {scene === 'home' ? <HomeScene go={go} /> : null}
      {scene === 'create' ? <CreateScene go={go} /> : null}
      {scene === 'waiting' ? <WaitingScene go={go} /> : null}
      {scene === 'table' ? <TableScene go={go} /> : null}
      {scene === 'result' ? <ResultScene go={go} /> : null}
    </div>
  );
}
