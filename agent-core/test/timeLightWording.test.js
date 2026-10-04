/**
 * 光线/时间文案的措辞（2026-10-01 静态体检抓到的真 bug）
 *
 * ## 现场
 * `getSeason()` 返回的是**带「天」的二字词**（`春天/夏天/秋天/冬天`），而四处模板拼的是
 * `${season}日的${timeDesc}时分` ⇒ prompt 里出现 **「秋天日的凌晨时分」** 这种病句。
 * 实测（内存库）：
 *   getSeason(9) = "秋天"
 *   getTimeLightInline(new Date()) → 现在是04:13，秋天日的凌晨时分。夜色昏暗，…
 *
 * 这段串直接进聊天 / 朋友圈 / 奇遇的 LLM prompt，四个调用点全中，而且**没有任何测试覆盖**
 * （`programTimeControl.test.js` 只断言两次调用结果相等）。
 *
 * ## 修法取舍（为什么改模板而不是改 getSeason）
 * `getSeason` 还被 `getTimeLight` / `getTimeTag` / `getLightHint` 等处按「秋天」这种形态使用，
 * 改它的返回值会顺带改掉那些文案；而病句只出在这四处拼接。
 * 所以**只改模板** `${season}日的` → `${season}的`，并把 `getSeason` 的返回契约钉在测试里防止被顺手改掉。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

process.env.DB_PATH = ':memory:'
process.env.LOG_TO_FILE = 'false'

const {
  getSeason, getTimeLightInline, getTimeLight, getTimeTag, getTimeLightTag, getLightHint,
} = await import('../src/services/timeLight.js')

/** 病句特征：「春天日」「秋天日」… 也就是季节词后面紧跟一个「日」 */
const BROKEN_RE = /[春夏秋冬]天日/

test('getSeason 的返回契约不变（带「天」的二字词）', () => {
  assert.equal(getSeason(3), '春天')
  assert.equal(getSeason(6), '夏天')
  assert.equal(getSeason(9), '秋天')
  assert.equal(getSeason(12), '冬天')
})

test('四种时间文案都不再吐出「秋天日」这种病句，且读得通', () => {
  const now = new Date()
  const lines = {
    getTimeLightInline: getTimeLightInline(now),
    getTimeLight: getTimeLight(now),
    getTimeTag: getTimeTag(now),
    getTimeLightTag: getTimeLightTag(now),
    getLightHint: getLightHint(now),
  }
  for (const [name, text] of Object.entries(lines)) {
    const value = String(text ?? '')
    assert.equal(BROKEN_RE.test(value), false, `${name} 里出现了病句：${value}`)
  }
  // 带季节的那两处必须写成「秋天的…时分」
  for (const name of ['getTimeLightInline', 'getTimeLight']) {
    const value = String(lines[name] ?? '')
    if (!/[春夏秋冬]天/.test(value)) continue
    assert.match(value, /[春夏秋冬]天的/, `${name} 里的季节应当用「X天的」连接：${value}`)
  }
})

test('源码级：模板里不许再出现 ${season}日', () => {
  const text = readFileSync(new URL('../src/services/timeLight.js', import.meta.url), 'utf8')
  assert.equal(/\$\{season\}日/.test(text), false, '四处模板必须是 ${season}的')
  assert.match(text, /\$\{season\}的\$\{timeDesc\}时分/, '修好的写法要真的存在')
})

test('晴朗夜晚的天气是「月朗星稀」——夜间改写搬到了真正在跑的那条链上', async () => {
  const { config } = await import('../src/config.js')
  const { getCurrentWeather, getWeatherLightNote } = await import('../src/services/timeLight.js')
  const { getDb } = await import('../src/db/index.js')

  const prev = config.features.weather
  config.features.weather = true
  try {
    const db = getDb()
    // 直接用 db 句柄读回，确认夹具真的落在**同一个库**上（`:memory:` 下不同连接是不同库，
    // 这条断言就是为了在那种情况下立刻指出问题，而不是让后面报一个含糊的 null）
    const stmt = db.prepare(`INSERT OR REPLACE INTO weather_hourly (weather_time, weather_text, temperature, wind_speed)
      VALUES (?, '晴', '26C', '2')`)
    // ⚠️ 要把**断言用到的每一个小时**都插进去（第一版只插了 12/22，却去断言 3/6/18 ⇒
    //    没有行 ⇒ getCurrentWeather 返 null ⇒ TypeError 指到 .weather 上，看着像产品 bug）
    for (const h of [3, 6, 12, 18, 22]) stmt.run(`${String(h).padStart(2, '0')}:00`)
    const row12 = db.prepare(`SELECT weather_text FROM weather_hourly WHERE weather_time='12:00'`).get()
    assert.ok(row12, '夹具写不进去')
    assert.equal(row12.weather_text, '晴', '夹具里的字面量要原样落库')
    assert.equal(config.features.weather, true, `features.weather 必须是开着的，实际=${config.features.weather}`)
    const probe = getCurrentWeather(12)
    assert.ok(probe, 'getCurrentWeather(12) 不该是 null —— 若 fixture 在另一个库上，这里就会空')
    assert.equal(probe.weather, '晴', '白天晴天照旧说晴')
    assert.equal(getCurrentWeather(22).weather, '月朗星稀', '夜里晴天要说月朗星稀')
    assert.equal(getCurrentWeather(3).weather, '月朗星稀', '凌晨 3 点也算夜间（hour < 6）')
    assert.equal(getCurrentWeather(6).weather, '晴', '6 点算白天，边界不能错')
    assert.equal(getCurrentWeather(18).weather, '月朗星稀', '18 点算夜间，边界不能错')
    // 光线修饰词也跟着走（它读同一个函数）。注意这里断言的是**夜间措辞**而不是「月朗星稀」
    // 字面量：光线表里的描述是「夜色清朗、月色分明、星光微弱」——第一版按字面量断言写错了。
    const nightNote = String(getWeatherLightNote(22))
    assert.match(nightNote, /夜色|月色|星光/, '夜里晴朗的光线提示要讲到夜色/月色（不能是空的）')
    assert.equal(getWeatherLightNote(12), '阳光充足、光影分明、色调偏暖', '白天仍走原来的「晴」那条')
  } finally {
    config.features.weather = prev
  }
})

test('源码级：四个死函数已删，且夜间映射不再有第二份实现', () => {
  const weather = readFileSync(new URL('../src/services/weatherService.js', import.meta.url), 'utf8')
  for (const dead of ['getResolvedCity', 'getWeatherContext']) {
    assert.equal(new RegExp(`function ${dead}\\b`).test(weather), false, `${dead} 应当已删除`)
  }
  // getSeason / getCurrentWeather 的名字在 timeLight 才是真源，weatherService 里不该再有实现
  assert.equal(/export function getSeason\b/.test(weather), false, 'weatherService.getSeason 应当已删除')
  assert.equal(/export function getCurrentWeather\b/.test(weather), false, 'weatherService.getCurrentWeather 应当已删除')
  // 「月朗星稀」的**代码字面量**只允许出现在一处（timeLight）；
  // 注释里提它不带引号（删函数时留的说明就专门点了这句），所以查带引号的形态最准
  const timeLightSrc = readFileSync(new URL('../src/services/timeLight.js', import.meta.url), 'utf8')
  assert.match(timeLightSrc, /'月朗星稀'/, '夜间映射的代码要在 timeLight 里')
  assert.equal(/'月朗星稀'/.test(weather), false, 'weatherService 里不该再有第二份实现（代码字面量）')
  assert.equal(/import \{ getTimeLight \}/.test(weather), false, '删函数后那个 import 也该一起删')
})
