# Skill library

The package store is also your local skill library (source version 0.8.0). One
folder on your machine (`~/.agent-profiles/store` by default) holds every version
you have published, content-addressed by SHA-256. Projects pin exact versions in
`agents.yaml` and lock them.

```sh
agent-profiles library publish ./skills/security-review
agent-profiles library list
agent-profiles library search security
agent-profiles library info @example/security-review --root /path/to/project
```

- **publish** imports a package directory, reading its name and version from
  `package.yaml`. It gives the same result as `add`.
- **list**, **search** and **info** are read-only and verify every version they
  show. **info** `--root` marks which versions a project pins and whether its lock
  agrees.

Details, the manifest format and limits are in
[docs/versioned-packages.md](https://github.com/guisam/Agent-Profiles/blob/main/docs/versioned-packages.md#library-browse-search-inspect-and-publish).
This is phase 2 of the [skill librarian](https://github.com/guisam/Agent-Profiles/issues/38);
see [#44](https://github.com/guisam/Agent-Profiles/issues/44).

[Return to the documentation home](https://github.com/guisam/Agent-Profiles/wiki).
