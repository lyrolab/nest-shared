import { existsSync } from "fs"
import { dirname, join } from "path"

export function findMainPath() {
  const rootPath = findUp("package.json", process.cwd())
  if (!rootPath) throw new Error("package.json not found")
  return rootPath
}

function findUp(path: string, cwd: string) {
  const currentPath = cwd
  const parentPath = dirname(currentPath)
  if (parentPath === currentPath) {
    return null
  }

  if (existsSync(join(currentPath, path))) {
    return currentPath
  }

  return findUp(path, parentPath)
}
