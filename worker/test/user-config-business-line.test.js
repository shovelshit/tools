import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrateUserConfigBusinessLine } from "../scripts/migrate-user-config-business-line.mjs";

test("配置迁移保留旧行与版本，并允许同一管理员分别保存两条业务配置", () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE users(id TEXT PRIMARY KEY,state TEXT NOT NULL);
    INSERT INTO users VALUES ('admin','active');
    CREATE TABLE user_config(token_id TEXT PRIMARY KEY,data TEXT NOT NULL,updated_at TEXT NOT NULL,version INTEGER NOT NULL);
    INSERT INTO user_config VALUES ('admin','{"cinemaId":"101"}','old',7);
    CREATE TRIGGER runtime_guard_user_config_insert BEFORE INSERT ON user_config
      WHEN EXISTS (SELECT 1 FROM users WHERE id=NEW.token_id AND state='revoked')
      BEGIN SELECT RAISE(ABORT, 'ACCOUNT_REVOKED'); END;
  `);
  assert.equal(migrateUserConfigBusinessLine(sqlite).applied, true);
  assert.equal(migrateUserConfigBusinessLine(sqlite).applied, false);
  sqlite.prepare("INSERT INTO user_config(token_id,business_line,data,updated_at) VALUES ('admin','store','{}','new')").run();
  const rows = sqlite.prepare("SELECT business_line,data,version FROM user_config WHERE token_id='admin' ORDER BY business_line").all().map((row) => ({ ...row }));
  assert.deepEqual(rows, [
    { business_line: "maoyan", data: '{"cinemaId":"101"}', version: 7 },
    { business_line: "store", data: "{}", version: 1 }
  ]);
  sqlite.prepare("UPDATE users SET state='revoked' WHERE id='admin'").run();
  assert.throws(() => sqlite.prepare("INSERT INTO user_config(token_id,business_line,data,updated_at) VALUES ('admin','store','{}','again')").run(), /ACCOUNT_REVOKED/);
});
