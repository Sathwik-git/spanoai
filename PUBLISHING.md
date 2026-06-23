# Publishing & Launch

How to publish the packages (`@spanoai/sdk`, `@spanoai/mcp` → npm; `spanoai` →
PyPI) and take the product live. For running/hosting the engine itself, see
[DEPLOYMENT.md](./DEPLOYMENT.md).

## One-time prerequisites

- **npm:** an npm account, and the **`@spanoai` org/scope** created on npmjs.com
  (free for public packages). Run `npm login`.
- **PyPI:** a PyPI account + an **API token**. (Optionally a TestPyPI account to
  rehearse.)
- **Check the names are free:** `@spanoai/sdk`, `@spanoai/mcp` on npm; `spanoai`
  on PyPI. If `spanoai` is taken on PyPI, rename in `packages/sdk-python/pyproject.toml`.

## npm — `@spanoai/sdk` then `@spanoai/mcp`

> Use **`bun publish`**, not `npm publish`: bun rewrites the `workspace:*`
> dependency (`@spanoai/mcp` → `@spanoai/sdk`) to the real version. `npm publish`
> would ship `workspace:*` literally and break installs. (Verified: the packed
> manifest shows `"@spanoai/sdk": "0.1.0"`.)

Order matters — the SDK must be published first, because the MCP server depends
on it.

```bash
# from the repo root
bun install
bun run build                       # turbo builds every package

# 1) SDK first
cd packages/sdk-typescript
bun publish --access public         # prepublishOnly rebuilds; ships dist + src + types

# 2) MCP server (workspace dep is rewritten to the published SDK version)
cd ../mcp
bun publish --access public
```

After this: `npm i @spanoai/sdk` and `npx @spanoai/mcp` work anywhere.
`publishConfig.access=public` and `prepublishOnly` are already set on both
packages, so the build runs automatically and scoped packages publish publicly.

## PyPI — `spanoai`

```bash
cd packages/sdk-python
python -m pip install --upgrade build twine
python -m build                     # → dist/spanoai-0.1.0-py3-none-any.whl + .tar.gz

# (optional) rehearse on TestPyPI
python -m twine upload --repository testpypi dist/*

# real upload — username: __token__   password: <your PyPI token>
python -m twine upload dist/*
```

After this: `pip install spanoai` works.

## Versioning

- Bump `version` in each `package.json` and in `pyproject.toml` before each
  release; keep them in lockstep where they share the API surface.
- Tag the release: `git tag v0.1.0 && git push --tags`.
- (Optional) adopt [`changesets`](https://github.com/changesets/changesets) for
  automated version bumps + changelogs across the npm packages.

## Launch checklist

1. **Deploy the engine** at a public HTTPS URL — see [DEPLOYMENT.md](./DEPLOYMENT.md).
2. **Publish** `@spanoai/sdk` + `@spanoai/mcp` (npm) and `spanoai` (PyPI) as above.
3. *(Optional)* deploy the **dashboard** (`apps/web`) and **docs** (`apps/docs`).
4. Update the README / docs with your hosted engine URL and the published
   install commands. The README's npm/PyPI badge links go live automatically.
5. Add a `CONTRIBUTING.md` if you want outside contributions (the repo is MIT).
