/**
 * 「系统表」的列定义 —— 这是唯一的真相来源。
 *
 * ── 为什么要有一张系统表 ────────────────────────────────────────
 * 团队现用的那张表（达人寄样信息）是给人看的：列名按团队习惯起、
 * 有多选列、有人工维护的运营字段、还有自动化在写的物流列。
 * 直接往那张表推，我们就得迁就它的一切，还随时可能和人或自动化打架。
 *
 * 改成：我们只写自己的「系统表」，列全由我们定；团队表通过
 * **关联 + 查找引用**去引系统表的值。引用是实时的，不消耗自动化配额，
 * 也不会因为自动化失败而两边不一致。
 *
 * 边界因此很清楚：**系统表归程序，团队表归人。** 我们不碰团队表一个字。
 *
 * ── 粒度 ────────────────────────────────────────────────────────
 * 一行 = 一条合作 × 一款产品，和团队表的「一次寄样」对齐。
 * 这样关联是 1:1，自动化只需要「新增时建一条并关联」，
 * 不用做 1→N 展开 —— 那是自动化最不擅长的事。
 *
 * ── 类型只用四种 ────────────────────────────────────────────────
 * 多行文本(1) / 数字(2) / 日期(5) / 复选框(7)。
 * 刻意不用单选和多选：它们要求写入的值必须已存在于选项里，
 * 否则报 1254043。每上一个新品就得记得去飞书加选项，忘了就同步失败 ——
 * 这种「平时没事、关键时刻炸」的依赖不值得为了好看而引入。
 * 团队表想要彩色标签，在它自己那边用单选列 + 自动化转换即可。
 */

/** 飞书字段类型 */
const TEXT = 1, NUMBER = 2, DATE = 5, CHECKBOX = 7;

/**
 * 列定义。`from` 对应 sync.js 里的取值函数 id。
 *
 * 顺序有意义：飞书的第一列是索引列，不能删，且是关联引用时显示的内容。
 * 放系统ID 是因为这张表是给机器看的，唯一性比可读性重要 ——
 * 人看的是团队表，那边显示的是查找引用列。
 */
export const SYSTEM_TABLE = [
  /* ── 身份 ── */
  { col: '系统ID', type: TEXT, from: 'systemId', required: true,
    note: '合作ID#产品行ID。判断新建还是更新全靠它，必须唯一。\n'
         + '        取值 id 沿用 systemId —— 改名会让已保存的映射失效，'
         + '这一列的语义也确实就是「系统ID」' },
  { col: '合作ID', type: TEXT, from: 'collaborationId',
    note: '同一条合作的多款产品共享它，团队表想按合作聚合时用得上' },

  /* ── 达人与账号 ── */
  { col: '达人名称', type: TEXT, from: 'creatorName' },
  { col: '抖音昵称', type: TEXT, from: 'accountNickname',
    note: '账号昵称。矩阵号时和达人名称不一样，多账号用「、」连' },
  { col: '抖音号', type: TEXT, from: 'douyinIds' },
  { col: 'UID', type: TEXT, from: 'uids' },
  { col: '合作码', type: TEXT, from: 'cooperationCodes',
    note: '必须是文本 —— 星图合作码可能有前导零，数字列会把它吃掉' },

  /* ── 合作 ── */
  { col: '合作类型', type: TEXT, from: 'type', note: '寄样合作 / 直播定向' },
  { col: '合作状态', type: TEXT, from: 'status', note: '待寄样 / 已寄样 / 已完成 / 已终止' },
  { col: '是否寄样', type: TEXT, from: 'shipped',
    note: '有产品行就是「是」。问的是这条记录是不是一次寄样，\n'
         + '        不是「有没有发出去」—— 发没发看合作状态和快递单号' },
  { col: '带货方式', type: TEXT, from: 'salesChannel' },

  /* ── 产品（本行）── */
  { col: '产品名称', type: TEXT, from: 'itemProduct', note: '本行那一款' },
  { col: '数量', type: NUMBER, from: 'itemQuantity' },
  { col: '寄样费用', type: NUMBER, from: 'sampleCostFirst',
    note: '费用是整条合作的，拆成多行后只写第一行，其余留空 —— 否则求和会翻倍' },

  /* ── 收件 ── */
  { col: '收件人', type: TEXT, from: 'recipientName' },
  { col: '收件电话', type: TEXT, from: 'recipientPhone' },
  { col: '收件地址', type: TEXT, from: 'recipientAddress' },
  { col: '配送备注', type: TEXT, from: 'deliveryNote' },
  { col: '收件信息', type: TEXT, from: 'recipientFull',
    note: '姓名+电话+地址拼成一段。团队表的「地址」列就是这个形态，直接引用即可' },

  /* ── 物流 ── */
  { col: '快递公司', type: TEXT, from: 'carriers' },
  { col: '快递单号', type: TEXT, from: 'trackingNos', note: '多包裹用「、」连' },
  { col: '已告知达人', type: CHECKBOX, from: 'notified' },

  /* ── 出片 ── */
  { col: '拍摄进度', type: TEXT, from: 'filmingProgress',
    note: '待拍摄 / 已催拍 / 已发布 / 本次不出片' },
  { col: '视频链接', type: TEXT, from: 'videoUrls', note: '多条换行' },

  /* ── 元信息 ── */
  { col: '归属商务', type: TEXT, from: 'ownerName' },
  { col: '建档时间', type: DATE, from: 'createdAt' },
  { col: '更新时间', type: DATE, from: 'updatedAt' },
  { col: '同步时间', type: DATE, from: 'syncedAt',
    note: '这一行最后一次被推送的时间。同步是不是还在跑，看这一列最直接' },
];

/** 索引列（第一列）。飞书不允许删除它，建表时要单独处理 */
export const INDEX_COL = SYSTEM_TABLE[0].col;

export const REQUIRED_COLS = SYSTEM_TABLE.filter((f) => f.required).map((f) => f.col);
