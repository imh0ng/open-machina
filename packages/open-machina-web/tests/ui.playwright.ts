import { test, expect } from '@playwright/test';

const PORT = 4444;
const BASE_URL = `http://localhost:${PORT}`;

test.describe('Machina Web UI', () => {
  test('has correct title and defaults', async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page).toHaveTitle(/Machina/);
    
    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-theme', 'dark');
    
    const body = page.locator('body');
    const accent = await body.evaluate((el: HTMLElement) => {
        return getComputedStyle(el).getPropertyValue('--machina-accent').trim();
    });
    expect(accent).toBe('#00FFB3');
    
    await page.screenshot({ path: '../../../.sisyphus/evidence/machina-full-parity/task-8-web-ui-dark.png' });
  });

  test('theme toggle works and persists', async ({ page }) => {
    await page.goto(BASE_URL);
    
    const toggle = page.locator('#theme-toggle');
    const html = page.locator('html');
    
    await expect(html).toHaveAttribute('data-theme', 'dark');
    
    await toggle.click();
    await expect(html).toHaveAttribute('data-theme', 'light');
    
    await page.screenshot({ path: '../../../.sisyphus/evidence/machina-full-parity/task-8-web-ui-light.png' });
    
    await page.reload();
    await expect(html).toHaveAttribute('data-theme', 'light');
    
    await toggle.click();
    await expect(html).toHaveAttribute('data-theme', 'dark');
  });

  test('health status is displayed', async ({ page }) => {
    await page.goto(BASE_URL);
    const status = page.locator('#health-status');
    await expect(status).toContainText('Operational');
  });
});
