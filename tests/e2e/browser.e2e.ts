import { mkdir, writeFile, readFile } from 'node:fs/promises';

import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { compareCards } from '../../packages/game-engine/src/index.ts';
import type { Card } from '../../packages/shared/src/index.ts';
import { createApp } from '../../apps/server/src/app.js';
import { SqliteHistoryStore } from '../../apps/server/src/history-store.js';

const evidenceRoot =
  process.env.EIGHTCARDS_EVIDENCE ?? 'C:/Users/12571/8cards-task23-evidence';
const errorsByPage = new WeakMap<Page, string[]>();
const framesByPage = new WeakMap<Page, string[]>();

async function newPlayer(
  browser: Browser,
  nickname: string,
  viewport = { width: 1440, height: 900 },
  socketUrl?: string,
) {
  const context = await browser.newContext({
    viewport,
    hasTouch: viewport.width <= 844,
  });
  if (socketUrl)
    await context.addInitScript((endpoint) => {
      const Original = window.WebSocket;
      window.WebSocket = class extends Original {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(
            String(url).includes('127.0.0.1:3101/ws') ? endpoint : url,
            protocols,
          );
        }
      };
    }, socketUrl);
  const page = await context.newPage();
  const frames: string[] = [];
  const errors: string[] = [];
  errorsByPage.set(page, errors);
  framesByPage.set(page, frames);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('websocket', (socket) => {
    socket.on('framesent', (event) => frames.push(String(event.payload)));
    socket.on('framereceived', (event) => frames.push(String(event.payload)));
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.getByPlaceholder('例如：麦田守望者').fill(nickname);
  return { context, page, frames, errors };
}

async function createRoom(page: Page, playerCount: 2 | 3 | 4) {
  await page.getByRole('button', { name: '＋ 创建好友房' }).click();
  await page
    .getByPlaceholder('例如：老城南门好友局')
    .fill(`端到端${playerCount}人局`);
  await page
    .getByRole('button', { name: new RegExp(`${playerCount} 人局`) })
    .click();
  await page.getByRole('button', { name: '创建房间 →' }).click();
  const code = page.locator('.room-code strong');
  await expect(code).toHaveText(/^[A-Z0-9]{6}$/);
  return (await code.textContent())!;
}

async function joinRoom(page: Page, code: string) {
  await page.getByPlaceholder('输入 6 位房间码').fill(code);
  await page.getByRole('button', { name: '加入', exact: true }).click();
  await expect(page.locator('.room-code strong')).toHaveText(code);
}

async function closeAll(contexts: BrowserContext[]) {
  await Promise.all(contexts.map((context) => context.close()));
}

function latestPlayerVersion(frames: string[]) {
  for (const frame of [...frames].reverse()) {
    try {
      const event = JSON.parse(frame) as {
        type?: string;
        stateVersion?: number;
      };
      if (event.type === 'state.player' && event.stateVersion !== undefined)
        return event.stateVersion;
    } catch {
      // Browser DevTools also reports non-JSON transport frames.
    }
  }
  return -1;
}

function latestPlayerState(frames: string[]) {
  for (const frame of [...frames].reverse()) {
    try {
      const event = JSON.parse(frame) as {
        type?: string;
        stateVersion?: number;
        view?: {
          public: {
            game: {
              trumpSuit: 'spades' | 'hearts' | 'clubs' | 'diamonds';
              table: Array<{ purpose: string; card: Card }>;
            };
          };
          private: { hand: Card[]; legalActionTypes: string[] };
        };
      };
      if (event.type === 'state.player' && event.view) return event;
    } catch {
      // Browser DevTools also reports non-JSON transport frames.
    }
  }
  return undefined;
}

const cardName = (card: Card) =>
  card.kind === 'joker'
    ? `★ ${card.rank === 'small-joker' ? '小王' : '大王'}`
    : `${{ spades: '♠', hearts: '♥', clubs: '♣', diamonds: '♦' }[card.suit]} ${card.rank}`;

async function playUntilVote(
  players: Array<Awaited<ReturnType<typeof newPlayer>>>,
  evidencePrefix?: string,
) {
  let refillCaptured = false;
  const pureDefenses: number[] = [];
  for (let step = 0; step < 4000; step += 1) {
    if (
      await players[0]!.page
        .getByRole('button', { name: '继续下一局' })
        .isVisible()
        .catch(() => false)
    ) {
      if (evidencePrefix)
        await writeFile(
          evidenceRoot + '/' + evidencePrefix + '-pure-joker-defense.json',
          JSON.stringify({
            observed: pureDefenses.length,
            steps: pureDefenses,
          }),
        );
      return step;
    }
    const live = latestPlayerState(players[0]!.frames)?.view as unknown as
      import('../../packages/shared/src/index.ts').PlayerView | undefined;
    const presentation = live?.public.series?.presentation;
    if (presentation && Date.now() < Date.parse(presentation.readyAt)) {
      if (evidencePrefix && presentation.kind === 'refill' && !refillCaptured) {
        refillCaptured = true;
        await captureViews(
          players[0]!.page,
          evidencePrefix + '-refill',
          viewports.slice(0, 2),
        );
      }
      await players[0]!.page.waitForTimeout(
        Math.max(20, Date.parse(presentation.readyAt) - Date.now() + 40),
      );
      continue;
    }
    let progressed = false;
    for (const player of players) {
      const before = latestPlayerVersion(player.frames);
      const state = latestPlayerState(player.frames);
      const legal = new Set(state?.view?.private.legalActionTypes ?? []);
      if (!legal.has('play-card') && !legal.has('beat-card')) continue;
      const collect = player.page.getByRole('button', { name: '收牌' });
      const pass = player.page.getByRole('button', { name: '过牌' });
      let card: Card | undefined;
      if (legal.has('beat-card') && state?.view) {
        const target = [...state.view.public.game.table]
          .reverse()
          .find((play) => play.purpose === 'attack')?.card;
        card = target
          ? state.view.private.hand
              .slice()
              .sort(
                (a, b) =>
                  Number(a.kind === 'joker') - Number(b.kind === 'joker'),
              )
              .find(
                (candidate) =>
                  compareCards(
                    candidate,
                    target,
                    state.view!.public.game.trumpSuit,
                  ) === 1 ||
                  (candidate.kind === 'joker' && target.kind !== 'joker'),
              )
          : undefined;
      } else if (
        legal.has('play-card') &&
        !state?.view?.public.game.table.length
      ) {
        card = state?.view?.private.hand.find(
          (candidate) => candidate.kind === 'standard',
        );
      }
      if (
        card?.kind === 'joker' &&
        state!.view!.private.hand.every((c) => c.kind === 'joker')
      ) {
        pureDefenses.push(step);
        if (evidencePrefix === 'three-pure-defense')
          await player.page.screenshot({
            path:
              evidenceRoot +
              '/screenshots/three-pure-joker-defender-before.png',
            fullPage: false,
          });
      }
      if (card) {
        await player.page
          .getByLabel('本人手牌')
          .getByRole('button', { name: cardName(card) })
          .first()
          .click();
        const action = player.page
          .locator('.action-bar button')
          .filter({ hasText: /出牌|压牌/ });
        if (!(await action.isEnabled({ timeout: 500 }).catch(() => false)))
          continue;
        await action.click({ timeout: 500 });
      } else if (await collect.isEnabled().catch(() => false))
        await collect.click();
      else if (await pass.isEnabled().catch(() => false)) await pass.click();
      else continue;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (latestPlayerVersion(player.frames) > before) break;
        await player.page.waitForTimeout(10);
      }
      if (latestPlayerVersion(player.frames) > before) {
        if (
          evidencePrefix === 'three-pure-defense' &&
          card?.kind === 'joker' &&
          state!.view!.private.hand.every((c) => c.kind === 'joker')
        ) {
          const after = latestPlayerState(player.frames)!
            .view as unknown as import('../../packages/shared/src/index.ts').PlayerView;
          expect(after.private.hand).toHaveLength(0);
          expect(after.public.series!.finishOrder).toContain(
            after.viewerPlayerId,
          );
          await player.page.screenshot({
            path:
              evidenceRoot + '/screenshots/three-pure-joker-defender-after.png',
            fullPage: false,
          });
          await writeFile(
            evidenceRoot + '/three-pure-joker-defense.json',
            JSON.stringify(
              {
                seed: 5,
                step,
                handCountBefore: state!.view!.private.hand.length,
                handCountAfter: 0,
                normalFinishRecorded: true,
                confirmed: true,
                serverVersion: latestPlayerVersion(player.frames),
              },
              null,
              2,
            ),
          );
          return step;
        }
        progressed = true;
        break;
      }
    }
    if (!progressed) await players[0]!.page.waitForTimeout(25);
  }
  throw new Error('连续房间赛未在 4000 步内进入继续投票');
}

test('大厅、分享链接、准备、开局、聊天、观战与三种响应式视口', async ({
  browser,
}) => {
  const contexts: BrowserContext[] = [];
  await mkdir(`${evidenceRoot}/screenshots`, { recursive: true });
  try {
    const host = await newPlayer(browser, '房主甲');
    contexts.push(host.context);
    await expect(host.page.getByText('YD八张')).toBeVisible();
    const avatarFits = await host.page
      .locator('.avatar-options img')
      .evaluateAll((images) =>
        images.map((image) => {
          const element = image as HTMLImageElement;
          const parent = element.parentElement!;
          const sourceRatio = element.naturalWidth / element.naturalHeight;
          const renderedRatio = element.clientWidth / element.clientHeight;
          return {
            fullyContained:
              element.clientWidth <= parent.clientWidth &&
              element.clientHeight <= parent.clientHeight,
            preservesRatio: Math.abs(sourceRatio - renderedRatio) < 0.02,
          };
        }),
      );
    expect(avatarFits).toHaveLength(9);
    expect(avatarFits.every(({ fullyContained }) => fullyContained)).toBe(true);
    expect(avatarFits.every(({ preservesRatio }) => preservesRatio)).toBe(true);
    await host.page.screenshot({
      path: `${evidenceRoot}/screenshots/desktop-home-1440x900.png`,
      fullPage: false,
    });
    await host.page.setViewportSize({ width: 844, height: 390 });
    await host.page.screenshot({
      path: `${evidenceRoot}/screenshots/mobile-landscape-home-844x390.png`,
      fullPage: false,
    });
    await host.page.setViewportSize({ width: 390, height: 844 });
    await host.page.screenshot({
      path: `${evidenceRoot}/screenshots/mobile-portrait-home-390x844.png`,
      fullPage: false,
    });
    await host.page.setViewportSize({ width: 1440, height: 900 });
    await host.page.getByRole('button', { name: '使用头像 1' }).click();
    const code = await createRoom(host.page, 2);
    const share = host.page.locator('.share > span');
    await expect(share).toContainText(`?room=${code}`);
    await host.page.screenshot({
      path: `${evidenceRoot}/screenshots/desktop-waiting-1440x900.png`,
      fullPage: false,
    });

    const guest = await newPlayer(browser, '玩家乙', {
      width: 844,
      height: 390,
    });
    contexts.push(guest.context);
    await guest.page.goto(`/?room=${code}`);
    await expect(guest.page.getByText('已从分享链接填入房间码')).toBeVisible();
    await guest.page.getByPlaceholder('例如：麦田守望者').fill('玩家乙');
    await guest.page.getByRole('button', { name: '加入', exact: true }).click();
    await guest.page.getByRole('button', { name: '准备', exact: true }).click();
    await expect(
      guest.page
        .locator('.ui-seat')
        .filter({ hasText: '房主甲' })
        .locator('img'),
    ).toHaveAttribute('src', '/avatars/avatar-1.jpg');
    await expect(guest.page.getByText('已准备，等待房主开始')).toBeVisible();
    await guest.page.screenshot({
      path: `${evidenceRoot}/screenshots/mobile-landscape-waiting-844x390.png`,
      fullPage: false,
    });
    await guest.page.setViewportSize({ width: 390, height: 844 });
    await guest.page.screenshot({
      path: `${evidenceRoot}/screenshots/mobile-portrait-waiting-390x844.png`,
      fullPage: false,
    });
    await guest.page.setViewportSize({ width: 844, height: 390 });

    await host.page.getByRole('button', { name: '开始游戏' }).click();
    await expect(host.page.getByLabel('2人游戏牌桌')).toBeVisible();
    await expect(guest.page.getByLabel('2人游戏牌桌')).toBeVisible();
    await expect(host.page.locator('.presentation-stage')).toHaveCount(0);
    await captureViews(host.page, 'clock-stock');
    const actor = (await host.page.getByText(/^轮到你/).isVisible())
      ? host.page
      : guest.page;
    await actor.getByLabel('本人手牌').getByRole('button').first().click();
    await actor.getByRole('button', { name: /^(出牌|压牌)$/ }).click();
    await expect(actor.locator('.table-motion--play')).toBeAttached();
    await host.page.getByRole('button', { name: /^聊天/ }).click();
    await host.page.getByRole('button', { name: '这局有点意思。' }).click();
    await host.page.getByRole('button', { name: '鼓掌' }).click();
    await expect(guest.page.locator('.reaction-burst strong')).toHaveText(
      '鼓掌',
    );
    await guest.page.getByRole('button', { name: /^聊天/ }).click();
    await guest.page.screenshot({
      path: `${evidenceRoot}/screenshots/mobile-landscape-quick-reactions-844x390.png`,
      fullPage: false,
    });
    await host.page.screenshot({
      path: `${evidenceRoot}/screenshots/desktop-quick-reactions-1440x900.png`,
      fullPage: false,
    });
    await host.page
      .getByLabel('聊天内容')
      .fill('<img src=x onerror=alert(1)>纯文本');
    await host.page.getByRole('button', { name: '发送' }).click();
    await expect(
      guest.page
        .getByLabel('房间聊天')
        .getByText('<img src=x onerror=alert(1)>纯文本'),
    ).toBeVisible();
    expect(await guest.page.locator('img[src="x"]').count()).toBe(0);
    await host.page.screenshot({
      path: `${evidenceRoot}/screenshots/desktop-game-1440x900.png`,
      fullPage: false,
    });
    await host.page.screenshot({
      path: `${evidenceRoot}/screenshots/desktop-stock-draw-1440x900.png`,
      fullPage: false,
    });
    await guest.page.screenshot({
      path: `${evidenceRoot}/screenshots/mobile-landscape-game-844x390.png`,
      fullPage: false,
    });
    await guest.page.setViewportSize({ width: 390, height: 844 });
    await guest.page.screenshot({
      path: `${evidenceRoot}/screenshots/mobile-portrait-game-390x844.png`,
      fullPage: false,
    });

    const spectator = await newPlayer(browser, '观众丙', {
      width: 390,
      height: 844,
    });
    contexts.push(spectator.context);
    await spectator.page.getByPlaceholder('输入 6 位房间码').fill(code);
    await spectator.page
      .getByRole('button', { name: '以观战者身份加入' })
      .click();
    await expect(spectator.page.getByText('观战中 · 不能操作')).toBeVisible();
    await spectator.page.getByRole('button', { name: '打开观战聊天' }).click();
    await expect(
      spectator.page.getByText('<img src=x onerror=alert(1)>纯文本'),
    ).toBeVisible();
    expect(
      await spectator.page.locator('[aria-label="本人手牌"]').count(),
    ).toBe(0);
    await spectator.page.reload();
    await expect(spectator.page.getByText('观战中 · 不能操作')).toBeVisible();
    await spectator.page.screenshot({
      path: `${evidenceRoot}/screenshots/mobile-portrait-spectator-390x844.png`,
      fullPage: false,
    });
    await spectator.page.getByRole('button', { name: '返回首页' }).click();
    await expect(spectator.page.getByText('入座开局')).toBeVisible();

    const hostStorage = await host.page.evaluate(() => ({ ...localStorage }));
    const guestStorage = await guest.page.evaluate(() => ({ ...localStorage }));
    const hostSerialized = JSON.stringify(hostStorage);
    const guestSerialized = JSON.stringify(guestStorage);
    const reconnectTokens = (value: string) =>
      [...value.matchAll(/"reconnectToken":"([^"]+)"/g)].map(
        (match) => match[1]!,
      );
    const hostTokens = reconnectTokens(hostSerialized);
    const guestTokens = reconnectTokens(guestSerialized);
    for (const token of guestTokens)
      expect(host.frames.join('\n')).not.toContain(token);
    for (const token of hostTokens)
      expect(guest.frames.join('\n')).not.toContain(token);
    expect(spectator.frames.join('\n')).not.toContain('"private"');
    expect(spectator.frames.join('\n')).not.toContain('"stock":[');

    for (const page of [host.page, guest.page, spectator.page]) {
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
  } finally {
    await closeAll(contexts);
  }
});

test('等待房主动离开释放座位且短码可再次加入', async ({ browser }) => {
  const contexts: BrowserContext[] = [];
  try {
    const host = await newPlayer(browser, '离房房主');
    contexts.push(host.context);
    const code = await createRoom(host.page, 2);
    const guest = await newPlayer(browser, '临时玩家');
    contexts.push(guest.context);
    await joinRoom(guest.page, code);
    await guest.page
      .getByRole('button', { name: '← 离开房间并返回首页' })
      .click();
    await expect(guest.page.getByText('入座开局')).toBeVisible();
    await expect(host.page.getByText('还需 1 位玩家入座')).toBeVisible();

    const replacement = await newPlayer(browser, '替补玩家');
    contexts.push(replacement.context);
    await joinRoom(replacement.page, code);
    await expect(host.page.getByText('替补玩家')).toBeVisible();
  } finally {
    await closeAll(contexts);
  }
});

test('三四人等待房权威移座、交换、拒绝与对家关系', async ({ browser }) => {
  const contexts: BrowserContext[] = [];
  await mkdir(`${evidenceRoot}/screenshots`, { recursive: true });
  try {
    const threeHost = await newPlayer(browser, '三人房主');
    const threeGuest = await newPlayer(browser, '三人玩家');
    contexts.push(threeHost.context, threeGuest.context);
    const threeCode = await createRoom(threeHost.page, 3);
    await joinRoom(threeGuest.page, threeCode);
    await threeHost.page
      .locator('.seat-choice')
      .filter({ hasText: '空座 3' })
      .getByRole('button', { name: '移到这里' })
      .click();
    await expect(threeHost.page.locator('.seat-choice').nth(2)).toContainText(
      '三人房主',
    );
    await closeAll([threeHost.context, threeGuest.context]);

    const host = await newPlayer(browser, '四人房主');
    const b = await newPlayer(browser, '玩家乙');
    const c = await newPlayer(browser, '玩家丙');
    const d = await newPlayer(browser, '玩家丁');
    contexts.push(host.context, b.context, c.context, d.context);
    const code = await createRoom(host.page, 4);
    await joinRoom(b.page, code);
    await joinRoom(c.page, code);
    await joinRoom(d.page, code);
    await b.page.getByRole('button', { name: '准备', exact: true }).click();
    await host.page
      .locator('.seat-choice')
      .filter({ hasText: '玩家乙' })
      .getByRole('button', { name: '请求交换' })
      .click();
    await expect(
      b.page.getByRole('dialog', { name: '换座请求' }),
    ).toBeVisible();
    await b.page.getByRole('button', { name: '同意' }).click();
    await expect(host.page.locator('.seat-choice').nth(1)).toContainText(
      '四人房主',
    );
    await expect(host.page.locator('.seat-choice').nth(0)).toContainText(
      '玩家乙',
    );
    await expect(
      b.page.getByRole('button', { name: '准备', exact: true }),
    ).toBeVisible();

    await host.page
      .locator('.seat-choice')
      .filter({ hasText: '玩家丙' })
      .getByRole('button', { name: '请求交换' })
      .click();
    await c.page.getByRole('button', { name: '拒绝' }).click();
    await expect(
      host.page.getByText('对家：座位 1 ↔ 3 · 座位 2 ↔ 4'),
    ).toBeVisible();
    await host.page.screenshot({
      path: `${evidenceRoot}/screenshots/desktop-four-seat-swap-1440x900.png`,
      fullPage: false,
    });
    await host.page.screenshot({
      path: `${evidenceRoot}/screenshots/desktop-four-waiting-1440x900.png`,
      fullPage: false,
    });
    await host.page.setViewportSize({ width: 844, height: 390 });
    await host.page.screenshot({
      path: `${evidenceRoot}/screenshots/mobile-landscape-four-waiting-844x390.png`,
      fullPage: false,
    });
    await host.page.setViewportSize({ width: 390, height: 844 });
    await host.page.screenshot({
      path: `${evidenceRoot}/screenshots/mobile-portrait-four-waiting-390x844.png`,
      fullPage: false,
    });
    await host.page.setViewportSize({ width: 1440, height: 900 });
    for (const player of [b, c, d]) {
      const ready = player.page.getByRole('button', {
        name: '准备',
        exact: true,
      });
      if (await ready.isVisible()) await ready.click();
    }
    await host.page.getByRole('button', { name: '开始游戏' }).click();
    await expect(host.page.getByLabel('4人游戏牌桌')).toBeVisible();
    await host.page.screenshot({
      path: `${evidenceRoot}/screenshots/desktop-four-game-1440x900.png`,
      fullPage: false,
    });
    await host.page.setViewportSize({ width: 844, height: 390 });
    await host.page.screenshot({
      path: `${evidenceRoot}/screenshots/mobile-landscape-four-game-844x390.png`,
      fullPage: false,
    });
  } finally {
    await closeAll(
      contexts.filter((context) => !context.pages()[0]?.isClosed()),
    );
  }
});

test('浏览器在延迟和抖动下保持真实 WebSocket 牌桌', async ({ browser }) => {
  const contexts: BrowserContext[] = [];
  try {
    const host = await newPlayer(browser, '弱网房主');
    contexts.push(host.context);
    const code = await createRoom(host.page, 2);
    const guest = await newPlayer(browser, '弱网玩家');
    contexts.push(guest.context);
    await joinRoom(guest.page, code);
    await guest.page.getByRole('button', { name: '准备', exact: true }).click();
    await host.page.getByRole('button', { name: '开始游戏' }).click();
    await expect(guest.page.getByLabel('2人游戏牌桌')).toBeVisible();

    const cdp = await guest.context.newCDPSession(guest.page);
    await cdp.send('Network.enable');
    for (const latency of [250, 80, 420]) {
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency,
        downloadThroughput: 64 * 1024,
        uploadThroughput: 32 * 1024,
        connectionType: 'cellular3g',
      });
      await expect(guest.page.getByLabel('2人游戏牌桌')).toBeVisible();
    }

    await expect(guest.page.getByLabel('2人游戏牌桌')).toBeVisible({
      timeout: 15_000,
    });
    await expect(guest.page.getByText('实时连接')).toBeVisible();
  } finally {
    await closeAll(contexts);
  }
});

test('玩家刷新页面后恢复正在进行的对局', async ({ browser }) => {
  const contexts: BrowserContext[] = [];
  try {
    const host = await newPlayer(browser, '刷新房主');
    const guest = await newPlayer(browser, '刷新玩家', {
      width: 844,
      height: 390,
    });
    contexts.push(host.context, guest.context);

    const code = await createRoom(host.page, 2);
    await joinRoom(guest.page, code);
    await guest.page.getByRole('button', { name: '准备', exact: true }).click();
    await host.page.getByRole('button', { name: '开始游戏' }).click();
    await expect(guest.page.getByLabel('2人游戏牌桌')).toBeVisible();
    const original = (
      latestPlayerState(guest.frames)!
        .view as unknown as import('../../packages/shared/src/index.ts').PlayerView
    ).public.series!.presentation!;
    await guest.page.waitForTimeout(700);
    await guest.page.reload({ waitUntil: 'domcontentloaded' });

    await expect(guest.page.getByLabel('2人游戏牌桌')).toBeVisible();
    await expect(guest.page.getByText('正在恢复对局…')).not.toBeVisible();
    const restored = (
      latestPlayerState(guest.frames)!
        .view as unknown as import('../../packages/shared/src/index.ts').PlayerView
    ).public.series!.presentation;
    if (restored) {
      expect(restored.id).toBe(original.id);
      expect(restored.readyAt).toBe(original.readyAt);
    }
    const session = await guest.context.newCDPSession(guest.page);
    await session.send('Page.setWebLifecycleState', { state: 'frozen' });
    await host.page.waitForTimeout(2200);
    await session.send('Page.setWebLifecycleState', { state: 'active' });
    await expect(guest.page.locator('.single-deal')).toHaveCount(0);
    await expect(guest.page.locator('.presentation-stage')).toHaveCount(0);
    await expect(
      guest.page.getByLabel('本人手牌').getByRole('button'),
    ).toHaveCount(8);
    expect(guest.errors).toEqual([]);
    await writeFile(
      evidenceRoot + '/presentation-recovery.json',
      JSON.stringify(
        {
          sameQueueId: true,
          sameReadyAt: true,
          backgroundFreezeMs: 2200,
          ghostCards: 0,
          finalHandCount: 8,
        },
        null,
        2,
      ),
    );
    await session.detach();
  } finally {
    await closeAll(contexts);
  }
});

test('真实浏览器完成三局连续房间赛、彩蛋演出与最终结算', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const players: Array<Awaited<ReturnType<typeof newPlayer>>> = [];
  try {
    const host = await newPlayer(browser, '连续赛房主');
    const guest = await newPlayer(browser, '连续赛玩家');
    players.push(host, guest);
    const code = await createRoom(host.page, 2);
    await joinRoom(guest.page, code);
    await guest.page.getByRole('button', { name: '准备', exact: true }).click();
    await host.page.getByRole('button', { name: '开始游戏' }).click();

    await installProbe(host.page);
    await expect(host.page.locator('.single-deal')).toBeVisible();
    await captureViews(host.page, 'two-initial-deal');
    const firstSteps = await playUntilVote(players, 'two');
    await captureViews(host.page, 'two-round-ranking');
    await expect(host.page.getByText(/第 1 局 · [1-4] 倍/)).toBeVisible();
    await expect(host.page.getByText(/总分/).first()).toBeVisible();
    await host.page.screenshot({
      path: `${evidenceRoot}/screenshots/desktop-round-result-1440x900.png`,
      fullPage: false,
    });
    await host.page.setViewportSize({ width: 844, height: 390 });
    await host.page.screenshot({
      path: `${evidenceRoot}/screenshots/mobile-landscape-round-result-844x390.png`,
      fullPage: false,
    });
    await host.page.setViewportSize({ width: 390, height: 844 });
    await host.page.screenshot({
      path: `${evidenceRoot}/screenshots/mobile-portrait-round-result-390x844.png`,
      fullPage: false,
    });
    await host.page.setViewportSize({ width: 1440, height: 900 });
    await host.page.getByRole('button', { name: '继续下一局' }).click();
    await guest.page.getByRole('button', { name: '继续下一局' }).click();
    await expect(host.page.getByText(/第 2 局 · [1-4] 倍/)).toBeVisible();

    const secondSteps = await playUntilVote(players);
    await host.page.getByRole('button', { name: '继续下一局' }).click();
    await guest.page.getByRole('button', { name: '继续下一局' }).click();
    await expect(host.page.locator('.egg-opening')).toBeVisible();
    await host.page.waitForTimeout(550);
    await captureViews(host.page, 'easter-egg');
    const thirdSteps = await playUntilVote(players);
    await saveProbe(host.page, 'two-three-round-timeline');
    await guest.page.getByRole('button', { name: '不继续，结束本场' }).click();
    await expect(host.page.getByText('房间赛最终排名')).toBeVisible();
    await expect(host.page.getByText(/总分/).first()).toBeVisible();
    await host.page.screenshot({
      path: `${evidenceRoot}/screenshots/desktop-two-round-series-result-1440x900.png`,
      fullPage: false,
    });
    await host.page.setViewportSize({ width: 844, height: 390 });
    await host.page
      .locator('.table-overlay.finished > .ui-panel')
      .evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
    await host.page.screenshot({
      path: `${evidenceRoot}/screenshots/mobile-landscape-final-ranking-844x390.png`,
      fullPage: false,
    });
    await host.page.setViewportSize({ width: 390, height: 844 });
    await host.page.screenshot({
      path: `${evidenceRoot}/screenshots/mobile-portrait-final-ranking-390x844.png`,
      fullPage: false,
    });
    await writeFile(
      `${evidenceRoot}/two-round-series.json`,
      JSON.stringify(
        {
          roomCode: code,
          roundsCompleted: 3,
          firstRoundActions: firstSteps,
          secondRoundActions: secondSteps,
          thirdRoundActions: thirdSteps,
          authoritativeSettlementsObserved: 3,
          finalSeriesResultObserved: true,
        },
        null,
        2,
      ),
    );
  } finally {
    await closeAll(players.map((player) => player.context));
  }
});

const viewports = [
  { width: 1440, height: 900 },
  { width: 844, height: 390 },
  { width: 390, height: 844 },
];
async function captureViews(page: Page, stem: string, sizes = viewports) {
  await mkdir(evidenceRoot + '/screenshots', { recursive: true });
  const metrics = [];
  if (await page.locator('.round-rank-row').count())
    await page.waitForTimeout(750);
  for (const viewport of sizes) {
    await page.setViewportSize(viewport);
    const geometry = await page.evaluate(() => {
      const stock = document
        .querySelector(
          '.center-table > .stock-stack, .spectator-timing .stock-stack',
        )
        ?.getBoundingClientRect();
      const clock = document
        .querySelector(
          '.center-table > .turn-clock, .spectator-timing .turn-clock',
        )
        ?.getBoundingClientRect();
      const panel = document
        .querySelector('.table-overlay.finished > .ui-panel')
        ?.getBoundingClientRect();
      const chatInput = document
        .querySelector('.spectator-chat input')
        ?.getBoundingClientRect();
      const flight = document.querySelector<HTMLElement>('.single-deal');
      return {
        hiddenStoragePayload: Object.values({
          ...localStorage,
          ...sessionStorage,
        }).some((value) => /"(?:hand|hands|stock|randomSeed)"\s*:/.test(value)),
        actionButtonsClipped:
          !panel &&
          [...document.querySelectorAll('.action-bar button')].some(
            (element) => {
              const r = element.getBoundingClientRect();
              return (
                r.left < 0 ||
                r.right > innerWidth ||
                r.top < 0 ||
                r.bottom > innerHeight
              );
            },
          ),
        chatInputClipped:
          !!chatInput &&
          chatInput.width > 0 &&
          (chatInput.left < 0 ||
            chatInput.right > innerWidth ||
            chatInput.top < 0 ||
            chatInput.bottom > innerHeight),
        flightIsAnchored:
          !flight ||
          Number.isFinite(
            parseFloat(flight.style.getPropertyValue('--deal-x')),
          ),
        panelClipped:
          !!panel &&
          (panel.left < 0 ||
            panel.right > innerWidth ||
            panel.top < 0 ||
            panel.bottom > innerHeight),
        overflow: document.documentElement.scrollWidth > innerWidth,
        stock: stock?.toJSON(),
        clock: clock?.toJSON(),
        intersect:
          !!stock &&
          !!clock &&
          stock.left < clock.right &&
          stock.right > clock.left &&
          stock.top < clock.bottom &&
          stock.bottom > clock.top,
      };
    });
    expect(geometry.overflow).toBe(false);
    expect(geometry.intersect).toBe(false);
    expect(geometry.panelClipped).toBe(false);
    expect(geometry.chatInputClipped).toBe(false);
    expect(geometry.actionButtonsClipped).toBe(false);
    expect(geometry.flightIsAnchored).toBe(true);
    expect(geometry.hiddenStoragePayload).toBe(false);
    const frameLeaks = (framesByPage.get(page) ?? []).some((frame) =>
      /"(?:hands|stock|randomSeed|reconnectTokenDigest)"\s*:/.test(frame),
    );
    expect(frameLeaks).toBe(false);
    const consoleErrors = [...(errorsByPage.get(page) ?? [])];
    expect(consoleErrors).toEqual([]);
    metrics.push({ viewport, ...geometry, frameLeaks, consoleErrors });
    await page.screenshot({
      path:
        evidenceRoot +
        '/screenshots/' +
        stem +
        '-' +
        viewport.width +
        'x' +
        viewport.height +
        '.png',
      fullPage: false,
    });
    const panel = page.locator('.table-overlay.finished > .ui-panel');
    if (
      (await panel.count()) &&
      (await panel.evaluate(
        (element) => element.scrollHeight > element.clientHeight,
      ))
    ) {
      await panel.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await page.screenshot({
        path:
          evidenceRoot +
          '/screenshots/' +
          stem +
          '-' +
          viewport.width +
          'x' +
          viewport.height +
          '-scrolled-bottom.png',
        fullPage: false,
      });
      await panel.evaluate((element) => {
        element.scrollTop = 0;
      });
    }
  }
  await writeFile(
    evidenceRoot + '/' + stem + '-geometry.json',
    JSON.stringify(metrics, null, 2),
  );
  await page.setViewportSize(viewports[0]!);
}
async function installProbe(page: Page) {
  await page.evaluate(() => {
    const target = window as unknown as {
      task23Timeline: unknown[];
      task23Timer: number;
    };
    target.task23Timeline = [];
    target.task23Timer = window.setInterval(() => {
      if (target.task23Timeline.length >= 5000) return;
      const stage = document.querySelector('.presentation-stage');
      const flight = document.querySelector('.single-deal');
      const flightBounds = flight?.getBoundingClientRect();
      const clockBounds = document
        .querySelector('.turn-clock')
        ?.getBoundingClientRect();
      target.task23Timeline.push({
        time: Date.now(),
        stage: stage?.getAttribute('data-presentation-id'),
        completed: stage?.getAttribute('data-completed'),
        flight: flight?.getAttribute('data-recipient'),
        flightBounds: flight?.getBoundingClientRect().toJSON(),
        flightIntersectsClock:
          !!flightBounds &&
          !!clockBounds &&
          flightBounds.left < clockBounds.right &&
          flightBounds.right > clockBounds.left &&
          flightBounds.top < clockBounds.bottom &&
          flightBounds.bottom > clockBounds.top,
        hand: document.querySelectorAll('.hand .ui-card').length,
        stock: document.querySelector('.stock-stack strong')?.textContent,
        egg: !!document.querySelector('.egg-opening'),
        ranks: [...document.querySelectorAll('.round-rank-row')].map((r) => ({
          rank: r.getAttribute('data-rank'),
          opacity: getComputedStyle(r).opacity,
        })),
      });
    }, 50);
  });
}
async function saveProbe(page: Page, name: string) {
  const timeline = await page.evaluate(() => {
    const t = window as unknown as {
      task23Timeline: unknown[];
      task23Timer: number;
    };
    clearInterval(t.task23Timer);
    return t.task23Timeline;
  });
  expect(JSON.stringify(timeline)).not.toContain(
    '"flightIntersectsClock":true',
  );
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const performanceData = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const deltas: number[] = [];
        let last = performance.now();
        const sample = (now: number) => {
          deltas.push(now - last);
          last = now;
          if (deltas.length < 90) requestAnimationFrame(sample);
          else {
            const sorted = [...deltas].sort((a, b) => a - b);
            resolve({
              frames: deltas.length,
              meanMs: deltas.reduce((a, b) => a + b, 0) / deltas.length,
              p95Ms: sorted[Math.floor(sorted.length * 0.95)],
              maxMs: Math.max(...deltas),
              domNodes: document.querySelectorAll('*').length,
              cpuThrottle: 4,
            });
          }
        };
        requestAnimationFrame(sample);
      }),
  );
  await session.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await session.detach();
  await writeFile(
    evidenceRoot + '/' + name + '-performance.json',
    JSON.stringify(performanceData, null, 2),
  );
  await writeFile(
    evidenceRoot + '/' + name + '.json',
    JSON.stringify(timeline, null, 2),
  );
}

test('任务23 三四人真实整局、逐张发牌、完整单局排名和恢复', async ({
  browser,
}) => {
  test.setTimeout(480000);
  for (const count of [3, 4] as const) {
    const players: Array<Awaited<ReturnType<typeof newPlayer>>> = [];
    try {
      for (let i = 0; i < count; i++)
        players.push(await newPlayer(browser, count + '人玩家' + i));
      const host = players[0]!;
      const code = await createRoom(host.page, count);
      for (const player of players.slice(1)) {
        await joinRoom(player.page, code);
        await player.page
          .getByRole('button', { name: '准备', exact: true })
          .click();
      }
      await host.page.getByRole('button', { name: '开始游戏' }).click();
      await installProbe(host.page);
      await expect(host.page.locator('.single-deal')).toBeVisible();
      await captureViews(host.page, count + '-initial-deal');
      await playUntilVote(players, count + '-player');
      let result = (
        latestPlayerState(host.frames)!
          .view as unknown as import('../../packages/shared/src/index.ts').PlayerView
      ).public.series!.lastRoundResult!;
      for (
        let retry = 0;
        result.reason !== 'emptied-hand' && retry < 4;
        retry++
      ) {
        expect(result.participants.map((p) => p.rank).sort()).toEqual(
          count === 3 ? [1, 1, 3] : [1, 1, 3, 3],
        );
        await captureViews(host.page, count + '-joker-team-ranking');
        await writeFile(
          evidenceRoot + '/' + count + '-joker-round-result.json',
          JSON.stringify(result, null, 2),
        );
        for (const player of players)
          await player.page.getByRole('button', { name: '继续下一局' }).click();
        await playUntilVote(players, count + '-retry-' + retry);
        result = (
          latestPlayerState(host.frames)!
            .view as unknown as import('../../packages/shared/src/index.ts').PlayerView
        ).public.series!.lastRoundResult!;
      }
      expect(result.reason).toBe('emptied-hand');
      expect(result.participants.map((p) => p.rank).sort()).toEqual(
        count === 3 ? [1, 2, 3] : [1, 2, 3, 4],
      );
      expect(result.participants.reduce((sum, p) => sum + p.delta, 0)).toBe(0);
      await captureViews(
        host.page,
        count + '-round-ranking',
        count === 3 ? viewports.slice(0, 1) : viewports.slice(0, 2),
      );
      await saveProbe(host.page, count + '-round-timeline');
      await host.page.reload({ waitUntil: 'domcontentloaded' });
      await expect(host.page.locator('.round-rank-row')).toHaveCount(count);
      const restored = (
        latestPlayerState(host.frames)!
          .view as unknown as import('../../packages/shared/src/index.ts').PlayerView
      ).public.series!.lastRoundResult;
      expect(restored).toEqual(result);
    } finally {
      await closeAll(players.map((p) => p.context));
    }
  }
});

test('任务23 玩家观战七种原创图形、全部指定快捷语和移动触控', async ({
  browser,
}) => {
  test.setTimeout(90000);
  const host = await newPlayer(browser, '表情房主');
  const guest = await newPlayer(browser, '表情玩家');
  const spectator = await newPlayer(browser, '表情观众', {
    width: 390,
    height: 844,
  });
  try {
    const code = await createRoom(host.page, 2);
    await joinRoom(guest.page, code);
    await guest.page.getByRole('button', { name: '准备', exact: true }).click();
    await host.page.getByRole('button', { name: '开始游戏' }).click();
    await spectator.page.getByPlaceholder('输入 6 位房间码').fill(code);
    await spectator.page
      .getByRole('button', { name: '以观战者身份加入' })
      .click();
    await spectator.page.getByRole('button', { name: '打开观战聊天' }).tap();
    await host.page.getByRole('button', { name: /^聊天/ }).click();
    const labels = ['点赞', '鼓掌', '大笑', '思考', '惊讶', '加油', '捂脸'];
    for (const page of [host.page, spectator.page]) {
      const icons = page.locator('.reaction-picker svg');
      await expect(icons).toHaveCount(7);
      const nodes = await icons.evaluateAll((elements) =>
        elements.map((e) => ({
          id: e.getAttribute('data-reaction'),
          width: e.getBoundingClientRect().width,
          height: e.getBoundingClientRect().height,
          drawing: e.innerHTML,
        })),
      );
      expect(nodes.every((n) => n.width > 0 && n.height > 0)).toBe(true);
      expect(new Set(nodes.map((n) => n.drawing)).size).toBe(7);
    }
    await host.page.screenshot({
      path: evidenceRoot + '/screenshots/seven-reactions-desktop.png',
      fullPage: false,
    });
    await spectator.page.screenshot({
      path: evidenceRoot + '/screenshots/seven-reactions-spectator-phone.png',
      fullPage: false,
    });
    for (let i = 0; i < labels.length; i++) {
      await host.page
        .getByRole('button', { name: labels[i]!, exact: true })
        .click();
      await expect(spectator.page.locator('.reaction-burst svg')).toBeVisible();
      await expect(spectator.page.locator('.reaction-burst strong')).toHaveText(
        labels[i]!,
      );
      await expect
        .poll(() =>
          spectator.page
            .locator('.reaction-burst')
            .evaluate((element) => Number(getComputedStyle(element).opacity)),
        )
        .toBeGreaterThan(0.9);
      if (i < 3)
        await spectator.page.screenshot({
          path: evidenceRoot + '/screenshots/reaction-burst-' + i + '.png',
          fullPage: false,
        });
      await spectator.page
        .getByRole('button', { name: labels[i]!, exact: true })
        .tap();
      await expect(host.page.locator('.reaction-burst strong')).toHaveText(
        labels[i]!,
      );
      await host.page.waitForTimeout(2100);
    }
    for (const phrase of [
      '豪到你了吗',
      '惊天大孙伯',
      '这猪÷',
      '野猪',
      '我日野猪',
    ]) {
      await host.page
        .getByRole('button', { name: phrase, exact: true })
        .click();
      await expect(
        spectator.page
          .locator('.chat-messages')
          .getByText(phrase, { exact: true })
          .last(),
      ).toBeVisible();
      await spectator.page
        .getByRole('button', { name: phrase, exact: true })
        .click();
      await expect(
        host.page
          .locator('.chat-messages')
          .getByText(phrase, { exact: true })
          .last(),
      ).toBeVisible();
      await host.page.waitForTimeout(2100);
    }
    await captureViews(spectator.page, 'spectator-clock-stock');
    expect(spectator.frames.join('\n')).not.toContain('"private"');
    expect(spectator.frames.join('\n')).not.toContain('"stock":[');
    await guest.page.emulateMedia({ reducedMotion: 'reduce' });
    await guest.page.reload({ waitUntil: 'domcontentloaded' });
    await expect(guest.page.locator('.presentation-stage')).toHaveCount(0);
    await expect(
      guest.page.getByLabel('本人手牌').getByRole('button'),
    ).toHaveCount(latestPlayerState(guest.frames)!.view!.private.hand.length);
    expect([...host.errors, ...guest.errors, ...spectator.errors]).toEqual([]);
    await writeFile(
      evidenceRoot + '/social-acceptance.json',
      JSON.stringify(
        {
          reactions: labels,
          phrases: 5,
          playerAndSpectator: true,
          nonzeroSVG: true,
          distinctSVG: true,
          hiddenInfoScan: 'passed',
          reducedMotionRecovery: 'passed',
        },
        null,
        2,
      ),
    );
  } finally {
    await closeAll([host.context, guest.context, spectator.context]);
  }
});

test('任务23 固定种子三人纯王防守合法出完的真实浏览器证据', async ({
  browser,
}) => {
  test.setTimeout(120000);
  await writeFile(
    evidenceRoot + '/three-pure-joker-defense.json',
    JSON.stringify({ confirmed: false }),
  );
  let seed = 5;
  const server = createApp({
    random: () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000,
    historyStore: new SqliteHistoryStore(':memory:'),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No acceptance server port');
  const endpoint = 'ws://127.0.0.1:' + address.port + '/ws';
  const players: Array<Awaited<ReturnType<typeof newPlayer>>> = [];
  try {
    for (let i = 0; i < 3; i++)
      players.push(
        await newPlayer(browser, '纯王验证' + i, viewports[0], endpoint),
      );
    const host = players[0]!;
    const code = await createRoom(host.page, 3);
    for (const player of players.slice(1)) {
      await joinRoom(player.page, code);
      await player.page
        .getByRole('button', { name: '准备', exact: true })
        .click();
    }
    await host.page.getByRole('button', { name: '开始游戏' }).click();
    await playUntilVote(players, 'three-pure-defense');
    expect(
      JSON.parse(
        await readFile(evidenceRoot + '/three-pure-joker-defense.json', 'utf8'),
      ).confirmed,
    ).toBe(true);
  } finally {
    await closeAll(players.map((p) => p.context));
    await server.realtime.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('任务23 固定种子四人团队憋王并列名次与恢复', async ({ browser }) => {
  test.setTimeout(120000);
  let seed = 1;
  const server = createApp({
    random: () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000,
    historyStore: new SqliteHistoryStore(':memory:'),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No local server port');
  const endpoint = 'ws://127.0.0.1:' + address.port + '/ws';
  const players: Array<Awaited<ReturnType<typeof newPlayer>>> = [];
  try {
    for (let i = 0; i < 4; i++)
      players.push(
        await newPlayer(browser, '团队憋王' + i, viewports[0], endpoint),
      );
    const host = players[0]!;
    const code = await createRoom(host.page, 4);
    for (const player of players.slice(1)) {
      await joinRoom(player.page, code);
      await player.page
        .getByRole('button', { name: '准备', exact: true })
        .click();
    }
    await host.page.getByRole('button', { name: '开始游戏' }).click();
    await playUntilVote(players);
    const result = (
      latestPlayerState(host.frames)!
        .view as unknown as import('../../packages/shared/src/index.ts').PlayerView
    ).public.series!.lastRoundResult!;
    expect(result.reason).toBe('stuck-with-jokers');
    expect(result.participants.map((p) => p.rank).sort()).toEqual([1, 1, 3, 3]);
    expect(result.participants.reduce((sum, p) => sum + p.delta, 0)).toBe(0);
    await captureViews(host.page, '4-joker-team-ranking');
    await writeFile(
      evidenceRoot + '/4-joker-round-result.json',
      JSON.stringify(result, null, 2),
    );
    await host.page.reload({ waitUntil: 'domcontentloaded' });
    await expect(host.page.locator('.round-rank-row')).toHaveCount(4);
    expect(
      (
        latestPlayerState(host.frames)!
          .view as unknown as import('../../packages/shared/src/index.ts').PlayerView
      ).public.series!.lastRoundResult,
    ).toEqual(result);
  } finally {
    await closeAll(players.map((p) => p.context));
    await server.realtime.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
