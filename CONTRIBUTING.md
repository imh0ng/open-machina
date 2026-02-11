# Contributing to OpenCode Machina

Thank you for your interest in contributing to OpenCode Machina! We welcome contributions from the community and appreciate your help in making Machina better.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Workflow](#development-workflow)
- [Coding Standards](#coding-standards)
- [Testing](#testing)
- [Submitting Changes](#submitting-changes)
- [Reporting Issues](#reporting-issues)

## Code of Conduct

This project adheres to a [Code of Conduct](./CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## Getting Started

### Prerequisites

- **Bun** 1.0 or later: [Install Bun](https://bun.sh/)
- **Git**: For version control
- **OpenCode**: With oh-my-opencode plugin installed
- **Editor**: VS Code or another TypeScript-capable editor

### Setup Development Environment

```bash
# 1. Fork the repository
# Click "Fork" on https://github.com/code-yeongyu/open-machina

# 2. Clone your fork
git clone https://github.com/YOUR_USERNAME/open-machina.git
cd open-machina

# 3. Add upstream remote
git remote add upstream https://github.com/code-yeongyu/open-machina.git

# 4. Install dependencies
bun install

# 5. Build the project
bun run build

# 6. Run tests to verify setup
bun test
```

### Verify Your Setup

```bash
# Check that Bun is installed correctly
bun --version

# Verify build succeeds
bun run build

# Run tests
bun test

# Check type definitions
bun run typecheck
```

## Development Workflow

### Branch Strategy

We use a simplified branching model:

- **`main`**: Protected branch for stable releases
- **`beta`**: Protected branch for pre-release testing
- **`feature/*`**: Short-lived feature branches
- **`fix/*`**: Short-lived bug fix branches

### Creating a Feature Branch

```bash
# Ensure your local main is up to date
git checkout main
git pull upstream main

# Create a new feature branch
git checkout -b feature/your-feature-name

# OR for a bug fix
git checkout -b fix/issue-number-description
```

### Making Changes

1. **Make your changes** in the appropriate package
2. **Add tests** for new functionality (see [Testing](#testing))
3. **Ensure code passes** all checks:
   ```bash
   # Type check
   bun run typecheck

   # Run tests
   bun test

   # Build
   bun run build
   ```

4. **Commit your changes** with clear messages:
   ```bash
   git add .
   git commit -m "feat: add new agent workflow"
   ```

### Commit Message Format

We follow semantic commit messages:

```
<type>: <description>

[optional body]

[optional footer]
```

**Types:**
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation only changes
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `chore`: Maintenance tasks
- `ci`: CI/CD changes

**Examples:**
```bash
git commit -m "feat: add support for custom agent templates"
git commit -m "fix: resolve terminal output buffering issue"
git commit -m "docs: update README with installation instructions"
```

### Syncing with Upstream

```bash
# Fetch latest changes from upstream
git fetch upstream

# Rebase your feature branch on upstream/main
git rebase upstream/main

# If conflicts occur, resolve them and continue
git add .
git rebase --continue
```

## Coding Standards

### TypeScript

- Use **TypeScript** for all code
- Enable **strict mode** in tsconfig.json
- Avoid `any` type; use `unknown` or proper types instead
- Prefer explicit return types for public APIs
- Use `interface` for object shapes, `type` for unions/aliases

### Code Style

- Use **camelCase** for variables and functions
- Use **PascalCase** for classes and interfaces
- Use **SCREAMING_SNAKE_CASE** for constants
- Use **kebab-case** for file and folder names

### Project Structure

Follow the existing monorepo structure:

```
packages/
├── open-machina-shared/     # Shared utilities, types, helpers
├── open-machina-plugin/     # OpenCode plugin integration
├── open-machina-cli/        # CLI interface
└── open-machina-web/        # Local web UI host
```

### Import Style

```typescript
// External dependencies first
import { z } from 'zod';

// Internal dependencies (relative)
import { Logger } from '../utils/logger.js';
import type { AgentConfig } from './types.js';
```

### Error Handling

```typescript
// Use Result types or proper error handling
try {
  const result = await operation();
  return { success: true, data: result };
} catch (error) {
  return {
    success: false,
    error: error instanceof Error ? error.message : 'Unknown error'
  };
}
```

## Testing

### Test Requirements

- All new features must include tests
- Bug fixes should include regression tests
- Maintain test coverage above 80%

### Test Structure

```typescript
// packages/open-machina-shared/src/utils/logger.test.ts
import { describe, it, expect } from 'bun:test';
import { Logger } from './logger.js';

describe('Logger', () => {
  it('should log messages correctly', () => {
    const logger = new Logger();
    logger.log('test message');
    expect(logger.hasLogged('test message')).toBe(true);
  });
});
```

### Running Tests

```bash
# Run all tests
bun test

# Run tests for a specific package
bun test packages/open-machina-shared

# Run tests in watch mode (if configured)
bun test --watch

# Run with coverage (if configured)
bun test --coverage
```

### Test Best Practices

- Write **descriptive test names** that explain what is being tested
- Use **AAA pattern**: Arrange, Act, Assert
- Test **edge cases** and error conditions
- Mock external dependencies
- Keep tests **independent** and **fast**

## Submitting Changes

### Pull Request Process

1. **Ensure your branch is up to date**:
   ```bash
   git fetch upstream
   git rebase upstream/main
   ```

2. **Push to your fork**:
   ```bash
   git push origin feature/your-feature-name
   ```

3. **Create a Pull Request** on GitHub:
   - Provide a clear title
   - Describe your changes in the body
   - Reference related issues
   - Include screenshots for UI changes

### PR Checklist

Before submitting your PR, ensure:

- [ ] Code follows the coding standards
- [ ] All tests pass (`bun test`)
- [ ] Type checking passes (`bun run typecheck`)
- [ ] Build succeeds (`bun run build`)
- [ ] New tests are included for new features
- [ ] Documentation is updated (if applicable)
- [ ] Commit messages follow semantic format

### Review Process

- **At least one maintainer** must approve the PR
- **All CI checks** must pass
- **Address review feedback** promptly
- **Keep PRs focused** on a single change

### After Merge

- **Delete your feature branch** (optional)
- **Sync your fork** with upstream
- **Celebrate!** 🎉

```bash
# Delete local branch
git branch -d feature/your-feature-name

# Delete remote branch
git push origin --delete feature/your-feature-name

# Sync fork with upstream
git checkout main
git pull upstream main
git push origin main
```

## Reporting Issues

### Before Creating an Issue

- **Search existing issues** to avoid duplicates
- **Check documentation** for existing solutions
- **Try the latest version** to see if it's already fixed

### Issue Template

When creating an issue, include:

- **Type**: Bug / Feature / Question
- **Version**: Machina version
- **Environment**: OS, Bun version, OpenCode version
- **Description**: Clear description of the issue or feature request
- **Steps to Reproduce**: (for bugs) Minimal reproduction steps
- **Expected Behavior**: What should happen
- **Actual Behavior**: What actually happens
- **Logs/Error Messages**: Relevant terminal output

### Feature Requests

For feature requests:

- Describe the **use case** and **motivation**
- Explain how the feature would **benefit users**
- Consider proposing an **implementation approach**
- Be open to **discussion** and **feedback**

## Getting Help

- **Documentation**: Read the [README](./README.md) and [RELEASE.md](./RELEASE.md)
- **Discussions**: Ask questions in [GitHub Discussions](https://github.com/code-yeongyu/open-machina/discussions)
- **Issues**: Report bugs or request features in [GitHub Issues](https://github.com/code-yeongyu/open-machina/issues)
- **Chat**: Join our community chat (link TBD)

## Recognition

Contributors are recognized in:

- **README.md**: Major contributors section
- **Release Notes**: Contributors to each release
- **Acknowledgments**: Special contributions

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE).

---

Thank you for contributing to OpenCode Machina! 🤖
