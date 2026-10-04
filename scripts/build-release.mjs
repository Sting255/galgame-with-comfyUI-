/**
 * build-release.mjs — 一键打包完整 Release
 *
 *   $ node scripts/build-release.mjs
 *
 * 流程:
 *   1. 下载便携 Node.js / Python / Git
 *   2. 预装 npm 依赖 + vite build
 *   3. 预装 pip 依赖 + 下载嵌入模型
 *   4. PyInstaller 打包启动器
 *   5. 构建安卓 APK 壳（android-shell/，工具链自动下载到 build_cache，失败不阻塞）
 *   6. shallow clone 保留 .git → 覆盖预构建产物 → 压缩 zip
 *
 * ── 打包排除（审查缺口 4：交付包里的非产品内容，本机实测合计 ≈127 MB）──
 *   这三项是开发 / 运行期产物，**不属于交付内容**，打包时必须排除：
 *     · .mimosa/          —— 代码扫描缓存（本机实测 ≈110 MB，最大头）
 *     · e2e/node_modules/ —— e2e 的依赖（≈17 MB）
 *     · logs/             —— 运行日志（≈0.1 MB）
 *
 *   正常路径走 git clone：这三个目录都在 .gitignore 里（.gitignore:48/1/63），
 *   **0 个 tracked 文件** ⇒ clone 天然带不进来（.gitignore 只对 untracked 生效，而它们正是 untracked）。
 *   只有 **clone 失败走 robocopy 兜底** 时才有风险 ⇒ 两条防线：
 *     ① robocopyExclude 显式加 .mimosa / logs（node_modules 这个目录名已被整体排除，覆盖 e2e 那份）；
 *     ② 压缩 zip 之前再清一次（见下面「打包前清掉非产品内容」那一段；双保险，也防将来复制口径被改）。
 *
 *   **.git 不进排除** —— 交付包保留 .git（审查 §六 第 1 条，Lead 已采纳）。
 *
 *   若改用 **7z 手工打包**（本脚本用的是 PowerShell Compress-Archive，不是 7z），等价参数是：
 *     -xr'!*.mimosa' -xr'!e2e\node_modules' -xr'!logs'
 *   ⚠️ 别动 -t7z -m0=lzma2 -mx=9 -md=512m -mfb=273 -mqs=on -ms=on -mmt=on -mf=off，
 *     尤其 -mf=off 丢了会破坏「方法集合只有 LZMA2」这条历史验收口径。
 */

import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, createWriteStream } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ── 配置 ──
const NODE_VERSION = "22.18.0";
const PYTHON_VERSION = "3.12.10";
const GIT_TAG = "2.47.1.windows.1";        // GitHub release tag
const GIT_VER = "2.47.1";                  // 文件名中的版本号（无 .windows.1）

// 从 git tag 自动获取版本号
let VERSION = "dev";
try {
  const tag = execSync("git describe --tags --abbrev=0", {
    cwd: ROOT, encoding: "utf8", windowsHide: true, stdio: ["pipe","pipe","pipe"]
  }).trim();
  // 去掉可能的 v 前缀
  VERSION = tag.replace(/^v/, "");
} catch {
  // 没有 tag 则用 dev
  console.log(`  ${C.yellow}[WARN] 未找到 git tag，使用版本号: dev${C.reset}`);
}
const PROJECT_NAME = "邻舍.EXE";
const RELEASE_NAME = `${PROJECT_NAME}-v${VERSION}`;

const CACHE_DIR = resolve(ROOT, "launcher", "build_cache");
const RUNTIME_DIR = resolve(ROOT, "runtime");
const RELEASE_DIR = resolve(ROOT, "release", RELEASE_NAME);

const NODE_DIR = resolve(RUNTIME_DIR, "nodejs");
const PY_DIR = resolve(RUNTIME_DIR, "python");
const GIT_DIR = resolve(RUNTIME_DIR, "git");

const AGENT_CORE = resolve(ROOT, "agent-core");
const WEB_UI = resolve(ROOT, "web-ui");
const VECTOR_SVC = resolve(ROOT, "vector-service");

// 镜像源
const MIRRORS = {
  node: `https://npmmirror.com/mirrors/node/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`,
  nodeOfficial: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`,
  python: `https://npmmirror.com/mirrors/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`,
  pythonOfficial: `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`,
  git: `https://npmmirror.com/mirrors/git-for-windows/v${GIT_TAG}/PortableGit-${GIT_VER}-64-bit.7z.exe`,
  gitOfficial: `https://github.com/git-for-windows/git/releases/download/v${GIT_TAG}/PortableGit-${GIT_VER}-64-bit.7z.exe`,
  pipBootstrap: "https://bootstrap.pypa.io/get-pip.py",
};

// ── 终端颜色 ──
const C = {
  reset: "\x1b[0m",
  dim:   "\x1b[2m",
  green: "\x1b[32m",
  yellow:"\x1b[33m",
  cyan:  "\x1b[36m",
  red:   "\x1b[31m",
  bold:  "\x1b[1m",
};

const LOG_PREFIX = `  `;

// ── 辅助函数 ──

function log(msg) {
  console.log(`${LOG_PREFIX}${msg}`);
}

function ok(msg) {
  console.log(`${LOG_PREFIX}${C.green}✓ ${msg}${C.reset}`);
}

function warn(msg) {
  console.log(`${LOG_PREFIX}${C.yellow}[WARN] ${msg}${C.reset}`);
}

function fail(msg) {
  console.error(`${LOG_PREFIX}${C.red}[ERROR] ${msg}${C.reset}`);
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * 下载文件，失败返回 false
 */
function downloadFile(url, dest, timeoutSec = 300) {
  return new Promise((resolvePromise) => {
    const proto = url.startsWith("https") ? https : http;
    const req = proto.get(url, { timeout: timeoutSec * 1000 }, (res) => {
      // 跟随重定向
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolvePromise(downloadFile(res.headers.location, dest, timeoutSec));
      }
      if (res.statusCode !== 200) {
        req.destroy();
        return resolvePromise(false);
      }
      const file = createWriteStream(dest);
      res.pipe(file);
      file.on("finish", () => { file.close(); resolvePromise(true); });
      file.on("error", () => resolvePromise(false));
    });
    req.on("error", () => resolvePromise(false));
    req.on("timeout", () => { req.destroy(); resolvePromise(false); });
  });
}

/**
 * 执行命令并等待完成，返回 { ok, stdout, stderr, code }
 */
function exec(cmd, args, opts = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd || ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: process.platform === "win32",
      ...opts,
      // 确保打包的 Node.js 在 PATH 最前面，否则 npm postinstall 脚本
      // （esbuild 的 node install.js 等）会因为 cmd.exe 找不到 node 而失败
      env: {
        ...process.env,
        PATH: existsSync(NODE_DIR) ? `${NODE_DIR};${process.env.PATH}` : process.env.PATH,
        PYTHONUNBUFFERED: "1",
        FORCE_COLOR: "0",
        ...(opts.env || {}),
      },
    });

    let stdout = "";
    let stderr = "";

    // timeout
    let timeoutId = null;
    if (opts.timeout) {
      timeoutId = setTimeout(() => {
        child.kill();
        resolvePromise({ ok: false, stdout, stderr, code: -1, killed: true });
      }, opts.timeout);
    }

    child.stdout.on("data", (d) => {
      const text = d.toString();
      stdout += text;
      if (opts.print) process.stdout.write(text);
    });
    child.stderr.on("data", (d) => {
      const text = d.toString();
      stderr += text;
      if (opts.print) process.stderr.write(text);
    });

    child.on("exit", (code) => {
      if (timeoutId) clearTimeout(timeoutId);
      resolvePromise({ ok: code === 0, stdout, stderr, code });
    });

    child.on("error", (err) => {
      if (timeoutId) clearTimeout(timeoutId);
      resolvePromise({ ok: false, stdout, stderr: err.message, code: -1 });
    });
  });
}

/**
 * 解压 zip 文件到目标目录
 */
function extractZip(zipPath, destDir) {
  // 使用 PowerShell 解压（Windows 内置）
  return exec("powershell", [
    "-NoProfile", "-Command",
    `Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force`
  ]);
}

/**
 * robocopy 复制目录
 */
async function robocopy(src, dest, excludeDirs = [], excludeFiles = []) {
  const args = [src, dest, "/E", "/NFL", "/NDL", "/NJH", "/NJS"];
  for (const d of excludeDirs) {
    args.push("/XD", d);
  }
  for (const f of excludeFiles) {
    args.push("/XF", f);
  }
  const result = await exec("robocopy", args);
  return result.code < 8;
}

// ── 使用说明.txt 正文 ──
//
// 抽成函数是为了能单独生成：`node scripts/build-release.mjs --usage-guide-only [输出路径]`
// （整包发布会走 clone / robocopy / PyInstaller / APK，改一段文案不值得跑全套。
//   单独生成时用 git tag 推出来的 VERSION 当 APK 名；正式发布走 APK_NAME。）
function buildUsageGuideText({ apkName = `【非刚需，但体验明显提高】邻舍-v${VERSION}.apk` } = {}) {
  return [
    "邻舍.EXE",
    "",
    "【首次使用，非常重要】",
    "！！！<<<ComfyUI内核版本需要更新到v0.23.0以上，否则不支持Anima>>>！！！",
    "anima_baseV10、qwen_image_vae、anima_baseV10_txt需要都在ComfyUI的models目录下的子文件夹内",
    "",
    "【使用步骤】",
    "1. 双击运行 邻舍.EXE.exe",
    "2. 在「设置」中配置 ComfyUI 启动器路径",
    "3. 返回「首页」点击「启动」",
    "4. 浏览器访问 http://localhost:3099 支持手机端网页访问，网页地址在日志中显示",
    "",
    "【手机端（安卓）】",
    `压缩包内附带 ${apkName}，安装后输入电脑端显示的局域网地址即可使用`,
    "（相比手机浏览器：按返回键会返回上一页，而不是退出到桌面）",
    "",
    "【版本更新】",
    "切换到「版本」页签 → 点击「检查更新」",
    "如有新版本，选择后点击「切换到此版本」，会自动构建",
    "",
    "【催眠手机】",
    "- 入口在角色聊天里，私聊和群聊都有",
    "- 「催眠」＝深度催眠＝完全控制：意志被压制、情绪被压平，她的反应按你给的硬优先级走",
    "- 「只唤醒意志」＝身体仍然不能动，但意识完全恢复，她会清醒地知道正在发生什么",
    "- 「强制高潮」会强制这一次出图，并把这一轮的反应写进记录",
    "- 群聊里也能用：选 1 人是「单独使用模式」（给到和私聊一样的完整面板，含遗忘与遗忘记录），选多人则一次对所有人下指令、逐个回执",
    "- 相关日志写进程序目录下的 logs\\backend-日期.log（默认保留 14 天）",
    "",
    "【睡眠控制】",
    "- 位置：催眠手机面板里独立的一区，标题就是「睡眠控制」；只管她睡没睡，与上面的催眠指令互不影响（睡着照样能被催眠，被催眠也照样能睡）",
    "- 「睡觉」＝立刻让她入睡（按她当天日程的主睡眠时长，兜底 8 小时）；「唤醒」＝把她从睡梦里叫起来 —— 解除的是睡眠，不是催眠",
    "- 这一区实时显示「睡眠中 / 清醒」；睡着时会写明「预计 MM-DD HH:mm 醒来」，临时唤醒期间会写明「被临时叫醒，醒着到 MM-DD HH:mm」",
    "- 睡着时给她发消息：消息照常收下、排进回复队列，等她醒了才会正式回你（睡梦中她可能先用一句梦话应你）",
    "- 「唤醒」只是当场把她从睡梦里叫起来；之后接着睡还是继续醒着，仍由她自己的日程决定",
    "",
    "【程序时间】",
    "- 位置：设置页里的「程序时间」卡片（就在「数据备份」上面），用来拨动游戏世界里的「现在」",
    "- 「+1 天」快进一天；想快进多天就先填天数（1 ~ 3650），再点「+N 天」——所有角色会一起过完这些天",
    "- 「切到白天」（08:00）/「切到黑夜」（22:00）：只换时段，日期和累计天数都不动",
    "- 「设定具体日期时间」：填好日期与时刻，点「确认设定」直接跳到那一刻",
    "- 「回到真实时间」：把程序钟与真实时间对齐（「第 1 天」重新锚定为今天），点之前会先让你确认一次",
    "- 会跟着程序时间变的：所有角色的日程与睡眠判定、白天 / 黑夜时段、提示词里的时间标签、日程页与小镇显示的日期时刻",
    "- 仍按真实时间走的：主动聊天心跳、日程模板刷新、临时唤醒窗口这些定时器，排队回复，以及朋友圈 / 邮件 / 天气 / 小镇等排期",
    "- 写进库的时间戳（sleep_until / temporary_wake_until / 排队回复时间），以及聊天记录和日志上的日期，也都是真实时间，不跟着程序钟走",
    "",
    "【睡梦唤醒】",
    "- 她还睡着时点「强制高潮」，会先给她一个 5 分钟的临时唤醒窗口再触发（否则日程里那句「正在睡觉，不要回复」会和指令打架）",
    "- 这一轮走的是「从深度睡眠里被硬拉起来」的专属表现：意识还没接上、身体先反应，分不清是梦还是现实",
    "- 声音是哑的、带睡意的鼻音，手脚发软、动作跟不上；她会先以为自己在做梦，明白过来是真的才后知后觉地慌",
    "- 只影响这一轮；临时唤醒到期后按她的日程放回睡眠",
    "",
    "【亲密看板】",
    "- 「AI 判断行为」：开关决定每轮回复完成后是否自动判断这轮是什么行为；旁边的「AI 判断行为」按钮可以手动补判最近 8 轮",
    "- 「每日判定上限」：0 ＝ 不限制；设了上限后当天用完就不再自动判断，输入框旁的提示会显示当前已用次数",
    "",
    "【群聊 ↔ 私聊记忆互通】",
    "- 双向互通：群里聊过的事私聊里记得，私聊里聊过的事群聊里也记得（记忆总开关关闭时不参与）",
    "- 注入时有硬性字数上限（每人最多 3 条 / 单节最多 300 字 / 全体合计最多 2400 字），避免上下文被撑爆",
    "",
    "【上下文余量面板】",
    "- 左上角的小胶囊显示当前会话用了多少 token、还剩多少（环形进度 + 百分比），点开可以看分项明细",
    "- 卡片里会写明「窗口来源」（手动声明 / 服务端探测 / 默认值），以及数字来自上一次请求还是估算",
    "- 快满时点卡片里的「压缩上下文」手动压缩一轮（滚动摘要 + 记忆整理，下一轮生效）",
    "- 添加 / 编辑模型时可以填「上下文窗口」：留空则由程序向上游探测或使用默认值",
    "",
    "【数据备份】",
    "- 设置页最下面的「数据备份」：点「一键导出全部数据」下载一个 linshe-backup-日期时间.tar.gz",
    "- 勾选「包含模型配置（含 API Key）」会把 config\\.env 一起打包；里面有密钥，这份备份不要发给别人",
    "- 「一键导入」选择归档即可恢复：导入会覆盖当前数据库与资产文件，导入前自动备份到 data\\backups\\，万一不满意可以用那份备份回滚",
    "- 导入成功后如果提示「建议重启应用」，重启一次即可",
    "",
    "【动作系统（触摸互动）】",
    "- 入口：聊天页输入区最右端、发送按钮左边有一颗 ✋（手掌）图标（和 🎁 礼物并排）；点它打开**可拖动的浮动小窗**",
    "- 四档共 25 个动作：日常（摸头、拍拍肩、拉手、抱抱、挠痒痒、捏脸）/ 亲密（摸头发、摸背、搂腰、亲脸颊、贴贴）/ 敏感（摸胸、摸臀、摸大腿、腰部游走、耳后吹气）/ 私密（摸私处、摸阴蒂、手指进入、抚摸脖颈、舔颈、吮吸乳头、捏乳头、咬耳朵、抚摸大腿内侧）",
    "- 群聊里也能用，入口同样是这颗 ✋：点它先弹成员面板选「对谁」，选完直接进面板；面板顶部有「对 XXX」可随时换人（没选人时点卡片会提示先选目标）",
    "- 灰掉的动作＝她现在不愿意（好感 / 关系不够，或她睡着了）。灰的也点得动，她会用一句话拒绝你，那是剧情不是报错",
    "- 腻烦度：同一个动作短时间连点她会越来越不耐烦（连点 4~5 次开始明显）；放着不管每 30 分钟自己降，不同动作互不影响",
    "- 「即时反应」开着时，点一下她立刻单独回一条；关掉后就是「省额度模式」，她的反应并进你下一句发言的回复里（想看她回应，就再跟她说一句话）",
    "- 即时反应默认每天 100 次，用完自动并回下一轮，不报错",
    // 2026-10-01 有意替换（「只增不删」纪律的例外，写清理由）：动作面板已经**浮窗化** ——
    // 不再是「底部弹层 + 遮罩」，所以「点遮罩关闭」这句已经与实现相反，照旧写会让用户点了面板外面却关不掉、
    // 误以为面板坏了（真机就报过「打开就关不了」）。改成与浮窗一致的关闭方式并写明可拖动。
    "- 点 ✋ 打开的是**浮动小窗**（宽度约 340px、从底部居中弹出、0.3 秒渐入渐出，关闭动画跑完才卸载）：日常 / 亲密 / 敏感 / 私密 四段分组，每段一排大卡片，还是那 25 个动作",
    "- ✋ 图标上的角标数字＝「还有 N 个动作等她回应」（只数**还没反应**的动作：即时反应已单独发出 ⇒ 不计；只有隐式模式下做下、还没演的才算），只有 N>0 才出现",
    "- 卡片上直接写状态，不用悬停：可用＝底部小字写她的耐受档（「还乐意」/「有点不耐烦了」）；不愿意＝卡片半透明 + 底部写她拒绝的原因，仍然点得动（点了会给你一句剧情化的话）；偏好＝右上角 喜欢 / 讨厌 小角标；正在上报＝该卡片转圈，连点无效",
    "- 面板不自动关：连着点几个动作都行，她的反应会出现在下面的消息里；**关面板点右上角的 ✕**（它是浮窗，没有遮罩，点面板外面不会关，这是故意的，不是点坏了）",
    "- 浮窗可以拖：按住标题栏（左边那个 ⠿ 把手）拖到任意位置，超出屏幕会被自动夹回可见范围；关掉再开回到默认位置，刷新页面后记得你上次拖到哪",
    "",
    "【动作出图 / 围观插话 / 统计面板】",
    "- 动作出图（设置 →「动作系统（触摸互动）」）：总是＝每个动作都配一张图；智能（默认）＝亲密档约 25%、敏感档约 50%；从不＝只要文字",
    "- 群聊里的围观插话：在群里对某人做动作时，其他成员凑过来插一句的概率，默认 30%，滑块 0~100% 可调；关掉＝这一轮谁都不插话",
    "- 群聊里的敏感动作（默认关）：关着时群里点敏感档一律被拦下来，打开后才放行",
    "- 统计面板：聊天页点头像打开角色详情，「触摸互动」那一节可以看到她被摸过多少次、等级分布、最近一次、每个动作的偏好与耐受度、配了多少张图",
    "- 私密档（第四段）什么时候亮：她好感很深（约 80 以上）或与你立誓、并且已授权亲密行为之后；她睡着时一律拦下来（催眠中除外）",
    "- 群里永远没有私密档：群聊里那一整段始终是灰的（当众做这种事越过了群聊该有的边界，这个开关不给）",
    "- 「还有 N 个动作等她回应」在两个地方显示：① ✋ 图标上的角标数字；② 点开面板后顶部那一行 —— 两处数字一致；**只数「还没反应」的动作**（即时反应已单独发出 ⇒ 不计；只有隐式模式做下、还没演的才算），她回应完就都消失",
    "- 隐式动作的那行小字写「她还没回应你的动作，跟她说句话吧」；即时动作不显示这行（她当场就回应过了），再跟她说一句隐式动作就没了",

    "",
    "【反重复与话题推进】",
    "- 位置：设置页「反重复与话题推进」。三个开关都是提示词层的增强，不额外调用模型，默认开",
    "- 反车轱辘话：最近几轮话题重叠太多时，提示她换个说法或者推进话题",
    "- 反钻牛角尖：同一情绪卡住好几轮不动时，提示她自我打断、做个小决定",
    "- 重复时自动加强约束：她连续 3 轮在复述同一件事时，把约束从温和升到更强；一旦不再重复立刻回落。关掉则只保留温和提示",
    "- 下面两个 penalty 输入框（presence / frequency，范围 -2 ~ 2）：留空＝请求里完全不发送这两个字段（与加功能前一致）——不确定就别填；想压重复可以试 presence 0.3~0.6、frequency 0.2~0.5",
    "- 填了要盯效果：给太大会让她说话发散、跑题；填 0 是「显式发送 0」，与留空不是一回事",
    "- 日志怎么看档位：搜 [anti-repetition]，能看到这一轮有没有触发、用的是温和还是升级档",
    "",
    "【日志在哪】",
    "- 启动器窗口的「日志」页签＝后端实时输出；在里面右键 →「复制全部」可以整段复制",
    "- 后端同时会把同样的内容写进程序目录下的 logs\\backend-日期.log（默认保留 14 天，可直接发人排查）",
    "- 想关掉落盘：启动前设环境变量 LOG_TO_FILE=false",
    "",
    "【玩具】",
    "- 入口：私聊输入区最右边那一排里的 🧸 玩具按钮（群聊里也有一套，各自算各自的）",
    "- 每件玩具都靠一把「钥匙」解锁；钥匙没填时会明确提示缺钥匙，那是没配好，不是点坏了",
    "- 玩具的反应会写进聊天记录，和动作系统共用同一套好感度 / 耐受度数据",
    "",
    "【图没出来怎么办】",
    "- 第一件事：看 ComfyUI 开着没。启动器首页有「打开 ComfyUI」按钮，等它把模型加载完（几十秒）再点「启动」",
    "- 没开 ComfyUI 时**聊天文字照常**，只有图会失败：气泡里会写明「ComfyUI 连不上（没启动或还在加载）」，这次失败也会记进生图任务里",
    "- 刚起来的前几次生成容易失败（模型还没加载完），程序会自动重试 3 次、约 30 秒；等它稳定后再点一次就好",
    "- 图跟文字对不上时：日志里搜 [imageSkill] Final prompt，那行就是真正送进 ComfyUI 的英文提示词，拿它跟画面比一比",
    "",
    "【常见问题】",
    "- 确保 ComfyUI 已正确安装并能正常运行",
    "- 本程序自带运行环境（Node.js/Python/Git），无需额外安装",
    "- 点动作没反应：查「动作系统」总开关、是否开着「即时反应」（关着时反应并进你下一句）、每日配额是否用完、她是不是睡着了",
    "- 她不理我摸她：多半是隐式模式（即时反应关着或配额用完），再跟她说一句话就能看到回应",
    "- 群里点敏感动作被拦 / 是灰的：设置 →「动作系统（触摸互动）」打开「群聊里的敏感动作」（默认关）",
    "- 生图相关的问题（没出图 / 图不对文 / 慢）看上面「图没出来怎么办」那一节",
    "- 日志里出现「记忆的向量检索」相关提示：说明派生索引与库不同步，程序会自己重建，等它跑完即可（重建期间聊天照常）",
  ].join("\n");
}

// ── 主流程 ──

async function main() {
  console.clear();
  console.log();
  console.log(`  ${C.bold}邻舍.EXE — 完整 Release 打包${C.reset}`);
  console.log(`  ${C.dim}${"=".repeat(50)}${C.reset}`);
  console.log();

  // 创建目录
  ensureDir(CACHE_DIR);
  if (existsSync(RELEASE_DIR)) {
    log("清理旧的 release 目录...");
    rmSync(RELEASE_DIR, { recursive: true, force: true });
  }
  ensureDir(RUNTIME_DIR);

  // ═══════════════════════════════════════════
  // [1/8] 便携 Node.js
  // ═══════════════════════════════════════════
  console.log(`  ${C.bold}[1/9]${C.reset} 准备便携 Node.js v${NODE_VERSION}...`);

  const nodeZip = resolve(CACHE_DIR, `node-v${NODE_VERSION}-win-x64.zip`);

  if (!existsSync(resolve(NODE_DIR, "node.exe"))) {
    if (!existsSync(nodeZip)) {
      log("下载 Node.js (~30MB)...");
      let dlOk = await downloadFile(MIRRORS.node, nodeZip);
      if (!dlOk) {
        warn("npmmirror 下载失败，尝试官方源...");
        dlOk = await downloadFile(MIRRORS.nodeOfficial, nodeZip);
        if (!dlOk) { fail("Node.js 下载失败!"); process.exit(1); }
      }
    }

    log("解压 Node.js...");
    if (existsSync(NODE_DIR)) rmSync(NODE_DIR, { recursive: true, force: true });
    await extractZip(nodeZip, RUNTIME_DIR);
    // 重命名 node-v* → nodejs
    const { readdirSync, renameSync } = await import("node:fs");
    const entries = readdirSync(RUNTIME_DIR);
    const nodeDirEntry = entries.find(e => e.startsWith("node-v"));
    if (nodeDirEntry) {
      renameSync(resolve(RUNTIME_DIR, nodeDirEntry), NODE_DIR);
    }
    ok("Node.js 就绪");
  } else {
    ok("已有捆绑 Node.js，跳过");
  }

  // ═══════════════════════════════════════════
  // [2/8] 便携 Python
  // ═══════════════════════════════════════════
  console.log(`  ${C.bold}[2/9]${C.reset} 准备便携 Python ${PYTHON_VERSION}...`);

  const pyZip = resolve(CACHE_DIR, `python-${PYTHON_VERSION}-embed-amd64.zip`);
  const getPip = resolve(CACHE_DIR, "get-pip.py");

  if (!existsSync(resolve(PY_DIR, "python.exe"))) {
    if (!existsSync(pyZip)) {
      log("下载 Python embeddable (~11MB)...");
      let dlOk = await downloadFile(MIRRORS.python, pyZip, 120);
      if (!dlOk) {
        warn("npmmirror 下载失败，尝试官方源...");
        dlOk = await downloadFile(MIRRORS.pythonOfficial, pyZip, 120);
        if (!dlOk) { fail("Python 下载失败!"); process.exit(1); }
      }
    }

    log("解压 Python...");
    if (existsSync(PY_DIR)) rmSync(PY_DIR, { recursive: true, force: true });
    ensureDir(PY_DIR);
    await extractZip(pyZip, PY_DIR);

    // 修改 python3XX._pth 启用 site-packages + pip
    const { readdirSync, writeFileSync } = await import("node:fs");
    const pthFiles = readdirSync(PY_DIR).filter(f => f.startsWith("python") && f.endsWith("._pth"));
    if (pthFiles.length > 0) {
      const pthFile = resolve(PY_DIR, pthFiles[0]);
      log(`配置 ${pthFiles[0]}...`);
      writeFileSync(pthFile, "python312.zip\n.\nLib\\site-packages\nimport site\n", "ascii");
    }

    const sitePkgs = resolve(PY_DIR, "Lib", "site-packages");
    ensureDir(sitePkgs);

    if (!existsSync(getPip)) {
      log("下载 get-pip.py...");
      await downloadFile(MIRRORS.pipBootstrap, getPip, 60);
    }

    log("安装 pip...");
    const pipResult = await exec(resolve(PY_DIR, "python.exe"), [getPip, "--no-warn-script-location"]);
    if (!pipResult.ok) { fail("pip 安装失败!"); process.exit(1); }
    ok("Python 就绪");
  } else {
    ok("已有捆绑 Python，跳过");
  }

  // ═══════════════════════════════════════════
  // [3/8] 便携 Git
  // ═══════════════════════════════════════════
  console.log(`  ${C.bold}[3/9]${C.reset} 准备便携 Git v${GIT_TAG}...`);

  const gitExe = resolve(CACHE_DIR, `PortableGit-${GIT_VER}-64-bit.7z.exe`);
  const gitCmd = resolve(GIT_DIR, "cmd", "git.exe");
  const gitBin = resolve(GIT_DIR, "bin", "git.exe");

  if (existsSync(gitCmd) || existsSync(gitBin)) {
    ok("已有捆绑 Git，跳过");
  } else {
    if (!existsSync(gitExe)) {
      log("下载 Portable Git (~50MB)...");
      let dlOk = await downloadFile(MIRRORS.git, gitExe);
      if (!dlOk) {
        warn("npmmirror 下载失败，尝试官方源...");
        dlOk = await downloadFile(MIRRORS.gitOfficial, gitExe);
        if (!dlOk) {
          warn("Git 下载失败，版本更新功能将不可用");
        }
      }
    }

    if (existsSync(gitExe)) {
      log("解压 Git（自解压，静默）...");
      if (existsSync(GIT_DIR)) rmSync(GIT_DIR, { recursive: true, force: true });
      await exec(gitExe, [`-o"${GIT_DIR}"`, "-y"]);
      if (existsSync(gitCmd) || existsSync(gitBin)) {
        ok("Git 就绪");
      } else {
        warn("Git 解压后未找到 git.exe，版本更新功能将不可用");
      }
    }
  }

  // ═══════════════════════════════════════════
  // [4/8] 预装 Node.js 依赖
  // ═══════════════════════════════════════════
  console.log(`  ${C.bold}[4/9]${C.reset} 预装 Node.js 依赖...`);

  const npmCmd = resolve(NODE_DIR, "npm.cmd");

  // agent-core — 始终安装，确保依赖与 package.json 一致。
  // 不要预先删除或无条件重建原生模块：开发服务运行时 Windows 会锁住 .node 文件。
  log("agent-core npm install (~3-8min)...");
  {
    const r = await exec(npmCmd, ["install", "--no-audit", "--no-fund"], { cwd: AGENT_CORE, print: true });
    if (!r.ok) { fail("agent-core npm install 失败!"); process.exit(1); }

    // 先验证现有绑定。大多数情况下 npm install 已经准备好依赖，且正在运行的
    // agent-core 可能持有这个文件；验证通过就不要碰它。
    const bundledNode = resolve(NODE_DIR, "node.exe");
    const sqliteTestArgs = [
      "-e",
      "const Database=require('better-sqlite3');const db=new Database(':memory:');db.prepare('SELECT 1').get();db.close();",
    ];
    let sqliteSmokeTest = await exec(bundledNode, sqliteTestArgs, { cwd: AGENT_CORE, shell: false });

    // 只有缺失或 ABI 不兼容时才重建。
    if (!sqliteSmokeTest.ok) {
      log("  现有 better-sqlite3 绑定不可用，尝试重建...");
      const rebuild = await exec(npmCmd, ["rebuild", "better-sqlite3"], {
        cwd: AGENT_CORE,
        print: true,
      });
      if (!rebuild.ok) {
        fail("better-sqlite3 原生绑定重建失败；请先关闭正在运行的 agent-core 后重试。");
        process.exit(1);
      }
      sqliteSmokeTest = await exec(bundledNode, sqliteTestArgs, { cwd: AGENT_CORE, shell: false });
    }

    if (!sqliteSmokeTest.ok) {
      fail("better-sqlite3 发布环境验证失败!");
      if (sqliteSmokeTest.stderr) log(`  ${sqliteSmokeTest.stderr.slice(-1000)}`);
      process.exit(1);
    }
    ok("agent-core 完成（better-sqlite3 已通过捆绑 Node.js 验证）");
  }

  // web-ui — 同样始终安装，确保依赖与 package.json 一致
  log("web-ui npm install (~2-5min)...");
  if (existsSync(resolve(WEB_UI, "node_modules"))) {
    const { rmSync } = await import("node:fs");
    try { rmSync(resolve(WEB_UI, "node_modules", ".cache"), { recursive: true, force: true }); } catch {}
  }
  {
    const r = await exec(npmCmd, ["install", "--no-audit", "--no-fund"], { cwd: WEB_UI, print: true });
    if (!r.ok) { fail("web-ui npm install 失败!"); process.exit(1); }
    ok("web-ui 完成");
  }

  // vite build —— 始终重新构建，确保 public/ 与源码一致
  log("vite build (~1min)...");
  const buildResult = await exec(npmCmd, ["run", "build"], { cwd: WEB_UI, print: true });
  if (!buildResult.ok) {
    fail("vite build 失败!");
    process.exit(1);
  }
  ok("vite build 完成");

  // ═══════════════════════════════════════════
  // [5/8] 预装 Python 依赖
  // ═══════════════════════════════════════════
  console.log(`  ${C.bold}[5/9]${C.reset} 预装 Python 依赖...`);

  const pyExe = resolve(PY_DIR, "python.exe");
  // pip 通用环境变量：跳过版本检查 + 信任镜像源（embeddable Python 可能缺 SSL 证书）
  const pipEnv = {
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    PIP_NO_CACHE_DIR: "1",
  };
  const pipMirror = "https://pypi.tuna.tsinghua.edu.cn/simple";
  const pipTrusted = ["--trusted-host", "pypi.tuna.tsinghua.edu.cn"];

  {
    const check = await exec(pyExe, [
      "-c", "import fastapi, uvicorn, chromadb, onnxruntime, numpy"
    ]);
    if (check.ok) {
      ok("Python 依赖已预装，跳过");
    } else {
      log("pip install (~1-3min)...");

      // 先确保 pip 本身是最新的
      log("  升级 pip...");
      await exec(pyExe, ["-m", "pip", "install", "--upgrade", "pip", ...pipTrusted],
        { print: true, env: pipEnv });

      // 逐个安装关键包以便定位失败点
      const pkgs = [
        "numpy",
        "fastapi",
        "uvicorn[standard]",
        "pydantic",
        "httpx",
        "requests",
        "onnxruntime",
        "huggingface-hub",
        "transformers",
        "chromadb",
        "cloudscraper",
        "beautifulsoup4",
        "lxml",
      ];

      let allOk = true;
      for (const pkg of pkgs) {
        log(`  pip install ${pkg}...`);
        // 先试清华源 + trusted-host
        let r = await exec(pyExe, [
          "-m", "pip", "install", pkg,
          "-i", pipMirror,
          ...pipTrusted,
        ], { print: true, env: pipEnv, timeout: 120000 });
        // 清华源失败则用默认源
        if (!r.ok) {
          r = await exec(pyExe, [
            "-m", "pip", "install", pkg,
          ], { print: true, env: pipEnv, timeout: 120000 });
        }
        if (!r.ok) {
          fail(`${pkg} 安装失败 (exit: ${r.code})`);
          log(`  stderr: ${r.stderr.slice(-500)}`);
          allOk = false;
          break;
        }
      }

      if (!allOk) {
        fail("Python 依赖安装失败!");
        log(`  请检查网络连接或手动执行:`);
        log(`  cd ${VECTOR_SVC}`);
        log(`  ${pyExe} -m pip install -r requirements.txt`);
        process.exit(1);
      }
      ok("Python 依赖完成");
    }
  }

  // ═══════════════════════════════════════════
  // [6/8] 预下载嵌入模型
  // ═══════════════════════════════════════════
  console.log(`  ${C.bold}[6/9]${C.reset} 预下载嵌入模型...`);

  const modelFile = resolve(VECTOR_SVC, "models", "jina-embeddings-v2-base-zh", "onnx", "model_int8.onnx");

  if (existsSync(modelFile)) {
    ok("模型已存在，跳过");
  } else {
    log("下载嵌入模型 (~155MB)...");
    const r = await exec(pyExe, ["download_model.py"], { cwd: VECTOR_SVC, print: true });
    if (!r.ok) {
      warn("模型下载失败，用户首次启动时会自动下载");
    } else {
      ok("模型下载完成");
    }
  }

  // ═══════════════════════════════════════════
  // [7/8] PyInstaller 打包启动器
  // ═══════════════════════════════════════════
  console.log(`  ${C.bold}[7/9]${C.reset} PyInstaller 打包启动器...`);

  const launcherDir = resolve(ROOT, "launcher");

  // 烘焙版本号到 __init__.py（打包进 exe，运行后恢复）
  let _initPyOrig = null;
  if (VERSION !== "dev") {
    const { readFileSync, writeFileSync } = await import("node:fs");
    const initPy = resolve(launcherDir, "launcher", "__init__.py");
    _initPyOrig = readFileSync(initPy, "utf-8");
    let modified = _initPyOrig.replace(
      /__version__\s*=\s*"[^"]*"/,
      `__version__ = "${VERSION}"`
    );
    writeFileSync(initPy, modified, "utf-8");
    log(`版本已写入 __init__.py: ${VERSION}`);
  }

  {
    // 删除旧 .spec 文件，避免缓存导致 --add-data 不生效
    const specFile = resolve(launcherDir, "邻舍.EXE.spec");
    if (existsSync(specFile)) {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(specFile);
      log("已删除旧的 .spec 文件");
    }

    const BUILD_VENV = resolve(launcherDir, "build_cache", "pyinstaller-venv");
    const BUILD_VENV_PY = resolve(BUILD_VENV, "Scripts", "python.exe");
    if (!existsSync(BUILD_VENV_PY)) {
      log("创建 PyInstaller 构建 venv（不污染 runtime）...");
      const venvOk = await exec("python", ["-m", "venv", BUILD_VENV], { print: true });
      if (!venvOk.ok) {
        warn("系统 python 创建 venv 失败，尝试 py -3...");
        const venvOk2 = await exec("py", ["-3", "-m", "venv", BUILD_VENV], { print: true });
        if (!venvOk2.ok) { fail("无法创建 PyInstaller 构建 venv!"); process.exit(1); }
      }
    }

    const buildDepsCheck = await exec(BUILD_VENV_PY, ["-m", "pip", "show", "PySide6"]);
    if (!buildDepsCheck.ok) {
      log("安装 PyInstaller 依赖到构建 venv...");
      const r = await exec(BUILD_VENV_PY, ["-m", "pip", "install", "PySide6", "psutil", "pyinstaller",
        "-i", "https://pypi.tuna.tsinghua.edu.cn/simple",
        "--trusted-host", "pypi.tuna.tsinghua.edu.cn"], { print: true, timeout: 300000 });
      if (!r.ok) {
        warn("构建 venv 安装失败，尝试系统 pip...");
        const r2 = await exec("pip", ["install", "PySide6", "psutil", "pyinstaller"], { print: true });
        if (!r2.ok) { fail("PyInstaller 依赖安装失败!"); process.exit(1); }
      }
    }

    // 优先使用构建 venv 运行 PyInstaller，失败则回退系统 pyinstaller
    let r = await exec(BUILD_VENV_PY, ["-m", "PyInstaller",
      "--onefile", "--windowed",
      "--name", "邻舍.EXE",
      "--icon", "assets/icon.ico",
      "--add-data", "assets/launchHeader.jpg;assets",
      "--add-data", "assets/icon.ico;assets",
      "--add-data", "assets/MiSans-Regular.ttf;assets",
      "--add-data", "assets/navbar-title.png;assets",
      "--hidden-import", "PySide6.QtCore",
      "--hidden-import", "PySide6.QtGui",
      "--hidden-import", "PySide6.QtWidgets",
      "--hidden-import", "PySide6.QtNetwork",
      "--clean", "--noconfirm",
      "main.py",
    ], { cwd: launcherDir, print: true, timeout: 300000 });
    if (!r.ok) {
      warn("捆绑 Python PyInstaller 失败，尝试系统 pyinstaller...");
      r = await exec("pyinstaller", [
        "--onefile", "--windowed",
        "--name", "邻舍.EXE",
        "--icon", "assets/icon.ico",
        "--add-data", "assets/launchHeader.jpg;assets",
        "--add-data", "assets/icon.ico;assets",
        "--add-data", "assets/MiSans-Regular.ttf;assets",
        "--add-data", "assets/navbar-title.png;assets",
        "--hidden-import", "PySide6.QtCore",
        "--hidden-import", "PySide6.QtGui",
        "--hidden-import", "PySide6.QtWidgets",
        "--hidden-import", "PySide6.QtNetwork",
        "--clean", "--noconfirm",
        "main.py",
      ], { cwd: launcherDir, print: true });
    }
    if (!r.ok) { fail("PyInstaller 打包失败!"); process.exit(1); }
    ok("PyInstaller 打包完成");
  }

  // 恢复 __init__.py（避免本地工作区被污染）
  if (_initPyOrig !== null) {
    const { writeFileSync } = await import("node:fs");
    const initPy = resolve(launcherDir, "launcher", "__init__.py");
    writeFileSync(initPy, _initPyOrig, "utf-8");
    log("__init__.py 已恢复");
  }

  // ═══════════════════════════════════════════
  // [8/9] 构建安卓 APK 壳
  // ═══════════════════════════════════════════
  console.log(`  ${C.bold}[8/9]${C.reset} 构建安卓 APK 壳...`);

  // 构建逻辑在 build-apk.mjs 中，可通过 npm run apk 单独执行
  let apkBuilt = null;   // 构建成功后的 APK 绝对路径
  let apkVersionName = null; // 独立于桌面端 VERSION，来源于 Android versionName
  try {
    const { buildApk, getAndroidVersionName } = await import("./build-apk.mjs");
    apkVersionName = getAndroidVersionName();
    apkBuilt = await buildApk();
  } catch (e) {
    warn(`APK 构建异常: ${e.message}`);
  }
  if (!apkBuilt) warn("release 将不包含 APK");

  // ═══════════════════════════════════════════
  // [9/9] 组装 Release 包
  // ═══════════════════════════════════════════
  console.log(`  ${C.bold}[9/9]${C.reset} 组装 Release 包...`);

  // shallow clone 保留 .git/
  log("创建 shallow clone (保留 .git 用于版本更新)...");
  const GITHUB_REPO_URL = "https://github.com/icecranberry/galgame-with-comfyUI.git";
  // depth=50 覆盖足够历史，确保用户端 git describe / checkout tag 不出问题
  const cloneResult = await exec("git", ["clone", "--depth", "50", ROOT, RELEASE_DIR]);
  let hasGit = cloneResult.ok;

  if (!hasGit) {
    warn("git clone 失败，回退到文件复制（版本更新功能不可用）");
    warn(`  错误: ${cloneResult.stderr.slice(0, 200)}`);
    ensureDir(RELEASE_DIR);

    // robocopy 排除目录
    // （.mimosa / logs 见文件头「打包排除」：兜底路径是唯一会把它们带进包的地方；
    //   e2e\node_modules 由 node_modules 这个目录名整体覆盖）
    const robocopyExclude = [".git", "node_modules", "release", "__pycache__", ".cache", ".mimosa", "logs"];
    // 运行时临时快照（如 agent-core/townstate.tmp.json）不属于发布内容，别带进用户包里
    const robocopyExcludeFiles = ["*.tmp.json"];
    const rcOk = await robocopy(ROOT, RELEASE_DIR, robocopyExclude, robocopyExcludeFiles);
    if (!rcOk) { fail("文件复制失败!"); process.exit(1); }
  } else {
    // 修正 remote URL：clone 会把 origin 设为本机路径，客户电脑上不存在
    const remoteResult = await exec("git", ["remote", "set-url", "origin", GITHUB_REPO_URL], { cwd: RELEASE_DIR });
    if (remoteResult.ok) {
      ok("shallow clone 完成，remote 已指向 GitHub");
    } else {
      warn(`修正 remote URL 失败: ${remoteResult.stderr.slice(0, 200)}，版本更新可能不可用`);
    }
  }

  // ── 覆盖预构建产物 ──

  // runtime
  log("复制 runtime...");
  {
    const rcOk = await robocopy(RUNTIME_DIR, resolve(RELEASE_DIR, "runtime"));
    if (!rcOk) { fail("runtime 复制失败!"); process.exit(1); }
    ok("runtime (Node.js + Python + Git)");
  }

  // agent-core/node_modules
  log("复制 agent-core\\node_modules...");
  ensureDir(resolve(RELEASE_DIR, "agent-core"));
  {
    const rcOk = await robocopy(
      resolve(AGENT_CORE, "node_modules"),
      resolve(RELEASE_DIR, "agent-core", "node_modules"),
      [".cache"]
    );
    if (!rcOk) { fail("node_modules 复制失败!"); process.exit(1); }

    // 对最终复制结果再验证一次，防止复制规则或文件锁导致原生绑定遗漏。
    const releaseNode = resolve(RELEASE_DIR, "runtime", "nodejs", "node.exe");
    const releaseCore = resolve(RELEASE_DIR, "agent-core");
    const releaseSqliteTest = await exec(releaseNode, [
      "-e",
      "const Database=require('better-sqlite3');const db=new Database(':memory:');db.prepare('SELECT 1').get();db.close();",
    ], { cwd: releaseCore, shell: false });
    if (!releaseSqliteTest.ok) {
      fail("release 中的 better-sqlite3 验证失败，终止打包!");
      if (releaseSqliteTest.stderr) log(`  ${releaseSqliteTest.stderr.slice(-1000)}`);
      process.exit(1);
    }
    ok("agent-core\\node_modules（发布目录验证通过）");
  }

  // agent-core/public
  log("复制 agent-core\\public...");
  if (existsSync(resolve(AGENT_CORE, "public"))) {
    await robocopy(
      resolve(AGENT_CORE, "public"),
      resolve(RELEASE_DIR, "agent-core", "public")
    );
  }
  ok("agent-core\\public");

  // vector-service/models
  if (existsSync(modelFile)) {
    log("复制嵌入模型...");
    const modelDst = resolve(RELEASE_DIR, "vector-service", "models");
    ensureDir(modelDst);
    await robocopy(
      resolve(VECTOR_SVC, "models"),
      modelDst
    );
    ok("vector-service\\models");
  }

  // 邻舍.EXE.exe
  const launcherExe = resolve(launcherDir, "dist", "邻舍.EXE.exe");
  if (existsSync(launcherExe)) {
    const { copyFileSync } = await import("node:fs");
    copyFileSync(launcherExe, resolve(RELEASE_DIR, "邻舍.EXE.exe"));
    ok("邻舍.EXE.exe");
  } else {
    warn("未找到 邻舍.EXE.exe，PyInstaller 可能未成功");
  }

  // 安卓 APK 壳
  const APK_NAME = apkVersionName
    ? `【非刚需，但体验明显提高】邻舍-v${apkVersionName}.apk`
    : "【非刚需，但体验明显提高】邻舍.apk";
  if (apkBuilt) {
    const { copyFileSync } = await import("node:fs");
    copyFileSync(apkBuilt, resolve(RELEASE_DIR, APK_NAME));
    ok(APK_NAME);
  } else {
    warn("无 APK 产物，release 包中不含安卓壳");
  }

  // 使用说明
  const { writeFileSync } = await import("node:fs");
  writeFileSync(resolve(RELEASE_DIR, "使用说明.txt"), buildUsageGuideText({ apkName: APK_NAME }), "utf-8");
  ok("使用说明.txt");

  // VERSION 文件（供启动器运行时读取版本号）
  writeFileSync(resolve(RELEASE_DIR, "VERSION"), VERSION + "\n", "utf-8");
  ok("VERSION");

  // 默认头像：从 assets 源复制到 avatars 目录
  const defaultAvatar = resolve(AGENT_CORE, "assets", "default_assistant_header.png");
  if (existsSync(defaultAvatar)) {
    const avatarDst = resolve(RELEASE_DIR, "agent-core", "data", "avatars");
    ensureDir(avatarDst);
    const { copyFileSync } = await import("node:fs");
    copyFileSync(defaultAvatar, resolve(avatarDst, "default_assistant_header.png"));
    ok("默认头像 → agent-core\\data\\avatars\\");
  } else {
    warn("默认头像不存在: agent-core/assets/default_assistant_header.png");
  }

  // ── 打包前清掉非产品内容（审查缺口 4，≈127 MB）──
  // 正常路径（git clone）本就带不上它们（.gitignore 覆盖、0 tracked 文件）；
  // 这里再清一次，是为了守住 **clone 失败时的 robocopy 兜底路径**，也防将来复制口径被改。
  // 三项分别对应 7z 的 -xr'!*.mimosa' / -xr'!e2e\node_modules' / -xr'!logs'。
  // **不含 .git** —— 交付包要保留 .git（审查 §六 第 1 条）。
  for (const stray of [
    resolve(RELEASE_DIR, ".mimosa"),
    resolve(RELEASE_DIR, "logs"),
    resolve(RELEASE_DIR, "e2e", "node_modules"),
  ]) {
    if (!existsSync(stray)) continue;
    rmSync(stray, { recursive: true, force: true });
    ok(`打包前剔除非产品内容: ${stray.slice(RELEASE_DIR.length + 1)}`);
  }

  // ═══════════════════════════════════════════
  // 打包 zip
  // ═══════════════════════════════════════════
  console.log();
  log("创建 release zip...");

  const zipFile = resolve(ROOT, "release", `${RELEASE_NAME}.zip`);
  if (existsSync(zipFile)) {
    const { unlinkSync } = await import("node:fs");
    unlinkSync(zipFile);
  }

  // 使用 PowerShell Compress-Archive（Windows 内置，无需额外依赖）
  const zipResult = await exec("powershell", [
    "-NoProfile", "-Command",
    `Compress-Archive -Path '${RELEASE_DIR}\\*' -DestinationPath '${zipFile}' -Force`
  ]);
  if (!zipResult.ok) { fail("zip 创建失败!"); process.exit(1); }

  const { statSync } = await import("node:fs");
  const zipSizeMB = Math.round(statSync(zipFile).size / (1024 * 1024));

  console.log();
  console.log(`  ${C.bold}${"=".repeat(50)}${C.reset}`);
  console.log(`  ${C.bold}✨ Release 打包完成!${C.reset}`);
  console.log(`  ${C.dim}${"=".repeat(50)}${C.reset}`);
  console.log();
  console.log(`  版本: v${VERSION}`);
  console.log(`  输出: release\\${RELEASE_NAME}.zip`);
  console.log(`  体积: ~${zipSizeMB} MB`);
  console.log();
  console.log(`  包含内容:`);
  console.log(`  - Node.js v${NODE_VERSION} 便携版`);
  console.log(`  - Python ${PYTHON_VERSION} + 全部依赖`);
  console.log(`  - Portable Git (版本更新)`);
  console.log(`  - .git/ (shallow, 约 5-10MB)`);
  console.log(`  - agent-core (预装依赖)`);
  console.log(`  - vector-service (含嵌入模型)`);
  console.log(`  - 邻舍.EXE 启动器`);
  if (apkBuilt) console.log(`  - 邻舍-安卓 APK 壳`);
  console.log();
  console.log(`  用户解压后:`);
  console.log(`  - 零构建，解压即用`);
  console.log(`  - 版本管理功能完整可用`);
  console.log();

  // 提示清理
  log(`${C.dim}提示: runtime/ 和 launcher/build_cache/ 为缓存，可保留用于下次打包加速${C.reset}`);
}

// ── 单独生成「使用说明.txt」 ──
//
//   $ node scripts/build-release.mjs --usage-guide-only [输出路径]
//
// 不碰 clone / robocopy / PyInstaller / APK，只把同一个函数生成的正文写盘，
// 因此单独跑出来的内容与正式发布包里那份逐字节一致。默认写到仓库根目录（gitignored）。
if (process.argv.includes("--usage-guide-only")) {
  const outArg = process.argv.slice(2).find(arg => arg !== "--usage-guide-only");
  const outPath = outArg ? resolve(process.cwd(), outArg) : resolve(ROOT, "使用说明.txt");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(outPath, buildUsageGuideText(), "utf-8");
  console.log(`  ${C.green}[OK]${C.reset} 使用说明.txt -> ${outPath}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`${C.red}Fatal: ${err.message}${C.reset}`);
  console.error(err.stack);
  process.exit(1);
});
