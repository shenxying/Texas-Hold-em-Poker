import { expect, test, type Page } from '@playwright/test';

async function expectOneScreen(page: Page): Promise<void> {
  const geometry = await page.evaluate(() => {
    const dock = document.querySelector<HTMLElement>('.player-dock');
    const dockBox = dock?.getBoundingClientRect();
    return {
      viewportHeight: window.innerHeight,
      documentHeight: document.documentElement.scrollHeight,
      bodyHeight: document.body.scrollHeight,
      dockTop: dockBox?.top,
      dockBottom: dockBox?.bottom,
    };
  });

  expect(geometry.documentHeight).toBeLessThanOrEqual(geometry.viewportHeight);
  expect(geometry.bodyHeight).toBeLessThanOrEqual(geometry.viewportHeight);
  expect(geometry.dockTop).toBeGreaterThanOrEqual(0);
  expect(geometry.dockBottom).toBeLessThanOrEqual(geometry.viewportHeight);
}

async function expectDocumentFitsViewport(page: Page): Promise<void> {
  const geometry = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    documentWidth: document.documentElement.scrollWidth,
    documentHeight: document.documentElement.scrollHeight,
  }));
  expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.documentHeight).toBeLessThanOrEqual(geometry.viewportHeight);
}

test('1366×768牌桌在聊天和设置展开时仍保持一屏并露出手牌', async ({ page }) => {
  await page.goto('./');
  await expect(page).toHaveURL(/\/poker\/$/);
  await expectDocumentFitsViewport(page);

  await page.getByLabel('昵称').fill('布局测试');
  await page.getByRole('button', { name: '创建私人房间' }).click();
  await expect(page.getByRole('region', { name: '我的手牌和操作' })).toBeVisible();
  await expectOneScreen(page);

  await page.getByRole('button', { name: '房主设置', exact: true }).click();
  await page.getByRole('button', { name: '添加 AI' }).click();
  await expect(page.getByRole('button', { name: /移除/ })).toBeVisible();
  await expectOneScreen(page);

  await page.getByRole('button', { name: '关闭侧边栏' }).click();
  await page.getByRole('button', { name: '开始游戏' }).click();
  const dock = page.getByRole('region', { name: '我的手牌和操作' });
  await expect(dock.getByRole('img')).toHaveCount(2);
  await expectOneScreen(page);

  await page.getByRole('button', { name: '聊天', exact: true }).click();
  await expect(page.getByTestId('room-side-panel')).toBeVisible();
  await expectOneScreen(page);

  await page.getByRole('button', { name: '房主设置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '房主设置' })).toBeVisible();
  await expectOneScreen(page);
});

test('窄屏聊天使用可滚动的模态抽屉并在关闭后恢复焦点', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await page.getByLabel('昵称').fill('手机测试');
  await page.getByRole('button', { name: '创建私人房间' }).click();
  await expectDocumentFitsViewport(page);
  const dockBox = await page.getByRole('region', { name: '我的手牌和操作' }).boundingBox();
  expect(dockBox?.x).toBeGreaterThanOrEqual(0);
  expect((dockBox?.x ?? 0) + (dockBox?.width ?? 0)).toBeLessThanOrEqual(390);

  const trigger = page.getByRole('button', { name: '聊天', exact: true });
  await trigger.click();
  const drawer = page.getByRole('dialog', { name: '房间侧边栏' });
  await expect(drawer).toHaveAttribute('aria-modal', 'true');
  await expect(page.locator('.room-header')).toHaveAttribute('inert', '');
  await expect(drawer.getByRole('button', { name: '关闭侧边栏' })).toBeFocused();
  await expect(drawer.locator('.side-panel-content:visible')).toHaveCSS('overflow-y', 'auto');
  const drawerBox = await drawer.boundingBox();
  expect(drawerBox?.height).toBeLessThanOrEqual(844);

  await page.getByLabel('聊天消息').fill('循环焦点');
  const first = drawer.getByRole('tab', { name: '聊天' });
  const last = drawer.getByRole('button', { name: '发送' });
  await last.focus();
  await page.keyboard.press('Tab');
  await expect(first).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(last).toBeFocused();

  await drawer.getByRole('tab', { name: '房主设置' }).click();
  const settingsFirst = drawer.getByRole('tab', { name: '房主设置' });
  const settingsLast = drawer.getByRole('button', { name: '添加 AI' });
  await settingsFirst.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(settingsLast).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(settingsFirst).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('room-side-panel')).toBeHidden();
  await expect(page.getByRole('button', { name: '房主设置', exact: true })).toBeFocused();
});
