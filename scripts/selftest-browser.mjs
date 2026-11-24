/**
 * Playwright 浏览器自检: 启动 vite preview -> Chromium (启用 WebGPU)
 * -> 打开 #/selftest -> 运行 -> 等待 window.__SELFTEST_RESULT__ -> 写 JSON 并断言。
 * 用法: npm run build && node scripts/selftest-browser.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PORT = process.env.SELFTEST_PORT || '5199';
const BASE = `http://127.0.0.1:${PORT}`;
const TIMEOUT_MS = 180_000;

function startServer() {
  const proc = spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', PORT, '--strictPort'], {
    cwd: ROOT,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('preview server 启动超时')), 30_000);
    proc.stdout.on('data', (chunk) => {
      const s = String(chunk);
      if (s.includes('Local:') || s.includes(PORT)) {
        clearTimeout(timer);
        resolvePromise(proc);
      }
    });
    proc.stderr.on('data', (chunk) => process.stderr.write(chunk));
    proc.on('exit', (code) => {
      if (code !== 0 && code !== null) reject(new Error(`preview 退出码 ${code}`));
    });
  });
}

async function waitForResult(page) {
  const start = Date.now();
  while (Date.now() - start < TIMEOUT_MS) {
    const done = await page.evaluate(() => ({
      result: window.__SELFTEST_RESULT__ ?? null,
      error: window.__SELFTEST_ERROR__ ?? null,
    }));
    if (done.result || done.error) return done;
    await page.waitForTimeout(1000);
  }
  throw new Error('自检超时');
}

async function main() {
  const server = await startServer();
  let exitCode = 1;
  try {
    const browser = await chromium.launch({
      headless: true,
      args: [
        '--enable-unsafe-webgpu',
        '--enable-features=Vulkan,UseSkiaRenderer',
        '--disable-gpu-sandbox',
        '--no-sandbox',
      ],
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    const page = await context.newPage();
    const consoleLogs = [];
    page.on('console', (msg) => consoleLogs.push(`[${msg.type()}] ${msg.text()}`));
    page.on('pageerror', (err) => consoleLogs.push(`[pageerror] ${err.message}`));

    await page.goto(`${BASE}/#/selftest`, { waitUntil: 'networkidle' });
    await page.waitForSelector('button.primary');
    await page.click('button.primary');

    const outcome = await waitForResult(page);
    await mkdir(resolve(ROOT, 'test-results'), { recursive: true });
    await writeFile(
      resolve(ROOT, 'test-results/selftest.json'),
      JSON.stringify({ ...(outcome.result ?? {}), fatal: outcome.error, consoleLogs }, null, 2),
    );
    await page.screenshot({ path: resolve(ROOT, 'test-results/selftest.png'), fullPage: true });

    if (outcome.error) {
      console.error('自检致命错误:', outcome.error);
    } else {
      const r = outcome.result;
      console.log('=== 自检结果 ===');
      console.log(JSON.stringify(r, null, 2));
      if (r.ok) {
        console.log('\n✅ 全部验收项通过');
        exitCode = 0;
      } else {
        console.log('\n❌ 存在未通过项');
      }
    }
    await browser.close();
  } finally {
    server.kill();
  }
  process.exit(exitCode);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
