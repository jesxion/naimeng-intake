/**
 * 发货截图存档。
 *
 * 存的是**文件**不是库：一张 base64 后 0.5～3MB，而启动时会把整个
 * naimeng.db 备份并保留 7 份 —— 图片进库等于这些体积乘以 7。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DIR = mkdtempSync(join(tmpdir(), 'naimeng-shots-'));
process.env.NAIMENG_DATA_DIR = DIR;

let shots;
const PNG = 'data:image/png;base64,'
  + 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

before(async () => { shots = await import('../lib/shots.js'); });
after(() => { try { rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ } });

/* ================================================================ */

describe('存与读', () => {
  test('存下来能读回来，类型对', () => {
    const id = shots.save(PNG);
    assert.match(id, /^sh-/);
    const got = shots.read(id);
    assert.equal(got.mime, 'image/png');
    assert.ok(got.bytes > 0);
  });

  test('落到 data/shots/ 下，不进数据库', () => {
    /* 备份保留 7 份 naimeng.db，图片进库就是 7 倍体积，
       而备份的价值在达人资料和合作记录，不在几个月前的一张快递截图。 */
    assert.ok(existsSync(join(DIR, 'shots')));
    assert.ok(readdirSync(join(DIR, 'shots')).some((f) => f.startsWith('sh-')));
  });

  test('不认识的格式返回 null，不抛 —— 存档失败不能挡住识别', () => {
    assert.equal(shots.save('not-a-data-url'), null);
    assert.equal(shots.save(''), null);
    assert.equal(shots.save(null), null);
    assert.doesNotThrow(() => shots.save({ weird: true }));
  });

  test('读不存在的返回 null，不抛', () => {
    assert.equal(shots.read('sh-zzzz-9999'), null);
    assert.equal(shots.read(''), null);
  });
});

/* ================================================================ */

describe('id 是路径的一部分，必须白名单', () => {
  test('路径穿越读不到任何东西', () => {
    /* id 会被拼进文件路径。用白名单而不是「过滤掉 ..」——
       过滤是黑名单思路，编码变体和平台差异总能绕过去。 */
    writeFileSync(join(DIR, 'secret.png'), 'topsecret');
    for (const evil of [
      '../secret', '..%2Fsecret', 'sh-../../secret',
      '/etc/passwd', 'sh-a-b/../../secret', 'sh-a-b ',
    ]) {
      assert.equal(shots.read(evil), null, `${evil} 没被挡住`);
    }
  });

  test('形状不对的 id 一律拒绝', () => {
    for (const bad of ['x-abc-def', 'sh-ABC-def', 'sh-abc', 'sh-abc-def-ghi']) {
      assert.equal(shots.read(bad), null, `${bad} 应该被拒`);
    }
  });

  test('只认我们自己发的 id —— 目录里别的文件也读不到', () => {
    /* 这条区分「白名单」和「过滤掉 ..」两种写法：
       后者对不含 .. 的名字完全放行，目录里任何文件都能被读出去。
       白名单要求 id 必须长成 sh-xxx-yyy，这类名字直接落空。 */
    const dir = join(DIR, 'shots');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'secret.png'), 'topsecret');
    assert.equal(shots.read('secret'), null, '非本系统生成的文件名被读出来了');
  });
});

/* ================================================================ */

describe('数量上限', () => {
  test('超过上限从最老的删起', () => {
    /* 仓库每天发一两张，不设上限的话几年后这个目录会很难看。
       文件名带时间戳，排序就是时间序 —— 清理不用 stat 每个文件。 */
    const dir = join(DIR, 'shots');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 12; i++) writeFileSync(join(dir, `sh-000${i}-aaaa.png`), 'x');
    const removed = shots.prune(5);
    assert.ok(removed > 0);
    const left = readdirSync(dir).filter((f) => f.startsWith('sh-')).sort();
    assert.equal(left.length, 5);
    // 留下的是最新的那几个：最老的 sh-0000 已经不在了
    assert.ok(!left.includes('sh-0000-aaaa.png'), '删的不是最老的');
  });

  test('没超上限时什么都不删', () => {
    assert.equal(shots.prune(999), 0);
  });

  test('统计可用', () => {
    const s = shots.stats();
    assert.ok(s.count >= 1);
    assert.ok(s.bytes >= 0);
  });
});
