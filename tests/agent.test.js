/**
 * Agent 层回归 —— 只测本地模拟解析和不依赖网络的部分。
 *
 * 真实模型调用不在回归范围内（需要网络和 key）。这里保证的是：
 *   1. 无 key 时的降级路径可用
 *   2. 提示词与 few-shot 里不含真实个人信息
 *   3. 原文出处在本地回填，不消耗模型输出 token
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { INTAKE_SAMPLES } from './fixtures/samples.js';

/* 必须在加载 agent/db 之前把数据目录指向临时目录，
   而且只能用动态 import —— ESM 的静态 import 会被提升到这些赋值之前，
   写成 `import ... from '../lib/agent.js'` 的话环境变量根本赶不上。

   原来这个文件压根没做隔离，直接读的是真实 data/settings.json：
   测试结果取决于开发机上有没有配过模型，
   「未配置 key 时为 false」这条在配过模型的机器上本该红却一直是绿的。 */
const TMP = mkdtempSync(join(tmpdir(), 'naimeng-agent-'));
process.env.NAIMENG_DATA_DIR = TMP;
for (const k of ['LLM_BASE_URL', 'LLM_MODEL', 'LLM_API_KEY',
  'VISION_BASE_URL', 'VISION_MODEL', 'VISION_API_KEY']) delete process.env[k];

const { mockExtract, locateSources, agentReady, visionReady, agentConfig, PROMPT_VERSION } =
  await import('../lib/agent.js');
const db = await import('../lib/db.js');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('降级路径', () => {
  test('未配置 key 时 agentReady/visionReady 为 false', async () => {
    // 测试进程里已清空 LLM_* 环境变量
    assert.equal(await agentReady(), false);
    assert.equal(await visionReady(), false);
  });

  /* 这条是补的。原来只断言 typeof === 'boolean' —— 那种写法在
     agentReady 永远返回 false 时照样通过，正是它让一个真实回归溜了过去：
     agentConfig 同步调用了已经异步化的 db.getSettings()，拿到的是 Promise，
     配置全部静默回落到环境变量。界面上「已保存」照常显示，识别却永远走本地模拟。
     所以必须反向验证：配置齐了就得为 true。 */
  test('配置齐全后 agentReady 必须变 true —— 只验类型的断言挡不住静默回落', async () => {
    await db.saveSettings({ model: {
      provider: 'Fake', baseUrl: 'http://127.0.0.1:9/v1', model: 'fake-1',
      apiStyle: 'chat', apiKey: 'sk-fake-0000000000',
    } });

    const cfg = await agentConfig();
    assert.equal(cfg.baseUrl, 'http://127.0.0.1:9/v1', 'agentConfig 没读到已保存的配置');
    assert.equal(cfg.model, 'fake-1');
    assert.ok(cfg.apiKey, 'apiKey 丢了');
    assert.equal(await agentReady(), true, '配置齐全却仍为 false，识别会一直走本地模拟');
  });

  test('视觉模型独立配置，不被文本模型带上', async () => {
    assert.equal(await agentReady(), true, '上一条已配好文本模型');
    assert.equal(await visionReady(), false, '只配了文本模型，视觉不该被带成 ready');

    await db.saveSettings({ vision: { baseUrl: 'http://127.0.0.1:9/v1', model: 'v', apiKey: 'sk-b0000000000' } });
    assert.equal(await visionReady(), true);
    assert.equal((await agentConfig('vision')).model, 'v');
    assert.equal((await agentConfig()).model, 'fake-1', '两个配置串了');

    await db.saveSettings({ model: { clearApiKey: true }, vision: { clearApiKey: true } });
  });

  test('提示词版本号存在，便于留痕比对', () => {
    assert.match(PROMPT_VERSION, /^intake-\d{4}-\d{2}-\d{2}/);
  });

  test('每条样本都能解析出结构，不抛异常', () => {
    for (const s of INTAKE_SAMPLES) {
      const r = mockExtract(s.text);
      assert.ok(Array.isArray(r.accounts), `${s.id} accounts 不是数组`);
      assert.ok(r.recipient, `${s.id} 缺 recipient`);
      assert.ok(Array.isArray(r.other_platform_accounts), `${s.id} 缺 other_platform_accounts`);
    }
  });

  test('直播定向能被识别', () => {
    const s = INTAKE_SAMPLES.find((x) => x.id === 'T14');
    assert.equal(mockExtract(s.text).cooperation_type, '直播定向');
  });

  test('跨平台账号被隔离，不进抖音字段', () => {
    const s = INTAKE_SAMPLES.find((x) => x.id === 'T13');
    const r = mockExtract(s.text);
    assert.ok(r.other_platform_accounts.length >= 2);
    const platforms = r.other_platform_accounts.map((o) => o.platform);
    assert.ok(platforms.includes('微信视频号'));
    assert.ok(platforms.includes('快手'));
  });
});

describe('原文出处本地回填', () => {
  test('按值反查所在行，模型不必输出 s 字段', () => {
    const raw = '账号名称：示例达人甲\n合作码：30000000001\n联系方式：13800138000';
    const data = {
      creator_name: { v: '示例达人甲', c: 0.9 },
      accounts: [{ cooperation_code: { v: '30000000001', c: 0.9 } }],
      recipient: { phone: { v: '13800138000', c: 0.9 } },
    };
    locateSources(data, raw);
    assert.equal(data.creator_name.s, '账号名称：示例达人甲');
    assert.equal(data.accounts[0].cooperation_code.s, '合作码：30000000001');
    assert.equal(data.recipient.phone.s, '联系方式：13800138000');
  });

  test('找不到对应行时留空，不编造', () => {
    const data = { creator_name: { v: '不存在的值', c: 0.9 } };
    locateSources(data, '毫不相关的一行');
    assert.equal(data.creator_name.s, '');
  });
});

/* ================================================================ 隐私 */

describe('提交到版本库的文件不含真实个人信息', () => {
  /* 这里必须是「列出要跳过的」而不是「列出要查的」。
     写死清单的版本漏掉了 tests/rules.test.js，真实号码就是从那个缝里进来的 ——
     新加一个文件没人会想起来同步这份清单，默认查全部才是对的。 */
  const SKIP = /^(node_modules|\.git|data|\.worktrees)(\/|$)/;
  const files = [];
  (function walk(rel) {
    for (const e of readdirSync(join(ROOT, rel || '.'), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (SKIP.test(r)) continue;
      if (e.isDirectory()) walk(r);
      else if (/\.(js|json|html|css|md)$/.test(e.name)) files.push(r);
    }
  })('');

  test('无真实手机号（占位号 138001380xx 除外）', () => {
    for (const f of files) {
      const text = readFileSync(join(ROOT, f), 'utf8');
      const hits = (text.match(/1[3-9]\d{9}/g) || []).filter((p) => !/^13800138\d{3}$/.test(p));
      assert.deepEqual(hits, [], `${f} 含疑似真实手机号：${hits.join(', ')}`);
    }
  });

  test('无 API Key 形态的字符串', () => {
    for (const f of files) {
      const text = readFileSync(join(ROOT, f), 'utf8');
      const hits = text.match(/sk-[A-Za-z0-9]{20,}/g) || [];
      assert.deepEqual(hits, [], `${f} 含疑似 API Key`);
    }
  });

  test('.gitignore 挡住数据目录与环境变量', () => {
    const gi = readFileSync(join(ROOT, '.gitignore'), 'utf8');
    for (const rule of ['data/', '.env']) {
      assert.ok(gi.split('\n').some((l) => l.trim() === rule), `.gitignore 缺少规则：${rule}`);
    }
  });
});
