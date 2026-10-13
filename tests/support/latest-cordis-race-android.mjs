import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { _android } from '../../../dsh-mobile/node_modules/playwright/index.mjs';
import { unzipSync } from '../../../dsh-mobile/node_modules/fflate/esm/index.mjs';
import { androidAppWebView } from '../../../dsh-mobile/scripts/android-app-webview.mjs';

/** 独立测试 UID 使用实际原生配对、密钥、资源桥和 socket；不读取主 App 数据。 */
export async function createLatestRaceAndroid({ origin, pairLink, title, approve, gate,
  packageName = 'dev.dshmobile.validation.latestofficetest', name = 'Latest race Android',
  connectionScoped = false, ownsReverse = true }) {
  const builds = { 'dev.dshmobile.validation.latestofficetest': 'latest-office-android-build',
    'dev.dshmobile.validation.latestcordispeer': 'latest-cordis-peer-android-build' };
  assert.ok(Object.hasOwn(builds, packageName), '只能清理两个明确归属的临时测试 UID');
  const root = resolve(import.meta.dirname, '../../../dsh-mobile');
  const serial = process.env.DSHM_ANDROID_SERIAL, adb = process.env.DSHM_ADB_PATH;
  assert.equal(serial, 'emulator-5554'); assert.ok(adb);
  const run = args => execFileSync(adb, ['-s', serial, ...args], { cwd: root, windowsHide: true, encoding: 'utf8' }).trim();
  const build = resolve(root, 'artifacts', builds[packageName], 'outputs/apk/debug');
  const metadata = JSON.parse(await readFile(resolve(build, 'output-metadata.json'), 'utf8'));
  assert.equal(metadata.applicationId, packageName);
  const bytes = await readFile(resolve(build, 'app-debug.apk'));
  const hash = value => createHash('sha256').update(value).digest('hex');
  const apk = unzipSync(bytes, { filter: entry => entry.name.startsWith('assets/web/') });
  const web = resolve(root, 'artifacts/latest-mobile-dist');
  const files = async directory => {
    const result = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      assert.equal(entry.isSymbolicLink(), false);
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) result.push(...await files(path));
      else if (entry.isFile() && relative(web, path) !== 'bundle-analysis.json') result.push(path);
    }
    return result;
  };
  const paths = await files(web), names = paths.map(path => 'assets/web/' + relative(web, path).replaceAll('\\', '/'));
  assert.deepEqual(Object.keys(apk).filter(name => !name.endsWith('/')).sort(), [...names].sort());
  for (let i = 0; i < paths.length; i++) assert.equal(hash(apk[names[i]]), hash(await readFile(paths[i])), names[i]);
  const installed = run(['shell', 'pm', 'path', packageName]);
  assert.match(installed, /^package:\/data\/app\/[A-Za-z0-9_./=+~-]+\/base\.apk$/);
  assert.equal(run(['shell', 'sha256sum', installed.slice(8)]).split(/\s+/)[0], hash(bytes));
  Object.assign(gate.report, { packageName, serial, apkSha256: hash(bytes), webFiles: paths.length,
    installedMatchesApk: true, webMatchesBuild: true, nativePairingAndTransport: false });
  const devices = await _android.devices({ omitDriverInstall: true });
  const device = devices.find(item => item.serial() === serial); assert.ok(device);
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const port = new URL(origin).port;
  if (ownsReverse) run(['reverse', `tcp:${port}`, `tcp:${port}`]);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    run(['shell', 'am', 'force-stop', packageName]);
    if (ownsReverse) run(['reverse', '--remove', `tcp:${port}`]);
    await device.close(); gate.close();
  };
  try {
    // 此 UID 专用于临时联调；重复执行只清理它，绝不清除 latesttest 的 Key 或绑定。
    assert.equal(run(['shell', 'pm', 'clear', packageName]), 'Success');
    const key = new URLSearchParams(new URL(pairLink).hash.slice(1)).get('key');
    assert.match(key, /^[A-Za-z0-9_-]{43}$/);
    const link = `dshm://pair?server=${encodeURIComponent(origin)}#key=${key}`;
    await device.shell(`am start -W -a android.intent.action.VIEW -c android.intent.category.BROWSABLE -d '${link}' -p ${packageName}`);
    const first = await (await androidAppWebView(device, packageName)).page();
    const page = first.context().pages().find(item => item.url().startsWith('https://remote.dshm.invalid/'))
      ?? await first.context().waitForEvent('page', { predicate: item => item.url().startsWith('https://remote.dshm.invalid/'), timeout: 30000 });
    page.setDefaultTimeout(20000);
    page.on('pageerror', error => gate.report.pageErrors.push(error.message));
    page.on('console', entry => { if (entry.type() === 'error') gate.report.consoleErrors.push(entry.text()); });
    assert.equal(await page.getByRole('textbox', { name: '一次性配对链接', exact: true }).inputValue(), pairLink);
    await page.getByLabel('设备名称', { exact: true }).fill(name);
    await page.getByRole('button', { name: '继续配对', exact: true }).click();
    await page.getByRole('heading', { name: '等待电脑批准', exact: true }).waitFor();
    const fingerprint = await page.getByTestId('remote-fingerprint').innerText();
    assert.match(fingerprint, /^[A-Za-z0-9_-]{43}$/);
    const claim = await approve(fingerprint);
    await page.getByRole('button', { name: '我已在电脑批准', exact: true }).click();
    await page.getByTestId('remote-workspace').waitFor({ timeout: 60000 });
    await page.getByRole('button').filter({ hasText: title }).click();
    await page.locator('[data-composer-input]').waitFor();
    await page.getByText('LATEST_CORDIS_RACE_HISTORY', { exact: true }).waitFor();
    assert.equal(await page.locator('iframe').count(), 0);
    gate.report.nativePairingAndTransport = true;
    gate.report.nativeResourceReadsBeforeBrowserReentry = gate.report.resources;
    assert.ok(gate.report.nativeResourceReadsBeforeBrowserReentry > 0, '原生页面实际读取电脑插件资源');
    const panel = page.getByRole('region', { name: '插件面板', exact: true });
    const focus = async () => {
      // 两个 Android 客户端共用模拟器屏幕；先恢复该真实任务，避免操作暂停中的 WebView。
      const blocks = run(['shell', 'dumpsys', 'activity', 'recents']).split(/(?=\* Recent #\d+:)/);
      const escaped = packageName.replaceAll('.', '\\.');
      const task = blocks.find(text => new RegExp(`A=\\d+:${escaped}\\s`).test(text)
        && text.includes('/dev.dshmobile.validation.RemoteActivity'));
      const taskId = task?.match(/Task\{[^\n]*#(\d+) /)?.[1];
      assert.ok(taskId, `缺少 ${packageName} 的真实 Remote 任务`);
      assert.ok(run(['shell', 'am', 'task', 'focus', taskId]).includes(`Setting focus to task ${taskId}`));
      await page.waitForFunction(() => document.visibilityState === 'visible');
    };
    return { page, panel, claim, report: gate.report, native: true, close,
      hold: gate.hold, release: gate.release, focus,
      async open() {
        await focus();
        await page.getByRole('button', { name: 'Remote 选项', exact: true }).click();
        await page.getByRole('button', { name: '插件面板', exact: true }).click(); await panel.waitFor();
      },
      async expand() {
        await focus();
        if (!await panel.locator('[data-cordis-panel]').isVisible()) await panel.locator('[data-cordis-badge]').click();
        await panel.locator('[data-cordis-panel]').waitFor();
      },
      async reconnect({ expectLoaded = true } = {}) {
        await focus();
        const before = gate.report.pageConnections;
        const resultsBefore = gate.report.results.length;
        if (connectionScoped) gate.acceptNextConnection();
        await gate.disconnectPage();
        const deadline = Date.now() + 30000;
        while (gate.report.pageConnections <= before && Date.now() < deadline)
          await new Promise(done => setTimeout(done, 100));
        assert.equal(gate.report.pageConnections, before + 1, '原生页面实际建立新 socket 与会话订阅');
        if (!expectLoaded) {
          // session/follow 已建立不代表面板目录已重新呈现；等真实新读取，避免点击将卸载的旧按钮。
          const inventoryDeadline = Date.now() + 15000;
          while (!gate.report.results.slice(resultsBefore).some(item => item.endpoint === 'dynamicCordisRunner/inventory'
            && item.frame.value?.ok && Array.isArray(item.frame.value.value)) && Date.now() < inventoryDeadline)
            await new Promise(done => setTimeout(done, 100));
          assert.ok(gate.report.results.slice(resultsBefore).some(item => item.endpoint === 'dynamicCordisRunner/inventory'
            && item.frame.value?.ok && Array.isArray(item.frame.value.value)), '新连接实际目录响应已返回');
          await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
          return;
        }
        const closeWindow = page.getByRole('button', { name: '关闭窗口', exact: true });
        if (await closeWindow.isVisible()) await closeWindow.click();
        await panel.getByRole('button', { name: '返回聊天', exact: true }).click();
        const echo = page.getByTestId('latest-race-echo');
        assert.equal(await echo.getAttribute('data-version'), '2');
        await echo.click(); await echo.getByText('LATEST_RACE_HOST_V2', { exact: true }).waitFor();
        await page.getByRole('button', { name: 'Remote 选项', exact: true }).click();
        await page.getByRole('button', { name: '插件面板', exact: true }).click(); await panel.waitFor();
        gate.report.nativeSamePageReconnected = true;
      },
      async verifyRevoked() {
        await focus();
        const closeWindow = page.getByRole('button', { name: '关闭窗口', exact: true });
        if (await closeWindow.isVisible()) await closeWindow.click();
        await page.getByRole('button', { name: '重新连接', exact: true }).click();
        await page.getByRole('heading', { name: '连接授权已失效', exact: true }).waitFor({ timeout: 30000 });
        gate.report.nativeRevocationObserved = true;
      },
    };
  } catch (error) { await close(); throw error; }
}
