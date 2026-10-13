import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { readFile, writeFile, realpath, readdir, rename, mkdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';

/** 独立 Host 的只读观察器；不暂停、替换或取消原转换器，也不开放远程接口。 */
export async function apply(ctx) {
  const root = await realpath(resolve(import.meta.dirname, '../../../plugin/artifacts/latest-runtime-check/relay-homes'));
  const home = await realpath(process.env.DSH_HOME);
  const within = relative(root, home);
  if (!within || within.startsWith('..') || isAbsolute(within)) throw Error('engine_observer_outside_test_home');
  const scratch = await realpath(resolve(home, 'office-engine-tmp'));
  if (await realpath(process.env.TEMP) !== scratch || await realpath(process.env.TMP) !== scratch)
    throw Error('engine_observer_requires_owned_tmp');
  const input = resolve(home, 'office-engine-control.json'), output = resolve(home, 'office-engine-observations');
  await mkdir(output, { recursive: true });
  const originalSpawn = childProcess.spawn;
  let control, closed = false, tickTask, sequence = 0, lastService;
  const helpers = [], errors = [], pending = new Set();
  const owned = path => {
    const value = relative(scratch, path);
    return value && !value.startsWith('..') && !isAbsolute(value);
  };
  function spawn(...args) {
    // 始终先调用原 spawn；观察器不改变程序参数、环境、输出或执行时序。
    const child = originalSpawn.apply(this, args);
    const argv = args[1];
    if (!control || !Array.isArray(argv) || !argv.includes('--program-directory') || !argv.includes('--input-path')) return child;
    const option = name => argv[argv.indexOf(name) + 1];
    const inputPath = option('--input-path'), outputPath = option('--output-path');
    if (!owned(inputPath) || !owned(outputPath) || option('--format') !== 'pdf') {
      errors.push('native_helper_outside_owned_tmp'); return child;
    }
    const record = { pid: child.pid, executable: args[0], inputPath, outputPath,
      startedAt: new Date().toISOString(), closed: false };
    helpers.push(record);
    child.once('close', (code, signal) => Object.assign(record, { closed: true, code, signal, closedAt: new Date().toISOString() }));
    child.once('error', error => errors.push(error.message));
    const task = readFile(inputPath).then(bytes => {
      record.inputSha256 = createHash('sha256').update(bytes).digest('hex');
      if (record.inputSha256 !== control.sha256) errors.push('native_input_digest_mismatch');
    }, error => errors.push('native_input_read_failed: ' + error.code));
    pending.add(task); void task.finally(() => pending.delete(task));
    return child;
  }
  childProcess.spawn = spawn;
  syncBuiltinESMExports();
  const tick = async () => {
    if (closed || tickTask) return;
    tickTask = (async () => {
      try {
        const next = JSON.parse(await readFile(input, 'utf8'));
        if (!/^[0-9a-f-]{36}$/.test(next.id) || !/^[0-9a-f]{64}$/.test(next.sha256)) throw Error('invalid_engine_control');
        if (control && control.id !== next.id) throw Error('engine_control_owner_changed');
        control = next;
        const currentService = ctx.get('officeToPdf');
        if (currentService) lastService = currentService;
        // 卸载后只旁观旧对象的实际清理；不保留服务注册或阻止原 dispose。
        const service = currentService ?? lastService;
        if (!service) return;
        const queue = service.queue;
        if (!(queue.ready instanceof Map) || !(queue.tasks instanceof Set) || !Array.isArray(service.slots))
          throw Error('original_office_queue_shape_changed');
        const value = { at: new Date().toISOString(), id: control.id, hostPid: process.pid,
          generation: service.generation, serviceAvailable: currentService !== undefined, expectedSha256: control.sha256, helpers, errors,
          queue: { running: queue.running, readers: queue.readers, tasks: queue.tasks.size,
            sourceBytes: queue.sourceBytes, sources: queue.sources.size, digests: queue.digests.size,
            cached: queue.ready.size, cachedBytes: queue.cachedBytes, busySlots: service.slots.filter(slot => slot.busy).length },
          scratchDirectories: (await readdir(scratch)).filter(name => /^(dsh-office-to-pdf-|libreoffice-kit-)/.test(name)) };
        // Windows 上读者可能暂时锁住旧文件；发布不可变的新快照，不覆盖正在读取的文件。
        const target = resolve(output, control.id + '-' + String(sequence++).padStart(6, '0') + '.json');
        await writeFile(target + '.tmp', JSON.stringify(value), { flag: 'wx' });
        await rename(target + '.tmp', target);
      } catch (error) {
        if (error.code !== 'ENOENT') errors.push(error.message);
      }
    })();
    try { await tickTask; } finally { tickTask = undefined; }
  };
  const timer = setInterval(() => { void tick(); }, 25);
  ctx.effect(() => async () => {
    closed = true; clearInterval(timer);
    if (childProcess.spawn === spawn) { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); }
    await tickTask; await Promise.all(pending);
  });
}
