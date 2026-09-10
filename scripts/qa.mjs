import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const page = await browser.newPage({ viewport: { width: 1536, height: 1024 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.goto('http://127.0.0.1:5173', { waitUntil: 'networkidle' });
const technicalVisibleByDefault = await page.getByText('模型与密钥').count();
const hasSampleData = (await page.locator('body').innerText()).includes('Climate Strategy');
await page.screenshot({ path: 'design/parallel-empty-implementation.png', fullPage: true });
await page.locator('input[type=file]').setInputFiles({
  name: 'qa.html',
  mimeType: 'text/html',
  buffer: Buffer.from('<section><h1>First page</h1><p>Sentence one.</p><p>Sentence two.</p></section><section><h1>Second page</h1><p>Another sentence.</p></section>')
});
await page.locator('.lw-workspace').waitFor();
const railBefore = await page.locator('.lw-rail').evaluate(element => element.getBoundingClientRect().width);
const railHandle = await page.locator('.lw-resizer-rail').boundingBox();
if (railHandle) await page.mouse.move(railHandle.x + 2, railHandle.y + 200), await page.mouse.down(), await page.mouse.move(railHandle.x + 34, railHandle.y + 200), await page.mouse.up();
const railAfter = await page.locator('.lw-rail').evaluate(element => element.getBoundingClientRect().width);
const splitBefore = await page.locator('.lw-slide-wrap').first().evaluate(element => element.getBoundingClientRect().width);
const splitHandle = await page.locator('.lw-resizer-split').boundingBox();
if (splitHandle) await page.mouse.move(splitHandle.x + 2, splitHandle.y + 200), await page.mouse.down(), await page.mouse.move(splitHandle.x + 72, splitHandle.y + 200), await page.mouse.up();
const splitAfter = await page.locator('.lw-slide-wrap').first().evaluate(element => element.getBoundingClientRect().width);
const dockBefore = await page.locator('.lw-dock').evaluate(element => element.getBoundingClientRect().height);
const dockHandle = await page.locator('.lw-resizer-dock').boundingBox();
if (dockHandle) await page.mouse.move(dockHandle.x + 200, dockHandle.y + 2), await page.mouse.down(), await page.mouse.move(dockHandle.x + 200, dockHandle.y - 28), await page.mouse.up();
const dockAfter = await page.locator('.lw-dock').evaluate(element => element.getBoundingClientRect().height);
await page.locator('.lw-sentence').first().hover();
const paired = await page.locator('.lw-sentence.active').count();
await page.locator('.lw-mic').click();
const recording = await page.locator('.lw-mic.active').count();
await page.getByRole('button', { name: '设置' }).click();
await page.getByText('模型与密钥').first().waitFor();
const providerCount = await page.locator('.lw-provider').count();
await page.locator('.lw-provider').first().locator('input').first().fill('sk-local-test-only');
const stored = await page.evaluate(() => localStorage.getItem('parallel.providers')?.includes('sk-local-test-only'));
await page.getByRole('button', { name: 'Token Plan' }).click();
const tokenPlanCount = await page.locator('.lw-plan-list>button').count();
await page.locator('.lw-plan-list>button').nth(1).click();
await page.locator('.lw-plan-detail input').fill('ark-local-test-only');
await page.getByRole('button', { name: '启用此套餐' }).click();
const planApplied = await page.evaluate(() => localStorage.getItem('parallel.providers')?.includes('/api/plan/v3'));
await page.screenshot({ path: 'design/parallel-token-plans-implementation.png', fullPage: true });
await page.getByRole('button', { name: '完成' }).click();
await page.locator('.lw-sentence').first().hover();
await page.screenshot({ path: 'design/parallel-lightweight-implementation.png', fullPage: true });
console.log(JSON.stringify({ title: await page.title(), technicalVisibleByDefault, hasSampleData, paired, recording, stored, providerCount, tokenPlanCount, planApplied, railDrag: railAfter > railBefore, splitDrag: splitAfter > splitBefore, dockDrag: dockAfter > dockBefore, errors, bodyWidth: await page.locator('body').evaluate(element => element.scrollWidth) }, null, 2));
await browser.close();
