import fs from "node:fs";
import path from "node:path";

export class StateStore {
  constructor(directory, profile = "default") {
    if (!/^[a-zA-Z0-9_-]+$/.test(profile)) throw new Error("Profile may contain only letters, numbers, _ and -");
    this.directory = directory;
    this.file = path.join(directory, `${profile}.json`);
  }

  load() {
    if (!fs.existsSync(this.file)) return {};
    return JSON.parse(fs.readFileSync(this.file, "utf8"));
  }

  save(value) {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(this.file, 0o600);
  }

  update(patch) {
    const next = { ...this.load(), ...patch, updatedAt: new Date().toISOString() };
    this.save(next);
    return next;
  }
}
