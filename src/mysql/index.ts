import * as mysql from "mysql2/promise";
import config from "../config";
import { MySqlException } from "../exceptions";
import { logger } from "../utils/Logger";

export const connection = async () => {
    try {
        return await mysql.createConnection(config.db);
    } catch (error) {
        logger.error(error);
        throw new MySqlException(error);
    }
};

export const query = async (sql: string, values: any) => {
    const conn = await connection();
    try {
        const [rows, fields] = await conn.query<mysql.RowDataPacket[]>(
            sql,
            values
        );
        return rows;
    } catch (error) {
        logger.error(error);
        throw new MySqlException(error);
    } finally {
        await conn.end();
    }
};

export const execute = async (sql: string, values: any) => {
    const conn = await connection();
    try {
        const [rows, fields] = await conn.execute<mysql.OkPacket>(sql, values);
        return rows;
    } catch (error) {
        logger.error(error);
        throw new MySqlException(error);
    } finally {
        await conn.end();
    }
};
