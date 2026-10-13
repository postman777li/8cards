import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Badge, Button, Panel } from '@8cards/ui';
import {
  NICKNAME_STORAGE_KEY,
  buildShareUrl,
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
} from './lobby.js';
import {
  connectToLobby,
  LobbyConnectionError,
  resolveWebSocketUrl,
  type LobbyConnection,
  type LobbyRequest,
} from './realtime-client.js';

type Page = 'home' | 'create' | 'settings' | 'entered';
const fallbackError = '暂时无法进入房间，请稍后重试';

function Brand() {
  return (
    <div className="brand">
      <b>八</b>
      <span>
        <strong>永城八张</strong>
        <small>YONGCHENG EIGHT</small>
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
  const [roomCode, setRoomCode] = useState(initialCode);
  const [roomName, setRoomName] = useState('');
  const [playerCount, setPlayerCount] = useState<2 | 3 | 4>(4);
  const [settings, setSettings] = useState<LobbySettings>(() =>
    loadSettings(localStorage),
  );
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [connection, setConnection] = useState<LobbyConnection>();
  const [networkState, setNetworkState] = useState<'online' | 'disconnected'>(
    'online',
  );
  const [copied, setCopied] = useState(false);
  const activeCancel = useRef<(() => void) | null>(null);

  useEffect(
    () => () => {
      activeCancel.current?.();
      connection?.socket.close();
    },
    [connection],
  );
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
  const run = async (request: LobbyRequest) => {
    if (pending) return;
    setPending(true);
    setError('');
    setNetworkState('online');
    try {
      const operation = connectToLobby(request, {
        url: resolveWebSocketUrl(window.location, import.meta.env.VITE_WS_URL),
      });
      activeCancel.current = operation.cancel;
      const result = await operation.promise;
      saveSession(localStorage, result);
      result.socket.addEventListener(
        'close',
        () => setNetworkState('disconnected'),
        { once: true },
      );
      setConnection(result);
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
    void run({ kind: 'join', nickname: name, roomCode: code });
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
    void run({ kind: 'create', nickname: name, roomName: title, playerCount });
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
  const room = connection?.view.public.room;
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
      {page === 'entered' && room && self && (
        <section className="entered-wrap">
          <Panel className="entered">
            <Badge tone={networkState === 'online' ? 'green' : 'red'} dot>
              {networkState === 'online' ? '已连接' : '连接已断开'}
            </Badge>
            <i>入</i>
            <h1>已进入房间</h1>
            <p>本人重连凭证已安全保存在当前浏览器。</p>
            <dl>
              <div>
                <dt>房间</dt>
                <dd>{room.name}</dd>
              </div>
              <div>
                <dt>房间码</dt>
                <dd>{room.code}</dd>
              </div>
              <div>
                <dt>昵称</dt>
                <dd>{self.nickname}</dd>
              </div>
              <div>
                <dt>模式</dt>
                <dd>{room.config.playerCount} 人局</dd>
              </div>
            </dl>
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
            {networkState === 'disconnected' && (
              <p className="error">
                连接已中断。自动恢复将在任务 15 接入，凭证已保留。
              </p>
            )}
            {error && <p className="error">{error}</p>}
            <p className="task-note">
              玩家列表、座位和准备操作将在任务 15 实现。
            </p>
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
