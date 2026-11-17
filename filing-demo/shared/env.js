import fs from 'node:fs';
import path from 'node:path';

// 极简 .env 加载（演示用，不引入第三方依赖）：已存在的环境变量优先。
export function loadEnv(rootDir) {
  const file = path.join(rootDir, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
