# OpenCode Machina 🤖

OpenCode Machina is a production-grade OpenCode plugin built on oh-my-opencode, delivering comprehensive capabilities with a custom neon-mint themed interface.

## Overview

Machina combines the power of oh-my-opencode's multi-agent framework with a comprehensive feature set, featuring:

- **🤖 Multi-Agent Architecture**: Built on oh-my-opencode for collaborative agent workflows
- **🚀 Full-Stack Terminal Control**: Complete system-level permissions and capabilities
- **🎨 Custom UI**: Neon mint themed dark/light mode interface with custom web UI
- **📦 Production Ready**: Comprehensive release governance with stable and beta channels
- **🔌 OpenCode Integration**: Seamless plugin experience within the OpenCode ecosystem

## Installation

### Prerequisites

- **Bun** 1.0 or later: [Install Bun](https://bun.sh/)
- **OpenCode** with oh-my-opencode plugin installed
- **Git** for version management

### From Git Repository

```bash
# Clone the repository
git clone https://github.com/code-yeongyu/open-machina.git
cd open-machina

# Install dependencies
bun install

# Build all packages
bun run build

# Use CLI locally
bun run cli --help
```

### From npm (global)

```bash
npm install -g open-machina
open-machina --help
```

### From bunx

```bash
bunx open-machina --help
bunx open-machina install
```

### Integration with OpenCode (Correct Plugin Loading)

`open-machina` does **not** get loaded by `oh-my-opencode` directly.

OpenCode itself loads plugins from `opencode.json` (`plugin: string[]`), then initializes each plugin module.
So you should configure OpenCode to load **both**:

1. `oh-my-opencode` (agent/tool framework)
2. `open-machina-plugin` (Machina orchestration layer)

Example `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "oh-my-opencode",
    "file:///ABSOLUTE_PATH_TO/open-machina/packages/open-machina-plugin/dist/index.js"
  ]
}
```

If `open-machina-plugin` is published to npm, you can use package form instead of file URL:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "oh-my-opencode",
    "open-machina-plugin"
  ]
}
```

Then start OpenCode normally and run:

```bash
open-machina --help
open-machina install
```

### Judge Model Auth (OpenCode Auth Flow)

`open-machina-plugin` reads judge credentials from OpenCode auth storage, not from a hardcoded key in plugin code.

1. Log in with a dedicated judge provider id:

```bash
opencode auth login
# choose "Other"
# provider id: open-machina-judge
# enter API key
```

2. Configure judge target model in your environment:

```bash
export MACHINA_JUDGE_PROVIDER=openai
export MACHINA_JUDGE_MODEL=gpt-4o-mini
```

Optional overrides:

- `MACHINA_JUDGE_AUTH_PROVIDER` (default: `open-machina-judge`)
- `MACHINA_JUDGE_API_URL` (default inferred for `openai`, `openrouter`, `xai`)
- `MACHINA_JUDGE_ALLOW_MODELS` (comma list: `provider/model`)
- `MACHINA_JUDGE_DENY_MODELS` (comma list: `provider/model`)
- `MACHINA_JUDGE_FALLBACK_MODELS` (comma list: `provider/model`, tried in order)

Policy example:

```bash
export MACHINA_JUDGE_PROVIDER=openai
export MACHINA_JUDGE_MODEL=gpt-4o-mini
export MACHINA_JUDGE_DENY_MODELS=openai/gpt-4o-mini
export MACHINA_JUDGE_FALLBACK_MODELS=openai/gpt-4.1-mini,openrouter/gpt-4.1-mini
```

With this policy, the primary model is blocked and Machina automatically falls back to the first valid candidate.

If you already keep provider credentials under a provider id such as `openai`, set:

```bash
export MACHINA_JUDGE_AUTH_PROVIDER=openai
```

`open-machina-plugin` validates that `MACHINA_JUDGE_PROVIDER/MACHINA_JUDGE_MODEL` exists in OpenCode provider metadata when available.

### Verify Installation

```bash
# Check that all packages build correctly
bun run build

# Verify types
bun run typecheck

# Run tests
bun test
```

## Usage

### CLI Commands

Open Machina provides a unified CLI interface through `open-machina`:

```bash
# Main entry point
open-machina

# View help and available commands
open-machina --help
```

### Build Scripts

The project uses a monorepo structure with multiple packages:

```bash
# Build all packages
bun run build

# Type check all packages
bun run typecheck

# Run all tests
bun test

# Individual package builds (if needed)
bun --cwd=packages/open-machina-shared run build
bun --cwd=packages/open-machina-plugin run build
bun --cwd=packages/open-machina-cli run build
```

### Web Interface

Machina includes a local web UI with:

- **Dark mode** (default) with neon mint accents
- **Light mode** toggle support
- Real-time agent activity monitoring
- Terminal integration and output streaming

Access the web UI by starting the OpenCode extension and navigating to the Machina panel.

## Development

### Project Structure

```
open-machina/
├── packages/
│   ├── open-machina-shared/    # Shared utilities and types
│   ├── open-machina-plugin/    # OpenCode plugin integration
│   ├── open-machina-cli/       # Command-line interface
│   └── open-machina-web/       # Local web UI host
├── config/                # Configuration files
├── script/                # Build and utility scripts
├── package.json           # Root package manifest
└── tsconfig.json          # TypeScript configuration
```

### Development Workflow

```bash
# Install dependencies
bun install

# Watch mode for development (if configured)
bun run dev

# Type check during development
bun run typecheck

# Run specific test suites
bun test packages/open-machina-shared
```

## Versioning

Machina follows [Semantic Versioning](https://semver.org/):

- **MAJOR**: Incompatible API changes
- **MINOR**: Backwards-compatible functionality additions
- **PATCH**: Backwards-compatible bug fixes

### Release Channels

| Channel | Branch | Stability | Use Case |
|---------|--------|-----------|----------|
| **Stable** | `main` | Production-grade | Production deployments |
| **Beta** | `beta` | Pre-production | Pre-release testing |

### Version Tags

- **Stable**: `vX.Y.Z` (e.g., `v1.0.0`)
- **Beta**: `vX.Y.Z-beta.N` (e.g., `v1.0.0-beta.1`)
- **Hotfix**: `vX.Y.Z` (patch increment, e.g., `v1.0.1`)

### Choosing a Version

- Use **stable** (`main` branch) for production
- Use **beta** (`beta` branch) for testing new features
- Beta releases may have bugs and breaking changes
- Report beta issues to help improve stability

See [RELEASE.md](./RELEASE.md) for detailed release procedures.

## Releasing

### Release Requirements

Before creating any release:

1. ✅ All tests pass (`bun test`)
2. ✅ Type checking passes (`bun run typecheck`)
3. ✅ Clean build succeeds (`bun run build`)
4. ✅ Version consistency across all packages
5. ✅ Release notes prepared
6. ✅ Documentation updated

### Stable Release

```bash
# Ensure on main branch
git checkout main
git pull origin main

# Update version numbers
bun run version:patch  # or minor/major

# Commit version bump
git add .
git commit -m "chore: bump version to X.Y.Z"

# Create annotated tag
git tag -a vX.Y.Z -m "Release vX.Y.Z"

# Push commit and tag
git push origin main
git push origin vX.Y.Z

# Create GitHub Release
gh release create vX.Y.Z --generate-notes
```

### Beta Release

```bash
# Ensure on beta branch
git checkout beta
git pull origin beta

# Update version with beta suffix
bun run version:prerelease beta

# Commit version bump
git add .
git commit -m "chore: bump version to X.Y.Z-beta.N"

# Create annotated tag
git tag -a vX.Y.Z-beta.N -m "Beta vX.Y.Z-beta.N"

# Push commit and tag
git push origin beta
git push origin vX.Y.Z-beta.N

# Create GitHub Release (pre-release)
gh release create vX.Y.Z-beta.N --prerelease --generate-notes
```

For detailed release procedures, rollback strategies, and hotfix workflows, see [RELEASE.md](./RELEASE.md).

## Support

### Getting Help

- **Documentation**: See this README and [RELEASE.md](./RELEASE.md)
- **Operations Runbook**: [OPERATIONS_RUNBOOK.md](./OPERATIONS_RUNBOOK.md)
- **Issue Tracker**: [GitHub Issues](https://github.com/code-yeongyu/open-machina/issues)
- **Discussions**: [GitHub Discussions](https://github.com/code-yeongyu/open-machina/discussions)

### Reporting Bugs

When reporting bugs, please include:

1. **Version**: Machina version (from `package.json` or git tag)
2. **Environment**: OS, Bun version, OpenCode version
3. **Steps to Reproduce**: Clear reproduction steps
4. **Expected Behavior**: What should happen
5. **Actual Behavior**: What actually happens
6. **Logs/Error Messages**: Relevant terminal output

### Feature Requests

We welcome feature requests! Please:

1. Check existing issues for duplicates
2. Provide a clear description of the feature
3. Explain the use case and motivation
4. Consider submitting a pull request

### Contributing

We encourage contributions from the community! See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines on:

- Setting up the development environment
- Coding standards and best practices
- Submitting pull requests
- The review process

### Security

If you discover a security vulnerability, please see [SECURITY.md](./SECURITY.md) for responsible disclosure procedures.

## License

This project is licensed under the MIT License - see the [LICENSE](./LICENSE) file for details.

## Acknowledgments

- **OpenCode**: The core editor and extension platform
- **oh-my-opencode**: Multi-agent framework foundation
- **OpenCode**: The core editor and extension platform
- **Bun**: Fast JavaScript runtime and package manager

## Roadmap

Upcoming features and improvements:

- [ ] Enhanced web UI with real-time visualization
- [ ] Additional agent templates and workflows
- [ ] Performance optimizations for large codebases
- [ ] Expanded terminal capabilities
- [ ] Plugin marketplace integration

For the latest updates, follow the [GitHub Releases](https://github.com/code-yeongyu/open-machina/releases).

---

**Built with 🤖 by the OpenCode Machina team**
