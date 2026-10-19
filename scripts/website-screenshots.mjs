import { copyFile, lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

function isInside(root, path) {
  const part = relative(root, path);
  return !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`);
}

async function inspect(path, root) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new Error(`Screenshot links are not allowed: ${path}`);
  if (!stat.isDirectory() && !stat.isFile()) throw new Error(`Unsupported screenshot entry: ${path}`);
  if (!isInside(root, await realpath(path))) throw new Error(`Screenshot entry escapes its root: ${path}`);
  return stat;
}

async function directoryRoot(path) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Expected an ordinary screenshot directory: ${path}`);
  return realpath(path);
}

/**
 * Copy only WebP assets, preserving relative paths and rejecting filesystem links.
 * `include` optionally limits publication to these relative paths (the whole tree is still validated).
 */
export async function copyWebsiteScreenshots(source, destination, { include } = {}) {
  const sourcePath = resolve(source);
  const sourceRoot = await directoryRoot(sourcePath);
  const files = [];
  async function visit(directory, publish = true) {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const stat = await inspect(path, sourceRoot);
      if (stat.isDirectory()) await visit(path, publish && name.toLowerCase() !== 'helpers');
      else if (publish && name.endsWith('.webp')) files.push(path);
    }
  }
  // Validate the whole source tree, including ignored entries, before copying.
  await visit(sourcePath);
  if (include) {
    const wanted = new Set(include);
    const kept = files.filter(file => wanted.has(relative(sourcePath, file).split(sep).join('/')));
    const missing = [...wanted].filter(name => !kept.some(file => relative(sourcePath, file).split(sep).join('/') === name));
    if (missing.length) throw new Error(`Missing published screenshot: ${missing.join(', ')}`);
    files.splice(0, files.length, ...kept);
  }

  const destinationPath = resolve(destination);
  const existing = await lstat(destinationPath).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) {
    throw new Error(`Expected an ordinary screenshot directory: ${destinationPath}`);
  }
  await mkdir(destinationPath, { recursive: true });
  const destinationRoot = await directoryRoot(destinationPath);
  for (const sourceFile of files) {
    const target = join(destinationPath, relative(sourcePath, sourceFile));
    const parent = dirname(target);
    let current = destinationPath;
    for (const part of relative(destinationPath, parent).split(sep).filter(Boolean)) {
      current = join(current, part);
      await mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error; });
      if (!(await inspect(current, destinationRoot)).isDirectory()) {
        throw new Error(`Expected an ordinary screenshot directory: ${current}`);
      }
    }
    const targetStat = await lstat(target).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (targetStat && !(await inspect(target, destinationRoot)).isFile()) {
      throw new Error(`Expected an ordinary screenshot file: ${target}`);
    }
    if (!(await inspect(sourceFile, sourceRoot)).isFile()) {
      throw new Error(`Expected an ordinary screenshot file: ${sourceFile}`);
    }
    await copyFile(sourceFile, target);
  }
  return files.length;
}
