import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });
copyFileSync("iran-freight-atlas-v3.html", "dist/index.html");
console.log("built dist/index.html");
