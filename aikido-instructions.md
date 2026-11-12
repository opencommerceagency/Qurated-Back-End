# Aikido Security CLI Setup & Usage

Aikido Security provides a unified developer-first software security platform. I use it to run scans on my repository locally before code is committed to avoid shipping vulnerabilities, leaked secrets, or IaC misconfigurations.

## 1. Authentication
Before running the CLI, you must log in and link your local machine to the Aikido workspace:
```bash
npx aikido login
```
*This will open your browser and prompt you to authenticate with Aikido.*

## 2. Running Scans Locally
You can scan your local code manually using the scripts defined in `package.json`:

**Standard Scan:**
Runs a standard security check and outputs the results to your terminal.
```bash
npm run security:scan
# Or directly: npx aikido scan
```

**Gated Scan (CI/CD / Pre-commit):**
Runs a scan that will intentionally fail (exit code `> 0`) if there are critical security issues or blocked findings. This is highly recommended before pushing to the `main` or `development` branches!
```bash
npm run security:gate
# Or directly: npx aikido scan --gate
```

**What it checks:**
- Open source dependencies (CVEs)
- Static code analysis (SAST)
- Exposed Secrets
- Container image vulnerabilities
- Infrastructure as Code (IaC) misconfigurations
