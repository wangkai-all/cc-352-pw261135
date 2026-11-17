// 演示场景种子：重置门户数据，并构造各类恢复/冲突/故障场景。
// 用法：node scripts/seed.mjs  （需要门户已启动）
const PORTAL = process.env.PORTAL_URL || 'http://127.0.0.1:4101';

async function post(pathname, body) {
  const res = await fetch(`${PORTAL}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${pathname} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function put(pathname, body) {
  const res = await fetch(`${PORTAL}${pathname}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${pathname} -> ${res.status}`);
  return res.json();
}

// 1) 重置门户，建立 7 条申报记录骨架（注意 0006 门户侧是 v1，待报数据是 v2 → 版本冲突场景）
await post('/api/admin/reset', {
  records: [
    { recordId: 'DECL-2026-0001', orgId: 'ORG-ALPHA', formVersion: 'v1' },
    { recordId: 'DECL-2026-0002', orgId: 'ORG-ALPHA', formVersion: 'v2' },
    { recordId: 'DECL-2026-0003', orgId: 'ORG-ALPHA', formVersion: 'v2' },
    { recordId: 'DECL-2026-0004', orgId: 'ORG-ALPHA', formVersion: 'v1' },
    { recordId: 'DECL-2026-0005', orgId: 'ORG-ALPHA', formVersion: 'v2' },
    { recordId: 'DECL-2026-0006', orgId: 'ORG-ALPHA', formVersion: 'v1' },
    { recordId: 'DECL-2026-0007', orgId: 'ORG-BETA', formVersion: 'v1' },
    { recordId: 'DECL-2026-0008', orgId: 'ORG-ALPHA', formVersion: 'v1' },
  ],
});
console.log('已重置门户并创建 8 条记录骨架');

// 2) 场景：0003 有“本程序账号”此前保存的旧草稿（Q2 旧数据）→ 应触发字段级续填
await post('/api/admin/seed-draft', {
  recordId: 'DECL-2026-0003',
  asUser: 'alpha',
  fields: {
    companyName: '阿尔法示例制造有限公司（虚构）',
    creditCode: 'DEMO-ALPHA-0001',
    contactPerson: '王示例',
    contactPhone: '13800000001',
    reportPeriod: '2026-Q2',
    revenue: '1400.0',
    taxPaid: '84.0',
    employees: '126',
    energyConsumption: '305.0',
    mainProduct: '示例零部件',
  },
});
console.log('已预置 0003 的旧草稿（alpha 本人保存）→ 预期：字段级续填');

// 3) 场景：0004 的草稿被“同事账号 alpha2”改过 → 应触发冲突，不覆盖不提交
await post('/api/admin/seed-draft', {
  recordId: 'DECL-2026-0004',
  asUser: 'alpha2',
  fields: {
    companyName: '阿尔法示例制造有限公司（虚构）',
    creditCode: 'DEMO-ALPHA-0001',
    contactPerson: '李样例',
    contactPhone: '13899998888',
    reportPeriod: '2026-Q3',
    revenue: '888.8',
    taxPaid: '53.3',
  },
});
console.log('已预置 0004 的他人草稿（alpha2 保存）→ 预期：冲突，转人工核验');

// 4) 场景：0005 提交时门户“丢失响应” → 自动程序应经状态查询恢复回执，不重复提交
await put('/api/chaos', { dropSubmitForRecords: ['DECL-2026-0005'], failDraftSaveForRecords: [] });
console.log('已对 0005 注入故障：提交后丢弃响应 → 预期：恢复回执且不重复提交');

// 5) 场景：0008 的草稿与待报数据完全一致（本程序账号所存）→ 应直接提交，无需填写
await post('/api/admin/seed-draft', {
  recordId: 'DECL-2026-0008',
  asUser: 'alpha',
  fields: {
    companyName: '阿尔法示例制造有限公司（虚构）',
    creditCode: 'DEMO-ALPHA-0001',
    contactPerson: '王示例',
    contactPhone: '13800000001',
    reportPeriod: '2026-Q3',
    revenue: '2010.4',
    taxPaid: '120.6',
  },
});
console.log('已预置 0008 的一致草稿（与待报数据相同）→ 预期：草稿一致，直接提交');

console.log('种子数据完成。运行 npm run automate 开始自动填报。');
