import fs from 'node:fs';
import path from 'node:path';

// 极简 JSON 文件存储（演示用）。写操作同步落盘，重启后状态保留。
export class Store {
  constructor(file, init) {
    this.file = file;
    if (fs.existsSync(file)) {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } else {
      this.data = init();
      this.save();
    }
  }

  get d() {
    return this.data;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  reset(next) {
    this.data = next;
    this.save();
  }
}
