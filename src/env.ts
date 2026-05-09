import { join } from "path";
import dotenv from "dotenv";
import { PACKAGE_ROOT } from "./paths.js";

dotenv.config({ path: join(PACKAGE_ROOT, ".env"), quiet: true });
