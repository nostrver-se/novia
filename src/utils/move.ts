import { copyFile, mkdir, rename, unlink } from "fs/promises";

export async function move(sourceFilePath: string, targetFilePath: string) {
  try {
    await rename(sourceFilePath, targetFilePath);
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === "EXDEV") {
      // Cross-device error, so copy and delete
      await copyFile(sourceFilePath, targetFilePath);
      await unlink(sourceFilePath);
    } else {
      // Rethrow other errors
      throw error;
    }
  }
}
