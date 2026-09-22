import mysql, { type ExecuteValues, type QueryValues, type Pool, type PoolConnection, type RowDataPacket, type ResultSetHeader } from "mysql2/promise";
import { defaultConfigStore, validateDatabaseConfig, type DatabaseConfig } from "../config/index.js";
import { waitForShutdown, validateShutdownOptions, type ShutdownOptions } from "../shutdown.js";
import { MySqlException } from "../exceptions/index.js";

export const createDatabase = (config: DatabaseConfig | (() => Readonly<DatabaseConfig>)) => {
  const resolveConfig = typeof config === "function" ? config : (() => {
    const snapshot = validateDatabaseConfig(config);
    return () => snapshot;
  })();
  let pool: Pool | undefined;
  let poolConfig: Readonly<DatabaseConfig> | undefined;
  let closing: Promise<void> | undefined;

  const getPool = (): Pool => {
    if (closing) throw new Error("The database pool is closing.");
    const db = resolveConfig();
    const changed = poolConfig && (
      poolConfig.host !== db.host || poolConfig.port !== db.port || poolConfig.user !== db.user
      || poolConfig.password !== db.password || poolConfig.database !== db.database
      || (poolConfig.connectionLimit ?? 10) !== (db.connectionLimit ?? 10)
    );
    if (pool && changed) {
      throw new Error("Call closeDatabase() before using changed database configuration.");
    }
    if (!pool) {
      pool = mysql.createPool({ ...db, connectionLimit: db.connectionLimit ?? 10, waitForConnections: true });
      poolConfig = db;
    }
    return pool;
  };

  /** Opens a dedicated connection. The caller must call end() when finished. */
  const connection = async () => {
    const { connectionLimit: _limit, ...db } = resolveConfig();
    try { return await mysql.createConnection(db); }
    catch (error) { throw new MySqlException(error); }
  };

  const closeDatabase = (options?: ShutdownOptions): Promise<void> => {
    if (options) validateShutdownOptions(options);
    if (closing) return options ? waitForShutdown(closing, options) : closing;
    if (!pool) return Promise.resolve();
    closing = pool.end().finally(() => {
      pool = undefined;
      poolConfig = undefined;
      closing = undefined;
    });
    return options ? waitForShutdown(closing, options) : closing;
  };

  const executeRows = async <T extends RowDataPacket[] | ResultSetHeader>(sql: string, values: ExecuteValues = []): Promise<T> => {
    const database = getPool();
    try {
      const [rows] = await database.execute<T>(sql, values);
      return rows;
    } catch (error) { throw new MySqlException(error); }
  };

  /** @deprecated Use getAllAsync for parameterized SELECT statements. */
  const query = async (sql: string, values?: QueryValues) => {
    const database = getPool();
    try {
      const [rows] = await database.query<RowDataPacket[]>(sql, values);
      return rows;
    } catch (error) { throw new MySqlException(error); }
  };

  /** @deprecated Use runAsync for INSERT, UPDATE, and DELETE statements. */
  const execute = (sql: string, values: ExecuteValues = []) => runAsync(sql, values);

  const getFirstAsync = async <T extends RowDataPacket = RowDataPacket>(sql: string, values: ExecuteValues = []): Promise<T | null> => {
    const rows = await getAllAsync<T>(sql, values);
    return rows[0] ?? null;
  };

  const getAllAsync = <T extends RowDataPacket = RowDataPacket>(sql: string, values: ExecuteValues = []): Promise<T[]> =>
    executeRows<T[]>(sql, values);

  const runAsync = (sql: string, values: ExecuteValues = []): Promise<ResultSetHeader> =>
    executeRows<ResultSetHeader>(sql, values);

  /** All transaction statements must use the supplied connection. */
  const withTransaction = async <T>(work: (connection: PoolConnection) => Promise<T>): Promise<T> => {
    const database = getPool();
    let conn: PoolConnection;
    try { conn = await database.getConnection(); }
    catch (error) { throw new MySqlException(error); }
    let begun = false;
    let reusable = true;
    try {
      await conn.beginTransaction();
      begun = true;
      const result = await work(conn);
      await conn.commit();
      return result;
    } catch (error) {
      if (begun) {
        try { await conn.rollback(); }
        catch (rollbackError) {
          reusable = false;
          throw new AggregateError([error, rollbackError], "Transaction failed and rollback also failed.");
        }
      } else {
        reusable = false;
      }
      throw error;
    } finally {
      if (reusable) conn.release();
      else conn.destroy();
    }
  };

  return { connection, closeDatabase, query, execute, getFirstAsync, getAllAsync, runAsync, withTransaction };
};
export type Database = ReturnType<typeof createDatabase>;
export const defaultDatabase = createDatabase(defaultConfigStore.database);
export const { connection, closeDatabase, query, execute, getFirstAsync, getAllAsync, runAsync, withTransaction } = defaultDatabase;
