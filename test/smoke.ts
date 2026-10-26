/**
 * 冒烟测试：在临时 git 仓库中验证 GitService 数据层。
 * 运行：esbuild test/smoke.ts --bundle --platform=node --format=cjs --outfile=dist-test/smoke.cjs && node dist-test/smoke.cjs
 */
import { GitRunner, resolveGitExecutable, GitRunnerError } from '../src/host/git/GitRunner';
import { GitService } from '../src/host/git/GitService';
import { BranchOps } from '../src/host/git/BranchOps';
import { parseStatus, parseLog, parseCommitFiles, parseSignOffIdentity } from '../src/host/git/parsers';
import { absPathIn, relPathIn, normalizeFsPath } from '../src/host/core/paths';
import { blobUriParams, blobUriQuery, parseBlobParams } from '../src/host/core/blobUri';
import { computeLanes, buildEdges, laneColor, badgeWidth } from '../webview/graph/lanes';
import { buildFileTree, collectDirs, collectFiles } from '../webview/ui/fileTree';
import { parseBranchName, parseRemotes } from '../src/host/git/BranchOps';
import { CommitInfo, FileStatus } from '../shared/protocol';

/**
 * 测试里直接 spawnSync 调 git 的超时（毫秒）。
 * 本机在负载极高时 git 子进程会「输出完整但不退出」而无限挂起（spawnSync
 * 默认无超时 → 整轮冒烟永远卡住）；给个宽松上限，超时即报错而不是死等。
 */
const SPAWN_TIMEOUT = 120_000;

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}`, extra ?? '');
  }
}

async function main(): Promise<void> {
  const os = await import('os');
  const fs = await import('fs');
  const path = await import('path');
  const cp = await import('child_process');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turtlegit-smoke-'));
  /**
   * 清理临时仓库（尽力而为）：Windows 上刚 spawn 完的 git 进程/杀软可能仍持有
   * 目录句柄，rmSync 偶发 EBUSY 会让整轮冒烟崩在收尾——清理失败不应算测试失败。
   */
  const rmTmp = (p: string): void => {
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch {
      /* 忽略：临时目录清理失败不影响断言结果 */
    }
  };
  const run = (args: string[]) => {
    const r = cp.spawnSync('git', args, { cwd: dir, encoding: 'utf8', timeout: SPAWN_TIMEOUT });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout;
  };
  run(['init', '-b', 'main']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', '测试用户']);

  fs.writeFileSync(path.join(dir, 'a.txt'), 'line1\nline2\nline3\n', 'utf8');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'b.ts'), 'export const b = 1;\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'c.md'), '# title\n', 'utf8');
  run(['add', '-A']);
  run(['commit', '-m', 'feat: 初始提交']);

  // 构造变更：修改、新增、删除、暂存/未暂存混合
  fs.writeFileSync(path.join(dir, 'a.txt'), 'line1\nline2-modified\nline3\nline4\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'src', 'b.ts'), 'export const b = 2;\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'd.txt'), 'untracked file\n', 'utf8');
  fs.rmSync(path.join(dir, 'c.md'));
  run(['add', 'a.txt', 'src/b.ts', 'c.md']); // a.txt 与 b.ts 进暂存区，c.md 删除也进暂存区
  fs.writeFileSync(path.join(dir, 'src', 'b.ts'), 'export const b = 3;\n', 'utf8'); // b.ts 再改一次 → 暂存+工作区

  const git = new GitService(new GitRunner(resolveGitExecutable()));
  const ops = new BranchOps(new GitRunner(resolveGitExecutable()));

  console.log('== status 解析 ==');
  const files = await git.status(dir);
  const byPath = new Map(files.map((f) => [f.path, f]));
  check('a.txt 已暂存修改', byPath.get('a.txt')?.index === 'modified' && byPath.get('a.txt')?.worktree === 'none');
  check('src/b.ts 暂存+工作区双状态', byPath.get('src/b.ts')?.index === 'modified' && byPath.get('src/b.ts')?.worktree === 'modified', byPath.get('src/b.ts'));
  check('c.md 已暂存删除', byPath.get('c.md')?.index === 'deleted');
  check('d.txt 未跟踪', byPath.get('d.txt')?.untracked === true);
  check('文件总数 4', files.length === 4, files.map((f) => f.path));

  console.log('== diff ==');
  const patch = await git.diffPatch(dir, 'a.txt', true);
  check('a.txt 暂存 diff 含 -line2/+line2-modified', patch.includes('-line2') && patch.includes('+line2-modified'));
  const patchW = await git.diffPatch(dir, 'src/b.ts', false);
  check('b.ts 工作区 diff 含 +export const b = 3', patchW.includes('+export const b = 3'));

  console.log('== 未跟踪文件 patch 与 numstat ==');
  const up = git.untrackedPatch(dir, 'd.txt');
  check('untrackedPatch 头部标准', up.includes('diff --git a/d.txt b/d.txt') && up.includes('--- /dev/null') && up.includes('+++ b/d.txt'), up);
  check('untrackedPatch 全新增行', up.includes('@@ -0,0 +1,1 @@') && up.includes('+untracked file'), up);

  // 无末尾换行
  fs.writeFileSync(path.join(dir, 'nonl.txt'), 'no trailing newline', 'utf8');
  const up2 = git.untrackedPatch(dir, 'nonl.txt');
  check('untrackedPatch 含无末尾换行标记', up2.includes('\\ No newline at end of file') && up2.includes('+no trailing newline'), up2);
  check('untrackedPatch 无末尾换行不产生空新增行', !/\+ ?\n/.test(up2.replace(/\\ No newline at end of file\n$/, '')), up2);

  // 二进制文件
  fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x00]));
  const up3 = git.untrackedPatch(dir, 'bin.dat');
  check('untrackedPatch 二进制提示', up3.includes('Binary files /dev/null and b/bin.dat differ'), up3);

  // 空文件
  fs.writeFileSync(path.join(dir, 'empty.txt'), '', 'utf8');
  const up4 = git.untrackedPatch(dir, 'empty.txt');
  check('untrackedPatch 空文件无新增行', up4.includes('@@ -0,0 +0,0 @@') && !up4.split('\n').some((l) => l.startsWith('+') && !l.startsWith('+++')), up4);

  const stats = await git.numstat(dir);
  const statOf = (p: string) => stats.find((s) => s.path === p);
  check('numstat a.txt +2 -1', statOf('a.txt')?.additions === 2 && statOf('a.txt')?.deletions === 1, statOf('a.txt'));
  check('numstat src/b.ts +1 -1', statOf('src/b.ts')?.additions === 1 && statOf('src/b.ts')?.deletions === 1, statOf('src/b.ts'));
  check('numstat c.md 删除 0 -1', statOf('c.md')?.additions === 0 && statOf('c.md')?.deletions === 1, statOf('c.md'));
  check('numstat d.txt 未跟踪 +1 -0', statOf('d.txt')?.additions === 1 && statOf('d.txt')?.deletions === 0, statOf('d.txt'));
  check('numstat nonl.txt +1 -0', statOf('nonl.txt')?.additions === 1 && statOf('nonl.txt')?.deletions === 0, statOf('nonl.txt'));
  check('numstat 二进制计 0', statOf('bin.dat')?.additions === 0 && statOf('bin.dat')?.deletions === 0, statOf('bin.dat'));
  check('numstat 空文件计 0', statOf('empty.txt')?.additions === 0 && statOf('empty.txt')?.deletions === 0, statOf('empty.txt'));

  fs.rmSync(path.join(dir, 'nonl.txt'));
  fs.rmSync(path.join(dir, 'bin.dat'));
  fs.rmSync(path.join(dir, 'empty.txt'));

  console.log('== 空仓库 numstat（无 HEAD） ==');
  {
    const d3 = fs.mkdtempSync(path.join(os.tmpdir(), 'turtlegit-empty-'));
    const r3 = (args: string[]) => {
      const r = cp.spawnSync('git', args, { cwd: d3, encoding: 'utf8', timeout: SPAWN_TIMEOUT });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
      return r.stdout.trim();
    };
    r3(['init', '-b', 'main']);
    r3(['config', 'user.email', 'e@e.com']);
    r3(['config', 'user.name', '空仓库测试']);
    fs.writeFileSync(path.join(d3, 'fresh.txt'), 'x\ny\nz\n', 'utf8');
    const emptyStats = await git.numstat(d3);
    check('空仓库 numstat 不抛错', Array.isArray(emptyStats));
    check('空仓库统计未跟踪文件 3 行', emptyStats.length === 1 && emptyStats[0].additions === 3, emptyStats);
    rmTmp(d3);
  }

  console.log('== 部分提交（勾选子集） ==');
  const { hash } = await git.commit({ repoRoot: dir, message: 'chore: 部分提交', files: ['src/b.ts'] });
  check('提交返回 hash', /^[0-9a-f]{40}$/.test(hash), hash);
  const after = await git.status(dir);
  check('提交后 b.ts 已干净（不在变更列表）', !after.some((f) => f.path === 'src/b.ts'), after.map((f) => f.path));
  check('提交后 a.txt 仍在暂存区', after.find((f) => f.path === 'a.txt')?.index === 'modified');
  const headSubject = (await git.log({ repoRoot: dir, limit: 1 }))[0]?.subject;
  check('HEAD 提交信息正确', headSubject === 'chore: 部分提交', headSubject);

  console.log('== 日志与提交文件 ==');
  const log = await git.log({ repoRoot: dir, limit: 10 });
  check('日志 2 条', log.length === 2, log.map((c) => c.subject));
  check('作者解析', log[0].author === '测试用户');
  check('refs 含 main', log.some((c) => c.refs.some((r) => r.includes('main'))), log[0].refs);
  const cf = await git.commitFiles(dir, hash);
  check('提交文件解析 b.ts', cf.some((f) => f.path === 'src/b.ts' && f.status === 'M'), cf);
  check('numstat 统计', cf[0]?.additions === 1 && cf[0]?.deletions === 1, cf[0]);

  console.log('== 签署（Signed-off-by）与提交后推送 ==');
  // --- 纯函数：签署人解析 ---
  const idFull = parseSignOffIdentity('张三 <zhangsan@example.com>');
  check(
    '解析完整签署人',
    idFull?.name === '张三' && idFull?.email === 'zhangsan@example.com',
    idFull,
  );
  const idName = parseSignOffIdentity('  李四  ');
  check('纯姓名 → email 为空', idName?.name === '李四' && idName?.email === '', idName);
  const idMail = parseSignOffIdentity('lisi@example.com');
  check('纯邮箱 → name 为空', idMail?.name === '' && idMail?.email === 'lisi@example.com', idMail);
  check('空白返回 null', parseSignOffIdentity('   ') === null);
  check('换行/制表符折叠成空格', parseSignOffIdentity('王五\n<w@e.com>')?.name === '王五');
  check('尖括号被剥离防注入', parseSignOffIdentity('a<b')?.name === 'ab');

  // --- git 身份读取 ---
  const ident = await git.identity(dir);
  check(
    'identity 读出仓库配置',
    ident.name === '测试用户' && ident.email === 'test@example.com',
    ident,
  );

  const bodyOf = (): string =>
    cp.spawnSync('git', ['log', '-1', '--format=%B'], { cwd: dir, encoding: 'utf8', timeout: SPAWN_TIMEOUT }).stdout;

  // --- 填写签署人 → 覆盖本次提交身份 ---
  fs.writeFileSync(path.join(dir, 'signoff1.txt'), 'x\n', 'utf8');
  run(['add', 'signoff1.txt']);
  await git.commit({
    repoRoot: dir,
    message: 'test: 自定义签署人',
    signOff: true,
    signOffName: '张三 <zhangsan@example.com>',
  });
  check(
    '自定义签署人写入 Signed-off-by',
    bodyOf().includes('Signed-off-by: 张三 <zhangsan@example.com>'),
    bodyOf(),
  );

  // --- 不填签署人 → 用 git 自己的身份 ---
  fs.writeFileSync(path.join(dir, 'signoff2.txt'), 'y\n', 'utf8');
  run(['add', 'signoff2.txt']);
  await git.commit({ repoRoot: dir, message: 'test: 默认签署', signOff: true });
  check(
    '默认签署用 git 身份',
    bodyOf().includes('Signed-off-by: 测试用户 <test@example.com>'),
    bodyOf(),
  );

  // --- 不勾选签署 → 无尾注 ---
  fs.writeFileSync(path.join(dir, 'signoff3.txt'), 'z\n', 'utf8');
  run(['add', 'signoff3.txt']);
  await git.commit({ repoRoot: dir, message: 'test: 不签署' });
  check('未勾选签署时无 Signed-off-by', !bodyOf().includes('Signed-off-by'), bodyOf());

  // --- 仓库与全局均无身份时，靠签署人补齐也能提交 ---
  const noId = fs.mkdtempSync(path.join(os.tmpdir(), 'turtlegit-noid-'));
  const bareEnv = {
    ...process.env,
    HOME: noId,
    USERPROFILE: noId,
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const runBare = (args: string[]) => {
    const r = cp.spawnSync('git', args, {
      cwd: noId,
      encoding: 'utf8',
      env: bareEnv,
      timeout: SPAWN_TIMEOUT,
    });
    return r;
  };
  runBare(['init', '-b', 'main']);
  fs.writeFileSync(path.join(noId, 'a.txt'), 'a\n', 'utf8');
  runBare(['add', 'a.txt']);
  const noIdCommit = await git.commit({
    repoRoot: noId,
    message: 'test: 无身份仓库签署',
    signOff: true,
    signOffName: '王五 <wangwu@example.com>',
  });
  check(
    '无身份仓库靠签署人完成提交',
    /^[0-9a-f]{40}$/.test(noIdCommit.hash),
    noIdCommit,
  );
  const noIdBody = cp.spawnSync('git', ['log', '-1', '--format=%B'], {
    cwd: noId,
    encoding: 'utf8',
    env: bareEnv,
    timeout: SPAWN_TIMEOUT,
  }).stdout;
  check(
    '无身份仓库的 Signed-off-by 正确',
    noIdBody.includes('Signed-off-by: 王五 <wangwu@example.com>'),
    noIdBody,
  );
  // -c 覆盖对 author/committer 同时生效：身份缺失时靠签署人补齐
  const noIdAuthor = cp.spawnSync('git', ['log', '-1', '--format=%an <%ae>'], {
    cwd: noId,
    encoding: 'utf8',
    env: bareEnv,
    timeout: SPAWN_TIMEOUT,
  }).stdout.trim();
  check('无身份仓库的作者为签署人', noIdAuthor === '王五 <wangwu@example.com>', noIdAuthor);
  rmTmp(noId);

  console.log('== 分支信息 ==');
  const info = await git.branchInfo(dir);
  check('分支名 main', info.name === 'main', info);
  check('状态 clean', info.state === 'clean');

  console.log('== 中文路径 ==');
  fs.mkdirSync(path.join(dir, '中文目录'));
  fs.writeFileSync(path.join(dir, '中文目录', '文件.txt'), '内容\n', 'utf8');
  run(['add', '-A']);
  run(['commit', '-m', 'test: 中文']);
  fs.writeFileSync(path.join(dir, '中文目录', '文件.txt'), '内容2\n', 'utf8'); // 先修改再部分提交
  const cn = await git.commit({ repoRoot: dir, message: 'test: 中文2', files: ['中文目录/文件.txt'] });
  check('中文路径提交成功', /^[0-9a-f]{40}$/.test(cn.hash), cn);
  const cnStatus = await git.status(dir);
  check('中文路径提交后干净', !cnStatus.some((f) => f.path.includes('文件.txt')), cnStatus.map((f) => f.path));
  fs.writeFileSync(path.join(dir, '中文目录', '文件.txt'), '内容3\n', 'utf8');
  const cnPatch = await git.diffPatch(dir, '中文目录/文件.txt', false);
  check('中文路径 diff', cnPatch.includes('内容3'), cnPatch);
  check('中文路径出现在 status', (await git.status(dir)).some((f) => f.path === '中文目录/文件.txt'));

  console.log('== 空格+中文路径 ==');
  fs.mkdirSync(path.join(dir, 'my dir'));
  fs.writeFileSync(path.join(dir, 'my dir', 'my file - 副本.txt'), 'space content\n', 'utf8');
  run(['add', '-A']);
  const spStatus = await git.status(dir);
  const spByPath = new Map(spStatus.map((f) => [f.path, f]));
  check('空格+中文路径完整解析（新增暂存条目）', spByPath.has('my dir/my file - 副本.txt'), [...spByPath.keys()]);
  check('空格路径不产生根目录残片', !spByPath.has('副本.txt') && !spByPath.has('my file - 副本.txt'), [...spByPath.keys()]);
  check(
    '空格路径 absPath 正确',
    spByPath.get('my dir/my file - 副本.txt')?.absPath === absPathIn(dir, 'my dir/my file - 副本.txt'),
    spByPath.get('my dir/my file - 副本.txt'),
  );
  // 再改一次 → 类型 1 条目（暂存+工作区双状态）的 path 同样带空格
  fs.writeFileSync(path.join(dir, 'my dir', 'my file - 副本.txt'), 'space content2\n', 'utf8');
  const spStatus2 = await git.status(dir);
  check(
    '空格路径工作区修改解析（类型 1 条目）',
    spStatus2.some((f) => f.path === 'my dir/my file - 副本.txt' && f.index === 'added' && f.worktree === 'modified'),
    spStatus2.map((f) => f.path),
  );
  const spDiff = await git.diffPatch(dir, 'my dir/my file - 副本.txt', false);
  check('空格路径 diff 可读', spDiff.includes('space content2'), spDiff);
  const spNumstat = (await git.numstat(dir)).find((n) => n.path === 'my dir/my file - 副本.txt');
  check('空格路径 numstat 命中（新文件 +1 -0）', spNumstat?.additions === 1 && spNumstat?.deletions === 0, spNumstat);
  run(['add', '-A']); // 工作区最新内容也暂存，再整仓库提交
  run(['commit', '-m', 'test: 空格路径']);
  check('空格路径提交后干净', !(await git.status(dir)).some((f) => f.path.includes('副本')));

  console.log('== parsers 边界 ==');
  check('空 status 解析为空数组', parseStatus('', dir).length === 0);
  check('空 log 解析为空数组', parseLog('').length === 0);
  check('空 name-status 解析为空数组', parseCommitFiles('').length === 0);
  // 空格路径：-z 模式下路径原样输出、不引号包裹；类型 1 条目必须按固定前缀切片还原
  const spParse = parseStatus(
    '1 .M N... 100644 100644 100644 aaa bbb my dir/my file - 副本.txt\0? untracked dir/x.txt\0',
    dir,
  );
  check('parseStatus 类型1 空格路径完整还原', spParse[0]?.path === 'my dir/my file - 副本.txt', spParse[0]);
  check('parseStatus 未跟踪空格路径完整还原', spParse[1]?.path === 'untracked dir/x.txt', spParse[1]);

  console.log('== 跨平台路径工具 ==');
  const sep = process.platform === 'win32' ? '\\' : '/';
  check('normalizeFsPath 使用平台分隔符', normalizeFsPath('a/b\\c') === ['a', 'b', 'c'].join(sep), normalizeFsPath('a/b\\c'));
  check('relPathIn 仓库相对路径为正斜杠', relPathIn(dir, `${dir}${sep}src${sep}b.ts`) === 'src/b.ts', relPathIn(dir, `${dir}${sep}src${sep}b.ts`));
  check('relPathIn 仓库根本身为空串', relPathIn(dir, dir) === '');
  check('relPathIn 仓库外返回 undefined', relPathIn(dir, `${dir}-outside${sep}x`) === undefined);
  check('absPathIn 往返一致', absPathIn(dir, 'src/b.ts') === `${dir}${sep}src${sep}b.ts`, absPathIn(dir, 'src/b.ts'));
  check('absPathIn 仓库根本身', absPathIn(dir, '') === dir);
  check('absPathIn 中文路径往返', relPathIn(dir, absPathIn(dir, '中文目录/文件.txt')) === '中文目录/文件.txt');
  check('repoRootOf 使用平台分隔符', (await git.repoRootOf(dir)) === dir, await git.repoRootOf(dir));

  rmTmp(dir);

  console.log('== 分支操作层（BranchOps） ==');
  {
    const os2 = await import('os');
    const fs2 = await import('fs');
    const path2 = await import('path');
    const cp2 = await import('child_process');
    const d2 = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'turtlegit-ops-'));
    const r2 = (args: string[]) => {
      const r = cp2.spawnSync('git', args, { cwd: d2, encoding: 'utf8', timeout: SPAWN_TIMEOUT });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
      return r.stdout.trim();
    };
    r2(['init', '-b', 'main']);
    r2(['config', 'user.email', 'ops@example.com']);
    r2(['config', 'user.name', '操作测试']);
    fs2.writeFileSync(path2.join(d2, 'a.txt'), 'one\ntwo\nthree\n', 'utf8');
    r2(['add', '-A']);
    r2(['commit', '-m', 'base']);

    // 分支与标签
    await ops.createBranch(d2, 'feature', 'HEAD', false);
    await ops.createTag(d2, 'v1.0');
    const branches = await ops.branches(d2);
    check('分支列表含 feature', branches.some((b) => b.name === 'feature' && !b.isRemote));
    check('当前分支仍是 main', branches.find((b) => b.name === 'main')?.isCurrent === true);
    const tags = await ops.tags(d2);
    check('标签 v1.0 存在', tags.some((t) => t.name === 'v1.0'));

    // 切换 + feature 提交 + cherry-pick
    await ops.checkout(d2, 'feature');
    const info = await git.branchInfo(d2);
    check('已切换到 feature', info.name === 'feature', info);
    fs2.writeFileSync(path2.join(d2, 'feature.txt'), 'feature only\n', 'utf8');
    r2(['add', '-A']);
    r2(['commit', '-m', 'feat: feature only']);
    const featHash = r2(['rev-parse', 'HEAD']);
    await ops.checkout(d2, 'main');
    await ops.cherryPick(d2, [featHash]);
    check('拣选后文件存在于 main', fs2.existsSync(path2.join(d2, 'feature.txt')));

    // 合并（内容相同，应自动解决）
    await ops.merge(d2, 'feature');
    const afterMerge = await git.status(d2);
    check('合并后工作区干净', afterMerge.length === 0, afterMerge.map((f) => f.path));

    // stash
    fs2.writeFileSync(path2.join(d2, 'a.txt'), 'dirty content\n', 'utf8');
    await ops.stashPush(d2, 'wip: smoke');
    const stashes = await ops.stashList(d2);
    check('stash 列表 1 条', stashes.length === 1, stashes);
    check('stash 消息正确', stashes[0]?.message.includes('wip: smoke'));
    check('stash 后工作区干净', (await git.status(d2)).length === 0);
    await ops.stashPop(d2, 0);
    check('pop 后修改恢复', fs2.readFileSync(path2.join(d2, 'a.txt'), 'utf8').includes('dirty content'));

    // revert + reset 恢复
    const beforeRevert = r2(['rev-parse', 'HEAD']);
    await ops.revert(d2, featHash);
    check('revert 后产生新提交', r2(['rev-parse', 'HEAD']) !== beforeRevert);
    await ops.reset(d2, beforeRevert, 'hard');
    check('hard reset 后回到原提交', r2(['rev-parse', 'HEAD']) === beforeRevert);
    check('hard reset 后文件恢复', fs2.existsSync(path2.join(d2, 'feature.txt')));

    // reflog / blame
    const reflog = await ops.reflog(d2, 30);
    check('reflog 非空', reflog.length > 0);
    check('reflog 含选择器', reflog.every((e) => /^HEAD@\{\d+\}$/.test(e.selector)), reflog[0]);
    const blame = await ops.blame(d2, 'a.txt');
    check('blame 行数正确', blame.length === 3, blame.length);
    check('blame 作者正确', blame.every((l) => l.author === '操作测试'));
    // hard reset 后工作区回到 HEAD 版本（'one\ntwo\nthree'）
    check('blame 含行内容', blame[0]?.content === 'one', blame[0]?.content);
    check('blame 短哈希', /^[0-9a-f]{7}$/.test(blame[0]?.shortHash ?? ''));

    // 分支重命名与删除
    await ops.renameBranch(d2, 'feature', 'feature-x');
    check('重命名分支', (await ops.branches(d2)).some((b) => b.name === 'feature-x'));
    await ops.deleteBranch(d2, 'feature-x', true);
    check('删除分支', !(await ops.branches(d2)).some((b) => b.name === 'feature-x'));

    rmTmp(d2);
  }

  console.log('== 拉取 / 推送（BranchOps pull/push） ==');
  {
    const os3 = await import('os');
    const fs3 = await import('fs');
    const path3 = await import('path');
    const cp3 = await import('child_process');
    const bare = fs3.mkdtempSync(path3.join(os3.tmpdir(), 'turtlegit-bare-'));
    const work = fs3.mkdtempSync(path3.join(os3.tmpdir(), 'turtlegit-work-'));
    const rb = (args: string[], cwd = bare) => {
      const r = cp3.spawnSync('git', args, { cwd, encoding: 'utf8', timeout: SPAWN_TIMEOUT });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
      return r.stdout.trim();
    };
    const rw = (args: string[]) => rb(args, work);
    rb(['init', '--bare', '-b', 'main']);
    rw(['init', '-b', 'main']);
    rw(['config', 'user.email', 'pull@example.com']);
    rw(['config', 'user.name', '拉取测试']);
    rw(['remote', 'add', 'origin', bare]);

    fs3.writeFileSync(path3.join(work, 'a.txt'), 'v1\n', 'utf8');
    rw(['add', '-A']);
    rw(['commit', '-m', 'c1']);
    // 首次推送：无上游 → 走自动探测 remote + -u 路径
    const push1 = await ops.push(work);
    check('首次推送（无上游自动 -u）', push1.code === 0, push1.stderr);
    check('远端含 c1', rb(['log', '--oneline']).includes('c1'));
    check('推送后建立上游跟踪', (await git.branchInfo(work)).upstream === 'origin/main', await git.branchInfo(work));

    fs3.writeFileSync(path3.join(work, 'a.txt'), 'v2\n', 'utf8');
    rw(['add', '-A']);
    rw(['commit', '-m', 'c2']);
    // 已有上游 → 普通 push 路径
    const push2 = await ops.push(work);
    check('二次推送（有上游）', push2.code === 0, push2.stderr);
    check('远端含 c2', rb(['log', '--oneline']).includes('c2'));

    // 本地回退一格后 pull → fast-forward 恢复
    rw(['reset', '--hard', 'HEAD~1']);
    check('本地已落后', rw(['rev-list', '--count', 'HEAD']) === '1');
    const pull = await ops.pull(work);
    check('pull 成功', pull.code === 0, pull.stderr);
    check('pull 后快进到 c2', rw(['log', '--oneline']).includes('c2'));
    check('pull 后文件内容同步', fs3.readFileSync(path3.join(work, 'a.txt'), 'utf8').trim() === 'v2', fs3.readFileSync(path3.join(work, 'a.txt'), 'utf8'));

    // 无新提交时 pull → Already up to date
    const pull2 = await ops.pull(work);
    check('重复 pull 为最新', /up to date/i.test(pull2.stdout + pull2.stderr), pull2.stdout);

    // detached HEAD 拉取应报错而非卡死
    rw(['checkout', '--detach', 'HEAD']);
    let pullDetachedErr: unknown;
    try {
      await ops.pull(work);
    } catch (e) {
      pullDetachedErr = e;
    }
    check(
      'detached HEAD pull 抛错',
      pullDetachedErr instanceof Error && /detached/i.test(pullDetachedErr.message),
      pullDetachedErr,
    );
    rw(['checkout', 'main']);

    rmTmp(bare);
    rmTmp(work);
  }

  console.log('== stash 按文件查看（主窗口 Stash 面板底层能力） ==');
  {
    const os4 = await import('os');
    const fs4 = await import('fs');
    const path4 = await import('path');
    const cp4 = await import('child_process');
    const d4 = fs4.mkdtempSync(path4.join(os4.tmpdir(), 'turtlegit-stashfiles-'));
    const r4 = (args: string[]) => {
      const r = cp4.spawnSync('git', args, { cwd: d4, encoding: 'utf8', timeout: SPAWN_TIMEOUT });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
      return r.stdout.trim();
    };
    r4(['init', '-b', 'main']);
    r4(['config', 'user.email', 'stash@example.com']);
    r4(['config', 'user.name', '暂存测试']);
    fs4.writeFileSync(path4.join(d4, 'a.txt'), 'one\ntwo\n', 'utf8');
    fs4.mkdirSync(path4.join(d4, 'src'));
    fs4.writeFileSync(path4.join(d4, 'src', 'b.ts'), 'const b = 1;\n', 'utf8');
    r4(['add', '-A']);
    r4(['commit', '-m', 'base']);
    // 构造含两个文件的 stash
    fs4.writeFileSync(path4.join(d4, 'a.txt'), 'one\ntwo-mod\nthree\n', 'utf8');
    fs4.writeFileSync(path4.join(d4, 'src', 'b.ts'), 'const b = 2;\n', 'utf8');
    await ops.stashPush(d4, 'wip: two files');

    // 主窗口 Stash 面板的文件列表：log:files 直接解析 stash ref
    const stashFiles = await git.commitFiles(d4, 'stash@{0}');
    check('stash 文件列表含 a.txt', stashFiles.some((f) => f.path === 'a.txt'), stashFiles.map((f) => f.path));
    check('stash 文件列表含 src/b.ts', stashFiles.some((f) => f.path === 'src/b.ts'), stashFiles.map((f) => f.path));
    check('stash 文件数为 2', stashFiles.length === 2, stashFiles.length);
    check('stash 文件状态为 M', stashFiles.every((f) => f.status === 'M'), stashFiles.map((f) => f.status));

    // 按文件查看差异：diff:patch 的 path + range 组合（git diff stash@{0}^..stash@{0} -- <file>）
    const patchA = await git.diffPatch(d4, 'a.txt', false, undefined, 'stash@{0}^..stash@{0}');
    check('a.txt 差异含新增行', patchA.includes('+three') && patchA.includes('-two'), patchA);
    check('a.txt 差异不含 b.ts 内容', !patchA.includes('const b = 2'), patchA);
    const patchB = await git.diffPatch(d4, 'src/b.ts', false, undefined, 'stash@{0}^..stash@{0}');
    check('b.ts 差异仅含本文件改动', patchB.includes('+const b = 2') && patchB.includes('-const b = 1'), patchB);
    check('b.ts 差异不含 a.txt 内容', !patchB.includes('three'), patchB);

    await ops.stashPop(d4, 0);
    check('pop 后两文件恢复', fs4.readFileSync(path4.join(d4, 'a.txt'), 'utf8').includes('three'));
    rmTmp(d4);
  }

  console.log('== lane 算法 ==');
  {
    const mk = (hash: string, parents: string[]): CommitInfo => ({
      hash,
      shortHash: hash,
      parents,
      author: 't',
      authorEmail: 't@t',
      authorDate: '2026-01-01T00:00:00+08:00',
      subject: hash,
      body: '',
      refs: [],
    });
    // 注意：git log 输出顺序为"子在前、父在后"（与 --topo-order 实际顺序一致）
    const linear = computeLanes([mk('c', ['b']), mk('b', ['a']), mk('a', [])]);
    check('线性历史 lane 全为 0', linear.every((n) => n.lane === 0), linear.map((n) => n.lane));
    check('root 提交无 parent', linear[2].parentLanes.length === 0, linear[2].parentLanes);

    const forked = computeLanes([
      mk('m', ['b', 'c']),
      mk('b', ['root']),
      mk('c', ['root']),
      mk('root', []),
    ]);
    check('分叉第二支线占 lane 1', forked[2].lane === 1, forked.map((n) => n.lane));
    check('合并节点回到 lane 0', forked[0].lane === 0);
    check('合并节点两个 parent 在不同 lane', new Set(forked[0].parentLanes).size === 2, forked[0].parentLanes);
    check('合并后旧支线 lane 释放', forked[3].lane === 0);

    // c 分支合入 d 后无后续提交：c 的 lane 不应泄漏到后续
    const merged = computeLanes([mk('d', ['b']), mk('b', ['root']), mk('c', ['root']), mk('root', [])]);
    check('合入场景 lane 正确', merged[0].lane === 0 && merged[1].lane === 0 && merged[2].lane === 1, merged.map((n) => n.lane));

    // 多分叉：三条支线
    const triple = computeLanes([
      mk('m', ['x', 'y', 'z']),
      mk('x', ['r']),
      mk('y', ['r']),
      mk('z', ['r']),
      mk('r', []),
    ]);
    check('三分叉占据 3 条 lane', new Set([triple[1].lane, triple[2].lane, triple[3].lane]).size === 3, triple.map((n) => n.lane));

    // 回归：分叉点泄漏幻影 lane（图沟槽越用越宽的真正原因）
    // 每个 Pi 都有两个子提交（主干 Ti 与支线 Bi 共享同一父提交 Pi）→ 旧实现里
    // 「两条 lane 同时等待 Pi」，Pi 落地只占第一条，另一条永久卡旧 hash 不再回收。
    const chain: Array<[string, string]> = [];
    const history: CommitInfo[] = [];
    for (let i = 1; i <= 4; i++) {
      const p = `p${i}`;
      const next = i === 4 ? undefined : `p${i + 1}`;
      history.push(mk(`t${i}`, [p]));
      history.push(mk(`b${i}`, [p]));
      history.push(mk(p, next ? [next] : []));
      chain.push([`t${i}`, `b${i}`]);
    }
    const multi = computeLanes(history);
    const maxLane = multi.reduce((m, n) => Math.max(m, n.lane), 0);
    check('多分叉不累积幻影 lane', maxLane <= 1, { maxLane, lanes: multi.map((n) => n.lane) });
    check(
      '支线用完即释放（lane 总数 = 2）',
      new Set(multi.map((n) => n.lane)).size === 2,
      multi.map((n) => n.lane),
    );

    // 边必须落在父节点真正所在的 lane 上（否则线断在半空）
    const multiEdges = buildEdges(multi);
    const wrong: unknown[] = [];
    multiEdges.forEach((e) => {
      if (e.continues) return;
      const parentRow = multi.findIndex((n) => n.commit.hash === multi[e.fromRow].commit.parents[0]);
      const targetLane = parentRow >= 0 ? multi[parentRow].lane : -1;
      if (parentRow >= 0 && targetLane !== e.toLane) wrong.push(e);
    });
    check('第一父提交的边连到父节点所在 lane', wrong.length === 0, wrong);
  }

  console.log('== 图沟槽宽度（autoLaneWidth / graphWidth / nodeRadius） ==');
  {
    const { autoLaneWidth, graphWidth, nodeRadius, GRAPH_PAD, GRAPH_W_MIN } = await import(
      '../webview/graph/lanes'
    );
    check('lane 越少间距越大', autoLaneWidth(1) > autoLaneWidth(5), [autoLaneWidth(1), autoLaneWidth(5)]);
    check('lane 多时压到 9px', autoLaneWidth(9) === 9, autoLaneWidth(9));
    check('间距不低于 7px', autoLaneWidth(20) >= 7, autoLaneWidth(20));
    check('图宽 = lane 数 × 间距 + padding', graphWidth(8, 10) === 8 * 10 + GRAPH_PAD, [graphWidth(8, 10), GRAPH_PAD]);
    check('图宽有下限', graphWidth(1, 7) === GRAPH_W_MIN, [graphWidth(1, 7), GRAPH_W_MIN]);
    check(
      '压缩后 8 条 lane 明显变窄（旧固定 18px = 150px）',
      graphWidth(8, autoLaneWidth(8)) < 8 * 18 + 6,
      graphWidth(8, autoLaneWidth(8)),
    );
    check('节点半径随间距收缩', nodeRadius(9) < nodeRadius(15), [nodeRadius(9), nodeRadius(15)]);
    check('节点半径有下限', nodeRadius(7) >= 2.6, nodeRadius(7));
    check('节点半径不超过 5', nodeRadius(28) === 5, nodeRadius(28));
  }

  console.log('== 版本分支图几何（buildEdges / laneColor / badgeWidth） ==');
  {
    const mk = (hash: string, parents: string[]): CommitInfo => ({
      hash,
      shortHash: hash,
      parents,
      author: 't',
      authorEmail: 't@t',
      authorDate: '2026-01-01T00:00:00+08:00',
      subject: hash,
      body: '',
      refs: [],
    });
    // 线性历史：逐行相连
    const lin = buildEdges(computeLanes([mk('c', ['b']), mk('b', ['a']), mk('a', [])]));
    check('线性历史 2 条连线', lin.length === 2, lin);
    check('线性连线连到下一行', lin[0].fromRow === 0 && lin[0].toRow === 1 && !lin[0].continues, lin[0]);
    check('线性连线不跨 lane', lin.every((e) => e.fromLane === e.toLane), lin);

    // 关键回归：合并提交的父提交往往隔着多行，连线必须连到父提交真实所在行
    // （旧实现一律连到下一行 → 线断在半空、节点没有入边，图看起来错位）
    const forked = computeLanes([mk('m', ['b', 'c']), mk('b', ['root']), mk('c', ['root']), mk('root', [])]);
    const fe = buildEdges(forked);
    const mToB = fe.find((e) => e.fromRow === 0 && e.toLane === forked[1].lane);
    const mToC = fe.find((e) => e.fromRow === 0 && e.toLane === forked[2].lane);
    check('合并节点第一父连到其真实行（隔行）', mToB?.toRow === 1, mToB);
    check('合并节点第二父连到其真实行', mToC?.toRow === 2, mToC);
    check('不再有连到"下一行"的错位连线', !fe.some((e) => e.fromRow === 0 && e.toRow === 1 && e.toLane === forked[2].lane), fe);
    check('末行 root 无出边', !fe.some((e) => e.fromRow === 3), fe);

    // 父提交不在列表内（未加载/被过滤）→ 延伸到底部
    const cont = buildEdges(computeLanes([mk('c', ['missing'])]));
    check('父提交缺失时标记为 continues', cont.length === 1 && cont[0].continues === true, cont);

    // lane 配色：固定调色板，不依赖主题背景色（暗黑模式下不会变黑点）
    check('不同 lane 颜色不同', laneColor(0) !== laneColor(1) && laneColor(1) !== laneColor(2));
    check('lane 颜色循环复用', laneColor(8) === laneColor(0));
    check('lane 颜色是具体色值而非主题变量', /^#[0-9a-f]{6}$/i.test(laneColor(3)), laneColor(3));

    // 徽标宽度：全角字符按 2 单位算，避免中文溢出矩形
    check('纯 ASCII 徽标宽度', Math.abs(badgeWidth('master') - (6 * 6.2 + 12)) < 0.001, badgeWidth('master'));
    check('中文徽标按全角计宽', Math.abs(badgeWidth('中文') - (4 * 6.2 + 12)) < 0.001, badgeWidth('中文'));
    check('中文徽标比同长度英文宽', badgeWidth('中文') > badgeWidth('ab'));
  }

  console.log('== 日志列截断 / 搜索匹配 / 对比引用挑选（fitText / searchMatches / pickCompareRef） ==');
  {
    const { fitText, searchMatches, pickCompareRef, isHeadCommit } = await import('../webview/graph/lanes');
    const mk = (
      hash: string,
      parents: string[],
      refs: string[],
      subject = hash,
    ): CommitInfo => ({
      hash,
      shortHash: hash.slice(0, 7),
      parents,
      author: 't',
      authorEmail: 't@t',
      authorDate: '2026-01-01T00:00:00+08:00',
      subject,
      body: '',
      refs,
    });
    // fitText：短文本原样；超宽截断补省略号；CJK 按双倍宽计
    check('短文本不截断', fitText('fix: 小改', 200) === 'fix: 小改', fitText('fix: 小改', 200));
    const truncated = fitText('abcdefghij', 40);
    check('超宽文本被截断', truncated.length < 10 && truncated.endsWith('…'), truncated);
    check('截断后宽度不超限', badgeWidth(truncated) - 12 <= 40 + 6.2, truncated);
    check('CJK 文本更早被截断', fitText('中文中文中文', 30).length <= 4, fitText('中文中文中文', 30));
    // searchMatches：hash/短哈希/消息/作者/引用，大小写不敏感
    const nodes = computeLanes([
      mk('aaaaaaa1111', ['bbbbbbb2222'], ['HEAD -> main'], 'feat: 登录'),
      mk('bbbbbbb2222', ['ccccccc3333'], ['origin/feature'], 'fix: 构建脚本'),
      mk('ccccccc3333', [], [], 'chore: 清理'),
    ]);
    check('按短哈希命中', searchMatches(nodes, 'BBBB').length === 1 && searchMatches(nodes, 'BBBB')[0] === 1, searchMatches(nodes, 'BBBB'));
    check('按消息命中（大小写不敏感）', searchMatches(nodes, '登录').length === 1 && searchMatches(nodes, '登录')[0] === 0, searchMatches(nodes, '登录'));
    check('按引用命中', searchMatches(nodes, 'origin/feature').length === 1 && searchMatches(nodes, 'origin/feature')[0] === 1);
    check('空关键词无匹配', searchMatches(nodes, '   ').length === 0);
    check('无匹配返回空', searchMatches(nodes, 'zzz-not-exist').length === 0);
    check('可同时命中多行', searchMatches(nodes, 'e').length === 3, searchMatches(nodes, 'e'));
    // pickCompareRef：优先本地分支 → 远程跟踪分支 → 提交号
    check('对比引用优先本地分支', pickCompareRef(mk('h', [], ['HEAD -> main'])) === 'main', pickCompareRef(mk('h', [], ['HEAD -> main'])));
    check('对比引用回退远程分支', pickCompareRef(mk('h', [], ['origin/feature'])) === 'origin/feature');
    check('对比引用回退提交号', pickCompareRef(mk('h'.padEnd(40, '0'), [], ['tag: v1'])) === 'h'.padEnd(40, '0'));
    // isHeadCommit：HEAD 自身不参与对比
    check('HEAD -> main 判为当前提交', isHeadCommit(mk('h', [], ['HEAD -> main'])));
    check('裸 HEAD 判为当前提交', isHeadCommit(mk('h', [], ['HEAD'])));
    check('普通分支不是当前提交', !isHeadCommit(mk('h', [], ['main'])));
  }

  console.log('== 行内分支芯片（branchChips）与日期预设（sinceArg） ==');
  {
    const { branchChips } = await import('../webview/graph/lanes');
    const { sinceArg } = await import('../src/host/git/parsers');

    // branchChips：head 芯片最左且取箭头后分支名（%D 里 'HEAD -> main' 是单个条目）
    const c1 = branchChips(['HEAD -> main', 'origin/main', 'tag: v1']);
    check('head 芯片排最左', c1.chips[0]?.kind === 'head' && c1.chips[0]?.text === 'main', c1.chips[0]);
    check('head 之后是远程分支', c1.chips[1]?.kind === 'remote' && c1.chips[1]?.text === 'origin/main', c1.chips.map((c) => c.text));
    check('标签排在分支之后', c1.chips[2]?.kind === 'tag' && c1.chips[2]?.text === 'v1', c1.chips.map((c) => c.text));
    check('head 芯片带 title', /当前分支/.test(c1.chips[0]?.title ?? ''), c1.chips[0]?.title);
    check('3 个 ref 无折叠', c1.collapsed.length === 0, c1.collapsed);

    // 分离头指针：裸 HEAD
    const c2 = branchChips(['HEAD']);
    check('裸 HEAD 显示 HEAD 芯片', c2.chips.length === 1 && c2.chips[0]?.text === 'HEAD' && c2.chips[0]?.kind === 'head', c2.chips);
    check('分离头指针 title 提示', /分离头指针/.test(c2.chips[0]?.title ?? ''), c2.chips[0]?.title);

    // 超过 3 个分支：截断 + collapsed
    const c3 = branchChips(['b1', 'b2', 'b3', 'b4', 'b5', 'tag: t1']);
    check('分支最多展示 3 个', c3.chips.filter((c) => c.kind !== 'tag').length === 3, c3.chips.map((c) => c.text));
    check('其余分支进 collapsed', c3.collapsed.length === 2 && c3.collapsed[0] === 'b4', c3.collapsed);
    check('collapsed 不含标签', !c3.collapsed.includes('t1'), c3.collapsed);
    check('标签仍展示', c3.chips.some((c) => c.kind === 'tag' && c.text === 't1'), c3.chips.map((c) => c.text));

    // 非 HEAD 提交：无 head 芯片
    const c4 = branchChips(['feature', 'origin/feature']);
    check('非 HEAD 提交无 head 芯片', c4.chips.every((c) => c.kind !== 'head'), c4.chips);
    check('空 refs 无芯片', branchChips([]).chips.length === 0 && branchChips([]).collapsed.length === 0);

    // sinceArg：预设映射 + 透传
    check('24h 映射', sinceArg('24h') === '24 hours ago', sinceArg('24h'));
    check('7d 映射', sinceArg('7d') === '7 days ago', sinceArg('7d'));
    check('日期串原样透传', sinceArg('2026-01-01') === '2026-01-01', sinceArg('2026-01-01'));
    check('空白 trim', sinceArg('  7d ') === '7 days ago', sinceArg('  7d '));
  }

  console.log('== 文件目录树构建（buildFileTree / collectFiles） ==');
  {
    const { buildFileTree, collectFiles } = await import('../webview/ui/fileTree');
    const mk = (path: string): FileStatus => ({
      path,
      index: 'modified',
      worktree: 'modified',
      untracked: false,
      ignored: false,
      conflicted: false,
    });
    const tree = buildFileTree(['src/a.ts', 'src/deep/b.ts', 'README.md', 'src/c/d.ts'].map(mk));
    check('顶层 1 目录 + 1 文件', tree.length === 2 && tree[0].kind === 'dir' && tree[1].kind === 'file', tree.map((n) => n.path));
    check('目录排在文件前', tree[0].path === 'src');
    check('src 下 2 目录 + 1 文件', tree[0].children!.filter((c) => c.kind === 'dir').length === 2 && tree[0].children!.filter((c) => c.kind === 'file').length === 1, tree[0].children!.map((c) => c.path));
    check('collectFiles 递归收集 3 个文件', collectFiles(tree[0]).length === 3, collectFiles(tree[0]).map((f) => f.path));
    check('collectFiles 对文件节点返回自身', collectFiles(tree[1]).length === 1);
    check('空输入为空树', buildFileTree([]).length === 0);
    check('根目录文件不建目录', buildFileTree([mk('a.txt'), mk('b.txt')]).every((n) => n.kind === 'file'));
    // 尾斜杠条目（超上限保持折叠的忽略目录 `! node_modules/`）→ 无子节点的目录节点
    const collapsedTree = buildFileTree([mk('node_modules/'), mk('.vscode/'), mk('src/a.ts')]);
    const nmNode = collapsedTree.find((n) => n.path === 'node_modules');
    check('尾斜杠条目建为目录节点', nmNode?.kind === 'dir' && (nmNode.children?.length ?? 0) === 0, collapsedTree.map((n) => `${n.kind}:${n.path}`));
    check('尾斜杠目录不产生空名文件行', collapsedTree.every((n) => n.label !== ''), collapsedTree.map((n) => `${n.kind}:${n.label}`));
    check('尾斜杠目录不参与 collectFiles', collectFiles(nmNode!).length === 0);
  }

  console.log('== 忽略列表写入（换行追加 / exclude / 目录两种模式） ==');
  {
    const igDir = fs.mkdtempSync(path.join(os.tmpdir(), 'turtlegit-ignore-'));
    const igRun = (args: string[]) => {
      const r = cp.spawnSync('git', args, { cwd: igDir, encoding: 'utf8', timeout: SPAWN_TIMEOUT });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
      return r.stdout;
    };
    igRun(['init', '-b', 'main']);
    fs.mkdirSync(path.join(igDir, 'build'));
    fs.writeFileSync(path.join(igDir, 'build', 'out.js'), 'var a=1;\n', 'utf8');
    fs.writeFileSync(path.join(igDir, 'build', 'out.css'), 'a{}\n', 'utf8');
    fs.mkdirSync(path.join(igDir, 'build', 'sub')); // 嵌套子目录：验证递归展开
    fs.writeFileSync(path.join(igDir, 'build', 'sub', 'deep.js'), 'deep\n', 'utf8');
    fs.writeFileSync(path.join(igDir, 'tmp.log'), 'log line\n', 'utf8');
    // 排除名单场景：.history / node_modules，以及嵌套在忽略目录里的同名目录
    fs.mkdirSync(path.join(igDir, '.history'));
    fs.writeFileSync(path.join(igDir, '.history', 'old.txt'), 'old\n', 'utf8');
    fs.mkdirSync(path.join(igDir, 'node_modules'));
    fs.writeFileSync(path.join(igDir, 'node_modules', 'x.js'), 'x\n', 'utf8');
    fs.mkdirSync(path.join(igDir, 'temp', '.history'), { recursive: true });
    fs.writeFileSync(path.join(igDir, 'temp', '.history', 'n.txt'), 'n\n', 'utf8');
    fs.writeFileSync(path.join(igDir, 'temp', 'ok.txt'), 'ok\n', 'utf8');
    // 超上限的巨型忽略目录（node_modules 场景）：保持折叠单条
    fs.mkdirSync(path.join(igDir, 'big'));
    for (let i = 0; i < 501; i++) {
      fs.writeFileSync(path.join(igDir, 'big', `f${i}.txt`), '', 'utf8');
    }

    // 1) 文件末尾无换行时也必须另起一行（原实现会粘在最后一行后面）
    const giPath = path.join(igDir, '.gitignore');
    fs.writeFileSync(giPath, 'node_modules', 'utf8'); // 故意不带换行
    await git.addToGitIgnore(igDir, ['tmp.log']);
    const gi1 = fs.readFileSync(giPath, 'utf8');
    check('无换行文件追加后另起一行', gi1.split(/\r?\n/)[0] === 'node_modules' && gi1.includes('\n/tmp.log\n'), JSON.stringify(gi1));

    // 2) 重复条目不重复追加
    await git.addToGitIgnore(igDir, ['tmp.log']);
    const gi2 = fs.readFileSync(giPath, 'utf8');
    check('已存在条目不重复写入', gi2.split(/\r?\n/).filter((l) => l.trim() === '/tmp.log').length === 1, JSON.stringify(gi2));

    // 3) 写入 .git/info/exclude（仅本地）
    await git.addToGitIgnore(igDir, ['secret.txt'], { target: 'exclude' });
    const exPath = path.join(igDir, '.git', 'info', 'exclude');
    check('exclude 目标写入 .git/info/exclude', fs.existsSync(exPath) && fs.readFileSync(exPath, 'utf8').includes('/secret.txt'));
    check('exclude 不影响 .gitignore', !fs.readFileSync(giPath, 'utf8').includes('secret.txt'));

    // 4) 目录：整目录模式写一条 dir/
    await git.addToGitIgnore(igDir, ['build'], { mode: 'dir' });
    const gi3Lines = fs.readFileSync(giPath, 'utf8').split(/\r?\n/).map((l) => l.trim());
    check('目录整目录模式写 dir/', gi3Lines.includes('/build/'), gi3Lines);
    // 巨型目录同样整目录忽略（用于验证超上限保持折叠）
    await git.addToGitIgnore(igDir, ['big'], { mode: 'dir' });
    // 排除名单相关目录
    await git.addToGitIgnore(igDir, ['.history'], { mode: 'dir' });
    await git.addToGitIgnore(igDir, ['temp'], { mode: 'dir' });

    // 5) 目录：遍历文件模式逐条写入
    await git.addToGitIgnore(igDir, ['build'], { mode: 'files' });
    const gi4 = fs.readFileSync(giPath, 'utf8');
    check('目录遍历模式写入目录下文件', gi4.includes('/build/out.js') && gi4.includes('/build/out.css'), gi4.split(/\r?\n/));
    check('遍历模式不写目录本身', !gi4.includes('/build/\n/build/out.js'), gi4.split(/\r?\n/));

    // 6) status 必须带 --ignored，且忽略目录展开为逐个文件：侧边栏勾选「忽略文件」后
    //    能看到 .vscode/、build/ 等目录里的文件；超上限的巨型目录保持折叠单条。
    const igStatus = await git.status(igDir);
    const igByPath = new Map(igStatus.map((f) => [f.path, f]));
    const igPaths = [...igByPath.keys()];
    check('status 含忽略文件 tmp.log', igByPath.get('tmp.log')?.ignored === true, igPaths);
    check('忽略目录展开：build/out.js', igByPath.get('build/out.js')?.ignored === true, igPaths);
    check('忽略目录展开：build/out.css', igByPath.get('build/out.css')?.ignored === true, igPaths);
    check('忽略目录递归展开：build/sub/deep.js', igByPath.get('build/sub/deep.js')?.ignored === true, igPaths);
    check('忽略目录展开后无目录单条', !igByPath.has('build/'), igPaths);
    check('未传排除列表时 .history 正常展开', igByPath.get('.history/old.txt')?.ignored === true, igPaths);
    check('超上限巨型目录保持折叠 big/', igByPath.has('big/') && igByPath.get('big/')?.ignored === true, igPaths.slice(0, 8));
    check('超上限目录不展开子文件', !igByPath.has('big/f0.txt'), igPaths.length);
    check('展开的忽略文件不进暂存状态', igByPath.get('build/out.js')?.index === 'none' && igByPath.get('build/out.js')?.worktree === 'none', igByPath.get('build/out.js'));
    check('.gitignore 自身是未跟踪而非忽略', igByPath.get('.gitignore')?.untracked === true && igByPath.get('.gitignore')?.ignored === false, igByPath.get('.gitignore'));
    check('忽略文件不进暂存状态', igByPath.get('tmp.log')?.index === 'none' && igByPath.get('tmp.log')?.worktree === 'none', igByPath.get('tmp.log'));

    // 7) 排除名单（turtlegit.ignoredExcludeDirs，默认 ['.history','node_modules']）：
    //    命中文件夹整条剔除，嵌套在忽略目录里的同名目录也跳过，其他忽略文件不受影响
    const igStatusEx = await git.status(igDir, { ignoredExcludeDirs: ['.history', 'node_modules'] });
    const exByPath = new Map(igStatusEx.map((f) => [f.path, f]));
    const exPaths = [...exByPath.keys()];
    check('排除 .history：目录条目剔除', !exByPath.has('.history/'), exPaths);
    check('排除 .history：文件不展开', !exByPath.has('.history/old.txt'), exPaths);
    check('排除 node_modules：目录条目剔除', !exByPath.has('node_modules/'), exPaths);
    check('排除 node_modules：文件不展开', !exByPath.has('node_modules/x.js'), exPaths);
    check('排除嵌套同名目录：temp/.history/n.txt 不列出', !exByPath.has('temp/.history/n.txt'), exPaths);
    check('排除不影响同级文件：temp/ok.txt 仍列出', exByPath.get('temp/ok.txt')?.ignored === true, exPaths);
    check('排除不影响其他忽略文件', exByPath.get('tmp.log')?.ignored === true && exByPath.get('build/out.js')?.ignored === true, exPaths);
    // 空数组 = 不过滤任何目录
    const igStatusNone = await git.status(igDir, { ignoredExcludeDirs: [] });
    check('空排除列表时 .history 恢复显示', igStatusNone.some((f) => f.path === '.history/old.txt'), igStatusNone.map((f) => f.path));
  }

  console.log('== diff 渲染（gap 折叠行 / 并排行号分列） ==');
  {
    const { rowsSideBySide, rowsUnified, renderDiff, contextDiffRows } = await import('../webview/diff/DiffRenderer');
    const patch = [
      'diff --git a/f.txt b/f.txt',
      'index 111..222 100644',
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@ -1,3 +1,3 @@',
      ' line1',
      '-line2',
      '+line2-mod',
      ' line3',
      '@@ -10,3 +10,3 @@',
      ' line10',
      '-line11',
      '+line11-mod',
      ' line12',
    ].join('\n');
    const gaps = rowsSideBySide(patch).filter((r) => r.kind === 'gap');
    check('hunk 间生成 1 个 gap 行', gaps.length === 1, gaps);
    check(
      'gap 行范围正确（旧 4..9 / 新 4..9）',
      gaps[0]?.oldStart === 4 && gaps[0]?.oldEnd === 9 && gaps[0]?.newStart === 4 && gaps[0]?.newEnd === 9,
      gaps[0],
    );
    const html = renderDiff(patch, 'side');
    check('gap 行含波浪线与展开按钮（6 行）', html.includes('d-wave') && html.includes('展开 6 行'));
    check('并排行号分列：左行号紧邻左文本', /<td class="d-no">2<\/td>\s*<td class="d-left">/.test(html), html);
    check('并排列序：左文本后是右行号', /<td class="d-left">line2<\/td>\s*<td class="d-no">2<\/td>/.test(html));

    // 首个 hunk 之前的省略行
    const patch2 = ['--- a/f.txt', '+++ b/f.txt', '@@ -5,2 +5,2 @@', ' line5', '-line6', '+line6-mod'].join('\n');
    const gaps2 = rowsSideBySide(patch2).filter((r) => r.kind === 'gap');
    check('首个 hunk 前生成 gap（1..4）', gaps2.length === 1 && gaps2[0]?.oldStart === 1 && gaps2[0]?.oldEnd === 4, gaps2);

    // 无省略时无 gap
    const patch3 = ['--- a/f.txt', '+++ b/f.txt', '@@ -1,1 +1,1 @@', '-a', '+b'].join('\n');
    check('单 hunk 无 gap', rowsSideBySide(patch3).filter((r) => r.kind === 'gap').length === 0);

    const ctx = contextDiffRows(['a', 'b'], ['a', 'b'], 10, 20);
    check(
      'contextDiffRows 行号递增',
      ctx.length === 2 && ctx[0]?.leftNo === 10 && ctx[0]?.rightNo === 20 && ctx[1]?.leftNo === 11 && ctx[1]?.rightNo === 21,
      ctx,
    );

    // 末尾省略区（最后一个 hunk 之后到 EOF）：git patch 不含这些行，
    // 传入两侧总行数后应补一个可展开的 gap 行
    const patch4 = ['--- a/f.txt', '+++ b/f.txt', '@@ -2,3 +2,3 @@', ' line2', '-line3', '+line3-mod', ' line4'].join('\n');
    const gaps4 = rowsSideBySide(patch4, { old: 10, new: 10 }).filter((r) => r.kind === 'gap');
    check(
      '末尾省略区生成 gap（旧 5..10 / 新 5..10）',
      gaps4.length === 2 &&
        gaps4[1]?.oldStart === 5 &&
        gaps4[1]?.oldEnd === 10 &&
        gaps4[1]?.newStart === 5 &&
        gaps4[1]?.newEnd === 10,
      gaps4,
    );
    check('不传 tail 无末尾 gap（向后兼容）', rowsSideBySide(patch4).filter((r) => r.kind === 'gap').length === 1);
    check('tail 到 hunk 末尾则无末尾 gap', rowsSideBySide(patch4, { old: 4, new: 4 }).filter((r) => r.kind === 'gap').length === 1);
    check('renderDiff 末尾 gap 渲染展开按钮（6 行）', renderDiff(patch4, 'side', { old: 10, new: 10 }).includes('展开 6 行'));
    check('unified 模式同样生成末尾 gap', rowsUnified(patch4, { old: 10, new: 10 }).filter((r) => r.kind === 'gap').length === 2);
    // 纯新增 / 纯删除文件：一侧行数为 0，不生成虚假末尾 gap
    const patchNew = ['--- /dev/null', '+++ b/n.txt', '@@ -0,0 +1,2 @@', '+x', '+y'].join('\n');
    check('新文件不生成末尾 gap', rowsSideBySide(patchNew, { old: 0, new: 2 }).filter((r) => r.kind === 'gap').length === 0);
    const patchDel = ['--- a/d.txt', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-x', '-y'].join('\n');
    check('删除文件不生成末尾 gap', rowsSideBySide(patchDel, { old: 2, new: 0 }).filter((r) => r.kind === 'gap').length === 0);

    // fileLineCounts（末尾 gap 的数据来源）：独立仓库验证两侧总行数
    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'turtlegit-lc-'));
    const run3 = (args: string[]) => {
      const r = cp.spawnSync('git', args, { cwd: dir3, encoding: 'utf8', timeout: SPAWN_TIMEOUT });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
      return r.stdout;
    };
    run3(['init', '-b', 'main']);
    run3(['config', 'user.email', 'lc@example.com']);
    run3(['config', 'user.name', '行数测试']);
    fs.writeFileSync(path.join(dir3, 'f.txt'), 'l1\nl2\nl3\n', 'utf8');
    run3(['add', '-A']);
    run3(['commit', '-m', 'init']);
    fs.writeFileSync(path.join(dir3, 'f.txt'), 'l1\nl2\nl3\nl4\nl5\n', 'utf8');
    const lc = await git.fileLineCounts(dir3, 'f.txt', {});
    check('fileLineCounts 旧侧 3 行', lc.old === 3, lc);
    check('fileLineCounts 新侧 5 行', lc.new === 5, lc);
    rmTmp(dir3);
  }

  console.log('== 原生 diff 内容提供器（blobAtRef / turtlegit: URI） ==');
  {
    // 独立临时仓库：构造 HEAD / index / 工作区三态内容
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'turtlegit-blob-'));
    const run2 = (args: string[]) => {
      const r = cp.spawnSync('git', args, { cwd: dir2, encoding: 'utf8', timeout: SPAWN_TIMEOUT });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
      return r.stdout;
    };
    run2(['init', '-q', '-b', 'main']);
    run2(['config', 'user.email', 'test@example.com']);
    run2(['config', 'user.name', '测试用户']);
    fs.writeFileSync(path.join(dir2, 'v1.txt'), 'line1\n', 'utf8');
    fs.mkdirSync(path.join(dir2, 'src 目录'));
    fs.writeFileSync(path.join(dir2, 'src 目录', '中文 名.ts'), '旧内容\n', 'utf8');
    run2(['add', '-A']);
    run2(['commit', '-qm', 'init']);
    fs.writeFileSync(path.join(dir2, 'v1.txt'), 'line1\nline2-staged\n', 'utf8');
    run2(['add', 'v1.txt']);
    fs.writeFileSync(path.join(dir2, 'v1.txt'), 'line1\nline2-work\n', 'utf8');

    const head = await git.blobAtRef(dir2, 'v1.txt', 'HEAD');
    check('blobAtRef HEAD 版本', head !== null && head.toString('utf8') === 'line1\n', head?.toString('utf8'));
    const idx = await git.blobAtRef(dir2, 'v1.txt', '');
    check('blobAtRef index 版本（暂存内容）', idx !== null && idx.toString('utf8') === 'line1\nline2-staged\n', idx?.toString('utf8'));
    const missing = await git.blobAtRef(dir2, 'no-such.txt', 'HEAD');
    check('blobAtRef 缺失文件返回 null', missing === null);
    const cn = await git.blobAtRef(dir2, 'src 目录/中文 名.ts', 'HEAD');
    check('blobAtRef 中文+空格路径', cn !== null && cn.toString('utf8') === '旧内容\n', cn?.toString('utf8'));

    // GBK 编码文件：必须原样返回字节（交给编辑器做编码检测，不能 UTF-8 乱码化）
    const gbkBytes = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a]); // "中文\n" 的 GBK 编码
    fs.writeFileSync(path.join(dir2, 'gbk.txt'), gbkBytes);
    run2(['add', 'gbk.txt']);
    run2(['commit', '-qm', 'gbk']);
    const gbk = await git.blobAtRef(dir2, 'gbk.txt', 'HEAD');
    check('blobAtRef 保留 GBK 原始字节', gbk !== null && gbk.equals(gbkBytes), gbk?.toString('hex'));

    // turtlegit: URI 参数（运行时用 Uri.file(abs).with({scheme, query}) 拼装，
    // 这里是 query 侧契约：Uri.with 存入 → uri.query 取回 → JSON.parse）
    const abs = path.join(dir2, 'src 目录', '中文 名.ts');
    check('参数对象含 path/ref/root', (() => {
      const p = blobUriParams(abs, 'HEAD', dir2);
      return p.path === abs && p.ref === 'HEAD' && p.root === dir2;
    })());
    const params = parseBlobParams(blobUriQuery(abs, 'HEAD', dir2));
    check(
      'query 往返解析一致（中文+空格路径）',
      params !== null && params.path === abs && params.ref === 'HEAD' && params.root === dir2,
      params,
    );
    // # 是 URI fragment 边界字符（? 在 Windows 文件名里非法，故只测 #）：
    // 走 Uri.file(...).with(query) 构造，路径与 query 分离，不受 # 影响
    const weird = path.join(dir2, 'a#b.txt');
    fs.writeFileSync(weird, 'weird\n', 'utf8');
    run2(['add', 'a#b.txt']);
    run2(['commit', '-qm', 'weird']);
    const paramsWeird = parseBlobParams(blobUriQuery(weird, 'HEAD', dir2));
    check('# 路径参数往返一致', paramsWeird?.path === weird && paramsWeird?.root === dir2, paramsWeird);
    const wb = await git.blobAtRef(dir2, 'a#b.txt', 'HEAD');
    check('# 路径 blobAtRef 可读', wb !== null && wb.toString('utf8') === 'weird\n', wb?.toString('utf8'));
    check('parseBlobParams 拒绝非法 query', parseBlobParams('not-json') === null && parseBlobParams('') === null);
    const paramsIdx = parseBlobParams(blobUriQuery(abs, '', dir2));
    check('query 支持 index 版本（ref 空串）', paramsIdx?.ref === '' && paramsIdx?.path === abs, paramsIdx);
  }

  console.log('== 分支名与远程解析（parseBranchName / parseRemotes） ==');
  {
    const a = parseBranchName('remotes/origin/feature/x');
    check('远程分支解析出 remote + 短名', a.isRemote && a.remote === 'origin' && a.shortName === 'feature/x', a);
    const b = parseBranchName('origin/feature');
    check('本地含斜杠分支不误判为远程', !b.isRemote && b.shortName === 'origin/feature' && b.remote === undefined, b);
    const c = parseBranchName('main');
    check('普通本地分支', !c.isRemote && c.shortName === 'main', c);

    const rs = parseRemotes(
      [
        'origin\thttps://x/r.git (fetch)',
        'origin\thttps://x/r.git (push)',
        'upstream\tgit@x:y.git (fetch)',
        'upstream\tgit@x:no.git (push)',
      ].join('\n'),
    );
    check('remote 去重为 2 个', rs.length === 2, rs.map((r) => r.name));
    check('fetch/push 相同则不输出 pushUrl', rs[0]?.fetchUrl === 'https://x/r.git' && rs[0]?.pushUrl === undefined, rs[0]);
    check('fetch/push 不同给出 pushUrl', rs[1]?.fetchUrl === 'git@x:y.git' && rs[1]?.pushUrl === 'git@x:no.git', rs[1]);
    check('空输出解析为空数组', parseRemotes('').length === 0);
  }

  console.log('== 远程仓库管理 + 远程分支检出（真实仓库，file-path 远程） ==');
  {
    // 用本地文件路径当"远程"，无需网络即可验证 push --delete / checkout --track
    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'turtlegit-remote-'));
    const bare = path.join(dir3, 'bare.git');
    const work = path.join(dir3, 'work');
    fs.mkdirSync(work);
    const run3 = (args: string[], cwd = work): string => {
      const r = cp.spawnSync('git', args, { cwd, encoding: 'utf8', timeout: SPAWN_TIMEOUT });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
      return r.stdout;
    };
    run3(['init', '-q', '--bare', bare], dir3);
    run3(['init', '-q', '-b', 'main']);
    run3(['config', 'user.email', 'test@example.com']);
    run3(['config', 'user.name', '测试用户']);
    fs.writeFileSync(path.join(work, 'f.txt'), 'v1\n', 'utf8');
    run3(['add', '-A']);
    run3(['commit', '-qm', 'init']);
    run3(['remote', 'add', 'origin', bare]);
    run3(['push', '-u', 'origin', 'main']);

    let rs = await ops.remotes(work);
    check('remotes() 列出 origin 与地址', rs.length === 1 && rs[0]?.name === 'origin' && rs[0]?.fetchUrl === bare, rs);

    // 回归：%(refname:short) 输出的远程分支是 `origin/main`（不带 remotes/ 前缀），
    // 旧实现按 `remotes/` 判定导致远程分支被误报成本地分支
    const pushed = await ops.branches(work);
    const rm = pushed.find((b) => b.name === 'origin/main');
    check('远程分支被正确标记为 isRemote', rm?.isRemote === true && rm?.remote === 'origin' && rm?.shortName === 'main', rm);
    check('本地分支不被误标为远程', pushed.find((b) => b.name === 'main')?.isRemote === false, pushed.map((b) => b.name));

    await ops.setRemoteUrl(work, 'origin', `${bare}-new`);
    rs = await ops.remotes(work);
    check('setRemoteUrl 改 fetch 地址', rs[0]?.fetchUrl === `${bare}-new`, rs);
    await ops.setRemoteUrl(work, 'origin', `${bare}-push`, true);
    rs = await ops.remotes(work);
    check(
      'setRemoteUrl(push) 只改 push 地址',
      rs[0]?.pushUrl === `${bare}-push` && rs[0]?.fetchUrl === `${bare}-new`,
      rs,
    );
    await ops.setRemoteUrl(work, 'origin', bare);
    await ops.setRemoteUrl(work, 'origin', bare, true);

    await ops.addRemote(work, 'backup', bare);
    rs = await ops.remotes(work);
    check('addRemote 新增第二个远程', rs.length === 2 && rs.some((r) => r.name === 'backup'), rs.map((r) => r.name));
    await ops.removeRemote(work, 'backup');
    rs = await ops.remotes(work);
    check('removeRemote 删除远程', rs.length === 1 && rs[0]?.name === 'origin', rs.map((r) => r.name));

    // 远程分支：本地删掉后从 origin/feature 检出（应新建同名本地分支并跟踪）
    run3(['checkout', '-q', '-b', 'feature']);
    fs.writeFileSync(path.join(work, 'f.txt'), 'v2\n', 'utf8');
    run3(['add', '-A']);
    run3(['commit', '-qm', 'feature']);
    run3(['push', '-u', 'origin', 'feature']);
    run3(['checkout', '-q', 'main']);
    run3(['branch', '-D', 'feature']);
    const list = await ops.branches(work);
    const rb = list.find((b) => b.isRemote && b.name === 'origin/feature');
    check('远程分支带 remote/shortName', rb?.remote === 'origin' && rb?.shortName === 'feature', rb);
    const co = await ops.checkoutRemote(work, 'origin/feature');
    check('检出远程分支 → 新建本地分支', co.created === true && co.branch === 'feature', co);
    check(
      '检出后当前分支为 feature',
      (await ops.branches(work)).find((b) => b.isCurrent)?.name === 'feature',
    );
    const co2 = await ops.checkoutRemote(work, 'origin/feature');
    check('本地已存在时直接检出（不新建）', co2.created === false && co2.branch === 'feature', co2);

    await ops.deleteRemoteBranch(work, 'origin', 'feature');
    run3(['fetch', '--prune']);
    const after = await ops.branches(work);
    check(
      '删除远程分支后列表消失',
      !after.some((b) => b.isRemote && b.name === 'origin/feature'),
      after.map((b) => b.name),
    );

    // fetchRemote：另一处 clone 推送新提交后，本仓库 fetch 拉回远程引用
    const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'turtlegit-fetch-'));
    const work2 = path.join(dir4, 'work2');
    const run4 = (args: string[], cwd = work2): string => {
      const r = cp.spawnSync('git', args, { cwd, encoding: 'utf8', timeout: SPAWN_TIMEOUT });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
      return r.stdout;
    };
    fs.mkdirSync(work2);
    // -b main：裸仓库 HEAD 指向不存在的 master（init 默认分支），裸 clone 会检不出分支
    run4(['clone', '-q', '-b', 'main', bare, work2], dir4);
    run4(['config', 'user.email', 'test@example.com']);
    run4(['config', 'user.name', '测试用户']);
    fs.writeFileSync(path.join(work2, 'f.txt'), 'v3\n', 'utf8');
    run4(['add', '-A']);
    run4(['commit', '-qm', 'upstream change']);
    run4(['push', '-q', 'origin', 'main']);

    const before = run3(['rev-parse', 'origin/main'], work).trim();
    const upstream = run4(['rev-parse', 'HEAD'], work2).trim();
    check('fetch 前本地 origin/main 落后', before !== upstream, { before, upstream });
    const fetchRes = await ops.fetchRemote(work, 'origin');
    check('fetchRemote 返回码为 0', fetchRes.code === 0, fetchRes.code);
    const afterFetch = run3(['rev-parse', 'origin/main'], work).trim();
    check('fetchRemote 后 origin/main 更新', afterFetch === upstream, { afterFetch, upstream });
    check('fetchRemote 不动工作区', run3(['rev-parse', 'HEAD'], work).trim() !== upstream, '工作区应保持旧提交');

    let emptyErr: unknown;
    try {
      await ops.fetchRemote(work, '');
    } catch (err) {
      emptyErr = err;
    }
    check('fetchRemote 空远程名抛错', emptyErr instanceof Error && /未指定远程仓库名称/.test(emptyErr.message), emptyErr);

    let missErr: unknown;
    try {
      await ops.fetchRemote(work, 'no-such-remote');
    } catch (err) {
      missErr = err;
    }
    check('fetchRemote 不存在的远程抛 GitRunnerError', missErr instanceof GitRunnerError, missErr);
    rmTmp(dir4);
  }

  console.log('== rangeFiles：分支区间变更文件（真实仓库） ==');
  {
    const dir5 = fs.mkdtempSync(path.join(os.tmpdir(), 'turtlegit-rangefiles-'));
    const bare = path.join(dir5, 'bare.git');
    const work = path.join(dir5, 'work');
    fs.mkdirSync(work);
    const run5 = (args: string[], cwd = work): string => {
      const r = cp.spawnSync('git', args, { cwd, encoding: 'utf8', timeout: SPAWN_TIMEOUT });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
      return r.stdout;
    };
    run5(['init', '-q', '--bare', bare], dir5);
    run5(['init', '-q', '-b', 'main']);
    run5(['config', 'user.email', 'test@example.com']);
    run5(['config', 'user.name', '测试用户']);
    fs.writeFileSync(path.join(work, 'base.txt'), 'base\n', 'utf8');
    fs.writeFileSync(path.join(work, 'mod.txt'), 'v1\n', 'utf8');
    run5(['add', '-A']);
    run5(['commit', '-qm', 'init']);
    run5(['remote', 'add', 'origin', bare]);
    run5(['push', '-q', '-u', 'origin', 'main']);

    run5(['checkout', '-q', '-b', 'feature']);
    fs.writeFileSync(path.join(work, 'mod.txt'), 'v1\nv2\nv3\n', 'utf8');
    fs.writeFileSync(path.join(work, 'added.txt'), 'new file\n', 'utf8');
    run5(['add', '-A']);
    run5(['commit', '-qm', 'feature change']);
    run5(['checkout', '-q', 'main']);

    const files = await git.rangeFiles(work, 'main..feature');
    const byPath = new Map(files.map((f) => [f.path, f]));
    check('rangeFiles 覆盖两个变更文件', files.length === 2, files.map((f) => f.path));
    check('修改文件状态为 M 且统计正确', byPath.get('mod.txt')?.status === 'M' && byPath.get('mod.txt')?.additions === 2 && byPath.get('mod.txt')?.deletions === 0, byPath.get('mod.txt'));
    check('新增文件状态为 A', byPath.get('added.txt')?.status === 'A' && byPath.get('added.txt')?.additions === 1, byPath.get('added.txt'));
    check('未变更文件不出现', !byPath.has('base.txt'), [...byPath.keys()]);

    // 反向区间：新增文件变成删除，修改文件的增删互换
    const rev = await git.rangeFiles(work, 'feature..main');
    const revByPath = new Map(rev.map((f) => [f.path, f]));
    check('反向区间新增文件变删除', revByPath.get('added.txt')?.status === 'D', revByPath.get('added.txt'));
    check('反向区间增删互换', revByPath.get('mod.txt')?.status === 'M' && revByPath.get('mod.txt')?.additions === 0 && revByPath.get('mod.txt')?.deletions === 2, revByPath.get('mod.txt'));

    // 相同引用区间无变更
    const same = await git.rangeFiles(work, 'main..main');
    check('相同引用区间无变更文件', same.length === 0, same);

    // 对比面板按文件取 patch：range 形式必须能拿到 hunk（左=base，右=target）
    const patchRange = await git.diffPatch(work, 'mod.txt', false, undefined, 'main..feature');
    check(
      '按 range 取单文件 patch（分支对比右侧内容）',
      patchRange.includes('+++ b/mod.txt') && patchRange.includes('+v2') && patchRange.includes('+v3'),
      patchRange,
    );
    const patchRev = await git.diffPatch(work, 'mod.txt', false, undefined, 'feature..main');
    check(
      '交换方向后 patch 反向（删除行变新增）',
      patchRev.includes('-v2') && patchRev.includes('-v3'),
      patchRev,
    );

    // 非法区间抛错（GitRunner.out 非零退出）
    let rangeErr: unknown;
    try {
      await git.rangeFiles(work, 'main..not-exist');
    } catch (err) {
      rangeErr = err;
    }
    check('rangeFiles 非法区间抛错', rangeErr instanceof Error, rangeErr);

    rmTmp(dir5);
  }

  console.log('== log 分支/时间过滤（branch / since）真实仓库 ==');
  {
    const dir6 = fs.mkdtempSync(path.join(os.tmpdir(), 'turtlegit-logfilter-'));
    const work = path.join(dir6, 'work');
    fs.mkdirSync(work);
    const run6 = (args: string[], env?: Record<string, string>): void => {
      const r = cp.spawnSync('git', args, {
        cwd: work,
        encoding: 'utf8',
        env: { ...process.env, ...env },
        timeout: SPAWN_TIMEOUT,
      });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    };
    run6(['init', '-q', '-b', 'main']);
    run6(['config', 'user.email', 'test@example.com']);
    run6(['config', 'user.name', '测试用户']);
    // 一条 30 天前的提交（作者/提交时间都改，--since 按提交时间过滤）。
    // 注意：部分 git 构建（Windows 2.55）拒绝把 "30 days ago" 之类的相对日期
    // 写进 GIT_*_DATE 环境变量，必须用 Node 算出的 ISO 时间戳。
    const oldIso = new Date(Date.now() - 30 * 86400e3).toISOString();
    fs.writeFileSync(path.join(work, 'a.txt'), 'old\n', 'utf8');
    run6(['add', '-A']);
    run6(['commit', '-qm', 'old commit'], {
      GIT_AUTHOR_DATE: oldIso,
      GIT_COMMITTER_DATE: oldIso,
    });
    fs.writeFileSync(path.join(work, 'a.txt'), 'new\n', 'utf8');
    run6(['add', '-A']);
    run6(['commit', '-qm', 'recent commit']);
    run6(['checkout', '-q', '-b', 'feature']);
    fs.writeFileSync(path.join(work, 'b.txt'), 'feature only\n', 'utf8');
    run6(['add', '-A']);
    run6(['commit', '-qm', 'feature commit']);
    run6(['checkout', '-q', 'main']);

    const all = await git.log({ repoRoot: work, all: true, limit: 50 });
    check('无过滤时三个提交都在', all.length === 3, all.map((c) => c.subject));

    const onMain = await git.log({ repoRoot: work, branch: 'main', limit: 50 });
    check('branch=main 只含 main 历史', onMain.length === 2 && onMain.every((c) => c.subject !== 'feature commit'), onMain.map((c) => c.subject));

    const onFeature = await git.log({ repoRoot: work, branch: 'feature', limit: 50 });
    check('branch=feature 含 feature 提交', onFeature.length === 3 && onFeature.some((c) => c.subject === 'feature commit'), onFeature.map((c) => c.subject));

    const recent = await git.log({ repoRoot: work, all: true, since: '7d', limit: 50 });
    check('since=7d 排除 30 天前提交', recent.length === 2 && recent.every((c) => c.subject !== 'old commit'), recent.map((c) => c.subject));

    const last24h = await git.log({ repoRoot: work, all: true, since: '24h', limit: 50 });
    check('since=24h 同样排除旧提交', last24h.length === 2, last24h.map((c) => c.subject));

    rmTmp(dir6);
  }

  console.log('== diff 语法高亮（highlight.js 词法着色） ==');
  {
    const { languageForPath, highlightLine, HIGHLIGHT_MAX_LINES } = await import('../webview/diff/highlight');
    const { renderDiff, diffLanguage } = await import('../webview/diff/DiffRenderer');

    check('ts/tsx 识别为 typescript', languageForPath('src/a/b.ts') === 'typescript' && languageForPath('x.tsx') === 'typescript');
    check('js/jsx 识别为 javascript', languageForPath('a.js') === 'javascript' && languageForPath('y.jsx') === 'javascript');
    check('csproj/svg 走 xml', languageForPath('a/b.csproj') === 'xml' && languageForPath('i.svg') === 'xml');
    check('Makefile 走 bash', languageForPath('Makefile') === 'bash');
    check('toml/ini 走 ini', languageForPath('Cargo.toml') === 'ini' && languageForPath('a.ini') === 'ini');
    check('未知扩展名不着色', languageForPath('a.unknownext') === undefined);
    check('空路径不着色', languageForPath(undefined) === undefined);

    const kw = highlightLine('const x = 1;', 'typescript');
    check('关键字被着色', kw.includes('hljs-keyword') && kw.includes('const'), kw);
    check('数字被着色', kw.includes('hljs-number'), kw);
    const esc1 = highlightLine('a < b && c > d', 'typescript');
    check('着色结果已转义（无裸 < >）', !esc1.includes('<b') && esc1.includes('&lt;') && esc1.includes('&gt;'), esc1);
    check('未注册语言退化为纯转义', highlightLine('<b>', 'nosuchlang') === '&lt;b&gt;');
    check('空行/缺失返回空串', highlightLine('', 'typescript') === '' && highlightLine(undefined, 'typescript') === '');

    const patchTs = ['--- a/a.ts', '+++ b/a.ts', '@@ -1,1 +1,1 @@', '-const a = 1;', '+const a = 2;'].join('\n');
    const htmlTs = renderDiff(patchTs, 'unified', undefined, 'a.ts');
    check('传入路径后差异行带 token 着色', htmlTs.includes('hljs-keyword'), htmlTs);
    const htmlNoPath = renderDiff(patchTs, 'unified');
    check(
      '不传路径时保持纯文本（向后兼容）',
      !htmlNoPath.includes('hljs-') && htmlNoPath.includes('const a = 1;'),
      htmlNoPath,
    );
    const htmlSide = renderDiff(patchTs, 'side', undefined, 'a.ts');
    check('并排模式左右两侧都着色', (htmlSide.match(/hljs-keyword/g) ?? []).length >= 2, htmlSide);
    check('普通大小 patch 保留着色', diffLanguage('a.ts', patchTs) === 'typescript');
    check(
      `超过 ${HIGHLIGHT_MAX_LINES} 行的 patch 关闭着色`,
      diffLanguage('a.ts', 'x\n'.repeat(HIGHLIGHT_MAX_LINES + 10)) === undefined,
    );
  }

  console.log('== 图面板列宽 CSS 回归护栏 ==');
  {
    const css = fs.readFileSync(path.join(__dirname, '..', 'webview', 'style.css'), 'utf8');
    const ruleBody = (sel: string): string => {
      const idx = css.indexOf(`\n${sel} {`);
      if (idx === -1) return '';
      const start = css.indexOf('{', idx);
      const end = css.indexOf('}', start);
      return css.slice(start + 1, end);
    };
    // 行内提交号列必须跟随 --col-hash-width，否则「提交 ↔ 消息」手柄拖了表头动、行不动
    check('行内提交号列宽度跟随 --col-hash-width', /width:\s*var\(--col-hash-width/.test(ruleBody('.commit-hash')));
    check('表头提交号列用同一个变量', /width:\s*var\(--col-hash-width/.test(ruleBody('.log-column-header-hash')));
    check('表头提交号列无额外左内边距（与行内一致）', !/padding-left/.test(ruleBody('.log-column-header-hash')));
    check(
      '表头左内边距 = 图沟槽 + 行内 commit-info 的 8px',
      /padding-left:\s*calc\(var\(--graph-w[^)]*\)\s*\+\s*8px\)/.test(ruleBody('.log-column-header-info')),
      ruleBody('.log-column-header-info'),
    );
    check(
      '表头与行内作者列内边距一致（12px）',
      /padding-left:\s*12px/.test(ruleBody('.log-column-header-author')) && /padding-left:\s*12px/.test(ruleBody('.commit-author')),
    );
    check(
      '表头与行内日期列内边距一致（12px）',
      /padding-left:\s*12px/.test(ruleBody('.log-column-header-date')) && /padding-left:\s*12px/.test(ruleBody('.commit-date')),
    );
    // 手柄必须净宽 0，否则表头会被手柄宽度累积推着右移，分割线与行内列错位
    const handle = ruleBody('.log-column-resize-handle');
    check(
      '列宽手柄净宽为 0（左右各 -3.5px）',
      /margin-left:\s*-3\.5px/.test(handle) && /margin-right:\s*-3\.5px/.test(handle),
      handle,
    );
    check('color-mix 用法都有 rgba 兜底或经 @supports 保护', /@supports \(background: color-mix/.test(css));

    // 表头必须在滚动容器内部：在外面时表头是整宽、行被竖向滚动条挤窄，
    // 右侧作者/日期列会整体偏移一个滚动条宽度，且 sticky 因就近滚动祖先不对而失效。
    const panelSrc = fs.readFileSync(path.join(__dirname, '..', 'webview', 'graph', 'GraphPanel.ts'), 'utf8');
    const scrollIdx = panelSrc.indexOf('class="graph-scroll"');
    const headerIdx = panelSrc.indexOf('class="log-column-header"');
    check(
      '表头位于滚动容器内部（与行同宽、sticky 生效）',
      scrollIdx !== -1 && headerIdx !== -1 && headerIdx > scrollIdx,
      `scroll@${scrollIdx} header@${headerIdx}`,
    );
    check(
      '表头为 sticky 定位（就近滚动祖先即 .graph-scroll）',
      /position:\s*sticky/.test(ruleBody('.log-column-header')),
      ruleBody('.log-column-header'),
    );

    // 分隔符归属：每个分隔符调整它「左侧」那一列（图沟槽|提交|消息|作者|日期）
    check('消息列是定宽列（跟随 --col-subject-width）', /width:\s*var\(--col-subject-width/.test(ruleBody('.commit-title')), ruleBody('.commit-title'));
    check('表头消息列与行内同宽', /width:\s*var\(--col-subject-width/.test(ruleBody('.log-column-header-title')), ruleBody('.log-column-header-title'));
    check(
      '日期列是吸收剩余空间的弹性列（前面的列宽之和 = 其左边缘，分隔符才归位到作者列）',
      /flex:\s*1\s+1\s+auto/.test(ruleBody('.commit-date')) && /flex:\s*1\s+1\s+auto/.test(ruleBody('.log-column-header-date')),
      ruleBody('.commit-date'),
    );
    const iTitle = panelSrc.indexOf('class="log-column-header-title"');
    const iAuthor = panelSrc.indexOf('class="log-column-header-author"');
    const iDate = panelSrc.indexOf('class="log-column-header-date"');
    const iHSubject = panelSrc.indexOf('data-column-resize="subject"');
    const iHAuthor = panelSrc.indexOf('data-column-resize="author"');
    check(
      '(消息|作者) 分隔符调整消息列（句柄夹在两列之间且标记为 subject）',
      iTitle !== -1 && iAuthor !== -1 && iHSubject > iTitle && iHSubject < iAuthor,
      `title@${iTitle} hSubject@${iHSubject} author@${iAuthor}`,
    );
    check(
      '(作者|日期) 分隔符调整作者列（句柄夹在两列之间且标记为 author）',
      iAuthor !== -1 && iDate !== -1 && iHAuthor > iAuthor && iHAuthor < iDate,
      `author@${iAuthor} hAuthor@${iHAuthor} date@${iDate}`,
    );
    check('不再有 date 句柄（日期列改为吸收剩余空间）', !panelSrc.includes('data-column-resize="date"'));

    // 图面板专用 .commit-row 必须加作用域：否则日志/提交列表也会被套上
    // padding-left:var(--graph-w)（那些面板 --graph-w 未定义 → 回落 60px，hash 前一片空白）
    check(
      '图面板 .commit-row 已收窄到 .gp-rows（不污染日志面板）',
      /\.gp-rows \.commit-row \{/.test(css) &&
        !/(^|\n)\.commit-row \{[^}]*padding-left:\s*var\(--graph-w/.test(css),
    );
  }

  console.log('== 0.4.0 提交模式 / 分支对比 ==');
  {
    const read = (rel: string): string =>
      fs.readFileSync(path.join(__dirname, '..', ...rel.split('/')), 'utf8');
    const proto = read('shared/protocol.ts');
    const pm = read('src/host/ui/PanelManager.ts');
    const cmp = read('webview/compare/ComparePanel.ts');
    const mainTs = read('webview/main.ts');
    const br = read('webview/branches/BranchesSidebar.ts');
    const cs = read('webview/commit/CommitSidebar.ts');
    const css = fs.readFileSync(path.join(__dirname, '..', 'webview', 'style.css'), 'utf8');

    // ---- 协议 ----
    check("WebviewView 含 'compare'", /\| 'compare'/.test(proto));
    check(
      'ui:openCompare 请求含 repoRoot/base/target',
      /'ui:openCompare':\s*\{\s*req:\s*\{\s*repoRoot:\s*string;\s*base:\s*string;\s*target:\s*string\s*\}/.test(proto),
    );
    check('WebviewInit 带 compare 参数', /compare\?:\s*\{\s*base:\s*string;\s*target:\s*string\s*\}/.test(proto));

    // ---- 宿主 ----
    check(
      'openCompare 在主窗口（embedded）打开 compare 面板',
      /openCompare\(repoRoot: string, base: string, target: string\): void \{\s*this\.openPanel\('compare', repoRoot, \{ compare: \{ base, target \} \}, 'embedded'\)/.test(pm),
    );
    check(
      'ui:openCompare 已注册 RPC',
      /router\.register\('ui:openCompare'[\s\S]{0,160}openCompare\(repoRoot, base, target\)/.test(pm),
    );
    check('compare 视图有中文标题', /compare:\s*'分支对比/.test(pm));

    // ---- 对比面板 ----
    check('对比面板用 diff:files 取变更文件', /send\('diff:files'[\s\S]{0,120}range: this\.range/.test(cmp));
    check('对比 range 为 base..target', /`\$\{this\.base\}\.\.\$\{this\.target\}`/.test(cmp));
    check('单文件差异用同一个 range', /loadPatchAndCounts\(this\.client, \{[\s\S]{0,160}range: this\.range/.test(cmp));
    check('左栏是目录树（buildFileTree）', /buildFileTree\(this\.files\)/.test(cmp));
    check('有可拖拽分栏把手', /class="split-handle" id="cmp-handle"/.test(cmp) && /bindSplitter\(\)/.test(cmp));
    check('分栏宽度持久化', /saveState\(\{[\s\S]{0,80}paneW: this\.paneW/.test(cmp));
    check('支持并排/统一切换', /this\.mode === 'side' \? 'unified' : 'side'/.test(cmp));
    check('可交换对比方向', /id="cmp-swap"/.test(cmp));
    check('可在原生编辑器打开（openRangeDiff）', /command\('openRangeDiff'[\s\S]{0,120}left: this\.base,\s*right: this\.target/.test(cmp));
    check("main.ts 分发 'compare'", /case 'compare':[\s\S]{0,80}new ComparePanel\(/.test(mainTs));
    check('主窗口打开时带 init.compare', /new ComparePanel\(app, client, init\.repoRoot, init\.compare\)/.test(mainTs));

    // ---- 分支页右键 ----
    check('分支右键菜单含「与当前分支对比」', /与当前分支对比/.test(br));
    check('对比时 base=当前分支、target=所选分支', /send\('ui:openCompare', \{ repoRoot: this\.repoRoot, base, target: name \}/.test(br));
    check('分离 HEAD 时用 HEAD 作基线', /this\.info\.detached \? 'HEAD' : this\.info\.name/.test(br));
    check('当前分支不与自己对比', /cur && cur !== name/.test(br));

    // ---- 提交按钮整行 + 模式下拉 ----
    check('提交按钮改为整行（主按钮 + 模式下拉）', /class="sc-commit-row"/.test(cs) && /id="sc-commit-mode"/.test(cs));
    check('三种提交模式 normal/amend/push', /CommitMode = 'normal' \| 'amend' \| 'push'/.test(cs));
    check('修订由模式决定', /amend: this\.commitMode === 'amend'/.test(cs));
    check('提交后推送由模式决定', /pushAfter: this\.commitMode === 'push'/.test(cs));
    check('提交成功后复位为普通提交', /this\.commitMode = 'normal'/.test(cs));
    check('已移除旧的「修订/推送」复选框', !/id="chk-amend"/.test(cs) && !/id="chk-push"/.test(cs));
    check('CSS 提供整行提交按钮样式', /\.sc-commit-row \{/.test(css) && /\.sc-commit-main \{/.test(css) && /\.sc-commit-mode \{/.test(css));
    check('对比面板左栏禁用原生 resize（用把手拖拽）', /\.cmp-split \.pane\.left \{[^}]*resize:\s*none/.test(css));

    // ---- fileTree 泛型化（对比视图复用同一套建树逻辑） ----
    const tree = buildFileTree([{ path: 'src/deep/b.ts' }, { path: 'src/a.ts' }, { path: 'README.md' }]);
    check('建树不依赖 FileStatus 字段（仅需 path）', tree.length === 2 && tree[0].label === 'src');
    const srcDir = tree.find((n) => n.label === 'src')!;
    check('目录节点带子节点', srcDir.kind === 'dir' && (srcDir.children ?? []).length === 2);
    check('递归收集文件', collectFiles(srcDir).length === 2);
    check('递归收集目录路径', collectDirs(tree).join('|') === 'src|src/deep', collectDirs(tree));
  }

  if (failures > 0) {
    console.error(`\n${failures} 个断言失败`);
    process.exit(1);
  }
  console.log('\n全部通过 ✔');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
