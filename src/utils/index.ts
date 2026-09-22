import fs from "node:fs";
import path from "node:path";

export const readAllFiles = (
  dirName: string,
  fileNames: string[],
  filter?: (fileName: string) => boolean
) => {
  fs.readdirSync(dirName, { withFileTypes: true }).forEach((dir) => {
    if (dir.isDirectory()) {
      readAllFiles(path.join(dirName, dir.name), fileNames, filter);
    } else if (!filter || filter(dir.name)) {
      fileNames.push(path.join(dirName, dir.name));
    }
  });
};

/** Asynchronous traversal; symlink directories are not followed. */
export const readAllFilesAsync = async (
  dirName: string, filter?: (fileName: string) => boolean,
): Promise<string[]> => {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if ((!filter || filter(entry.name)) && (entry.isFile() || entry.isSymbolicLink())) files.push(fullPath);
    }
  };
  await visit(dirName);
  return files.sort((a, b) => {
    const left = path.relative(dirName, a).split(path.sep).join("/");
    const right = path.relative(dirName, b).split(path.sep).join("/");
    return left < right ? -1 : left > right ? 1 : 0;
  });
};
