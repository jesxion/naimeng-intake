/**
 * 假的飞书多维表格服务端。
 *
 * 真实接口既要凭据又会改公司正在用的表，回归里不能碰。
 * 这个假服务实现了我们用到的那几个端点，并且**照抄了飞书的行为特征**：
 *   · 成功也返回 HTTP 200，靠 body 里的 code 判断成败
 *   · 权限问题返回 91403（真实场景里多半是「应用没被加进这张表」）
 *   · 字段类型不匹配返回 1254002
 *   · 记录不存在返回 1254005
 * 照抄这些是有意义的：我们的错误翻译和「记录被删就重建」的兜底逻辑
 * 全靠这些码来触发，用一个只会返回 500 的假服务是测不出来的。
 */
import { createServer } from 'node:http';

export function startFakeFeishu({ appId = 'cli_test', appSecret = 'secret_test' } = {}) {
  const state = {
    tables: [
      { table_id: 'tblSample', name: '达人寄样信息' },
      { table_id: 'tblOther', name: '其他表' },
    ],
    fields: [
      { field_id: 'f1', field_name: '系统ID', type: 1 },
      { field_id: 'f2', field_name: '达人名称', type: 1 },
      { field_id: 'f3', field_name: '抖音号', type: 1 },
      { field_id: 'f4', field_name: '合作状态', type: 1 },
      { field_id: 'f5', field_name: '寄样费用', type: 2 },
      { field_id: 'f6', field_name: '已告知达人', type: 7 },
      { field_id: 'f7', field_name: '建档时间', type: 5 },
      { field_id: 'f8', field_name: '快递单号', type: 1 },
    ],
    records: new Map(),      // record_id -> fields
    seq: 0,
    tokenIssued: 0,
    denyPermission: false,   // 模拟「应用没被加进这张表」
    calls: [],
  };

  const json = (res, body) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  const err = (res, code, msg) => json(res, { code, msg });

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const path = url.pathname;
      const body = raw ? JSON.parse(raw) : {};
      state.calls.push({ method: req.method, path });

      if (path === '/open-apis/auth/v3/tenant_access_token/internal') {
        if (body.app_id !== appId || body.app_secret !== appSecret) {
          return err(res, 99991663, 'app_id or app_secret error');
        }
        state.tokenIssued++;
        return json(res, { code: 0, msg: 'ok', tenant_access_token: 't-fake-' + state.tokenIssued, expire: 7200 });
      }

      if (!String(req.headers.authorization || '').startsWith('Bearer t-fake-')) {
        return err(res, 99991661, 'invalid token');
      }
      if (state.denyPermission) return err(res, 91403, 'Forbidden');

      const m = path.match(/^\/open-apis\/bitable\/v1\/apps\/([^/]+)\/tables(?:\/([^/]+))?(?:\/(fields|records))?(?:\/([^/]+))?$/);
      if (!m) return err(res, 1254000, 'unknown path: ' + path);
      const [, appToken, tableId, kind, tail] = m;

      if (appToken !== 'appTokenSample') return err(res, 91402, 'app not found');
      if (!tableId) {
        // 照抄飞书的分页：一次最多给 page_size 条，还有就给 page_token
        const size = Number(url.searchParams.get('page_size') || 20);
        const from = Number(url.searchParams.get('page_token') || 0);
        const slice = state.tables.slice(from, from + size);
        const next = from + size;
        return json(res, { code: 0, data: {
          items: slice,
          has_more: next < state.tables.length,
          page_token: next < state.tables.length ? String(next) : undefined,
        } });
      }
      if (!state.tables.some((t) => t.table_id === tableId)) return err(res, 91402, 'table not found');

      if (kind === 'fields') {
        if (req.method === 'POST') {
          if (state.fields.some((f) => f.field_name === body.field_name)) {
            return err(res, 1254001, 'field name already exists');
          }
          const f = {
            field_id: 'f' + (state.fields.length + 1),
            field_name: body.field_name,
            type: body.type || 1,
          };
          state.fields.push(f);
          return json(res, { code: 0, data: { field: f } });
        }
        return json(res, { code: 0, data: { items: state.fields } });
      }

      if (kind === 'records') {
        const typeOf = (name) => state.fields.find((f) => f.field_name === name)?.type;
        const validate = (fields) => {
          for (const [name, v] of Object.entries(fields || {})) {
            const t = typeOf(name);
            if (t === undefined) return { code: 1254045, msg: `field not found: ${name}` };
            if (t === 2 && typeof v !== 'number') return { code: 1254002, msg: `${name} expects number` };
            if (t === 7 && typeof v !== 'boolean') return { code: 1254002, msg: `${name} expects checkbox` };
            if (t === 5 && typeof v !== 'number') return { code: 1254002, msg: `${name} expects timestamp` };
            if (t === 1 && typeof v !== 'string') return { code: 1254002, msg: `${name} expects text` };
          }
          return null;
        };

        if (tail === 'search' && req.method === 'POST') {
          const cond = body.filter?.conditions?.[0];
          const hit = [...state.records.entries()].find(([, f]) =>
            cond && String(f[cond.field_name] ?? '') === String(cond.value?.[0] ?? ''));
          return json(res, { code: 0, data: { items: hit ? [{ record_id: hit[0], fields: hit[1] }] : [] } });
        }

        if (!tail && req.method === 'POST') {
          const bad = validate(body.fields);
          if (bad) return err(res, bad.code, bad.msg);
          const id = 'rec' + (++state.seq);
          state.records.set(id, { ...body.fields });
          return json(res, { code: 0, data: { record: { record_id: id, fields: body.fields } } });
        }

        if (tail && req.method === 'PUT') {
          if (!state.records.has(tail)) return err(res, 1254005, 'record not found');
          const bad = validate(body.fields);
          if (bad) return err(res, bad.code, bad.msg);
          state.records.set(tail, { ...state.records.get(tail), ...body.fields });
          return json(res, { code: 0, data: { record: { record_id: tail, fields: body.fields } } });
        }
      }
      return err(res, 1254000, 'unhandled');
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        state,
        port: server.address().port,
        origin: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
