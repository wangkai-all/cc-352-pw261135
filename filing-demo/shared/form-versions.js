// 两个版本的申报表单定义（虚构）。
// 门户用它渲染页面，自动填写程序用它定位字段，双方对同一版本的理解保持一致。

const BASE_FIELDS = [
  { key: 'companyName', label: '企业名称', type: 'text', required: true },
  { key: 'creditCode', label: '统一社会信用代码', type: 'text', required: true },
  { key: 'contactPerson', label: '联系人', type: 'text', required: true },
  { key: 'contactPhone', label: '联系电话', type: 'text', required: true },
  {
    key: 'reportPeriod',
    label: '报告期',
    type: 'select',
    options: ['2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4'],
    required: true,
  },
  { key: 'revenue', label: '营业收入（万元）', type: 'number', required: true },
  { key: 'taxPaid', label: '已缴税额（万元）', type: 'number', required: true },
];

export const FORM_VERSIONS = {
  v1: {
    version: 'v1',
    title: '企业经营情况申报表（V1）',
    fields: BASE_FIELDS,
  },
  v2: {
    version: 'v2',
    title: '企业经营情况申报表（V2 · 增报用工与能耗）',
    fields: [
      ...BASE_FIELDS,
      { key: 'employees', label: '从业人员数（人）', type: 'number', required: true },
      { key: 'energyConsumption', label: '综合能耗（吨标准煤）', type: 'number', required: true },
      { key: 'mainProduct', label: '主要产品', type: 'text', required: false },
    ],
  },
};

export function formDef(version) {
  const def = FORM_VERSIONS[version];
  if (!def) throw new Error(`未知表单版本: ${version}`);
  return def;
}

export function fieldKeys(version) {
  return formDef(version).fields.map((f) => f.key);
}
