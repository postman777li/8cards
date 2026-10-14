import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Badge, Button, Panel, PlayerSeat } from '@8cards/ui';
import type { AvatarId } from '@8cards/shared';
import {
  NICKNAME_STORAGE_KEY,
  buildShareUrl,
  loadCurrentSession,
  loadSettings,
  normalizeNickname,
  normalizeRoomCode,
  normalizeRoomName,
  roomCodeFromUrl,
  saveSession,
  saveSettings,
  validateNickname,
  validateRoomCode,
  validateRoomName,
  type LobbySettings,
  getOrCreateVisitorId,
} from './lobby.js';
import {
  connectToLobby,
  LobbyConnectionError,
  resolveWebSocketUrl,
  resumeLobby,
  type LobbyConnection,
  type LobbyRequest,
  spectateRoom,
  resumeSpectator,
  type SpectatorConnection,
} from './realtime-client.js';
import { leaveWaitingRoom } from './waiting-room.js';
import { GameTable } from './game-table.js';
import { SpectatorTable } from './spectator-table.js';
import {
  leaveSpectatorRoom,
  SPECTATOR_SESSION_STORAGE_KEY,
} from './spectator-session.js';
import {
  AVATAR_STORAGE_KEY,
  avatarImage,
  avatarOptions,
  loadAvatarId,
} from './avatars.js';

type Page = 'home' | 'create' | 'settings' | 'entered';
type SessionState =
  | 'connecting'
  | 'waiting-room'
  | 'disconnected'
  | 'resuming'
  | 'resume-failed'
  | 'started';
const fallbackError = '暂时无法进入房间，请稍后重试';

function Brand() {
  return (
    <div className="brand">
      <b>八</b>
      <span>
        <strong>YD八张</strong>
        <small>YD EIGHT</small>
      </span>
    </div>
  );
}

function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="toggle">
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <i aria-hidden="true" />
    </label>
  );
}

export default function App() {
  const initialCode = useMemo(
    () => roomCodeFromUrl(new URL(location.href)),
    [],
  );
  const [page, setPage] = useState<Page>('home');
  const [nickname, setNickname] = useState(
    () => localStorage.getItem(NICKNAME_STORAGE_KEY) ?? '',
  );
  const [avatarId, setAvatarId] = useState<AvatarId>(() =>
    loadAvatarId(localStorage),
  );
  const [roomCode, setRoomCode] = useState(initialCode);
  const [roomName, setRoomName] = useState('');
  const [playerCount, setPlayerCount] = useState<2 | 3 | 4>(4);
  const [settings, setSettings] = useState<LobbySettings>(() =>
    loadSettings(localStorage),
  );
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [connection, setConnection] = useState<LobbyConnection>();
  const [spectatorConnection, setSpectatorConnection] =
    useState<SpectatorConnection>();
  const [spectatorView, setSpectatorView] =
    useState<SpectatorConnection['view']>();
  const [view, setView] = useState<LobbyConnection['view']>();
  const [sessionState, setSessionState] = useState<SessionState>('connecting');
  const [copied, setCopied] = useState(false);
  const activeCancel = useRef<(() => void) | null>(null);
  const activeConnection = useRef<LobbyConnection | null>(null);
  const activeSpectator = useRef<SpectatorConnection | null>(null);
  const recoveryAttempt = useRef(0);

  useEffect(() => {
    const stored = loadCurrentSession(localStorage);
    const storedSpectator = (() => {
      try {
        return JSON.parse(
          localStorage.getItem(SPECTATOR_SESSION_STORAGE_KEY) ?? 'null',
        ) as {
          roomId: never;
          spectatorId: never;
          reconnectToken: string;
          visitorId: never;
        } | null;
      } catch {
        return null;
      }
    })();
    const restoreTimer = stored
      ? window.setTimeout(() => void recover(stored), 0)
      : storedSpectator
        ? window.setTimeout(() => void recoverSpectator(storedSpectator), 0)
        : undefined;
    return () => {
      if (restoreTimer !== undefined) window.clearTimeout(restoreTimer);
      activeCancel.current?.();
      activeConnection.current?.close();
      activeSpectator.current?.close();
    };
  }, []);
  useEffect(() => {
    document.documentElement.dataset.reduceMotion = settings.reducedMotion
      ? 'true'
      : 'false';
  }, [settings.reducedMotion]);

  const persistNickname = () => {
    const value = normalizeNickname(nickname);
    const problem = validateNickname(value);
    if (problem) {
      setError(problem);
      return null;
    }
    setNickname(value);
    localStorage.setItem(NICKNAME_STORAGE_KEY, value);
    return value;
  };
  const activate = (result: LobbyConnection) => {
    activeConnection.current?.close();
    activeConnection.current = result;
    setConnection(result);
    setView(result.view);
    setSessionState(result.view.public.game ? 'started' : 'waiting-room');
    result.subscribe((next) => {
      if (activeConnection.current !== result) return;
      setView(next);
      setSessionState(next.public.game ? 'started' : 'waiting-room');
    });
    result.onDisconnect(() => {
      if (activeConnection.current !== result) return;
      setSessionState('disconnected');
      const credential = {
        roomId: result.roomId,
        playerId: result.playerId,
        reconnectToken: result.reconnectToken,
      };
      window.setTimeout(() => {
        if (activeConnection.current === result) void recover(credential);
      }, 500);
    });
  };
  const recover = async (stored = loadCurrentSession(localStorage)) => {
    if (!stored || recoveryAttempt.current >= 2) {
      setSessionState('resume-failed');
      setPage('entered');
      return;
    }
    recoveryAttempt.current += 1;
    setSessionState('resuming');
    setPage('entered');
    try {
      const operation = resumeLobby(stored, {
        url: resolveWebSocketUrl(window.location, import.meta.env.VITE_WS_URL),
      });
      activeCancel.current = operation.cancel;
      const result = await operation.promise;
      recoveryAttempt.current = 0;
      saveSession(localStorage, result);
      activate(result);
    } catch (caught) {
      setError(
        caught instanceof LobbyConnectionError ? caught.message : fallbackError,
      );
      setSessionState('resume-failed');
    } finally {
      activeCancel.current = null;
    }
  };
  const activateSpectator = (result: SpectatorConnection) => {
    activeSpectator.current?.close();
    activeSpectator.current = result;
    setSpectatorConnection(result);
    setSpectatorView(result.view);
    setPage('entered');
    setSessionState('started');
    result.subscribe((next) => setSpectatorView(next));
    result.onDisconnect(() => setSessionState('disconnected'));
    localStorage.setItem(
      SPECTATOR_SESSION_STORAGE_KEY,
      JSON.stringify({
        roomId: result.roomId,
        spectatorId: result.spectatorId,
        reconnectToken: result.reconnectToken,
        visitorId: result.visitorId,
      }),
    );
  };
  const recoverSpectator = async (stored: {
    roomId: never;
    spectatorId: never;
    reconnectToken: string;
    visitorId: never;
  }) => {
    try {
      const operation = resumeSpectator(stored, {
        url: resolveWebSocketUrl(window.location, import.meta.env.VITE_WS_URL),
      });
      activateSpectator(await operation.promise);
    } catch {
      localStorage.removeItem(SPECTATOR_SESSION_STORAGE_KEY);
      setSessionState('resume-failed');
    }
  };
  const startSpectating = async () => {
    const name = persistNickname();
    const code = normalizeRoomCode(roomCode);
    const problem = validateRoomCode(code);
    if (!name || problem) {
      if (problem) setError(problem);
      return;
    }
    setPending(true);
    setError('');
    try {
      const operation = spectateRoom(
        {
          nickname: name,
          avatarId,
          roomCode: code,
          visitorId: getOrCreateVisitorId(localStorage),
        },
        {
          url: resolveWebSocketUrl(
            window.location,
            import.meta.env.VITE_WS_URL,
          ),
        },
      );
      activateSpectator(await operation.promise);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : fallbackError);
    } finally {
      setPending(false);
    }
  };
  const leaveSpectating = async () => {
    const current = activeSpectator.current;
    if (!current || pending) return;
    setPending(true);
    setError('');
    try {
      await leaveSpectatorRoom(current, localStorage);
      current.close();
      activeSpectator.current = null;
      setSpectatorConnection(undefined);
      setSpectatorView(undefined);
      go('home');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : fallbackError);
    } finally {
      setPending(false);
    }
  };
  const run = async (request: LobbyRequest) => {
    if (pending) return;
    setPending(true);
    setError('');
    setSessionState('connecting');
    try {
      const operation = connectToLobby(request, {
        url: resolveWebSocketUrl(window.location, import.meta.env.VITE_WS_URL),
      });
      activeCancel.current = operation.cancel;
      const result = await operation.promise;
      saveSession(localStorage, result);
      recoveryAttempt.current = 0;
      activate(result);
      setPage('entered');
    } catch (caught) {
      setError(
        caught instanceof LobbyConnectionError ? caught.message : fallbackError,
      );
    } finally {
      activeCancel.current = null;
      setPending(false);
    }
  };
  const submitJoin = (event: FormEvent) => {
    event.preventDefault();
    const name = persistNickname();
    const code = normalizeRoomCode(roomCode);
    const problem = validateRoomCode(code);
    if (!name || problem) {
      if (problem) setError(problem);
      return;
    }
    setRoomCode(code);
    void run({
      kind: 'join',
      nickname: name,
      avatarId,
      roomCode: code,
      visitorId: getOrCreateVisitorId(localStorage),
    });
  };
  const submitCreate = (event: FormEvent) => {
    event.preventDefault();
    const name = persistNickname();
    const title = normalizeRoomName(roomName);
    const problem = validateRoomName(title);
    if (!name || problem) {
      if (problem) setError(problem);
      return;
    }
    setRoomName(title);
    void run({
      kind: 'create',
      nickname: name,
      avatarId,
      roomName: title,
      playerCount,
      visitorId: getOrCreateVisitorId(localStorage),
    });
  };
  const updateSettings = (next: LobbySettings) => {
    setSettings(next);
    saveSettings(localStorage, next);
  };
  const go = (next: Page) => {
    setError('');
    setCopied(false);
    setPage(next);
  };
  const finishReturnHome = () => {
    activeConnection.current?.close();
    activeConnection.current = null;
    setConnection(undefined);
    setView(undefined);
    go('home');
  };
  const requestLeave = async () => {
    const current = activeConnection.current;
    if (!current || pending || sessionState !== 'waiting-room') return;
    setPending(true);
    setError('');
    try {
      await leaveWaitingRoom(current, localStorage);
      finishReturnHome();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : fallbackError);
    } finally {
      setPending(false);
    }
  };
  const returnHomePreservingSession = () => {
    activeCancel.current?.();
    activeCancel.current = null;
    activeConnection.current?.close();
    activeConnection.current = null;
    setConnection(undefined);
    setView(undefined);
    go('home');
  };
  const room = view?.public.room;
  const self = room?.players.find(
    (player) => player.playerId === connection?.playerId,
  );
  const shareUrl = room ? buildShareUrl(new URL(location.href), room.code) : '';

  return (
    <main className="app-shell">
      <div className="ambient one" />
      <div className="ambient two" />
      <header className="topbar">
        <Brand />
        <button
          className="quiet-button"
          type="button"
          onClick={() => go(page === 'settings' ? 'home' : 'settings')}
        >
          ⚙ 设置
        </button>
      </header>
      {page === 'home' && (
        <section className="home-layout">
          <div className="hero">
            <p className="eyebrow">河南永城 · 好友局</p>
            <h1>
              一桌老友，
              <br />
              <em>八张见真章。</em>
            </h1>
            <p>无需注册，输入昵称就能邀请远方朋友，重新围坐一桌。</p>
            <div className="chips">
              <span>2–4 人私密房</span>
              <span>20 秒回合</span>
              <span>断线凭证保存</span>
            </div>
          </div>
          <Panel className="entry-card">
            <header>
              <span>
                <small>今晚打几圈</small>
                <h2>入座开局</h2>
              </span>
              <b>♠</b>
            </header>
            <label className="field">
              <span>你的昵称</span>
              <input
                value={nickname}
                maxLength={24}
                autoComplete="nickname"
                placeholder="例如：麦田守望者"
                onChange={(e) => setNickname(e.target.value)}
              />
            </label>
            <fieldset className="avatar-picker">
              <legend>选择头像</legend>
              <div className="avatar-options">
                {avatarOptions.map((option, index) => {
                  const image = avatarImage(option);
                  return (
                    <button
                      key={option}
                      className={option === avatarId ? 'is-selected' : ''}
                      type="button"
                      aria-label={
                        option === 'default'
                          ? '使用默认头像'
                          : `使用头像 ${index}`
                      }
                      aria-pressed={option === avatarId}
                      onClick={() => {
                        setAvatarId(option);
                        localStorage.setItem(AVATAR_STORAGE_KEY, option);
                      }}
                    >
                      {image ? (
                        <img src={image} alt="" />
                      ) : (
                        <span>{nickname.trim().slice(0, 1) || '默'}</span>
                      )}
                    </button>
                  );
                })}
              </div>
              <small>默认头像使用昵称首字，也可以选择图片头像。</small>
            </fieldset>
            <Button
              size="large"
              type="button"
              onClick={() => {
                if (persistNickname()) go('create');
              }}
              disabled={pending}
            >
              ＋ 创建好友房
            </Button>
            <div className="divider">或者加入牌局</div>
            <form className="join-form" onSubmit={submitJoin}>
              <label className="field">
                <span className="sr-only">房间码</span>
                <input
                  value={roomCode}
                  maxLength={6}
                  autoCapitalize="characters"
                  placeholder="输入 6 位房间码"
                  onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
                />
              </label>
              <Button variant="secondary" type="submit" disabled={pending}>
                {pending ? '连接中…' : '加入'}
              </Button>
            </form>
            <Button
              variant="ghost"
              type="button"
              disabled={pending}
              onClick={() => void startSpectating()}
            >
              以观战者身份加入
            </Button>
            {initialCode && <p className="notice">已从分享链接填入房间码</p>}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
          </Panel>
        </section>
      )}
      {page === 'create' && (
        <section className="page-wrap">
          <button className="back" onClick={() => go('home')}>
            ← 返回首页
          </button>
          <div className="heading">
            <p className="eyebrow">好友牌局</p>
            <h1>创建房间</h1>
            <p>只设置本局人数，其余按已确认的默认值开启。</p>
          </div>
          <Panel className="form-card">
            <form onSubmit={submitCreate}>
              <label className="field">
                <span>
                  房间名称 <small>1–40 个字符</small>
                </span>
                <input
                  autoFocus
                  value={roomName}
                  maxLength={40}
                  placeholder="例如：老城南门好友局"
                  onChange={(e) => setRoomName(e.target.value)}
                />
              </label>
              <fieldset className="modes">
                <legend>参与人数</legend>
                <div>
                  {([2, 3, 4] as const).map((count) => (
                    <button
                      key={count}
                      type="button"
                      aria-pressed={playerCount === count}
                      onClick={() => setPlayerCount(count)}
                    >
                      <b>{count} 人局</b>
                      <small>
                        {count === 2
                          ? '短兵相接'
                          : count === 3
                            ? '各自为战'
                            : '对家组队'}
                      </small>
                    </button>
                  ))}
                </div>
              </fieldset>
              <div className="defaults">
                <span>◷ 20 秒</span>
                <span>◉ 允许观战</span>
                <span>◌ 房间聊天</span>
              </div>
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <Button size="large" type="submit" disabled={pending}>
                {pending ? '正在创建…' : '创建房间 →'}
              </Button>
            </form>
          </Panel>
        </section>
      )}
      {page === 'settings' && (
        <section className="page-wrap">
          <button className="back" onClick={() => go('home')}>
            ← 返回首页
          </button>
          <div className="heading">
            <p className="eyebrow">本地偏好</p>
            <h1>基础设置</h1>
            <p>只保存在当前浏览器。尚未接入音频素材，不会伪装播放。</p>
          </div>
          <Panel className="form-card settings">
            <Toggle
              label="操作音效"
              description="保存开关，供后续功能使用"
              checked={settings.soundEffects}
              onChange={(soundEffects) =>
                updateSettings({ ...settings, soundEffects })
              }
            />
            <Toggle
              label="背景音乐"
              description="默认关闭，不会自动播放"
              checked={settings.backgroundMusic}
              onChange={(backgroundMusic) =>
                updateSettings({ ...settings, backgroundMusic })
              }
            />
            <Toggle
              label="减弱动画"
              description="减少页面装饰动效"
              checked={settings.reducedMotion}
              onChange={(reducedMotion) =>
                updateSettings({ ...settings, reducedMotion })
              }
            />
            <p className="notice">更改会立即保存</p>
          </Panel>
        </section>
      )}
      {page === 'entered' && room && self && view?.public.game && (
        <GameTable
          view={view}
          connection={connection}
          connectionState={sessionState}
          onSafeReturn={returnHomePreservingSession}
        />
      )}
      {page === 'entered' && spectatorView && spectatorConnection && (
        <SpectatorTable
          view={spectatorView}
          connection={spectatorConnection}
          leaving={pending}
          leaveError={error}
          onReturn={() => void leaveSpectating()}
        />
      )}
      {page === 'entered' && room && self && !view?.public.game && (
        <section className="waiting-layout">
          <Panel className="table-preview" tone="felt">
            <header className="room-title">
              <div>
                <p className="eyebrow">好友等待房</p>
                <h1>{room.name}</h1>
              </div>
              <Badge
                tone={
                  sessionState === 'waiting-room' || sessionState === 'started'
                    ? 'green'
                    : 'red'
                }
                dot
              >
                {sessionState === 'waiting-room'
                  ? '实时连接'
                  : sessionState === 'started'
                    ? '对局已开始'
                    : sessionState === 'resuming'
                      ? '正在恢复'
                      : '连接中断'}
              </Badge>
            </header>
            <div
              className={`seat-grid seats-${room.config.playerCount}`}
              aria-label="玩家座位"
            >
              {Array.from({ length: room.config.playerCount }, (_, seat) => {
                const player = room.players.find((item) => item.seat === seat);
                return player ? (
                  <PlayerSeat
                    key={seat}
                    name={player.nickname}
                    avatar={
                      avatarImage(player.avatarId) ? (
                        <img src={avatarImage(player.avatarId)!} alt="" />
                      ) : (
                        player.nickname.slice(0, 1)
                      )
                    }
                    active={player.playerId === self.playerId}
                    online={player.connection === 'online'}
                    role={[
                      player.isHost ? '房主' : '',
                      player.playerId === self.playerId ? '本人' : '',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                    status={`${player.connection === 'online' ? '在线' : '已掉线'} · ${player.isHost ? '房主无需准备' : player.readiness === 'ready' ? '已准备' : '未准备'}`}
                  />
                ) : (
                  <PlayerSeat
                    key={seat}
                    name={`空座 ${seat + 1}`}
                    avatar="座"
                    online={false}
                    status="等待玩家入座"
                  />
                );
              })}
              <div className="table-mark">
                <b>八</b>
                <span>逆时针座次</span>
              </div>
            </div>
          </Panel>
          <Panel className="room-sidebar">
            <div className="room-code">
              <span>六位房间码</span>
              <strong>{room.code}</strong>
            </div>
            <div className="room-facts">
              <span>{room.config.playerCount} 人局</span>
              <span>{room.config.turnTimeoutSeconds} 秒操作</span>
              <span>{room.config.allowChat ? '允许聊天' : '关闭聊天'}</span>
              <span>
                {room.config.allowSpectators ? '允许观战' : '禁止观战'}
              </span>
            </div>
            <div className="share">
              <span>{shareUrl}</span>
              <Button
                variant="secondary"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(shareUrl)
                    .then(() => setCopied(true))
                    .catch(() => setError('复制失败，请手动复制'));
                }}
              >
                {copied ? '已复制 ✓' : '复制邀请'}
              </Button>
            </div>
            {sessionState === 'started' ? (
              <div className="started-placeholder">
                <b>对局已开始</b>
                <p>连接与本人安全视图已保留。牌桌操作将在任务 16 实现。</p>
              </div>
            ) : self.isHost ? (
              (() => {
                const missing = room.config.playerCount - room.players.length;
                const unready = room.players.filter(
                  (player) => !player.isHost && player.readiness !== 'ready',
                ).length;
                const reason =
                  missing > 0
                    ? `还需 ${missing} 位玩家入座`
                    : unready > 0
                      ? `还有 ${unready} 位玩家未准备`
                      : '全员就绪，可以开始';
                return (
                  <div className="primary-action">
                    <p>{reason}</p>
                    <Button
                      size="large"
                      disabled={
                        pending ||
                        missing > 0 ||
                        unready > 0 ||
                        sessionState !== 'waiting-room'
                      }
                      onClick={() => {
                        if (!connection || pending) return;
                        setPending(true);
                        setError('');
                        void connection
                          .start()
                          .catch((caught) =>
                            setError(
                              caught instanceof Error
                                ? caught.message
                                : fallbackError,
                            ),
                          )
                          .finally(() => setPending(false));
                      }}
                    >
                      {pending ? '提交中…' : '开始游戏'}
                    </Button>
                  </div>
                );
              })()
            ) : (
              <div className="primary-action">
                <p>
                  {self.readiness === 'ready'
                    ? '已准备，等待房主开始'
                    : '准备好后告诉房主'}
                </p>
                <Button
                  size="large"
                  variant={self.readiness === 'ready' ? 'secondary' : 'primary'}
                  disabled={pending || sessionState !== 'waiting-room'}
                  onClick={() => {
                    if (!connection || pending) return;
                    setPending(true);
                    setError('');
                    void connection
                      .ready(self.readiness !== 'ready')
                      .catch((caught) =>
                        setError(
                          caught instanceof Error
                            ? caught.message
                            : fallbackError,
                        ),
                      )
                      .finally(() => setPending(false));
                  }}
                >
                  {pending
                    ? '提交中…'
                    : self.readiness === 'ready'
                      ? '取消准备'
                      : '准备'}
                </Button>
              </div>
            )}
            {(sessionState === 'disconnected' ||
              sessionState === 'resuming') && (
              <p className="notice">连接短暂中断，正在使用安全凭证恢复…</p>
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            {sessionState === 'waiting-room' ? (
              <button
                className="back home-link"
                type="button"
                disabled={pending}
                onClick={() => void requestLeave()}
              >
                {pending ? '正在安全离开…' : '← 离开房间并返回首页'}
              </button>
            ) : (
              <button className="back home-link" type="button" disabled>
                {sessionState === 'started'
                  ? '对局已开始，暂不支持主动离开'
                  : '恢复连接后可安全离开房间'}
              </button>
            )}
          </Panel>
        </section>
      )}
      {page === 'entered' && !spectatorView && (!room || !self) && (
        <section className="entered-wrap">
          <Panel className="entered">
            <Badge tone={sessionState === 'resuming' ? 'gold' : 'red'} dot>
              {sessionState === 'resuming' || sessionState === 'connecting'
                ? '正在恢复房间'
                : '恢复失败'}
            </Badge>
            <i>续</i>
            <h1>
              {sessionState === 'resume-failed'
                ? '无法恢复房间'
                : '正在重新入座'}
            </h1>
            <p>{error || '正在验证当前浏览器保存的安全凭证…'}</p>
            {sessionState === 'resume-failed' && (
              <div className="recovery-actions">
                <Button
                  onClick={() => {
                    recoveryAttempt.current = 0;
                    void recover();
                  }}
                >
                  重试恢复
                </Button>
                <Button
                  variant="secondary"
                  onClick={returnHomePreservingSession}
                >
                  保留凭证返回首页
                </Button>
              </div>
            )}
          </Panel>
        </section>
      )}
      <footer>
        <span>原创“中原夜宴”视觉</span>
        <span>服务端权威规则 · 真实 WebSocket</span>
      </footer>
    </main>
  );
}

export { App };
