// Keep existing money and receipts; only extend the wallet range for measured
// postpaid bills. Legacy reserved calls retain their original capped settlement.
export function migratePostpaidWallet(database) {
  if (database.prepare("SELECT value FROM platform_settings WHERE key='postpaid_wallet_v1'").get()) return;
  database.exec(database.kind === 'postgres' ? 'BEGIN' : 'BEGIN IMMEDIATE');
  try {
    if (database.kind === 'postgres') {
      database.exec(`ALTER TABLE platform_wallets DROP CONSTRAINT IF EXISTS platform_wallets_balance_micros_check;
        ALTER TABLE platform_wallets ADD CONSTRAINT platform_wallets_balance_micros_check
        CHECK(balance_micros BETWEEN -9000000000000000 AND 9000000000000000);`);
    } else {
      database.exec(`CREATE TABLE platform_wallets_postpaid(user_id TEXT PRIMARY KEY REFERENCES users(id),
        balance_micros INTEGER NOT NULL CHECK(balance_micros BETWEEN -9000000000000000 AND 9000000000000000));
        INSERT INTO platform_wallets_postpaid SELECT user_id,balance_micros FROM platform_wallets;
        DROP TABLE platform_wallets;
        ALTER TABLE platform_wallets_postpaid RENAME TO platform_wallets;`);
    }
    if (!database.prepare('PRAGMA table_info(platform_calls)').all().some(column => column.name === 'billing_mode')) {
      database.exec("ALTER TABLE platform_calls ADD COLUMN billing_mode TEXT NOT NULL DEFAULT 'prepaid' CHECK(billing_mode IN ('prepaid','postpaid'))");
    }
    database.prepare("INSERT INTO platform_settings(key,value) VALUES('postpaid_wallet_v1','1')").run();
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
}
