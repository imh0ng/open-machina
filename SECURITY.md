# Security Policy

## Supported Versions

| Version | Status | Supported Until |
|---------|--------|-----------------|
| Latest stable | ✅ Supported | Until next major release |
| Latest beta | ⚠️ Pre-release | Until promoted to stable |
| Older versions | ❌ Unsupported | N/A |

**Note**: Only the latest stable and beta versions receive security updates. Users are encouraged to upgrade regularly.

## Reporting a Vulnerability

### Private Disclosure Process

**Do NOT open a public issue** for security vulnerabilities. Instead, follow this private disclosure process:

1. **Email us**: Send details to [security@machina.dev](mailto:security@machina.dev)
   - Use a descriptive subject line: `Security Vulnerability - [Brief Description]`
   - Include a GPG key if available for encrypted communication

2. **Provide the following information**:
   - Type of vulnerability (e.g., XSS, RCE, injection, etc.)
   - Affected versions
   - Steps to reproduce (minimal, clear reproduction)
   - Proof of concept (if applicable)
   - Potential impact
   - Suggested fix (if known)

3. **What to expect**:
   - We will acknowledge receipt within 48 hours
   - We will provide an estimated timeline for fix
   - We will keep you informed of progress
   - We will request your permission before public disclosure
   - We will credit you in the security advisory (if desired)

### Disclosure Timeline

- **Initial response**: Within 48 hours
- **Investigation**: Within 7 days
- **Fix development**: Varies by severity
- **Public disclosure**: After fix is released and users have time to upgrade

### Credit and Recognition

We value responsible disclosure and will credit contributors who report vulnerabilities:

- Credit in the security advisory
- Recognition in the project's acknowledgments (with permission)
- Invitation to collaborate on security improvements

## Security Best Practices

### For Users

1. **Keep Updated**: Always use the latest stable version
2. **Review Release Notes**: Check for security updates in each release
3. **Use Official Sources**: Only install from official GitHub repository
4. **Monitor Permissions**: Be aware of Machina's system-level access
5. **Review Code**: If building from source, verify the code

### For Developers

1. **Validate Inputs**: Sanitize all user inputs
2. **Least Privilege**: Request only necessary permissions
3. **Secure Dependencies**: Regularly audit and update dependencies
4. **Code Review**: All code must pass peer review
5. **Testing**: Include security tests in CI/CD

### System-Level Access

Machina operates with system-level permissions. This means:

- **File System**: Full read/write access to user's files
- **Terminal**: Ability to execute system commands
- **Network**: Network access for external operations
- **Process**: Can spawn and manage processes

**Users should**:
- Review agent scripts before execution
- Understand what operations agents will perform
- Use sandboxed environments for untrusted code
- Keep Machina updated for security patches

## Security Features

### Built-in Protections

- **Type Safety**: TypeScript reduces runtime type-related vulnerabilities
- **Input Validation**: Agent inputs are validated before execution
- **Sandboxing**: Agents run in controlled environments (where applicable)
- **Audit Logs**: Terminal operations are logged for review

### Known Limitations

- Machina has system-level access and can execute arbitrary commands
- Agent code is not inherently sandboxed (user responsibility)
- Network operations are not filtered (use firewall/network policies)

## Dependency Security

We monitor and update dependencies regularly:

- **Automated Scanning**: Dependabot alerts for known vulnerabilities
- **Regular Updates**: Dependencies updated on release cycles
- **Vulnerability Disclosure**: Security updates are prioritized

### Updating Dependencies

```bash
# Check for outdated packages
bun outdated

# Update all dependencies
bun update

# Update a specific package
bun update <package-name>
```

## Security Advisories

Past security advisories will be published on GitHub:

- [GitHub Security Advisories](https://github.com/code-yeongyu/open-machina/security/advisories)

Subscribe to security alerts to be notified of new advisories:

1. Visit the [GitHub repository](https://github.com/code-yeongyu/open-machina)
2. Click "Watch" → "Custom" → Enable "Security alerts"

## Incident Response

In the event of a confirmed security incident:

1. **Immediate Action**: Issue security advisory with workaround
2. **Patch Development**: Prioritize fix development
3. **Release**: Release patched version immediately
4. **Communication**: Notify users via multiple channels
5. **Post-Mortem**: Document lessons learned and improve processes

## Contact

- **Security Email**: [security@machina.dev](mailto:security@machina.dev)
- **PGP Key**: Available on request
- **GitHub Issues**: For non-security bugs and feature requests

---

**Last Updated**: 2025-02-11
