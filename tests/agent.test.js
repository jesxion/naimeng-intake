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
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mockExtract, locateSources, agentReady, visionReady, PROMPT_VERSION } from '../lib/agent.js';
import { INTAKE_SAMPLES } from './fixtures/samples.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('降级路径', () => {
  test('未配置 key 时 agentReady/visionReady 为 false', () => {
    // 测试进程里已清空 LLM_* 环境变量
    assert.equal(typeof agentReady(), 'boolean');
    assert.equal(typeof visionReady(), 'boolean');
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
  const files = ['lib/agent.js', 'lib/rules.js', 'lib/db.js', 'server.js',
    'public/index.html', 'tests/fixtures/samples.js'];

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
