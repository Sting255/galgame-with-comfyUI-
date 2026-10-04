/**
 * 时间 + 光线描述生成器
 *
 * 供朋友圈、奇遇事件、聊天生图、瞄一眼等模块统一使用。
 * 按当前小时映射为中文时段描述 + 中文光线关键词，直接写进 prompt。
 * 同时读取 weather_hourly 表数据，融合天气信息丰富光线描述。
 */

import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { getProgramNow, toProgramTime } from './programTime.js';

/**
 * 时间入参归一：本模块所有导出的 `now` 参数都按这个口径解释。
 *   · 不传        → **程序时间**（真实时间 + 程序时间偏移）—— 默认路径
 *   · `Date`      → 视为**真实时间**，内部加上偏移（chat.js / moments / eventGenerator 都传 new Date()）
 *   · 其它对象    → 原样透传（小镇模拟传的是 `{ getHours, getMinutes }` 这种鸭子类型时钟，
 *                   它有自己的世界钟，不能在这里再偏移一次）
 * 偏移为 0（默认）时三种情况都与改动前逐字节一致。
 */
function resolveNow(now) {
  if (now === undefined || now === null) return getProgramNow();
  if (now instanceof Date) return toProgramTime(now);
  return now;
}

const LIGHT_MAP = [
  // [时间范围], 时段名, 无天气全量描述（室外+室内）, 有天气时仅室内描述
  [[0, 5], '凌晨', '夜色昏暗，若有室外场景可出现冷调月光或暖黄路灯点缀；如果醒着，室内场景以低亮度暖色人工光源为主，如果睡觉，房间里没有灯光',
    '若有室内场景以低亮度暖色人工光源为主'],
  [[5, 7], '清晨', '室外可能是淡金晨光、薄雾或阴天灰调；室内场景以窗边自然光与人工光混合',
    '若有室内场景以窗边自然光与人工光混合'],
  [[7, 12], '上午', '室外日光清亮或阴天漫反射，室内场景以窗边散射自然光为主',
    '若有室内场景以窗边散射自然光为主'],
  [[12, 13], '中午', '室外日照充足明亮，室内场景光线均匀、明亮通透',
    '若有室内场景光线均匀、明亮通透'],
  [[13, 17], '下午', '室外阳光可能偏暖但光线柔和多变（晴/阴差异大），室内场景以散射自然光为主',
    '若有室内场景以散射自然光为主'],
  [[17, 19], '傍晚', '室外或呈暖调夕照或阴天灰蓝调，室内场景暖光与窗外暮色可能交织',
    '若有室内场景暖光与窗外暮色可能交织'],
  [[19, 22], '晚上', '室外深蓝暮色或已全黑，室内场景以暖黄灯光、屏幕光、烛光等人造光源为主',
    '若有室内场景以暖黄灯光、屏幕光、烛光等人造光源为主'],
  [[22, 24], '深夜', '深夜暗光环境，月光或路灯微光，沉静冷暗氛围（深夜色调较明确，可偏冷暗）',
    '若有室内场景以暗光为主'],
];

// 天气→光线修饰。QWeather v7 天气文本 → 对画面光线的影响描述。
const WEATHER_LIGHT_MOD = {
  '晴': '阳光充足、光影分明、色调偏暖',
  // 2026-10-01：夜间的「晴」（见 getCurrentWeather 里的夜间改写）。不加这条的话，
  // 晴朗夜晚被改写成「月朗星稀」之后 `_normalizeWeather` 归一到它、表里却没有，
  // 光线修饰词会直接从「阳光充足…」变成**空串** —— 等于修好一个文案、弄丢另一个。
  '月朗星稀': '夜色清朗、月色分明、星光微弱',
  '少云': '阳光充足、有少量云影',
  '晴间多云': '阳光与云影交替、光线多变',
  '多云': '云层较多、厚薄不一，光线柔和偏散，阴影较淡',
  '阴': '天色灰暗阴沉、光线平淡无强烈明暗对比，整体偏灰',
  '小雨': '天色阴沉、地面潮湿有微弱反光、远处景物稍朦胧',
  '中雨': '天色阴暗、雨幕可见、光线昏暗、远景模糊',
  '大雨': '天色昏暗、雨势较大影响能见度、地面有明显水花',
  '暴雨': '天色极为昏暗、雨势猛烈、能见度低、氛围压抑',
  '大暴雨': '天色漆黑如夜、暴雨倾盆、能见度极低',
  '特大暴雨': '天色漆黑、雨势灾难级、能见度极低',
  '阵雨': '时晴时雨、光线变化频繁、地面偶有潮湿反光',
  '雷阵雨': '天色阴沉、偶有闪电亮光、氛围紧张',
  '雷阵雨伴有冰雹': '天色阴沉、闪电亮光与冰雹敲击、氛围紧张',
  '冻雨': '天色阴沉、地面冰壳反射冷光',
  '雨夹雪': '天色阴沉、雨雪混合、地面湿滑有微弱反光',
  '小雪': '天色偏白、地面薄雪轻微反光、氛围清冷',
  '中雪': '天色灰白、积雪较厚反射冷调白光',
  '大雪': '天色暗白、积雪深厚、整体偏亮偏冷',
  '暴雪': '天色暗白、积雪极厚、高反差冷调',
  '雪': '天色灰白、积雪反光使环境偏亮偏冷',
  '雾': '能见度低、光线朦胧散射、远近景物柔化、氛围朦胧柔和',
  '霾': '能见度降低、光线昏黄浑浊、远景发灰',
  '扬沙': '天色昏黄、光线浑浊、能见度下降',
  '浮尘': '天色灰黄、光线暗淡、能见度下降',
  '沙尘暴': '天色昏黄极暗、能见度极低、光线浑浊',
  '强沙尘暴': '天色昏黑、能见度极低、光线极为浑浊',
};

// 天气大类归一（用于粗略兼容）
function _normalizeWeather(text) {
  if (!text) return null;
  if (text.includes('暴雨') || text.includes('大暴雨') || text.includes('特大暴雨')) return '暴雨';
  if (text.includes('大雨') || text.includes('中到大雨') || text.includes('大到暴雨')) return '大雨';
  if (text.includes('中雨') || text.includes('小到中雨')) return '中雨';
  if (text.includes('小雨')) return '小雨';
  if (text.includes('雷阵雨伴有冰雹')) return '雷阵雨伴有冰雹';
  if (text.includes('阵雨') || text.includes('雷阵雨')) return text.startsWith('雷阵') ? '雷阵雨' : '阵雨';
  if (text.includes('沙尘暴') || text.includes('强沙尘暴')) return '沙尘暴';
  if (text.includes('暴雪')) return '暴雪';
  if (text.includes('大雪')) return '大雪';
  if (text.includes('中雪')) return '中雪';
  if (text.includes('小雪')) return '小雪';
  if (text.includes('雪') || text.includes('雨夹雪') || text.includes('冻雨')) return text;
  if (text.includes('雾')) return '雾';
  if (text.includes('霾')) return '霾';
  if (text.includes('扬沙') || text.includes('浮尘') || text.includes('沙尘')) return '扬沙';
  if (text.includes('多云') || text.includes('少云') || text.includes('晴间多云')) return text;
  if (text.includes('阴')) return '阴';
  if (text.includes('晴')) return '晴';
  return text;
}

/**
 * 从 weather_hourly 表读取当前小时的天气
 * @param {number} hour 0-23
 * @returns {{ weather: string, temperature: string, windSpeed: string } | null}
 */
export function getCurrentWeather(hour) {
  if (!config.features.weather) return null;
  try {
    const db = getDb();
    const timeStr = `${String(hour).padStart(2, '0')}:00`;
    const row = db.prepare(
      'SELECT weather_text, temperature, wind_speed FROM weather_hourly WHERE weather_time = ?'
    ).get(timeStr);
    if (!row) return null;
    // 2026-10-01：夜间改写**从 weatherService 搬到这里**（单一真源）。
    // 原来只有 `weatherService.getWeatherContext → getCurrentWeather` 那条链做这件事，
    // 而那四个函数全树零调用点 ⇒ 夜里「晴」永远不会变成「月朗星稀」，
    // 所有角色在晴朗夜晚抬头看天都只会说「晴」。这里才是真正在跑的那条链
    // （getTimeLight / getTimeTag / getLightHint / getWeatherLightNote 都吃它）。
    const isNight = hour >= 18 || hour < 6;
    const weather = (isNight && row.weather_text === '晴') ? '月朗星稀' : row.weather_text;
    return { weather, temperature: row.temperature, windSpeed: row.wind_speed };
  } catch {
    return null;
  }
}

/**
 * 获取当前小时的天气光线修饰词（仅返回天气对光线的影响描述，不含时间信息）
 * @param {number} hour 0-23
 * @returns {string} 天气光线描述，没有数据则返回空字符串
 */
export function getWeatherLightNote(hour) {
  const w = getCurrentWeather(hour);
  if (!w || !w.weather) return '';
  const norm = _normalizeWeather(w.weather);
  return WEATHER_LIGHT_MOD[norm] || '';
}

/**
 * 获取天气紧凑描述（不含光线修饰），供需要自定义格式的调用方拼积木。
 * 示例："天气：晴、挺热、微风"，无数据返回空字符串。
 * @param {number} hour 0-23
 * @returns {string}
 */
export function getWeatherClause(hour) {
  const weather = getCurrentWeather(hour);
  if (!weather || !weather.weather) return '';
  const weatherLight = getWeatherLightNote(hour);
  const parts = [weather.weather];
  if (weather.temperature) parts.push(weather.temperature);
  if (weather.windSpeed) parts.push(weather.windSpeed);
  if (weatherLight) parts.push(weatherLight);
  return `天气：${parts.join('、')}`;
}

/**
 * 内联时间+天气+光线从句，自然语言，同时说明室内外光线。
 * 示例（含天气）："现在是14:30，夏日下午时分。外面多云、挺热，光线柔和偏散。室内散射自然光为主"
 * 示例（无天气）："现在是14:30，夏日下午时分。室外阳光可能偏暖但光线柔和多变（晴/阴差异大），室内散射自然光为主"
 * @param {Date} [now]
 * @returns {string}
 */
export function getTimeLightInline(now) {
  now = resolveNow(now);
  const { timeStr, timeDesc, lightNote, lightNoteIndoor, hour } = pickTimeLight(now); // 已在上方 resolveNow 过，这里不能再 resolve（否则偏移加两遍）
  const season = getSeason(now.getMonth() + 1);
  const weather = getCurrentWeather(hour);
  if (weather && weather.weather) {
    const weatherLight = getWeatherLightNote(hour);
    const parts = [weather.weather];
    if (weather.temperature) parts.push(weather.temperature);
    if (weather.windSpeed) parts.push(weather.windSpeed);
    if (weatherLight) parts.push(weatherLight);
    return `现在是${timeStr}，${season}的${timeDesc}时分。外面${parts.join('、')}。${lightNoteIndoor}`;
  }
  return `现在是${timeStr}，${season}的${timeDesc}时分。${lightNote}`;
}

/**
 * 紧凑天气+光线描述，仅当有天气数据时返回，否则空串。
 * 示例："外面多云、挺热，光线柔和偏散。室外阳光可能偏暖但光线柔和多变，室内散射自然光为主"
 * @param {Date} [now]
 * @returns {string}
 */
export function getLightNoteWithWeather(now) {
  now = resolveNow(now);
  const { lightNoteIndoor, hour } = pickTimeLight(now); // 已在上方 resolveNow 过，这里不能再 resolve（否则偏移加两遍）
  const weather = getCurrentWeather(hour);
  if (!weather || !weather.weather) return '';
  const weatherLight = getWeatherLightNote(hour);
  const parts = [weather.weather];
  if (weather.temperature) parts.push(weather.temperature);
  if (weather.windSpeed) parts.push(weather.windSpeed);
  if (weatherLight) parts.push(weatherLight);
  return `外面${parts.join('、')}。${lightNoteIndoor}`;
}

/**
 * ⚠️ 2026-10-01 修掉一类**双重偏移** bug（用户："角色感受到的时间很混乱"）：
 *
 * `resolveNow()` 对真实瞬间会 `toProgramTime()`（加一次偏移），但对**已经是程序时间**的 Date
 * 无法识别，还会再加一次。而本文件里每个"非叶子"函数原来都是
 * `now = resolveNow(now)` → `getTimeLight(now)`，而 `getTimeLight` 内部**也会 resolve** ⇒
 * 偏移被加两遍：**日期/时刻串用的是加一遍的值，时段标签与天气钟点用的是加两遍的值**。
 *
 * 真实日志证据（用户程序时间拨快 13h17m 后）：
 *   `[2026-10-02 周五 08:56 | 秋天·深夜]` —— 08:56 + 13h17m = 22:13 ⇒ 落在 LIGHT_MAP 的「深夜」，
 *   而同一行前面的 `08:56` 是只加一遍的正确值。角色于是"早上八点"被喂成"深夜"。
 *
 * 修法：**resolve 只做一次**，之后一律走不做解析的纯函数 `pickTimeLight(date)`。
 * 公共 API 形状不变（外部仍传真实瞬间或什么都不传）。
 */
function pickTimeLight(date) {
  const hour = date.getHours();
  const timeStr = `${String(hour).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const entry = LIGHT_MAP.find(([r]) => hour >= r[0] && hour < r[1]);
  return {
    timeStr,
    hour,
    timeDesc: entry?.[1] || '未知',
    lightNote: entry?.[2] || 'natural lighting',
    lightNoteIndoor: entry?.[3] || '室内场景以灯光为主',
  };
}

/**
 * @param {Date} [now]
 * @returns {{ timeStr: string, timeDesc: string, lightNote: string, lightNoteIndoor: string, hour: number }}
 */
export function getTimeLight(now) {
  return pickTimeLight(resolveNow(now));
}

/**
 * 生成时间标签（用于主聊天流）含季节和天气。
 * 格式尽量系统化、中性化：像系统状态栏一样客观呈现时间与环境信息，
 * 避免"当前时间/夏日下午"这类叙事化措辞诱导模型在回复中复述或展开环境描写。
 * [2026-08-04 周二 04:54 | 夏天·深夜 | 天气:多云、挺热]
 * @param {Date} [now]
 * @param {boolean} [needWeather=true] 是否附加天气
 * @returns {string}
 */
export function getTimeTag(now, needWeather = true) {
  now = resolveNow(now);
  const weekDay = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const { timeDesc } = pickTimeLight(now); // 已在上方 resolveNow 过，这里不能再 resolve（否则偏移加两遍）
  const season = getSeason(now.getMonth() + 1);
  const envParts = [`${season}·${timeDesc}`];
  const weather = needWeather ? getCurrentWeather(now.getHours()) : null;
  if (weather && weather.weather) {
    const wParts = [weather.weather];
    if (weather.temperature) wParts.push(weather.temperature);
    envParts.push(`天气:${wParts.join('、')}`);
  }
  return `[${dateStr} ${weekDay} ${timeStr} | ${envParts.join(' | ')}]`;
}

/**
 * 生成带光线描述的时间标签（用于生图 prompt 场景）
 * [当前时间 周三 07/03 14:30 / 下午 — warm afternoon sunlight, ...]
 *
 * @param {Date} [now]
 * @returns {string}
 */
export function getTimeLightTag(now) {
  now = resolveNow(now);
  const weekDay = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
  const dateStr = `${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
  const { timeStr, timeDesc } = pickTimeLight(now); // 已在上方 resolveNow 过，这里不能再 resolve（否则偏移加两遍）
  const season = getSeason(now.getMonth() + 1);
  const weather = getCurrentWeather(now.getHours());
  if (weather && weather.weather) {
    const parts = [weather.weather];
    if (weather.temperature) parts.push(weather.temperature);
    return `[当前时间 ${weekDay} ${dateStr} ${timeStr} / ${season}/${timeDesc} — 外面${parts.join('、')}]`;
  }
  return `[当前时间 ${weekDay} ${dateStr} ${timeStr} / ${season}/${timeDesc}]`;
}

/**
 * 根据月份获取季节
 * @param {number} month 1-12
 * @returns {'春天'|'夏天'|'秋天'|'冬天'}
 */
export function getSeason(month) {
  if (month >= 3 && month <= 5) return '春天';
  if (month >= 6 && month <= 8) return '夏天';
  if (month >= 9 && month <= 11) return '秋天';
  return '冬天';
}

/**
 * 光线参考提示——作为系统背景环境设定，同时说明室内外光线。
 * 示例（含天气）："夏日下午时分。外面多云、挺热，光线柔和偏散。室内散射自然光为主"
 * 示例（无天气）："夏日下午时分。室外阳光可能偏暖但光线柔和多变（晴/阴差异大），室内散射自然光为主"
 *
 * @param {Date} [now]
 * @returns {string}
 */
export function getLightHint(now) {
  now = resolveNow(now);
  const { timeDesc, lightNote, lightNoteIndoor, hour } = pickTimeLight(now); // 已在上方 resolveNow 过，这里不能再 resolve（否则偏移加两遍）
  const season = getSeason(now.getMonth() + 1);
  const weather = getCurrentWeather(hour);

  if (weather && weather.weather) {
    const weatherLight = getWeatherLightNote(hour);
    const parts = [weather.weather];
    if (weather.temperature) parts.push(weather.temperature);
    if (weather.windSpeed) parts.push(weather.windSpeed);
    if (weatherLight) parts.push(weatherLight);
    return `${season}的${timeDesc}时分。外面${parts.join('、')}。${lightNoteIndoor}`;
  }

  return `${season}的${timeDesc}时分。${lightNote}`;
}
