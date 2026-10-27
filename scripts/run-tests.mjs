/**
 * 运行编译后的 Node.js 测试文件，并支持按源码目录或文件筛选。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-16
 */
import { existsSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { cpus } from 'node:os';

// 仅依赖 Node.js 内置模块，使测试入口在干净安装后即可执行。
// 编译产物由 TypeScript 生成，脚本本身保持为可直接调用的 ESM 文件。
// 编译后的测试文件统一从 dist/tests 目录发现，保持源码目录到产物目录的映射稳定。
const compiledTestRoot = join(process.cwd(), 'dist', 'tests');
// npm 透传的 --run 只是筛选标记，不应作为路径参与匹配；其余参数按路径处理。
const requestedPaths = process.argv.slice(2).filter((argument) => argument !== '--run');

/**
 * 递归收集目录下的编译测试文件。
 *
 * @param directory - 要扫描的编译目录
 * @returns 按路径排序返回测试文件绝对路径
 * @author lvdaxianer@yeah.net
 * @date 2026-10-16
 */
function collectTestFiles(directory) {
  // 目录递归只做本地文件转换，不执行远程或数据库调用，避免测试发现产生外部副作用。
  const testFiles = readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(directory, entry.name);
    // 子目录继续递归，普通文件进入扩展名判断，保证嵌套测试目录也能被发现。
    if (entry.isDirectory()) {
      return collectTestFiles(entryPath);
    }
    // 非测试文件被排除，避免声明文件、源码映射等产物误交给 Node 测试运行器。
    return entry.isFile() && entry.name.endsWith('.test.js') ? [entryPath] : [];
  });
  // 排序保证不同文件系统的遍历顺序不会改变测试执行顺序。
  return testFiles.sort();
}

// 构建目录缺失时立即失败，并给出可执行的修复提示，避免空集合造成假绿。
if (!existsSync(compiledTestRoot)) {
  console.error('未找到 dist/tests，请先执行 npm run build。');
  process.exit(1);
}

// 先收集全部测试，再按调用方提供的源码路径缩小范围，避免直接把目录交给 Node。
const allTestFiles = collectTestFiles(compiledTestRoot);
// 无筛选参数时运行完整测试集，保证默认 npm test 覆盖所有已编译测试。
const testFiles = requestedPaths.length === 0
  ? allTestFiles
  : allTestFiles.filter((filePath) => {
      // relative 结果从 dist/tests 计算，因此补上 tests 前缀即可恢复源码语义路径。
      const sourcePath = `tests${sep}${relative(compiledTestRoot, filePath)}`;
      // 同时保留编译后的 .js 路径和去掉 .test 后缀的源码路径，兼容常见调用方式。
      const compiledPathWithoutExtension = sourcePath.replace(/\.js$/, '');
      const sourcePathWithoutTestSuffix = sourcePath.replace(/\.test\.js$/, '');
      return requestedPaths.some((requestedPath) => {
        // 统一 POSIX 与 Windows 分隔符，并移除目录尾斜杠，避免跨平台筛选失配。
        const normalizedPath = requestedPath.replaceAll('/', sep).replace(/[\\/]+$/, '');
        // 源码筛选可以带 ts/tsx/mts/cts 扩展名，也可以只给测试目录前缀。
        const sourcePathWithoutExtension = normalizedPath.replace(/\.(?:ts|tsx|mts|cts)$/, '');
        // 精确路径优先覆盖单个测试文件，避免相似文件名被误选中。
        return sourcePath === normalizedPath
          || compiledPathWithoutExtension === sourcePathWithoutExtension
          || sourcePathWithoutTestSuffix === sourcePathWithoutExtension
          // 目录前缀只在分隔符边界匹配，避免 tests/foo 匹配到 tests/foobar。
          || sourcePath.startsWith(`${normalizedPath}${sep}`);
      });
    });

// 没有匹配文件时失败，防止聚焦测试命令在测试缺失时伪装通过。
if (testFiles.length === 0) {
  // 筛选参数拼写错误也必须失败，帮助调用方及时发现测试未被执行。
  console.error('未找到与筛选条件匹配的测试文件。');
  process.exitCode = 1;
} else {
  // 测试未显式提供 snapshotPath 时使用独立内存 SQLite，避免多个用例共享开发机默认文件；恢复回归会显式传入临时文件。
  // 每个文件使用独立 Node 进程按有界并发运行，隔离环境变量、临时端口和 Worker SQLite；并发度可用 IAR_TEST_CONCURRENCY 覆盖。
  const failures = [];
  let nextIndex = 0;
  const envConcurrency = Number.parseInt(process.env.IAR_TEST_CONCURRENCY ?? '', 10);
  const concurrency = Number.isFinite(envConcurrency) && envConcurrency > 0
    ? envConcurrency
    : Math.min(6, Math.max(2, (cpus().length || 2) - 2));

  /** 启动单个测试进程并等待退出，失败信息收集后统一汇总。 */
  async function runTestFile(testFile) {
    await new Promise((resolve) => {
      const child = spawn(process.execPath, ['--test', testFile], { stdio: 'inherit', env: { ...process.env, IAR_SANDBOX_SQLITE_PATH: ':memory:' } });
      // 启动失败没有退出码，必须显式输出底层错误，便于定位 Node 或权限问题。
      child.on('error', (error) => {
        console.error(`测试进程启动失败：${error.message}`);
        failures.push({ file: testFile, code: 1 });
        resolve();
      });
      child.on('exit', (code, signal) => {
        if ((code ?? 1) !== 0) failures.push({ file: testFile, code: code ?? 1, signal });
        resolve();
      });
    });
  }

  /** 并发工作线程持续领取测试文件，直到队列耗尽。 */
  async function worker() {
    while (nextIndex < testFiles.length) {
      const testFile = testFiles[nextIndex++];
      await runTestFile(testFile);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));

  if (failures.length > 0) {
    process.exitCode = failures[0].code;
    console.error(`\n${failures.length} 个测试文件失败：`);
    for (const failure of failures) console.error(` - ${relative(process.cwd(), failure.file)}`);
  } else {
    process.exitCode = 0;
  }
}
