import { mkdir, writeFile } from 'node:fs/promises';

import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { compareCards } from '../../packages/game-engine/src/index.ts';
import type { Card } from '../../packages/shared/src/index.ts';

const evidenceRoot =
  process.env.EIGHTCARDS_EVIDENCE ?? 'C:/Users/12571/8cards-task19-evidence';

async function newPlayer(
  browser: Browser,
  nickname: string,
  viewport = { width: 1440, height: 900 },
) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const frames: string[] = [];
  page.on('websocket', (socket) => {
    socket.on('framesent', (event) => frames.push(String(event.payload)));
    socket.on('framereceived', (event) => frames.push(String(event.payload)));
  });
  await page.goto('/');
  await page.getByPlaceholder('例如：麦田守望者').fill(nickname);
  return { context, page, frames };
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
) {
  for (let step = 0; step < 400; step += 1) {
    if (
      await players[0]!.page
        .getByRole('button', { name: '继续下一局' })
        .isVisible()
        .catch(() => false)
    )
      return step;
    let progressed = false;
    for (const player of players) {
      const before = latestPlayerVersion(player.frames);
      const state = latestPlayerState(player.frames);
      const legal = new Set(state?.view?.private.legalActionTypes ?? []);
      const collect = player.page.getByRole('button', { name: '收牌' });
      const pass = player.page.getByRole('button', { name: '过牌' });
      let card: Card | undefined;
      if (legal.has('beat-card') && state?.view) {
        const target = [...state.view.public.game.table]
          .reverse()
          .find((play) => play.purpose === 'attack')?.card;
        card = target
          ? state.view.private.hand.find(
              (candidate) =>
                compareCards(
                  candidate,
                  target,
                  state.view!.public.game.trumpSuit,
                ) === 1 ||
                (candidate.kind === 'joker' && target.kind !== 'joker'),
            )
          : undefined;
      } else if (legal.has('play-card')) {
        card = state?.view?.private.hand.find(
          (candidate) => candidate.kind === 'standard',
        );
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
        progressed = true;
        break;
      }
    }
    if (!progressed) await players[0]!.page.waitForTimeout(25);
  }
  throw new Error('连续房间赛未在 400 步内进入继续投票');
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
      fullPage: true,
    });
    await host.page.getByRole('button', { name: '使用头像 1' }).click();
    const code = await createRoom(host.page, 2);
    const share = host.page.locator('.share > span');
    await expect(share).toContainText(`?room=${code}`);
    await host.page.screenshot({
      path: `${evidenceRoot}/screenshots/desktop-waiting-1440x900.png`,
      fullPage: true,
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
      fullPage: true,
    });

    await host.page.getByRole('button', { name: '开始游戏' }).click();
    await expect(host.page.getByLabel('2人游戏牌桌')).toBeVisible();
    await expect(guest.page.getByLabel('2人游戏牌桌')).toBeVisible();
    const actor = (await host.page.getByText(/^轮到你/).isVisible())
      ? host.page
      : guest.page;
    await actor.getByLabel('本人手牌').getByRole('button').first().click();
    await actor.getByRole('button', { name: /^(出牌|压牌)$/ }).click();
    await expect(actor.locator('.table-motion--play')).toBeAttached();
    await host.page.getByRole('button', { name: /^聊天/ }).click();
    await host.page
      .getByLabel('聊天内容')
      .fill('<img src=x onerror=alert(1)>纯文本');
    await host.page.getByRole('button', { name: '发送' }).click();
    await guest.page.getByRole('button', { name: /^聊天/ }).click();
    await expect(
      guest.page
        .getByLabel('房间聊天')
        .getByText('<img src=x onerror=alert(1)>纯文本'),
    ).toBeVisible();
    expect(await guest.page.locator('img[src="x"]').count()).toBe(0);
    await host.page.screenshot({
      path: `${evidenceRoot}/screenshots/desktop-game-1440x900.png`,
      fullPage: true,
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
      fullPage: true,
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
      fullPage: true,
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

    await guest.page.reload();

    await expect(guest.page.getByLabel('2人游戏牌桌')).toBeVisible();
    await expect(guest.page.getByText('正在恢复对局…')).not.toBeVisible();
  } finally {
    await closeAll(contexts);
  }
});

test('真实浏览器完成两局连续房间赛、倍率显示与最终结算', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const players: Array<Awaited<ReturnType<typeof newPlayer>>> = [];
  try {
    const host = await newPlayer(browser, '连续赛房主');
    const guest = await newPlayer(browser, '连续赛玩家');
    players.push(host, guest);
    const code = await createRoom(host.page, 2);
    await joinRoom(guest.page, code);
    await guest.page.getByRole('button', { name: '准备', exact: true }).click();
    await host.page.getByRole('button', { name: '开始游戏' }).click();

    const firstSteps = await playUntilVote(players);
    await expect(host.page.getByText(/第 1 局 · [1-4] 倍/)).toBeVisible();
    await expect(host.page.getByText(/总分/).first()).toBeVisible();
    await host.page.getByRole('button', { name: '继续下一局' }).click();
    await guest.page.getByRole('button', { name: '继续下一局' }).click();
    await expect(host.page.getByText(/第 2 局 · [1-4] 倍/)).toBeVisible();

    const secondSteps = await playUntilVote(players);
    await guest.page.getByRole('button', { name: '不继续，结束本场' }).click();
    await expect(host.page.getByText('房间赛最终排名')).toBeVisible();
    await expect(host.page.getByText(/总分/).first()).toBeVisible();
    await host.page.screenshot({
      path: `${evidenceRoot}/screenshots/desktop-two-round-series-result-1440x900.png`,
      fullPage: true,
    });
    await writeFile(
      `${evidenceRoot}/two-round-series.json`,
      JSON.stringify(
        {
          roomCode: code,
          roundsCompleted: 2,
          firstRoundActions: firstSteps,
          secondRoundActions: secondSteps,
          authoritativeSettlementsObserved: 2,
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
