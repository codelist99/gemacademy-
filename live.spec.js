const { test, expect } = require('@playwright/test');

test('production funnel controls and payment fields', async ({ page }) => {
  await page.goto('https://www.gemstock.online/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.locked-video')).toHaveCount(4);
  const main = page.locator('.locked-video').first();
  await expect(main.locator('.video-toggle')).toBeVisible();
  await expect(main.locator('.video-mute')).toBeVisible();
  await expect(main.locator('iframe')).toHaveAttribute('src', /controls=0.*autoplay=1.*muted=1/);
  await page.waitForFunction(() => window.Vimeo && document.querySelector('.locked-video iframe'));
  const playback = await page.evaluate(async () => {
    const player = new Vimeo.Player(document.querySelector('.locked-video iframe'));
    await player.ready();
    await new Promise(r => setTimeout(r, 2500));
    return { muted: await player.getMuted(), time: await player.getCurrentTime() };
  });
  expect(playback.muted).toBe(true);
  expect(playback.time).toBeGreaterThan(0);
  const seek = await page.evaluate(async () => {
    const player = new Vimeo.Player(document.querySelector('.locked-video iframe'));
    const before = await player.getCurrentTime();
    await player.setCurrentTime(before + 60);
    await new Promise(r => setTimeout(r, 1200));
    return { before, after: await player.getCurrentTime() };
  });
  expect(seek.after).toBeLessThan(seek.before + 5);

  await page.goto('https://www.gemstock.online/#/checkout', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#checkout')).toBeVisible();
  await expect(page.locator('#payButton')).toBeEnabled({ timeout: 15000 });
  await expect(page.locator('#ccnumber iframe')).toHaveCount(1);
  await expect(page.locator('#ccexp iframe')).toHaveCount(1);
  await expect(page.locator('#cvv iframe')).toHaveCount(1);

  await page.goto('https://www.gemstock.online/#/upgrade');
  await expect(page.locator('.accept-upgrade')).toBeVisible();
  await expect(page.locator('.locked-video iframe')).toHaveAttribute('src', /autoplay=1.*muted=1/);
  await page.locator('.decline-upgrade').click();
  await expect(page).toHaveURL(/#\/plan$/);
  await expect(page.locator('.accept-plan')).toBeVisible();
  await page.locator('.decline-plan').click();
  await expect(page).toHaveURL(/#\/thank-you$/);
});
