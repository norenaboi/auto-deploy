import fs from "fs";
import dotenv from "dotenv";

const envFile = fs.existsSync(".env") ? fs.readFileSync(".env") : Buffer.alloc(0);
export const env = dotenv.parse(envFile);
