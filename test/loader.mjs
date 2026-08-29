import { access } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
	if (specifier.startsWith('.') && !specifier.endsWith('.ts') && !specifier.endsWith('.js')) {
		const parentPath = context.parentURL ? dirname(fileURLToPath(context.parentURL)) : process.cwd();
		const candidate = resolvePath(parentPath, `${specifier}.ts`);
		try {
			await access(candidate);
			return nextResolve(pathToFileURL(candidate).href, context);
		} catch {
			// Let Node resolve the original specifier and report the normal error.
		}
	}
	return nextResolve(specifier, context);
}
