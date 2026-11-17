import crypto from 'node:crypto';

// 内容指纹：只取表单定义内的字段、按键名排序后序列化，再取 SHA-256。
// 门户、自动填写程序、核对服务三方用同一算法比对“内容是否一致”。
export function canonicalize(fields, keys) {
  const obj = {};
  for (const k of [...keys].sort()) {
    const v = fields?.[k];
    obj[k] = v === undefined || v === null ? '' : String(v);
  }
  return JSON.stringify(obj);
}

export function contentHash(fields, keys) {
  return crypto.createHash('sha256').update(canonicalize(fields, keys)).digest('hex');
}
