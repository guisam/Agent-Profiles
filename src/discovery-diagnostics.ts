// Inspection must not render parser messages: they can embed private source text.
// Other discovery consumers retain their existing detailed diagnostics by default.
import { errorCode, errorMessage } from "./files.ts";

export function discoveryError(error: unknown, metadataOnly = false): string {
	if (!metadataOnly) return errorMessage(error);
	const errno = errorCode(error);
	const code = [
		"EACCES",
		"EPERM",
		"ENOENT",
		"ENOTDIR",
		"EISDIR",
		"ELOOP",
		"EINVAL",
		"EIO",
		"EMFILE",
		"ENFILE",
	].includes(errno ?? "")
		? ` (${errno})`
		: "";
	return `Cannot safely read metadata${code}; check permissions, path containment and file type, or repair malformed/incomplete frontmatter or source preferences`;
}
