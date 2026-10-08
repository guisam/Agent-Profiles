// Inspection must not render parser messages: they can embed private source text.
// Other discovery consumers retain their existing detailed diagnostics by default.
export function discoveryError(error, metadataOnly = false) {
  if (!metadataOnly) return error.message;
  const code = ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'EISDIR', 'ELOOP', 'EINVAL', 'EIO', 'EMFILE', 'ENFILE'].includes(error.code) ? ` (${error.code})` : '';
  return `Cannot safely read metadata${code}; check permissions, path containment and file type, or repair malformed/incomplete frontmatter or source preferences`;
}
